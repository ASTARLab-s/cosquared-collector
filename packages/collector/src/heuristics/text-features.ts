import type { SessionEvent } from "@cosquared/schema";

/**
 * Tool-agnostic, pure text feature-extraction rules shared by EVERY collector
 * (Claude Code, Codex CLI, Cursor).
 *
 * These are the published scoring methodology: deliberately simple, auditable
 * string rules rather than clever classifiers, because users must be able to
 * verify exactly how a score was computed (PRD §7.6 evidence fidelity). They
 * live in one module precisely so the methodology is IDENTICAL across tools —
 * a test-run or a planning prompt is detected the same way no matter which AI
 * tool produced the session, never silently re-implemented per collector.
 *
 * PRIVACY CONTRACT for this module: functions receive prompt/command/output
 * text TRANSIENTLY and return only numbers, booleans, and enum labels. No
 * function here may return user-authored text.
 */

export type PlanArtifactKind = Extract<
	SessionEvent,
	{ type: "plan_artifact_created" }
>["artifactKind"];

/**
 * Whitespace-delimited word count of a prompt. Feeds `user_prompt.wordCount`
 * (Task Framing, PRD §7.3): prompt length is a coarse proxy for how much
 * context and intent the user supplies up front.
 */
export function countWords(text: string): number {
	return text.trim().split(/\s+/).filter(Boolean).length;
}

/**
 * Whether a prompt asks a question. Rule: contains at least one `?`.
 * Deliberately simple (published methodology); feeds Cognitive Engagement
 * (PRD §7.3).
 */
export function isQuestion(text: string): boolean {
	return text.includes("?");
}

/**
 * Whether a prompt references a planning artifact. Rule: contains the word
 * `plan`/`planning`, `spec`/`specification`, `prd`, or `todo` (word-bounded),
 * or a `plans/` path segment. Feeds Task Framing (PRD §7.3): working from
 * explicit plans is the core upstream signal of well-framed tasks.
 */
export function referencesPlanArtifact(text: string): boolean {
	return (
		/\b(plan(?:ning)?|spec(?:ification)?|prd|todo)\b/i.test(text) ||
		/\bplans?\//i.test(text)
	);
}

/**
 * Ordered-step discourse markers. Each entry is one KIND of ordering cue;
 * two DISTINCT kinds are required to call a prompt sequenced, so a single
 * incidental "first" ("the first test is broken") never counts as framing
 * while "first … then" does.
 */
const SEQUENCE_MARKERS: ReadonlyArray<RegExp> = [
	/\bfirst(?:ly)?\b/i,
	/\bthen\b/i,
	/\bnext\b/i,
	/\bafter that\b/i,
	/\bfinally\b/i,
	/\blastly\b/i,
	/\bsecond(?:ly)?\b/i,
	/\bthird(?:ly)?\b/i,
];

/** A numbered step at the start of a line: `1.`, `2)`, `Step 3`. */
const NUMBERED_STEP = /^[ \t]*(?:\d+[.)]|step\s+\d+\b)/gim;

/**
 * Whether a prompt lays out the work as explicit ordered steps — a
 * numbered list of two or more items, or two distinct sequencing cues
 * ("first … then", "next … finally").
 *
 * Feeds Task Framing (PRD §7.3) alongside {@link referencesPlanArtifact}.
 * Structuring the work IN the prompt is planning, even when no plan file
 * exists: "First, explain how scheduled tasks work. Then interview me to
 * figure out what I need scheduled" states a sequence before any code is
 * generated, which is the behavior Task Framing exists to reward.
 *
 * Why this is not a return of prompt length (calibration 2026-08-28): the
 * rejected length rule credited any long prompt, so rambling scored as
 * planning. Ordering is structural — it is the sequence itself, not the
 * word count, and a 12-word prompt can satisfy it while a 200-word
 * unstructured one cannot. Added because the structure-only rule shipped
 * in 0.3.0 pinned three of seven calibration repos at exactly 0 on
 * Framing where a qualitative read of the same sessions saw 40-68: it
 * recognized only explicit plan ARTIFACTS and missed in-prompt sequencing
 * entirely.
 */
export function describesOrderedSteps(text: string): boolean {
	const numbered = text.match(NUMBERED_STEP);
	if (numbered !== null && numbered.length >= 2) {
		return true;
	}
	let kinds = 0;
	for (const marker of SEQUENCE_MARKERS) {
		if (marker.test(text)) {
			kinds += 1;
			if (kinds >= 2) {
				return true;
			}
		}
	}
	return false;
}

/**
 * Whether a prompt asks the AI to explain rather than produce changes.
 * Rule: contains an explanation-seeking phrase (`explain`, `why`,
 * `how does/do/did/is/are/come`, `what does/is/are`, `walk me through`,
 * `help me understand`). Gates the `explanation_request` event; feeds
 * Cognitive Engagement (PRD §7.3): explanation-seeking distinguishes
 * comprehension-oriented use from pure generation.
 */
