/**
 * Deterministic path-classification rules for the git collector.
 *
 * Every rule here is published methodology: deliberately simple, auditable
 * string rules rather than clever classifiers, because users must be able
 * to verify exactly how a score was computed (PRD §7.6 evidence fidelity).
 *
 * PRIVACY CONTRACT for this module: functions receive file paths
 * TRANSIENTLY and return only booleans. No function here may return any
 * part of a path.
 */

/**
 * Path segments that mark a file as living in a test tree. Matched as
 * whole segments (split on `/`), never as substrings, so `contest/` or
 * `latest/` can never false-positive.
 */
const TEST_SEGMENTS = new Set(["__tests__", "test", "tests", "spec"]);

/** Path segments that mark a file as documentation. Whole segments only. */
const DOC_SEGMENTS = new Set(["doc", "docs"]);

/**
 * The final path segment. Git always emits `/` separators (even on
 * Windows), so splitting on `/` is exact. Rename numstat paths like
 * `src/{old => new}/file.test.ts` keep a clean final segment, so basename
 * rules still fire on them.
 */
function basenameOf(path: string): string {
	return path.split("/").pop() ?? "";
}

function segmentsOf(path: string): string[] {
	return path.split("/").slice(0, -1);
}

/**
 * Whether a file path is a test file. Rule (case-insensitive): the
 * basename contains `.test.` or `.spec.`, ends `_test.<ext>`, or starts
 * `test_`; or any directory segment is exactly `__tests__`, `test`,
 * `tests`, or `spec`. Feeds `commit.touchedTestFiles` and
 * `repo_snapshot.testFileCount` (Testing Discipline, PRD §7.3).
 */
export function isTestFilePath(path: string): boolean {
	const basename = basenameOf(path).toLowerCase();
	if (
		basename.includes(".test.") ||
		basename.includes(".spec.") ||
		/_test\.[^.]+$/.test(basename) ||
		basename.startsWith("test_")
	) {
		return true;
	}
	return segmentsOf(path).some((segment) =>
		TEST_SEGMENTS.has(segment.toLowerCase()),
	);
}

/**
 * Whether a file path is documentation. Rule (case-insensitive): the
 * basename matches `readme*`, or any directory segment is exactly `doc`
 * or `docs`. Deliberately narrow — a stray `.md` anywhere does NOT count
 * as documentation. Feeds `repo_snapshot.docFileCount` (repo-shape
 * context-quality signals, PRD §7.3, §4).
 */
export function isDocFilePath(path: string): boolean {
	if (basenameOf(path).toLowerCase().startsWith("readme")) {
		return true;
	}
	return segmentsOf(path).some((segment) =>
		DOC_SEGMENTS.has(segment.toLowerCase()),
	);
}

/**
 * Basenames that mark a file as an agent-context file — the cross-tool
 * set of rules/instructions files AI coding tools read (skills/rules are
 * the portable context layer across Claude Code, Codex, Cursor, Copilot).
 * Whole-basename match only.
 */
const CONTEXT_FILE_BASENAMES = new Set([
	"claude.md",
	"agents.md",
	".cursorrules",
	"gemini.md",
	"copilot-instructions.md",
]);

/**
 * Whether a file path is an agent-context file. Rule (case-insensitive):
 * the basename is exactly one of `claude.md`, `agents.md`, `.cursorrules`,
 * `gemini.md`, or `copilot-instructions.md` — never a substring match, so
 * `reclaude.md` or `my-agents.md.bak` can never false-positive. Feeds
 * `repo_snapshot.contextFileCount` (Tool & Workflow Judgment's
 * context-engineering artifacts, PRD §7.3; DORA 2025: context/docs quality
 * strongly predicts AI effectiveness).
 */
export function isContextFilePath(path: string): boolean {
	return CONTEXT_FILE_BASENAMES.has(basenameOf(path).toLowerCase());
}

/** Subdirectories of `.claude/` that hold authored automation. */
const AUTOMATION_SUBDIRS = new Set(["skills", "commands", "agents"]);

/**
 * Whether a file path is authored automation config — the user building
 * their own workflow tooling. Rule (case-insensitive): the path contains
 * the consecutive directory segments `.claude/skills`, `.claude/commands`,
 * or `.claude/agents`. Segment-exact, never substring, so
 * `src/.claude-backup/skills/x.md` can never false-positive. Feeds
 * `repo_snapshot.automationFileCount` (Tool & Workflow Judgment,
 * PRD §7.3 agent-vs-manual task fit).
 */
export function isAutomationConfigPath(path: string): boolean {
	const directories = segmentsOf(path);
	return directories.some(
		(segment, index) =>
			segment.toLowerCase() === ".claude" &&
			AUTOMATION_SUBDIRS.has(directories[index + 1]?.toLowerCase() ?? ""),
	);
}
