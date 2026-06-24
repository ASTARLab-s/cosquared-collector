import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { SessionEvent } from "@cosquared/schema";
import { describe, expect, test } from "vitest";
import {
	changeAccepted,
	changeRejected,
	churnSnapshot,
	commandInvoked,
	commit,
	explanationRequest,
	planArtifact,
	prompt,
	repoSnapshot,
	sessionEnd,
	sessionStart,
	testRun,
	toolCall,
} from "./__fixtures__/builders";
import { scoreProfile } from "./score-profile";

/**
 * End-to-end golden-profile test. The expected JSON is the public
 * contract for how a full event stream scores — every value, weight,
 * evidence statistic, and ref. Updating it is a deliberate, reviewed act
 * (the same golden-file discipline as the collectors).
 *
 * The fixture tells a deliberate story: a developer who verifies and
 * tests well (careful_validator) but never frames tasks up front
 * (task_framing is the weakness and the recommended focus).
 */

/** Session 1 (June 10): verified, tested, leveraged — but unframed. */
const sessionOneEvents: SessionEvent[] = [
	sessionStart("s1", "2026-06-10T10:00:00.000Z"),
	prompt("s1", "2026-06-10T10:00:00.000Z", { wordCount: 5 }),
	toolCall("s1", "2026-06-10T10:02:00.000Z", "file_edit", "Edit"),
	// Created AFTER the first edit: does NOT count as task framing.
	planArtifact("s1", "2026-06-10T10:03:00.000Z"),
	toolCall("s1", "2026-06-10T10:04:00.000Z", "execute", "Bash"),
	toolCall("s1", "2026-06-10T10:05:00.000Z", "search", "Grep"),
	changeAccepted("s1", "2026-06-10T10:06:00.000Z", true),
	testRun("s1", "2026-06-10T10:07:00.000Z"),
	// A /prime-style context command: counts as Tool & Workflow Judgment
	// leverage, but deliberately does NOT frame the session (Task Framing
	// stays this profile's weakness — that distinction is the point here).
	commandInvoked("s1", "2026-06-10T10:08:00.000Z", "context"),
	explanationRequest("s1", "2026-06-10T10:09:00.000Z"),
	sessionEnd("s1", "2026-06-10T10:10:00.000Z", 10),
];

/** Session 2 (June 11): edit-and-accept with no tests or engagement. */
const sessionTwoEvents: SessionEvent[] = [
	prompt("s2", "2026-06-11T10:00:00.000Z", { wordCount: 5 }),
	toolCall("s2", "2026-06-11T10:01:00.000Z", "file_edit", "Edit"),
	changeAccepted("s2", "2026-06-11T10:02:00.000Z", true),
	changeRejected("s2", "2026-06-11T10:03:00.000Z", false),
];

const repoScopeEvents: SessionEvent[] = [
	// Inside session 1's window → completes its arc; touches tests.
	commit("2026-06-10T10:30:00.000Z", {
		touchedTestFiles: true,
		insertions: 10,
	}),
	// Before session 2 starts → completes nothing.
	commit("2026-06-11T09:00:00.000Z"),
	repoSnapshot("2026-06-11T12:00:00.000Z", {
		trackedFileCount: 100,
		testFileCount: 20,
		docFileCount: 5,
		contextFileCount: 1,
		automationFileCount: 1,
	}),
	churnSnapshot("2026-06-11T12:00:00.000Z", {
		linesAdded: 100,
		linesChurned: 10,
	}),
];

const goldenEvents: SessionEvent[] = [
	...sessionOneEvents,
	...sessionTwoEvents,
	...repoScopeEvents,
];

const goldenProfile = JSON.parse(
	readFileSync(
		fileURLToPath(
			new URL("./__fixtures__/golden-profile.expected.json", import.meta.url),
		),
		"utf8",
	),
);

describe("scoreProfile", () => {
	test("scores the golden stream into the checked-in expected profile", () => {
		// JSON round-trip normalizes the comparison to wire form — the same
		// representation `analyze --json` emits and uploads will use.
		expect(JSON.parse(JSON.stringify(scoreProfile(goldenEvents)))).toEqual(
			goldenProfile,
		);
	});

	test("scoring is deterministic: two runs deep-equal", () => {
		expect(scoreProfile(goldenEvents)).toEqual(scoreProfile(goldenEvents));
	});

	test("an empty stream yields an all-null profile, never fake numbers", () => {
		const profile = scoreProfile([]);
		expect(profile.builderType).toBeNull();
		expect(profile.aiCollaboration.value).toBeNull();
		expect(profile.aiCollaboration.confidence).toBe("none");
		expect(profile.testingDiscipline.value).toBeNull();
		expect(profile.shippingMomentum.value).toBeNull();
		expect(profile.strengths).toEqual([]);
		expect(profile.weaknesses).toEqual([]);
		expect(profile.recommendedFocus).toBeNull();
		expect(profile.window).toEqual({
			firstEventAt: null,
			lastEventAt: null,
			eventCount: 0,
			sessionCount: 0,
			commitCount: 0,
		});
	});

	test("window stats reflect the stream", () => {
		const profile = scoreProfile(goldenEvents);
		expect(profile.window).toEqual({
			firstEventAt: "2026-06-10T10:00:00.000Z",
			lastEventAt: "2026-06-11T12:00:00.000Z",
			eventCount: goldenEvents.length,
			sessionCount: 2,
			commitCount: 2,
		});
	});

	test("only leaf signals are ranked — AI Collaboration never appears", () => {
		const profile = scoreProfile(goldenEvents);
		const ranked = [
			...profile.strengths,
			...profile.weaknesses,
			...(profile.recommendedFocus ? [profile.recommendedFocus] : []),
		];
		expect(ranked).not.toContain("ai_collaboration");
	});
});
