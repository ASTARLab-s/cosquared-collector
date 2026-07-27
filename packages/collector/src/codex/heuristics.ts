import type { SessionEvent } from "@cosquared/schema";

/**
 * Codex-CLI-specific feature extraction: the tool→category map and the
 * argument/output reducers. The tool-agnostic TEXT rules (test-runner
 * detection, prompt classification) are shared via `../heuristics/text-features`
 * so the published methodology is identical across tools; only the
 * Codex-line-shaped pieces live here.
 *
 * PRIVACY CONTRACT: these functions read tool arguments and outputs (raw shell
 * commands, patch bodies, exec stdout) TRANSIENTLY and return only enums and
 * booleans. No user-authored text is ever returned.
 *
 * Tool names verified against real rollouts (cli_version 0.108 → 0.142):
 * `exec_command` is the shell tool (older versions used `shell`/`local_shell`);
 * `apply_patch` arrives as a `custom_tool_call`; `update_plan` is Codex's
 * planning mechanism.
 */

type ToolCategory = Extract<SessionEvent, { type: "tool_call" }>["category"];

/**
 * Codex tool name → normalized category. `exec_command` (and the legacy
 * `shell`/`local_shell`) run commands; `write_stdin` feeds an interactive
 * shell session; `apply_patch` edits files; `read_file` reads them;
 * `web_search` searches. `update_plan` stays `other` here and is handled
 * specially as a planning artifact (see {@link isCodexPlanTool}). Every
 * unknown name (MCP tools, future tools) falls to `other` — never an error
 * (PRD §14 Risk #4 forward compatibility).
 */
const CODEX_TOOL_CATEGORY_BY_NAME: Record<string, ToolCategory> = {
	exec_command: "execute",
	shell: "execute",
	local_shell: "execute",
	local_shell_call: "execute",
	write_stdin: "execute",
	apply_patch: "file_edit",
	read_file: "file_read",
	web_search: "search",
};

/** See {@link CODEX_TOOL_CATEGORY_BY_NAME}. */
export function categorizeCodexTool(name: string): ToolCategory {
	return CODEX_TOOL_CATEGORY_BY_NAME[name] ?? "other";
}

/**
 * `update_plan` is Codex's planning mechanism (a structured step list) — the
 * strongest Task Framing signal Codex emits, mapped to a `plan_artifact_created`
 * (`plan_doc`) event, analogous to Claude Code's ExitPlanMode (PRD §7.3).
 */
export function isCodexPlanTool(name: string): boolean {
	return name === "update_plan";
}

/** JSON.parse that never throws — returns undefined on any failure. */
function tryParseJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

/**
 * Extracts the shell command from a `function_call.arguments` JSON string, for
 * test-run detection. `exec_command` uses `{ "cmd": "…" }` (current); older
 * `shell`/`local_shell` used `{ "command": ["bash","-lc","…"] }` — join an
 * array to one string. TRANSIENT: the command is read to detect a test runner
 * and then dropped, never emitted.
 */
export function extractShellCommand(argumentsJson: string): string | null {
	const parsed = tryParseJson(argumentsJson);
	if (typeof parsed !== "object" || parsed === null) {
		return null;
	}
	const raw =
		(parsed as { cmd?: unknown; command?: unknown }).cmd ??
		(parsed as { command?: unknown }).command;
	if (typeof raw === "string") {
		return raw;
	}
	if (Array.isArray(raw)) {
		return raw
			.filter((part): part is string => typeof part === "string")
			.join(" ");
	}
	return null;
}

/** Whether a parsed output object signals failure (truthy `error`, or a
 * non-zero `exit_code` / `metadata.exit_code`). */
function objectIndicatesError(value: object): boolean {
	const obj = value as {
		error?: unknown;
		exit_code?: unknown;
		metadata?: { exit_code?: unknown };
	};
	if (obj.error !== undefined && obj.error !== null && obj.error !== false) {
		return true;
	}
	const exitCode =
		typeof obj.exit_code === "number" ? obj.exit_code : obj.metadata?.exit_code;
	return typeof exitCode === "number" && exitCode !== 0;
}

/**
 * Whether a `function_call_output` / `custom_tool_call_output` indicates an
 * error, used for `test_run.passed` and `error_encountered`. Handles both
 * shapes seen on disk: a structured object/JSON string with `exit_code` or
 * `metadata.exit_code` (apply_patch), and the plain exec text containing
 * "Process exited with code N" (exec_command). TRANSIENT: output text is read
 * to decide pass/fail and then dropped.
 */
export function functionCallOutputIsError(output: unknown): boolean {
	if (typeof output === "string") {
		const parsed = tryParseJson(output);
		if (typeof parsed === "object" && parsed !== null) {
			return objectIndicatesError(parsed);
		}
		const match = /exited with code (\d+)/.exec(output);
		return match !== null && match[1] !== "0";
	}
	if (typeof output === "object" && output !== null) {
		return objectIndicatesError(output);
	}
	return false;
}
