import type { SessionEvent } from "@cosquared/schema";
import type { RawToolFormerData } from "./cursor-store";

/**
 * Cursor-specific feature extraction: the tool→category map and the
 * `toolFormerData` reducers. The tool-agnostic TEXT rules are shared via
 * `../heuristics/text-features`, so the published methodology stays identical
 * across tools; only the Cursor-shaped pieces live here.
 *
 * PRIVACY CONTRACT: these read `params`/`result` (raw command/output text)
 * TRANSIENTLY and return only enums and booleans — never user-authored text.
 *
 * Tool names verified against a real `state.vscdb` (the `toolFormerData.name`
 * distribution): Cursor has versioned tool names (`run_terminal_cmd` and
 * `run_terminal_command_v2`, `edit_file` and `edit_file_v2`, …) — both are
 * mapped so a version bump doesn't silently drop a category.
 */

type ToolCategory = Extract<SessionEvent, { type: "tool_call" }>["category"];

/**
 * Cursor tool name → normalized category. Unknown names (MCP tools, future
 * tools) fall to `other` — never an error (PRD §14 Risk #4). `create_plan`
 * stays `other` here and is handled specially as a planning artifact (see
 * {@link isCursorPlanTool}).
 */
const CURSOR_TOOL_CATEGORY_BY_NAME: Record<string, ToolCategory> = {
	run_terminal_cmd: "execute",
	run_terminal_command: "execute",
	run_terminal_command_v2: "execute",
	edit_file: "file_edit",
	edit_file_v2: "file_edit",
	search_replace: "file_edit",
	write: "file_edit",
	write_file: "file_edit",
	apply_patch: "file_edit",
	delete_file: "file_edit",
	edit_notebook: "file_edit",
	read_file: "file_read",
	read_file_v2: "file_read",
	codebase_search: "search",
	semantic_search_full: "search",
	grep: "search",
	grep_search: "search",
	ripgrep_raw_search: "search",
	rg: "search",
	glob_file_search: "search",
	file_search: "search",
	list_dir: "search",
	list_dir_v2: "search",
	web_search: "search",
	web_fetch: "search",
	task_v2: "delegate",
};

/** See {@link CURSOR_TOOL_CATEGORY_BY_NAME}. */
export function categorizeCursorTool(name: string): ToolCategory {
	return CURSOR_TOOL_CATEGORY_BY_NAME[name] ?? "other";
}

/**
 * `create_plan` is Cursor's explicit planning tool — mapped to a
 * `plan_artifact_created` (`plan_doc`) event, analogous to Codex's
 * `update_plan` and Claude's ExitPlanMode (PRD §7.3 Task Framing). `todo_write`
 * is deliberately NOT treated as a plan artifact (it's a high-frequency
 * internal agent mechanism, matching how the Claude collector leaves TodoWrite
 * as `other`).
 */
export function isCursorPlanTool(name: string): boolean {
	return name === "create_plan";
}

/** Parses a `params`/`result` field that may be a JSON string or an already-
 * decoded object; returns null on anything else. */
function parseToolJson(value: unknown): Record<string, unknown> | null {
	if (typeof value === "string") {
		try {
			const parsed = JSON.parse(value);
			return typeof parsed === "object" && parsed !== null
				? (parsed as Record<string, unknown>)
				: null;
		} catch {
			return null;
		}
	}
	if (typeof value === "object" && value !== null) {
		return value as Record<string, unknown>;
	}
	return null;
}

/**
 * Extracts the shell command from a terminal tool's `params` (`{ command }`),
 * for test-run detection. TRANSIENT: read to detect a runner, then dropped.
 */
export function extractCursorCommand(
	toolFormerData: RawToolFormerData,
): string | null {
	const params = parseToolJson(toolFormerData.params);
	const command = params?.command;
	return typeof command === "string" ? command : null;
}

/**
 * Whether the user rejected this tool call — a calibration signal (PRD §7.3).
 * Rule: `userDecision === "rejected"`, or a `result` of `{ "rejected": true }`
 * (the shape Cursor records for a declined edit/command).
 */
export function toolWasRejected(toolFormerData: RawToolFormerData): boolean {
	if (toolFormerData.userDecision === "rejected") {
		return true;
	}
	const result = parseToolJson(toolFormerData.result);
	return result?.rejected === true;
}

/**
 * Whether this tool call errored. Rule: `status === "error"`, or a `result`
 * carrying a truthy `error`. `cancelled`/`loading` are NOT errors (an
 * abandoned/in-flight call, not a failure).
 */
export function toolErrored(toolFormerData: RawToolFormerData): boolean {
	if (toolFormerData.status === "error") {
		return true;
	}
	const result = parseToolJson(toolFormerData.result);
	const error = result?.error;
	return error !== undefined && error !== null && error !== false;
}
