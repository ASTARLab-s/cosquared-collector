import { describe, expect, test } from "vitest";
import { mapRolloutToEvents } from "./event-mapping";
import { type RolloutLine, RolloutLineSchema } from "./rollout-line";

/**
 * The pure Codex mapper as a readable spec: hand-built rollout lines in, the
 * exact normalized event stream out. Each test pins one mapping rule.
 */

function line(
	timestamp: string,
	type: string,
	payload: Record<string, unknown>,
): RolloutLine {
	return RolloutLineSchema.parse({ timestamp, type, payload });
}

const FALLBACK = "fallback-uuid";

describe("mapRolloutToEvents", () => {
	test("maps a full session: prompt, test_run, change_accepted, plan, resolved error", () => {
		const lines = [
			line("2026-06-10T10:00:00.000Z", "session_meta", {
				id: "codex-session-1",
				cwd: "/tmp/x",
				cli_version: "0.142.0",
			}),
			line("2026-06-10T10:00:05.000Z", "event_msg", {
				type: "user_message",
				message: "work from plans/feature.md and explain why it fails?",
			}),
			line("2026-06-10T10:01:00.000Z", "response_item", {
				type: "function_call",
				name: "exec_command",
				arguments: '{"cmd":"pytest -q","workdir":"/tmp/x"}',
				call_id: "call_1",
			}),
			line("2026-06-10T10:01:05.000Z", "response_item", {
				type: "function_call_output",
				call_id: "call_1",
				output: "Process exited with code 0\nOutput:\nok",
			}),
			line("2026-06-10T10:02:00.000Z", "response_item", {
				type: "custom_tool_call",
				name: "apply_patch",
				input: "*** Begin Patch\n…",
				call_id: "call_2",
				status: "completed",
			}),
			line("2026-06-10T10:02:05.000Z", "response_item", {
				type: "custom_tool_call_output",
				call_id: "call_2",
				output: '{"output":"Success","metadata":{"exit_code":0}}',
			}),
			line("2026-06-10T10:03:00.000Z", "response_item", {
				type: "function_call",
				name: "update_plan",
				arguments: '{"plan":[{"step":"do it"}]}',
				call_id: "call_3",
			}),
			line("2026-06-10T10:04:00.000Z", "response_item", {
				type: "function_call",
				name: "exec_command",
				arguments: '{"cmd":"npm run build"}',
				call_id: "call_4",
			}),
			line("2026-06-10T10:04:05.000Z", "response_item", {
				type: "function_call_output",
				call_id: "call_4",
				output: "Process exited with code 1",
			}),
			line("2026-06-10T10:05:00.000Z", "response_item", {
				type: "function_call",
				name: "exec_command",
				arguments: '{"cmd":"npm run build"}',
				call_id: "call_5",
			}),
			line("2026-06-10T10:05:05.000Z", "response_item", {
				type: "function_call_output",
				call_id: "call_5",
				output: "Process exited with code 0",
			}),
		];

		expect(mapRolloutToEvents(lines, FALLBACK)).toEqual([
			{
				sessionId: "codex-session-1",
				source: "codex-cli",
				timestamp: "2026-06-10T10:00:00.000Z",
				type: "session_start",
				toolVersion: "0.142.0",
			},
			{
				sessionId: "codex-session-1",
				source: "codex-cli",
				timestamp: "2026-06-10T10:00:05.000Z",
				type: "user_prompt",
				wordCount: 8,
				isQuestion: true,
				referencesPlanArtifact: true,
				describesOrderedSteps: false,
			},
			{
				sessionId: "codex-session-1",
				source: "codex-cli",
				timestamp: "2026-06-10T10:00:05.000Z",
				type: "explanation_request",
			},
			{
				sessionId: "codex-session-1",
				source: "codex-cli",
				timestamp: "2026-06-10T10:01:00.000Z",
				type: "tool_call",
				toolName: "exec_command",
				category: "execute",
			},
			{
				sessionId: "codex-session-1",
				source: "codex-cli",
				timestamp: "2026-06-10T10:01:00.000Z",
				type: "test_run",
				framework: "pytest",
				passed: true,
			},
			{
				sessionId: "codex-session-1",
				source: "codex-cli",
				timestamp: "2026-06-10T10:02:00.000Z",
				type: "tool_call",
				toolName: "apply_patch",
				category: "file_edit",
			},
			{
				sessionId: "codex-session-1",
				source: "codex-cli",
				timestamp: "2026-06-10T10:02:05.000Z",
				type: "change_accepted",
				followedByValidation: true,
			},
			{
				sessionId: "codex-session-1",
				source: "codex-cli",
				timestamp: "2026-06-10T10:03:00.000Z",
				type: "tool_call",
				toolName: "update_plan",
				category: "other",
			},
			{
				sessionId: "codex-session-1",
				source: "codex-cli",
				timestamp: "2026-06-10T10:03:00.000Z",
				type: "plan_artifact_created",
				artifactKind: "plan_doc",
			},
			{
				sessionId: "codex-session-1",
				source: "codex-cli",
				timestamp: "2026-06-10T10:04:00.000Z",
				type: "tool_call",
				toolName: "exec_command",
				category: "execute",
			},
			{
				sessionId: "codex-session-1",
				source: "codex-cli",
				timestamp: "2026-06-10T10:04:05.000Z",
				type: "error_encountered",
				resolved: true,
			},
			{
				sessionId: "codex-session-1",
				source: "codex-cli",
				timestamp: "2026-06-10T10:05:00.000Z",
				type: "tool_call",
				toolName: "exec_command",
				category: "execute",
			},
			{
				sessionId: "codex-session-1",
				source: "codex-cli",
				timestamp: "2026-06-10T10:05:05.000Z",
				type: "session_end",
				durationMinutes: 5,
			},
		]);
	});

	test("prefers event_msg prompts and ignores the duplicate/injected response_item copies", () => {
		const lines = [
			line("2026-06-10T10:00:00.000Z", "session_meta", { id: "s2", cwd: "/x" }),
			// Injected harness context — must never be a user_prompt.
			line("2026-06-10T10:00:01.000Z", "response_item", {
				type: "message",
				role: "user",
				content: [{ type: "input_text", text: "<environment_context>…" }],
			}),
			// The same prompt appears twice (response_item + event_msg); only the
			// event_msg copy is counted.
			line("2026-06-10T10:00:02.000Z", "response_item", {
				type: "message",
				role: "user",
				content: [{ type: "input_text", text: "add a login form" }],
			}),
			line("2026-06-10T10:00:03.000Z", "event_msg", {
				type: "user_message",
				message: "add a login form",
			}),
		];
		const prompts = mapRolloutToEvents(lines, FALLBACK).filter(
			(event) => event.type === "user_prompt",
		);
		expect(prompts).toHaveLength(1);
		expect(prompts[0]).toMatchObject({ wordCount: 4, isQuestion: false });
	});

	test("falls back to response_item user messages when there is no event_msg", () => {
		const lines = [
			line("2026-06-10T10:00:00.000Z", "session_meta", { id: "s3", cwd: "/x" }),
			line("2026-06-10T10:00:01.000Z", "response_item", {
				type: "message",
				role: "user",
				content: [{ type: "input_text", text: "<user_instructions>skip me" }],
			}),
			line("2026-06-10T10:00:02.000Z", "response_item", {
				type: "message",
				role: "user",
				content: [{ type: "input_text", text: "refactor the parser please" }],
			}),
			line("2026-06-10T10:00:03.000Z", "response_item", {
				type: "message",
				role: "assistant",
				content: [{ type: "output_text", text: "sure, on it" }],
			}),
		];
		const prompts = mapRolloutToEvents(lines, FALLBACK).filter(
			(event) => event.type === "user_prompt",
		);
		expect(prompts).toHaveLength(1);
		expect(prompts[0]).toMatchObject({ wordCount: 4 });
	});

	test("drops Codex approval-review scaffolding that no human typed", () => {
		// Both harness variants found on disk (calibration 2026-08-27). Each is
		// deliberately written to LOOK like engaged prompting — a question mark
		// and an explanation-seeking phrase — so a miss here would silently
		// inflate Cognitive Engagement and the uploaded prompt_count.
		const lines = [
			line("2026-06-10T10:00:00.000Z", "session_meta", { id: "s6", cwd: "/x" }),
			line("2026-06-10T10:00:01.000Z", "response_item", {
				type: "message",
				role: "user",
				content: [
					{
						type: "input_text",
						text: "The following is the Codex agent history whose request action you are assessing. Explain why the planned action is safe. Should it proceed?",
					},
				],
			}),
			line("2026-06-10T10:00:02.000Z", "response_item", {
				type: "message",
				role: "user",
				content: [
					{
						type: "input_text",
						text: "The following is the Codex agent history added since your last approval assessment. What does the delta show?",
					},
				],
			}),
			line("2026-06-10T10:00:03.000Z", "response_item", {
				type: "message",
				role: "user",
				content: [{ type: "input_text", text: "now add rate limiting" }],
			}),
		];
		const events = mapRolloutToEvents(lines, FALLBACK);
		const prompts = events.filter((event) => event.type === "user_prompt");
		expect(prompts).toHaveLength(1);
		expect(prompts[0]).toMatchObject({ wordCount: 4, isQuestion: false });
		// The scaffolding's explanatory phrasing must not reach the signal.
		expect(
			events.filter((event) => event.type === "explanation_request"),
		).toHaveLength(0);
	});

	test("categorizes shell tool calls by the command they run, and MCP tools as delegation", () => {
		const lines = [
			line("2026-06-10T10:00:00.000Z", "session_meta", { id: "s5", cwd: "/x" }),
			line("2026-06-10T10:00:01.000Z", "response_item", {
				type: "function_call",
				name: "exec_command",
				arguments: '{"cmd":"rg -n \'weightedMean\' src/"}',
				call_id: "c1",
			}),
			line("2026-06-10T10:00:02.000Z", "response_item", {
				type: "function_call",
				name: "exec_command",
				arguments: '{"cmd":"sed -n \'1,80p\' src/index.ts"}',
				call_id: "c2",
			}),
			line("2026-06-10T10:00:03.000Z", "response_item", {
				type: "function_call",
				name: "mcp__notion__search",
				arguments: "{}",
				call_id: "c3",
			}),
		];
		const categories = mapRolloutToEvents(lines, FALLBACK)
			.filter((event) => event.type === "tool_call")
			.map((event) =>
				event.type === "tool_call"
					? { toolName: event.toolName, category: event.category }
					: null,
			);
		expect(categories).toEqual([
			{ toolName: "exec_command", category: "search" },
			{ toolName: "exec_command", category: "file_read" },
			{ toolName: "mcp__notion__search", category: "delegate" },
		]);
	});

	test("a read-only command after an edit is not validation; only execution is", () => {
		const editThenRead = [
			line("2026-06-10T10:00:00.000Z", "session_meta", { id: "s6", cwd: "/x" }),
			line("2026-06-10T10:01:00.000Z", "response_item", {
				type: "custom_tool_call",
				name: "apply_patch",
				input: "*** Begin Patch\n…",
				call_id: "e1",
				status: "completed",
			}),
			line("2026-06-10T10:01:05.000Z", "response_item", {
				type: "custom_tool_call_output",
				call_id: "e1",
				output: '{"output":"Success","metadata":{"exit_code":0}}',
			}),
			// Reading the diff back is inspection, not verification-by-running.
			line("2026-06-10T10:02:00.000Z", "response_item", {
				type: "function_call",
				name: "exec_command",
				arguments: '{"cmd":"git diff"}',
				call_id: "r1",
			}),
		];
		const accepted = mapRolloutToEvents(editThenRead, FALLBACK).find(
			(event) => event.type === "change_accepted",
		);
		expect(accepted).toMatchObject({ followedByValidation: false });
	});

	test("uses the filename UUID fallback when session_meta has no id", () => {
		const lines = [
			line("2026-06-10T10:00:00.000Z", "turn_context", { cwd: "/x" }),
			line("2026-06-10T10:00:05.000Z", "event_msg", {
				type: "user_message",
				message: "hello",
			}),
		];
		const events = mapRolloutToEvents(lines, "uuid-from-filename");
		expect(events[0].sessionId).toBe("uuid-from-filename");
	});

	test("empty input maps to an empty stream", () => {
		expect(mapRolloutToEvents([], FALLBACK)).toEqual([]);
	});
});
