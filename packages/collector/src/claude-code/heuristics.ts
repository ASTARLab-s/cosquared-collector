import type { SessionEvent } from "@cosquared/schema";
import {
	TextBlockSchema,
	ToolResultBlockSchema,
	type UserLine,
} from "./transcript-line";

/**
 * Deterministic feature-extraction rules for Claude Code transcripts.
 *
 * Every rule here is published methodology: deliberately simple, auditable
 * string rules rather than clever classifiers, because users must be able
 * to verify exactly how a score was computed (PRD §7.6 evidence fidelity).
 *
 * PRIVACY CONTRACT for this module: functions receive transcript text
 * TRANSIENTLY and return only numbers, booleans, and enum labels. No
 * function here may return user-authored text.
 */

export type ToolCategory = Extract<
	SessionEvent,
	{ type: "tool_call" }
>["category"];

export type PlanArtifactKind = Extract<
	SessionEvent,
	{ type: "plan_artifact_created" }
>["artifactKind"];

export type CommandCategory = Extract<
	SessionEvent,
	{ type: "command_invoked" }
>["category"];

/** Slash-command and harness machinery markers at the start of user content. */
const COMMAND_MACHINERY_PREFIXES = ["<command-", "<local-command-"];

function isCommandMachinery(text: string): boolean {
	return COMMAND_MACHINERY_PREFIXES.some((prefix) => text.startsWith(prefix));
}

/**
 * Whether a user line is a prompt the human actually typed.
 *
 * Rule: content is a string (or an array containing a `text` block and no
 * `tool_result` block), the line is not harness-injected (`isMeta`), not
 * subagent traffic (`isSidechain`), and the text is not slash-command
 * machinery (`<command-...>` / `<local-command-...>` markers).
 *
 * Gates the `user_prompt` event, which feeds the Task Framing and
 * Cognitive Engagement sub-signals (PRD §7.3, AI Collaboration).
 */
export function isHumanPrompt(line: UserLine): boolean {
	if (line.isMeta === true || line.isSidechain === true) {
		return false;
	}
	const content = line.message.content;
	if (typeof content === "string") {
		return !isCommandMachinery(content);
	}
	const containsToolResult = content.some(
		(block) => block.type === "tool_result",
	);
	if (containsToolResult) {
		return false;
	}
	const text = promptText(line);
	return text.length > 0 && !isCommandMachinery(text);
}

/**
 * Whether a user line is the user invoking a skill or slash command.
 *
 * Rule: a non-sidechain user line whose text content starts with a
 * `<command-` marker (the harness's command-expansion envelope).
 * `<local-command-` lines are built-in CLI output, not workflow
 * invocations, and never match.
 *
 * Gates the payload-free `command_invoked` event: the command NAME is
 * user-authored text and is deliberately never captured — the invocation
 * count alone feeds Tool & Workflow Judgment's workflow-leverage component
 * (PRD §7.3 agent-vs-manual task fit).
 */
export function isCommandInvocation(line: UserLine): boolean {
	if (line.isSidechain === true) {
		return false;
	}
	return promptText(line).startsWith("<command-");
}

/**
 * Published command → category allowlist. Deliberately small and retunable
 * in ONE place (like the scoring weights): a command absent from this table
 * — including every custom user command — falls to `other`, because its
 * name is never inspected beyond this lookup. `plan` = working from or
 * producing an explicit plan/spec; `context` = engineering the agent's
 * context. Names are matched without the leading slash, case-insensitively.
 */
const COMMAND_CATEGORY_BY_NAME: Record<string, CommandCategory> = {
	execute: "plan",
	"plan-feature": "plan",
	plan: "plan",
	"create-prd": "plan",
	implement: "plan",
	prime: "context",
	init: "context",
};

/** Captures the command name from a `<command-name>/foo</command-name>` tag. */
const COMMAND_NAME_TAG = /<command-name>\/?([\w-]+)<\/command-name>/;

/**
 * Classifies a command invocation into the structural category emitted on
 * the `command_invoked` event. Rule: read the `<command-name>` tag
 * TRANSIENTLY, look it up in {@link COMMAND_CATEGORY_BY_NAME}; unrecognized
 * or unparseable → `other`. The name is used only for this lookup and never
 * returned — only the category leaves (same privacy posture as
 * {@link referencesPlanArtifact}).
 *
 * Only the `plan` category feeds Task Framing in v1 (working from explicit
 * plans, PRD §7.3): a session driven by `/execute <plan>` is well-framed
 * even when its typed prompt is a terse "continue".
 */
export function classifyCommand(line: UserLine): CommandCategory {
	const match = COMMAND_NAME_TAG.exec(promptText(line));
	if (match === null) {
		return "other";
	}
	return COMMAND_CATEGORY_BY_NAME[match[1].toLowerCase()] ?? "other";
}

/**
 * Extracts the prompt text of a user line: the string content, or the
 * concatenated `text` blocks. TRANSIENT USE ONLY — callers must reduce the
 * string to structural features and drop it; it never enters an event.
 */
export function promptText(line: UserLine): string {
	const content = line.message.content;
	if (typeof content === "string") {
		return content;
	}
	const textParts: string[] = [];
	for (const block of content) {
		if (block.type === "text") {
			const parsed = TextBlockSchema.safeParse(block);
			if (parsed.success) {
				textParts.push(parsed.data.text);
			}
		}
	}
	return textParts.join("\n");
}

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
 * Claude Code tool name → normalized tool category, for the category
 * distribution that feeds Tool & Workflow Judgment (PRD §7.3). `Skill`,
 * `Task`, and `Agent` are delegation to skills/subagents — the
 * agent-vs-manual task fit signal (PRD §7.3) feeding workflow leverage.
 * Unknown names (future tools, MCP tools) map to `other` — never an error
 * (PRD §14 Risk #4 forward compatibility).
 */
const TOOL_CATEGORY_BY_NAME: Record<string, ToolCategory> = {
	Edit: "file_edit",
	Write: "file_edit",
	MultiEdit: "file_edit",
	NotebookEdit: "file_edit",
	Read: "file_read",
	Bash: "execute",
	BashOutput: "execute",
	Grep: "search",
	Glob: "search",
	WebSearch: "search",
	WebFetch: "search",
	ToolSearch: "search",
	Explore: "search",
	Skill: "delegate",
	Task: "delegate",
	Agent: "delegate",
};

/** See {@link TOOL_CATEGORY_BY_NAME}. */
export function categorizeToolName(name: string): ToolCategory {
	return TOOL_CATEGORY_BY_NAME[name] ?? "other";
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
 * Detects a test-suite execution in a Bash command. Rule: the command
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

/**
 * Extracts the text of a tool result block (string content or concatenated
 * `text` sub-blocks). TRANSIENT USE ONLY — read for rejection detection,
 * never emitted.
 */
export function toolResultText(block: unknown): string {
	const parsed = ToolResultBlockSchema.safeParse(block);
	if (!parsed.success || parsed.data.content === undefined) {
		return "";
	}
	const content = parsed.data.content;
	if (typeof content === "string") {
		return content;
	}
	return content
		.map((part) => part.text ?? "")
		.filter(Boolean)
		.join("\n");
}
