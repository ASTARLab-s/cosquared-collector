import { describe, expect, test } from "vitest";
import {
	type RawBubble,
	RawBubbleSchema,
	type RawComposer,
	RawComposerSchema,
} from "./cursor-store";
import { mapCursorConversationToEvents } from "./event-mapping";

/**
 * The pure Cursor mapper as a readable spec: a hand-built composer + ordered
 * bubbles in, the exact normalized event stream out. Every in-session event is
 * stamped with the composer's `createdAt` (deterministic header ordering — see
 * event-mapping.ts).
 */

const CREATED_AT = Date.parse("2026-06-10T10:00:00.000Z");
const LAST_UPDATED_AT = CREATED_AT + 5 * 60_000;
const TS = "2026-06-10T10:00:00.000Z";
const END_TS = "2026-06-10T10:05:00.000Z";
const SESSION_ID = "composer-1";

function composer(): RawComposer {
	return RawComposerSchema.parse({
		composerId: SESSION_ID,
		createdAt: CREATED_AT,
		lastUpdatedAt: LAST_UPDATED_AT,
	});
}

function userBubble(text: string): RawBubble {
	return RawBubbleSchema.parse({ type: 1, text });
}

function toolBubble(toolFormerData: Record<string, unknown>): RawBubble {
	return RawBubbleSchema.parse({ type: 2, toolFormerData });
}

describe("mapCursorConversationToEvents", () => {
	test("maps a full conversation: prompt, tests, accept/reject, plan, resolved error", () => {
		const bubbles = [
			userBubble("work from plans/feature.md and explain why? CURSOR_PROMPT"),
			toolBubble({
				name: "run_terminal_cmd",
				params: '{"command":"pytest -q"}',
				result: '{"output":"ok"}',
				status: "completed",
			}),
			toolBubble({
				name: "edit_file_v2",
				status: "completed",
				userDecision: "accepted",
			}),
			toolBubble({
				name: "run_terminal_cmd",
				params: '{"command":"pnpm test"}',
				status: "completed",
			}),
			toolBubble({
				name: "search_replace",
				userDecision: "rejected",
				result: '{"rejected":true}',
			}),
			toolBubble({ name: "create_plan", status: "completed" }),
			toolBubble({
				name: "run_terminal_cmd",
				params: '{"command":"npm run build"}',
				status: "error",
			}),
			toolBubble({
				name: "edit_file_v2",
				status: "completed",
				userDecision: "accepted",
			}),
		];

		const event = (extra: Record<string, unknown>) => ({
			sessionId: SESSION_ID,
			source: "cursor",
			timestamp: TS,
			...extra,
		});

		expect(
			mapCursorConversationToEvents(SESSION_ID, composer(), bubbles),
		).toEqual([
			event({ type: "session_start", toolVersion: null }),
			event({
				type: "user_prompt",
				wordCount: 7,
				isQuestion: true,
				referencesPlanArtifact: true,
				describesOrderedSteps: false,
			}),
			event({ type: "explanation_request" }),
			event({
				type: "tool_call",
				toolName: "run_terminal_cmd",
				category: "execute",
			}),
			event({ type: "test_run", framework: "pytest", passed: true }),
			event({
				type: "tool_call",
				toolName: "edit_file_v2",
				category: "file_edit",
			}),
			event({ type: "change_accepted", followedByValidation: true }),
			event({
				type: "tool_call",
				toolName: "run_terminal_cmd",
				category: "execute",
			}),
			event({ type: "test_run", framework: "npm-script", passed: true }),
			event({
				type: "tool_call",
				toolName: "search_replace",
				category: "file_edit",
			}),
			event({ type: "change_rejected", followedByValidation: true }),
			event({ type: "tool_call", toolName: "create_plan", category: "other" }),
			event({ type: "plan_artifact_created", artifactKind: "plan_doc" }),
			event({
				type: "tool_call",
				toolName: "run_terminal_cmd",
				category: "execute",
			}),
			event({ type: "error_encountered", resolved: true }),
			event({
				type: "tool_call",
				toolName: "edit_file_v2",
				category: "file_edit",
			}),
			event({ type: "change_accepted", followedByValidation: null }),
			{
				sessionId: SESSION_ID,
				source: "cursor",
				timestamp: END_TS,
				type: "session_end",
				durationMinutes: 5,
			},
		]);
	});

	test("skips empty and injected user bubbles, and assistant prose", () => {
		const bubbles = [
			userBubble("<additional_data>injected context</additional_data>"),
			userBubble("   "),
			RawBubbleSchema.parse({ type: 2, text: "assistant prose, no tool" }),
			userBubble("real question here?"),
		];
		const prompts = mapCursorConversationToEvents(
			SESSION_ID,
			composer(),
			bubbles,
		).filter((e) => e.type === "user_prompt");
		expect(prompts).toHaveLength(1);
		expect(prompts[0]).toMatchObject({ isQuestion: true, wordCount: 3 });
	});

	test("returns empty when the composer has no createdAt timestamp", () => {
		const noTime = RawComposerSchema.parse({ composerId: SESSION_ID });
		expect(
			mapCursorConversationToEvents(SESSION_ID, noTime, [userBubble("hi")]),
		).toEqual([]);
	});
});
