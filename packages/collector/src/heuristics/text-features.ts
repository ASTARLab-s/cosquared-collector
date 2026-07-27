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
