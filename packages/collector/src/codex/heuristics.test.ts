import { describe, expect, test } from "vitest";
import {
	categorizeCodexTool,
	extractShellCommand,
	functionCallOutputIsError,
	isCodexPlanTool,
} from "./heuristics";

/**
 * Table-driven fixtures for the Codex-specific reducers. These pin how real
 * Codex tool names and outputs (verified against on-disk rollouts) map to
 * categories, commands, and pass/fail.
 */

describe("categorizeCodexTool", () => {
	const fixtures: Record<string, { name: string; expected: string }> = {
		execCommandIsExecute: { name: "exec_command", expected: "execute" },
		legacyShellIsExecute: { name: "shell", expected: "execute" },
		writeStdinIsExecute: { name: "write_stdin", expected: "execute" },
		applyPatchIsFileEdit: { name: "apply_patch", expected: "file_edit" },
		readFileIsFileRead: { name: "read_file", expected: "file_read" },
		webSearchIsSearch: { name: "web_search", expected: "search" },
		// update_plan is a plan artifact, categorized other (handled separately).
		updatePlanIsOther: { name: "update_plan", expected: "other" },
		unknownMcpToolIsOther: {
			name: "mcp__figma_console__figma_get_status",
			expected: "other",
		},
	};

	test.each(Object.entries(fixtures))("%s", (_name, { name, expected }) => {
		expect(categorizeCodexTool(name)).toBe(expected);
	});
});

describe("isCodexPlanTool", () => {
	test("update_plan is the plan tool", () => {
		expect(isCodexPlanTool("update_plan")).toBe(true);
	});
	test("exec_command is not", () => {
		expect(isCodexPlanTool("exec_command")).toBe(false);
	});
});

describe("extractShellCommand", () => {
	test("reads exec_command's cmd string", () => {
		expect(
			extractShellCommand('{"cmd":"pytest -q","workdir":"/tmp/repo"}'),
		).toBe("pytest -q");
	});

	test("joins a legacy command array into one string", () => {
		expect(
			extractShellCommand('{"command":["bash","-lc","go test ./..."]}'),
		).toBe("bash -lc go test ./...");
	});

	test("returns null when there is no command field", () => {
		expect(extractShellCommand('{"session_id":42,"chars":""}')).toBeNull();
	});

	test("returns null for malformed JSON", () => {
		expect(extractShellCommand("not json")).toBeNull();
	});

	test("feeds detectTestRun: a pytest exec command is detectable", () => {
		const command = extractShellCommand(
			'{"cmd":"pytest tests/","workdir":"/x"}',
		);
		expect(command).toContain("pytest");
	});
});

describe("functionCallOutputIsError", () => {
	test("exec text with non-zero exit code is an error", () => {
		expect(
			functionCallOutputIsError(
				"Chunk ID: 58153f\nProcess exited with code 1\nOutput:\n…",
			),
		).toBe(true);
	});

	test("exec text with exit code 0 is not an error", () => {
		expect(
			functionCallOutputIsError("Process exited with code 0\nOutput:\nok"),
		).toBe(false);
	});

	test("apply_patch JSON metadata exit_code drives the result", () => {
		expect(
			functionCallOutputIsError(
				'{"output":"Success","metadata":{"exit_code":0}}',
			),
		).toBe(false);
		expect(
			functionCallOutputIsError(
				'{"output":"failed","metadata":{"exit_code":2}}',
			),
		).toBe(true);
	});

	test("an explicit error field is an error", () => {
		expect(functionCallOutputIsError({ error: "boom" })).toBe(true);
	});

	test("plain output with no exit signal is not an error", () => {
		expect(functionCallOutputIsError("just some text")).toBe(false);
	});
});
