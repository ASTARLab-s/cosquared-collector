import { SessionEventSchema } from "@cosquared/schema";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import { mapTranscriptToEvents } from "./event-mapping";
import {
	AssistantLineSchema,
	type TranscriptLine,
	UserLineSchema,
} from "./transcript-line";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";

/** Builders keep fixtures readable; timestamps are explicit per line. */
function userPromptLine(
	text: string,
	timestamp: string,
	extra: Record<string, unknown> = {},
) {
	return UserLineSchema.parse({
		type: "user",
		sessionId: SESSION_ID,
		timestamp,
		message: { content: text },
		...extra,
	});
}

function toolUseLine(
	name: string,
	input: Record<string, unknown>,
	id: string,
	timestamp: string,
	extra: Record<string, unknown> = {},
) {
	return AssistantLineSchema.parse({
		type: "assistant",
		sessionId: SESSION_ID,
		timestamp,
		message: { content: [{ type: "tool_use", id, name, input }] },
		...extra,
	});
}

function toolResultLine(
	toolUseId: string,
	timestamp: string,
	options: { isError?: boolean; text?: string } = {},
	extra: Record<string, unknown> = {},
) {
	return UserLineSchema.parse({
		type: "user",
		sessionId: SESSION_ID,
		timestamp,
		message: {
			content: [
				{
					type: "tool_result",
					tool_use_id: toolUseId,
					is_error: options.isError,
					content: options.text ?? "ok",
				},
			],
		},
		...extra,
	});
}

function eventsOfType(lines: TranscriptLine[], type: string) {
	return mapTranscriptToEvents(lines).filter((event) => event.type === type);
}

