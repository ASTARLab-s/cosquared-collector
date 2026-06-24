import type { SessionEvent } from "@cosquared/schema";
import { describe, expect, test } from "vitest";
import { segmentSessions } from "./sessions";

function promptEvent(
	sessionId: string,
	timestamp: string,
	source: SessionEvent["source"] = "claude-code",
): SessionEvent {
	return {
		sessionId,
		source,
		timestamp,
		type: "user_prompt",
		wordCount: 5,
		isQuestion: false,
		referencesPlanArtifact: false,
	};
}

function commitEvent(timestamp: string): SessionEvent {
	return {
		sessionId: null,
		source: "git",
		timestamp,
		type: "commit",
		filesChanged: 1,
		insertions: 5,
		deletions: 0,
		touchedTestFiles: false,
	};
}

describe("segmentSessions", () => {
	test("segments an interleaved two-session stream by sessionId", () => {
		const segmented = segmentSessions([
			promptEvent("sess-b", "2026-06-10T11:00:00.000Z"),
			promptEvent("sess-a", "2026-06-10T10:00:00.000Z"),
			promptEvent("sess-b", "2026-06-10T11:05:00.000Z"),
			promptEvent("sess-a", "2026-06-10T10:05:00.000Z", "cursor"),
		]);
		expect(segmented.sessions.map((session) => session.sessionId)).toEqual([
			"sess-a",
			"sess-b",
		]);
		// Mixed sources within one session stay together (cross-tool streams).
		expect(
			segmented.sessions[0].events.map((event) => event.timestamp),
		).toEqual(["2026-06-10T10:00:00.000Z", "2026-06-10T10:05:00.000Z"]);
	});

	test("separates repo-scope events and sorts them by timestamp", () => {
		const segmented = segmentSessions([
			commitEvent("2026-06-11T09:00:00.000Z"),
			promptEvent("sess-a", "2026-06-10T10:00:00.000Z"),
			commitEvent("2026-06-09T09:00:00.000Z"),
		]);
		expect(segmented.repoEvents.map((event) => event.timestamp)).toEqual([
			"2026-06-09T09:00:00.000Z",
			"2026-06-11T09:00:00.000Z",
		]);
		expect(segmented.sessions).toHaveLength(1);
	});

	test("referenceTime is the max timestamp across all events", () => {
		const segmented = segmentSessions([
			promptEvent("sess-a", "2026-06-10T10:00:00.000Z"),
			commitEvent("2026-06-12T09:00:00.000Z"),
			promptEvent("sess-a", "2026-06-11T10:00:00.000Z"),
		]);
		expect(segmented.referenceTime).toBe("2026-06-12T09:00:00.000Z");
	});

	test("empty input yields empty segments and a null reference time", () => {
		expect(segmentSessions([])).toEqual({
			sessions: [],
			repoEvents: [],
			referenceTime: null,
		});
	});
});