export function isExplanationRequest(text: string): boolean {
	return /\b(explain|why\b|how (?:does|do|did|is|are|come)|what (?:does|is|are)|walk me through|help me understand)\b/i.test(
		text,
	);
}

/**
 * Known test runners, matched on command/word boundaries so that e.g.
 * `echo "test"` or `npm run build` never count as a test run. The matched
 * label becomes `test_run.framework`.
 */
const TEST_RUNNER_PATTERNS: ReadonlyArray<{
	framework: string;
	pattern: RegExp;
}> = [
	{ framework: "vitest", pattern: /\bvitest\b/ },
	{ framework: "jest", pattern: /\bjest\b/ },
	{ framework: "pytest", pattern: /\bpytest\b/ },
	{ framework: "go", pattern: /\bgo test\b/ },
	{ framework: "cargo", pattern: /\bcargo test\b/ },
	{ framework: "bun", pattern: /\bbun test\b/ },
	{ framework: "rspec", pattern: /\brspec\b/ },
	{ framework: "phpunit", pattern: /\bphpunit\b/ },
	{
		framework: "npm-script",
		pattern: /\b(?:npm|pnpm|yarn)\s+(?:run\s+)?test\b/,
	},
];

/**
 * Detects a test-suite execution in a shell command. Rule: the command
 * matches a known runner from {@link TEST_RUNNER_PATTERNS} (first match
 * wins; package-manager `test` scripts report framework `npm-script`).
 * Gates the `test_run` event — the strongest signal for Testing Discipline
 * and Verification & Calibration (PRD §7.3).
 */
export function detectTestRun(command: string): { framework: string } | null {
	for (const { framework, pattern } of TEST_RUNNER_PATTERNS) {
		if (pattern.test(command)) {
			return { framework };
		}
	}
	return null;
}

/** Categories a shell command can classify into (a subset of tool_call
 * categories — a shell command is never an edit/delegate by this rule). */
export type ShellCommandCategory = "search" | "file_read" | "execute";

/** Programs whose purpose is searching file contents or names. */
const SEARCH_PROGRAMS = new Set([
	"rg",
	"grep",
	"egrep",
	"fgrep",
	"zgrep",
	"ag",
	"ack",
	"fd",
	"find",
	"fzf",
]);

/** Programs that only read/inspect files or state — never mutate. */
const READ_PROGRAMS = new Set([
	"cat",
	"head",
	"tail",
	"less",
	"more",
	"bat",
	"nl",
	"wc",
	"stat",
	"file",
	"du",
	"ls",
	"tree",
	"pwd",
	"readlink",
	"od",
	"strings",
	"jq",
	"yq",
	"diff",
	"cmp",
	"column",
	"hexdump",
	"xxd",
	"awk",
]);

/** Read-only git subcommands — repo inspection, not state change. */
const GIT_READ_SUBCOMMANDS = new Set([
	"diff",
	"status",
	"log",
	"show",
	"blame",
	"branch",
	"remote",
	"rev-parse",
	"ls-files",
	"ls-remote",
	"describe",
	"shortlog",
	"reflog",
	"cat-file",
]);

/** Wrapper tokens that defer to the program that follows them. */
const WRAPPER_PROGRAMS = new Set([
	"sudo",
	"env",
	"command",
	"time",
	"nohup",
	"xargs",
]);

const SHELL_PROGRAMS = new Set(["bash", "sh", "zsh", "dash"]);

