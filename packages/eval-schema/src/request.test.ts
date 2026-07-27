import { describe, expect, test } from "vitest";
import { EvaluationRequestSchema } from "./request";

const event = {
	id: "evt_1",
	type: "ai.explanation_requested",
	occurred_at: "2026-07-10T14:00:00.000Z",
	subject: "sub_1",
	session_id: "session_1",
	source: "claude-code",
	provenance: "client_observed",
};

const request = {
	subject: "sub_1",
	external_session_id: "mission_42",
	window: {
		start: "2026-07-10T13:00:00.000Z",
		end: "2026-07-10T16:00:00.000Z",
	},
	profiles: ["ai_collaboration_v1"],
	events: [event],
};

describe("EvaluationRequestSchema", () => {
	test("accepts a strict bounded evaluation request", () => {
		expect(EvaluationRequestSchema.safeParse(request).success).toBe(true);
	});

	test("rejects an inverted advisory window", () => {
		expect(
			EvaluationRequestSchema.safeParse({
				...request,
				window: { start: request.window.end, end: request.window.start },
			}).success,
		).toBe(false);
	});

	test("rejects an empty event batch", () => {
		expect(
			EvaluationRequestSchema.safeParse({ ...request, events: [] }).success,
		).toBe(false);
	});

	test("rejects more than 5000 events", () => {
		expect(
			EvaluationRequestSchema.safeParse({
				...request,
				events: Array.from({ length: 5001 }, (_, index) => ({
					...event,
					id: `evt_${index}`,
				})),
			}).success,
		).toBe(false);
	});

	test("rejects unknown request fields", () => {
		expect(
			EvaluationRequestSchema.safeParse({ ...request, scores: [100] }).success,
		).toBe(false);
	});
});
