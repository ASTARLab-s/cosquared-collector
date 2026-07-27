import { describe, expect, test } from "vitest";
import type { EvaluationEvent } from "./event";
import { serializeEventsCanonical } from "./result";

const early: EvaluationEvent = {
	id: "evt_a",
	type: "ai.change_accepted",
	occurred_at: "2026-07-10T14:00:00.000Z",
	subject: "sub_1",
	session_id: "session_1",
	source: "claude-code",
	provenance: "client_observed",
	followed_by_validation: true,
};

const late: EvaluationEvent = {
	id: "evt_b",
	type: "validation.test_run",
	occurred_at: "2026-07-10T14:05:00.000Z",
	subject: "sub_1",
	session_id: "session_1",
	source: "external",
	provenance: "server_observed",
	passed: true,
	framework: "vitest",
};

describe("serializeEventsCanonical", () => {
	test("is stable under input reordering", () => {
		expect(serializeEventsCanonical([late, early])).toBe(
			serializeEventsCanonical([early, late]),
		);
	});

	test("uses a fixed envelope-first key order", () => {
		expect(serializeEventsCanonical([early])).toBe(
			'[{"id":"evt_a","type":"ai.change_accepted","occurred_at":"2026-07-10T14:00:00.000Z","subject":"sub_1","session_id":"session_1","source":"claude-code","provenance":"client_observed","followed_by_validation":true}]',
		);
	});
});