describe("mapTranscriptToEvents", () => {
	test("maps an empty transcript to an empty stream", () => {
		expect(mapTranscriptToEvents([])).toEqual([]);
	});

	test("emits session_start and session_end bracketing the transcript", () => {
		const lines = [
			userPromptLine("start here", "2026-06-10T10:00:00.000Z", {
				version: "2.1.170",
			}),
			userPromptLine("still going", "2026-06-10T10:07:30.000Z"),
		];
		const events = mapTranscriptToEvents(lines);
		expect(events[0]).toEqual({
			sessionId: SESSION_ID,
			source: "claude-code",
			timestamp: "2026-06-10T10:00:00.000Z",
			type: "session_start",
			toolVersion: "2.1.170",
		});
		expect(events[events.length - 1]).toEqual({
			sessionId: SESSION_ID,
			source: "claude-code",
			timestamp: "2026-06-10T10:07:30.000Z",
			type: "session_end",
			durationMinutes: 8,
		});
	});

	test("single-line session has duration 0 and a null toolVersion when absent", () => {
		const events = mapTranscriptToEvents([
			userPromptLine("one and done", "2026-06-10T10:00:00.000Z"),
		]);
		expect(events[0]).toMatchObject({
			type: "session_start",
			toolVersion: null,
		});
		expect(events[events.length - 1]).toMatchObject({
			type: "session_end",
			durationMinutes: 0,
		});
	});

	test("reduces a typed prompt to word count and flags, never text", () => {
		const promptSentence =
			"Can you review the plan in .agents/plans/feature.md before we start?";
		const events = mapTranscriptToEvents([
			userPromptLine(promptSentence, "2026-06-10T10:00:00.000Z"),
		]);
		expect(eventsFiltered(events, "user_prompt")).toEqual([
			{
				sessionId: SESSION_ID,
				source: "claude-code",
				timestamp: "2026-06-10T10:00:00.000Z",
				type: "user_prompt",
				wordCount: 10,
				isQuestion: true,
				referencesPlanArtifact: true,
				describesOrderedSteps: false,
			},
		]);
		// Privacy guard: no fragment of the prompt survives serialization.
		expect(JSON.stringify(events)).not.toContain("review the plan");
	});

	test("emits explanation_request alongside the prompt that asks for one", () => {
		const lines = [
			userPromptLine(
				"why does the parser drop sidechain lines?",
				"2026-06-10T10:00:00.000Z",
			),
		];
		expect(eventsOfType(lines, "explanation_request")).toHaveLength(1);
	});

	test("a whitespace-only prompt yields wordCount 0, no crash", () => {
		const lines = [userPromptLine("   \n ", "2026-06-10T10:00:00.000Z")];
		expect(eventsOfType(lines, "user_prompt")).toEqual([
			expect.objectContaining({ wordCount: 0, isQuestion: false }),
		]);
	});

	test("skips slash-command machinery and meta lines", () => {
		const lines = [
			userPromptLine(
				"<command-message>execute</command-message>",
				"2026-06-10T10:00:00.000Z",
			),
			userPromptLine("Caveat: injected context", "2026-06-10T10:00:05.000Z", {
				isMeta: true,
			}),
		];
		expect(eventsOfType(lines, "user_prompt")).toEqual([]);
	});

	test("emits command_invoked but no user_prompt for a slash-command line", () => {
		const lines = [
			userPromptLine(
				"<command-message>plan-feature</command-message>\n<command-name>/plan-feature</command-name>",
				"2026-06-10T10:00:00.000Z",
			),
		];
		expect(eventsOfType(lines, "command_invoked")).toEqual([
			{
				sessionId: SESSION_ID,
				source: "claude-code",
				timestamp: "2026-06-10T10:00:00.000Z",
				type: "command_invoked",
				// /plan-feature classifies as a plan command (feeds Task Framing).
				category: "plan",
			},
		]);
		expect(eventsOfType(lines, "user_prompt")).toEqual([]);
		// Privacy guard: the command name never survives into the stream.
		expect(JSON.stringify(mapTranscriptToEvents(lines))).not.toContain(
			"plan-feature",
		);
	});

	test("categorizes Skill and Task tool calls as delegate", () => {
		const lines = [
			toolUseLine(
				"Skill",
				{ skill: "commit" },
				"toolu_01",
				"2026-06-10T10:00:00.000Z",
			),
			toolUseLine(
				"Task",
				{ prompt: "explore the repo" },
				"toolu_02",
				"2026-06-10T10:01:00.000Z",
			),
		];
		expect(eventsOfType(lines, "tool_call")).toEqual([
			expect.objectContaining({ toolName: "Skill", category: "delegate" }),
			expect.objectContaining({ toolName: "Task", category: "delegate" }),
		]);
	});

	test("pairs a Bash test command with its result to set passed", () => {
		const lines = [
			toolUseLine(
				"Bash",
				{ command: "pnpm test" },
				"toolu_01",
				"2026-06-10T10:00:00.000Z",
			),
			toolResultLine("toolu_01", "2026-06-10T10:01:00.000Z", {
				text: "Tests passed",
			}),
			toolUseLine(
				"Bash",
				{ command: "pnpm vitest run" },
				"toolu_02",
				"2026-06-10T10:02:00.000Z",
			),
			toolResultLine("toolu_02", "2026-06-10T10:03:00.000Z", {
				isError: true,
				text: "2 tests failed",
			}),
		];
		expect(eventsOfType(lines, "test_run")).toEqual([
			expect.objectContaining({ framework: "npm-script", passed: true }),
			expect.objectContaining({ framework: "vitest", passed: false }),
		]);
	});

	test("an unpaired test command (session ended mid-call) has passed null", () => {
		const lines = [
			toolUseLine(
				"Bash",
				{ command: "pnpm test" },
				"toolu_01",
				"2026-06-10T10:00:00.000Z",
			),
		];
		expect(eventsOfType(lines, "test_run")).toEqual([
			expect.objectContaining({ passed: null }),
		]);
	});

	test("marks accepted edit followedByValidation true when a test run follows", () => {
		const lines = [
			toolUseLine(
				"Edit",
				{ file_path: "src/a.ts" },
				"toolu_01",
				"2026-06-10T10:00:00.000Z",
			),
			toolResultLine("toolu_01", "2026-06-10T10:00:05.000Z"),
			toolUseLine(
				"Bash",
				{ command: "pnpm test" },
				"toolu_02",
				"2026-06-10T10:01:00.000Z",
			),
			toolResultLine("toolu_02", "2026-06-10T10:02:00.000Z"),
		];
		expect(eventsOfType(lines, "change_accepted")).toEqual([
			expect.objectContaining({ followedByValidation: true }),
		]);
	});

	test("followedByValidation is false when later tool activity never executes anything", () => {
		const lines = [
			toolUseLine(
				"Edit",
				{ file_path: "src/a.ts" },
				"toolu_01",
				"2026-06-10T10:00:00.000Z",
			),
			toolResultLine("toolu_01", "2026-06-10T10:00:05.000Z"),
			toolUseLine(
				"Read",
				{ file_path: "src/b.ts" },
				"toolu_02",
				"2026-06-10T10:01:00.000Z",
			),
			toolResultLine("toolu_02", "2026-06-10T10:01:05.000Z"),
		];
		expect(eventsOfType(lines, "change_accepted")).toEqual([
			expect.objectContaining({ followedByValidation: false }),
		]);
	});

	test("a change is validated only before the next instruction, not by a later one", () => {
		// Instruction 1: edit, no verification, user moves on → false.
		// Instruction 2: edit, then a test before the session ends → true.
		// The OLD rule ("any later execute anywhere") validated BOTH; the
		// instruction-adjacent rule does not let instruction 2's test reach
		// back and validate instruction 1's change.
		const lines = [
			userPromptLine("first, edit the parser", "2026-06-10T10:00:00.000Z"),
			toolUseLine(
				"Edit",
				{ file_path: "src/a.ts" },
				"toolu_01",
				"2026-06-10T10:00:30.000Z",
			),
			toolResultLine("toolu_01", "2026-06-10T10:00:35.000Z"),
			userPromptLine("now edit the formatter", "2026-06-10T10:01:00.000Z"),
			toolUseLine(
				"Edit",
				{ file_path: "src/b.ts" },
				"toolu_02",
				"2026-06-10T10:01:30.000Z",
			),
			toolResultLine("toolu_02", "2026-06-10T10:01:35.000Z"),
			toolUseLine(
				"Bash",
				{ command: "pnpm test" },
				"toolu_03",
				"2026-06-10T10:02:00.000Z",
			),
			toolResultLine("toolu_03", "2026-06-10T10:02:30.000Z"),
		];
		expect(eventsOfType(lines, "change_accepted")).toEqual([
			expect.objectContaining({ followedByValidation: false }),
			expect.objectContaining({ followedByValidation: true }),
		]);
	});

	test("batch-then-verify under one instruction validates the whole batch", () => {
		// Two edits then a test, all under one instruction: both are verified
		// before the next turn — batching is not penalized.
		const lines = [
			userPromptLine("edit both files and test", "2026-06-10T10:00:00.000Z"),
			toolUseLine(
				"Edit",
				{ file_path: "src/a.ts" },
				"toolu_01",
				"2026-06-10T10:00:30.000Z",
			),
			toolResultLine("toolu_01", "2026-06-10T10:00:35.000Z"),
			toolUseLine(
				"Edit",
				{ file_path: "src/b.ts" },
				"toolu_02",
				"2026-06-10T10:01:00.000Z",
			),
			toolResultLine("toolu_02", "2026-06-10T10:01:05.000Z"),
			toolUseLine(
				"Bash",
				{ command: "pnpm test" },
				"toolu_03",
				"2026-06-10T10:02:00.000Z",
			),
			toolResultLine("toolu_03", "2026-06-10T10:02:30.000Z"),
		];
		expect(eventsOfType(lines, "change_accepted")).toEqual([
			expect.objectContaining({ followedByValidation: true }),
			expect.objectContaining({ followedByValidation: true }),
		]);
	});

	test("followedByValidation is null when the accept is the final tool activity", () => {
		const lines = [
			toolUseLine(
				"Edit",
				{ file_path: "src/a.ts" },
				"toolu_01",
				"2026-06-10T10:00:00.000Z",
			),
			toolResultLine("toolu_01", "2026-06-10T10:00:05.000Z"),
		];
		expect(eventsOfType(lines, "change_accepted")).toEqual([
			expect.objectContaining({ followedByValidation: null }),
		]);
	});

	test("an edit with no paired result emits no change event", () => {
		const lines = [
			toolUseLine(
				"Edit",
				{ file_path: "src/a.ts" },
				"toolu_01",
				"2026-06-10T10:00:00.000Z",
			),
		];
		expect(eventsOfType(lines, "change_accepted")).toEqual([]);
		expect(eventsOfType(lines, "change_rejected")).toEqual([]);
	});

	test("emits change_rejected not error_encountered for a user rejection", () => {
		const lines = [
			toolUseLine(
				"Edit",
				{ file_path: "src/a.ts" },
				"toolu_01",
				"2026-06-10T10:00:00.000Z",
			),
			toolResultLine("toolu_01", "2026-06-10T10:00:05.000Z", {
				isError: true,
				text: "The user doesn't want to proceed with this tool use.",
			}),
		];
		expect(eventsOfType(lines, "change_rejected")).toHaveLength(1);
		expect(eventsOfType(lines, "error_encountered")).toEqual([]);
		expect(eventsOfType(lines, "change_accepted")).toEqual([]);
	});

	test("a genuine error result emits error_encountered with a resolution arc", () => {
		const lines = [
			toolUseLine(
				"Bash",
				{ command: "pnpm typecheck" },
				"toolu_01",
				"2026-06-10T10:00:00.000Z",
			),
			toolResultLine("toolu_01", "2026-06-10T10:00:30.000Z", {
				isError: true,
				text: "error TS2345: type mismatch",
			}),
			toolUseLine(
				"Bash",
				{ command: "pnpm typecheck" },
				"toolu_02",
				"2026-06-10T10:01:00.000Z",
			),
			toolResultLine("toolu_02", "2026-06-10T10:01:30.000Z"),
		];
		expect(eventsOfType(lines, "error_encountered")).toEqual([
			expect.objectContaining({ resolved: true }),
		]);
	});

	test("an error with no later non-error result stays unresolved", () => {
		const lines = [
			toolUseLine(
				"Bash",
				{ command: "pnpm typecheck" },
				"toolu_01",
				"2026-06-10T10:00:00.000Z",
			),
			toolResultLine("toolu_01", "2026-06-10T10:00:30.000Z", {
				isError: true,
				text: "error TS2345: type mismatch",
			}),
		];
		expect(eventsOfType(lines, "error_encountered")).toEqual([
			expect.objectContaining({ resolved: false }),
		]);
	});

	test("emits plan_artifact_created for ExitPlanMode and plan-file writes", () => {
		const lines = [
			toolUseLine(
				"ExitPlanMode",
				{ plan: "..." },
				"toolu_01",
				"2026-06-10T10:00:00.000Z",
			),
			toolUseLine(
				"Write",
				{ file_path: ".agents/plans/feature.md", content: "..." },
				"toolu_02",
				"2026-06-10T10:01:00.000Z",
			),
		];
		expect(eventsOfType(lines, "plan_artifact_created")).toEqual([
			expect.objectContaining({ artifactKind: "plan_doc" }),
			expect.objectContaining({ artifactKind: "plan_doc" }),
		]);
	});

	test("skips sidechain lines entirely", () => {
		const lines = [
			userPromptLine("main thread prompt", "2026-06-10T10:00:00.000Z"),
			userPromptLine("sidechain prompt", "2026-06-10T10:01:00.000Z", {
				isSidechain: true,
			}),
			toolUseLine(
				"Edit",
				{ file_path: "src/a.ts" },
				"toolu_01",
				"2026-06-10T10:02:00.000Z",
				{ isSidechain: true },
			),
			toolResultLine(
				"toolu_01",
				"2026-06-10T10:02:05.000Z",
				{ isError: true, text: "exploded" },
				{ isSidechain: true },
			),
		];
		const events = mapTranscriptToEvents(lines);
		expect(events.filter((event) => event.type === "user_prompt")).toHaveLength(
			1,
		);
		expect(events.filter((event) => event.type === "tool_call")).toEqual([]);
		expect(
			events.filter((event) => event.type === "error_encountered"),
		).toEqual([]);
	});

	test("every emitted event passes the strict SessionEventSchema", () => {
		const lines = [
			userPromptLine(
				"why is the plan in .agents/plans/x.md failing?",
				"2026-06-10T10:00:00.000Z",
				{ version: "2.1.170" },
			),
			toolUseLine(
				"Edit",
				{ file_path: "src/a.ts" },
				"toolu_01",
				"2026-06-10T10:01:00.000Z",
			),
			toolResultLine("toolu_01", "2026-06-10T10:01:05.000Z"),
			toolUseLine(
				"Bash",
				{ command: "pnpm test" },
				"toolu_02",
				"2026-06-10T10:02:00.000Z",
			),
			toolResultLine("toolu_02", "2026-06-10T10:03:00.000Z", {
				isError: true,
				text: "1 test failed",
			}),
			toolUseLine(
				"Write",
				{ file_path: "TODO.md", content: "..." },
				"toolu_03",
				"2026-06-10T10:04:00.000Z",
			),
		];
		const events = mapTranscriptToEvents(lines);
		expect(events.length).toBeGreaterThan(0);
		expect(() => z.array(SessionEventSchema).parse(events)).not.toThrow();
	});
});

function eventsFiltered(
	events: ReturnType<typeof mapTranscriptToEvents>,
	type: string,
) {
	return events.filter((event) => event.type === type);
}
