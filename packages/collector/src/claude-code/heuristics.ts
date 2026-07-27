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
 *
 * The tool-agnostic text rules (`countWords`, `isQuestion`,
 * `referencesPlanArtifact`, `isExplanationRequest`, `detectTestRun`,
 * `isPlanArtifactWrite`, `isRejectionResult`) live in
 * `../heuristics/text-features` so the published methodology is identical
 * across every collector; they are re-exported here so this module's
 * existing importers (event-mapping, tests) keep importing from
 * `./heuristics` unchanged. Everything below is Claude-Code-line-shaped.
 */

export {
	countWords,
	detectTestRun,
	isExplanationRequest,
	isPlanArtifactWrite,
	isQuestion,
	isRejectionResult,
	type PlanArtifactKind,
	referencesPlanArtifact,
} from "../heuristics/text-features";

export type ToolCategory = Extract<
	SessionEvent,
	{ type: "tool_call" }
>["category"];

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
