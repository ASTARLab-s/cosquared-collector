import { describe, expect, test } from "vitest";
import { RawToolFormerDataSchema } from "./cursor-store";
import {
	categorizeCursorTool,
	extractCursorCommand,
	isCursorPlanTool,
	toolErrored,
	toolWasRejected,
} from "./heuristics";

/**
 * Table-driven fixtures for the Cursor-specific reducers, pinned to real
 * `toolFormerData` shapes (verified against a live `state.vscdb`): tool names
 * with `_v2` suffixes, `params:'{"command":…}'`, and `result:'{"rejected":true}'`.
 */

function tfd(fields: Record<string, unknown>) {
	return RawToolFormerDataSchema.parse(fields);
}

describe("categorizeCursorTool", () => {
	const fixtures: Record<string, { name: string; expected: string }> = {
		runTerminalCmdIsExecute: {
			name: "run_terminal_cmd",
			expected: "execute",
		},
		runTerminalCmdV2IsExecute: {
			name: "run_terminal_command_v2",
			expected: "execute",
		},
		editFileV2IsFileEdit: { name: "edit_file_v2", expected: "file_edit" },
		searchReplaceIsFileEdit: { name: "search_replace", expected: "file_edit" },
		writeIsFileEdit: { name: "write", expected: "file_edit" },
		readFileV2IsFileRead: { name: "read_file_v2", expected: "file_read" },
		codebaseSearchIsSearch: { name: "codebase_search", expected: "search" },
		ripgrepIsSearch: { name: "ripgrep_raw_search", expected: "search" },
		webSearchIsSearch: { name: "web_search", expected: "search" },
		taskV2IsDelegate: { name: "task_v2", expected: "delegate" },
		// create_plan is a plan artifact, categorized other (handled separately).
		createPlanIsOther: { name: "create_plan", expected: "other" },
		todoWriteIsOther: { name: "todo_write", expected: "other" },
		unknownMcpToolIsOther: {
			name: "mcp_canvas-mcp-server_canvas_list_courses",
			expected: "other",
		},
	};

	test.each(Object.entries(fixtures))("%s", (_name, { name, expected }) => {
		expect(categorizeCursorTool(name)).toBe(expected);
	});
});

describe("isCursorPlanTool", () => {
	test("create_plan is the plan tool", () => {
		expect(isCursorPlanTool("create_plan")).toBe(true);
	});
	test("todo_write is not a plan tool", () => {
		expect(isCursorPlanTool("todo_write")).toBe(false);
	});
});

describe("extractCursorCommand", () => {
	test("reads .command from a params JSON string", () => {
		expect(
			extractCursorCommand(
				tfd({ params: '{"command":"pnpm test","is_background":false}' }),
			),
		).toBe("pnpm test");
	});

	test("reads .command from an already-parsed params object", () => {
		expect(
			extractCursorCommand(tfd({ params: { command: "go test ./..." } })),
		).toBe("go test ./...");
	});

	test("returns null when there is no command", () => {
		expect(
			extractCursorCommand(tfd({ params: '{"path":"src/x.ts"}' })),
		).toBeNull();
	});
});

describe("toolWasRejected", () => {
	test("userDecision rejected is a rejection", () => {
		expect(toolWasRejected(tfd({ userDecision: "rejected" }))).toBe(true);
	});
	test("a result of {rejected:true} is a rejection", () => {
		expect(toolWasRejected(tfd({ result: '{"rejected":true}' }))).toBe(true);
	});
	test("an accepted tool is not a rejection", () => {
		expect(
			toolWasRejected(
				tfd({ userDecision: "accepted", result: '{"output":"ok"}' }),
			),
		).toBe(false);
	});
});

describe("toolErrored", () => {
	test("status error is an error", () => {
		expect(toolErrored(tfd({ status: "error" }))).toBe(true);
	});
	test("a result with a truthy error field is an error", () => {
		expect(
			toolErrored(tfd({ status: "completed", result: '{"error":"boom"}' })),
		).toBe(true);
	});
	test("a completed tool is not an error", () => {
		expect(
			toolErrored(tfd({ status: "completed", result: '{"output":"ok"}' })),
		).toBe(false);
	});
	test("a cancelled tool is not an error", () => {
		expect(toolErrored(tfd({ status: "cancelled" }))).toBe(false);
	});
});