/** The program a token names, with any path prefix and quotes stripped. */
function programName(token: string): string {
	const unquoted = token.replace(/^["']|["']$/g, "");
	const base = unquoted.split("/").pop() ?? unquoted;
	return base.toLowerCase();
}

function classifySegment(segment: string): ShellCommandCategory | null {
	const tokens = segment.trim().split(/\s+/).filter(Boolean);
	let index = 0;
	// Skip env assignments (VAR=value) and wrapper programs to reach the
	// program that determines the segment's purpose.
	while (index < tokens.length) {
		const token = tokens[index];
		if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) {
			index += 1;
			continue;
		}
		if (WRAPPER_PROGRAMS.has(programName(token))) {
			index += 1;
			continue;
		}
		break;
	}
	const head = tokens[index];
	if (head === undefined) {
		return null;
	}
	const program = programName(head);
	// `bash -lc "…"` runs a nested command — classify what it runs.
	if (SHELL_PROGRAMS.has(program)) {
		const flag = tokens[index + 1];
		if (flag !== undefined && /^-\w*c\w*$/.test(flag)) {
			const nested = tokens.slice(index + 2).join(" ");
			return nested.length === 0 ? "execute" : classifySegment(nested);
		}
		return "execute";
	}
	if (SEARCH_PROGRAMS.has(program)) {
		return "search";
	}
	if (program === "git") {
		const subcommand = tokens
			.slice(index + 1)
			.map((token) => token.replace(/^["']|["']$/g, ""))
			.find((token) => !token.startsWith("-"));
		if (subcommand === "grep") {
			return "search";
		}
		return subcommand !== undefined && GIT_READ_SUBCOMMANDS.has(subcommand)
			? "file_read"
			: "execute";
	}
	if (program === "sed") {
		// `sed -n '1,50p' file` prints ranges (a read); `sed -i` rewrites.
		const rest = tokens.slice(index + 1);
		const inPlace = rest.some((token) => /^-i/.test(token));
		const printOnly = rest.includes("-n");
		return printOnly && !inPlace ? "file_read" : "execute";
	}
	if (READ_PROGRAMS.has(program)) {
		return "file_read";
	}
	return "execute";
}

/**
 * Classifies a shell command as `search`, `file_read`, or `execute` from the
 * programs it invokes. Feeds the tool_call category for shell-mediated tools
 * (Codex CLI's `exec_command`), so that agents whose ONLY channel is a shell
 * still produce an honest category distribution for Tool & Workflow Judgment
 * (PRD §7.3) — calibration against real rollouts showed ~70% of exec commands
 * are reads/searches (`sed -n`, `rg`, `nl`), which a blanket "execute" label
 * misrepresented, making balanced sessions structurally undetectable.
 *
 * Rules (published methodology — deliberately simple string rules):
 * - The command is split on `&&`, `||`, `;`, and `|`; each segment is
 *   classified by its program name (env assignments, `sudo`/`env`/`time`/
 *   `xargs` wrappers, and `bash -c` nesting are skipped; path prefixes are
 *   stripped). Quoted connector characters are not shell-parsed — a known,
 *   accepted simplification.
 * - Any segment that RUNS something (build, script, unknown program) makes
 *   the whole command `execute` — execution dominates, so validation
 *   detection (`followedByValidation`) stays strict.
 * - Otherwise any search segment (`rg`, `grep`, `fd`, `git grep`…) makes it
 *   `search`; otherwise read-only segments (`cat`, `sed -n`, `nl`, `head`,
 *   read-only `git` subcommands…) make it `file_read`.
 * - An empty/unclassifiable command falls back to `execute` (the historical
 *   label — never silently uncounted).
 */
export function classifyShellCommand(command: string): ShellCommandCategory {
	const categories: ShellCommandCategory[] = [];
	for (const segment of command.split(/\|\||&&|;|\|/)) {
		const category = classifySegment(segment);
		if (category !== null) {
			categories.push(category);
		}
	}
	if (categories.length === 0 || categories.includes("execute")) {
		return "execute";
	}
	return categories.includes("search") ? "search" : "file_read";
}

/** Doc-ish files only: markdown, plain text, or extensionless. */
function isDocFileName(basename: string): boolean {
	return /\.(md|txt)$/i.test(basename) || !basename.includes(".");
}

/**
 * Detects a planning-artifact write from a file path. Rules:
 * basename `plan*.md` or a `plans/` path segment → `plan_doc`;
 * basename starting with `spec`/`todo` → `spec`/`todo`, but only for
 * doc-like files (`.md`/`.txt`/extensionless) so source files such as
 * `todo-list.component.ts` never match. The path is inspected transiently
 * and never emitted. Feeds Task Framing via `plan_artifact_created`
 * (PRD §7.3).
 */
export function isPlanArtifactWrite(
	filePath: string,
): { artifactKind: PlanArtifactKind } | null {
	const basename = filePath.split("/").pop() ?? "";
	if (/^plan.*\.md$/i.test(basename) || /\bplans?\//i.test(filePath)) {
		return { artifactKind: "plan_doc" };
	}
	if (/^spec/i.test(basename) && isDocFileName(basename)) {
		return { artifactKind: "spec" };
	}
	if (/^todo/i.test(basename) && isDocFileName(basename)) {
		return { artifactKind: "todo" };
	}
	return null;
}

/**
 * Whether an error tool result is actually the user declining the tool
 * call (Claude Code reports rejection as `is_error: true` with a marker
 * phrase). Rule: result text contains "doesn't want to proceed" or
 * "user rejected" (case-insensitive). Distinguishes `change_rejected`
 * (a calibration signal) from `error_encountered` (PRD §7.3).
 */
export function isRejectionResult(resultText: string): boolean {
	const lowered = resultText.toLowerCase();
	return (
		lowered.includes("doesn't want to proceed") ||
		lowered.includes("user rejected")
	);
}
