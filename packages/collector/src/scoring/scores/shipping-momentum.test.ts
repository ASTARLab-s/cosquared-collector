import { describe, expect, test } from "vitest";
import {
	churnSnapshot,
	commit,
	prompt,
	toolCall,
} from "../__fixtures__/builders";
import { segmentSessions } from "../sessions";
import { shippingMomentum } from "./shipping-momentum";

/**
 * All fixtures use June 2026 timestamps. Determinism is the point: these
 * dates are "old" relative to any test run's wall clock, and the score
 * must come out identical forever because the engine's clock is the
 * stream's max timestamp, never `Date.now()`.
 */

const SESSION_START = "2026-06-10T10:00:00.000Z";
const SESSION_END = "2026-06-10T11:00:00.000Z";

function sessionEvents(sessionId = "s1") {
	return [
		prompt(sessionId, SESSION_START),
		toolCall(sessionId, SESSION_END, "file_edit"),
	];
}

function score(events: Parameters<typeof segmentSessions>[0]) {
	const { sessions, repoEvents, referenceTime } = segmentSessions(events);
	return shippingMomentum(sessions, repoEvents, referenceTime);
}

describe("scores: shippingMomentum", () => {
	test("cadence counts distinct UTC commit days against the reference time, not the wall clock", () => {
		// 7 distinct days in the 14 ending at the last event = 0.5 ≥ full-at.
		const commits = Array.from({ length: 7 }, (_unused, index) =>
			commit(`2026-06-${String(10 + index).padStart(2, "0")}T09:00:00.000Z`),
		);
		const result = score(commits);
		const cadence = result.components[0].signal;
		expect(cadence.value).toBe(100);
		expect(cadence.evidence[0]).toMatchObject({
			kind: "commit_cadence_days",
			numerator: 7,
			denominator: 14,
		});
	});

	test("scoring the same old stream twice is identical (no clock dependence)", () => {
		const events = [
			...sessionEvents(),
			commit("2026-06-10T10:30:00.000Z"),
			churnSnapshot("2026-06-10T10:30:00.000Z"),
		];
		expect(score(events)).toEqual(score(events));
	});

	test("commitDuringSessionWindowCompletes", () => {
		const result = score([
			...sessionEvents(),
			commit("2026-06-10T10:30:00.000Z"),
		]);
		expect(result.components[1].signal.evidence[0]).toMatchObject({
			kind: "sessions_ending_in_commit",
			numerator: 1,
			denominator: 1,
		});
	});

	test("commitWithinGraceAfterLastEventCompletes", () => {
		// 59 minutes after the session's last event — inside the 60min grace.
		const result = score([
			...sessionEvents(),
			commit("2026-06-10T11:59:00.000Z"),
		]);
		expect(result.components[1].signal.evidence[0].numerator).toBe(1);
	});

	test("commitBeyondGraceDoesNot", () => {
		// 61 minutes after the last event — outside the grace window.
		const result = score([
			...sessionEvents(),
			commit("2026-06-10T12:01:00.000Z"),
		]);
		expect(result.components[1].signal.evidence[0].numerator).toBe(0);
	});

	test("commitBeforeSessionStartDoesNot", () => {
		const result = score([
			...sessionEvents(),
			commit("2026-06-10T09:00:00.000Z"),
		]);
		expect(result.components[1].signal.evidence[0].numerator).toBe(0);
	});

	test("oneCommitCanCompleteTwoOverlappingSessions", () => {
		const result = score([
			...sessionEvents("s1"),
			...sessionEvents("s2"),
			commit("2026-06-10T10:30:00.000Z"),
		]);
		expect(result.components[1].signal.evidence[0]).toMatchObject({
			numerator: 2,
			denominator: 2,
		});
	});

	test("no git data yields null completion component, not zero", () => {
		// Sessions but zero commit events: absence of git data must not
		// read as abandonment — completion is null and its weight
		// redistributes (here: no components have data at all).
		const result = score(sessionEvents());
		expect(result.components[1].signal.value).toBeNull();
		expect(result.value).toBeNull();
		expect(result.confidence).toBe("none");
	});

	test("churnHealthReadsTheLatestChurnSnapshot", () => {
		// ratio 0.3 between zeroAt 0.1 and fullAt 0.5 → scale 50 → health 50.
		const result = score([
			churnSnapshot("2026-06-10T10:00:00.000Z", {
				linesAdded: 100,
				linesChurned: 30,
			}),
		]);
		const churnHealth = result.components[2].signal;
		// Component values are unrounded floats; only ScoreResult rounds.
		expect(churnHealth.value).toBeCloseTo(50, 10);
		expect(churnHealth.evidence[0]).toMatchObject({
			kind: "recent_churn_ratio",
			numerator: 30,
			denominator: 100,
		});
	});

	test("zeroLinesAddedGuardsChurnToNullNotNaN", () => {
		const result = score([
			churnSnapshot("2026-06-10T10:00:00.000Z", {
				linesAdded: 0,
				linesChurned: 0,
			}),
		]);
		expect(result.components[2].signal.value).toBeNull();
	});

	test("missingChurnSnapshotRenormalizesOntoCadenceAndCompletion", () => {
		// Commit inside the session window: cadence 1/14 days
		// (scale(1/14, 0, .5) ≈ 14.29) w 0.4; completion 1/1 (→100) w 0.3;
		// churn null → (14.29×0.4 + 100×0.3) / 0.7 ≈ 51.02 → 51.
		const result = score([
			...sessionEvents(),
			commit("2026-06-10T10:30:00.000Z"),
		]);
		expect(result.value).toBe(51);
	});

	test("fewSessionsAndCommitsPropagateLowConfidence", () => {
		const result = score([
			...sessionEvents(),
			commit("2026-06-10T10:30:00.000Z"),
		]);
		expect(result.confidence).toBe("low");
	});
});
