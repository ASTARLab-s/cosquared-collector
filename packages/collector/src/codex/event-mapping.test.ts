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
