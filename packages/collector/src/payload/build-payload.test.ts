import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { SessionEvent } from "@cosquared/schema";
import {
	type AnalysisPayload,
	serializeAnalysisPayload,
} from "@cosquared/schema";
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
} from "../scoring/__fixtures__/builders";
import { buildAnalysisPayload } from "./build-payload";

/**
 * Golden-file test for the upload builder, mirroring the scoring engine's
 * golden-profile discipline. The event stream is the SAME story scored in
 * `score-profile.test.ts` (a careful_validator who never frames tasks), so
 * the payload's `local_scores` line up with the already-verified profile —
 * updating this fixture is a deliberate, reviewed act.
 */

const META = {
	cliVersion: "0.1.0",
	platform: "test-os",
	repoIdHash: "sha256:fixture-repo",
};

/** Session 1 (June 10): verified, tested, leveraged — but unframed. */
const sessionOneEvents: SessionEvent[] = [
	sessionStart("s1", "2026-06-10T10:00:00.000Z"),
	prompt("s1", "2026-06-10T10:00:00.000Z", { wordCount: 5 }),
	toolCall("s1", "2026-06-10T10:02:00.000Z", "file_edit", "Edit"),
	planArtifact("s1", "2026-06-10T10:03:00.000Z"),
	toolCall("s1", "2026-06-10T10:04:00.000Z", "execute", "Bash"),
	toolCall("s1", "2026-06-10T10:05:00.000Z", "search", "Grep"),
	changeAccepted("s1", "2026-06-10T10:06:00.000Z", true),
	testRun("s1", "2026-06-10T10:07:00.000Z"),
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
	commit("2026-06-10T10:30:00.000Z", {
		touchedTestFiles: true,
		insertions: 10,
	}),
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

const goldenPayload: AnalysisPayload = JSON.parse(
	readFileSync(
		fileURLToPath(
			new URL("./__fixtures__/payload.expected.json", import.meta.url),
		),
		"utf8",
	),
);

describe("buildAnalysisPayload", () => {
	test("builds the golden stream into the checked-in expected payload", () => {
		expect(buildAnalysisPayload(goldenEvents, META)).toEqual(goldenPayload);
	});

	test("is deterministic: two runs serialize byte-identically", () => {
		const first = serializeAnalysisPayload(
			buildAnalysisPayload(goldenEvents, META),
		);
		const second = serializeAnalysisPayload(
			buildAnalysisPayload(goldenEvents, META),
		);
		expect(first).toBe(second);
	});

	test("local scores match the verified Builder Profile", () => {
		const { local_scores } = buildAnalysisPayload(goldenEvents, META);
		expect(local_scores).toEqual({
			ai_collaboration: 53,
			ai_collaboration_subsignals: {
				task_framing: 0,
				tool_workflow_judgment: 81.25,
				verification_calibration: 80,
				cognitive_engagement: 25,
			},
			testing: 93,
			shipping: 63,
		});
	});

	test("populates the profile from the verified Builder Profile", () => {
		const { profile } = buildAnalysisPayload(goldenEvents, META);
		// The careful_validator story: verifies and tests, but never frames.
		expect(profile.builder_type).toBe("careful_validator");
		// recommended_focus is the single weakest leaf (task_framing scored 0).
		expect(profile.recommended_focus).toBe("task_framing");
		expect(profile.weaknesses[0]).toBe("task_framing");
		expect(profile.strengths).toContain("testing_discipline");
	});

	test("coarsens every evidence ref to a bare date — no time, no sessionId", () => {
		const { profile } = buildAnalysisPayload(goldenEvents, META);
		const allRefs = Object.values(profile.evidence)
			.flat()
			.flatMap((statistic) => statistic.refs);
		// There is real evidence to check (the guard would pass vacuously otherwise).
		expect(allRefs.length).toBeGreaterThan(0);
		for (const ref of allRefs) {
			expect(ref.session_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
			expect(ref.session_date).not.toContain("T");
			// `sessionId` is dropped on the wire — the ref carries only source+date.
			expect(Object.keys(ref).sort()).toEqual(["session_date", "source"]);
		}
	});

	test("a thin stream is flagged low confidence, never falsely precise", () => {
		// One short, unframed session — far below the published 5-session minimum.
		const thin: SessionEvent[] = [
			prompt("s1", "2026-06-11T10:00:00.000Z", { wordCount: 3 }),
			toolCall("s1", "2026-06-11T10:01:00.000Z", "file_edit", "Edit"),
		];
		const { profile } = buildAnalysisPayload(thin, META);
		// Sub-signals with data are flagged low (1 session < 5); none is "normal".
		const confidences = [
			profile.confidence.ai_collaboration,
			...Object.values(profile.confidence.subsignals),
		];
		expect(confidences).not.toContain("normal");
		expect(confidences).toContain("low");
	});

	test("an empty stream yields a fully-null, honest profile, never a throw", () => {
		const { profile } = buildAnalysisPayload([], META);
		expect(profile.builder_type).toBeNull();
		expect(profile.recommended_focus).toBeNull();
		expect(profile.strengths).toEqual([]);
		expect(profile.weaknesses).toEqual([]);
		expect(profile.confidence.testing).toBe("none");
		expect(profile.confidence.shipping).toBe("none");
	});

	test("windows are measured from referenceTime, not the wall clock", () => {
		// A commit 29 days before HEAD counts; one 31 days before does not —
		// proving the 30-day window keys off the stream's max timestamp.
		const events: SessionEvent[] = [
			commit("2026-05-13T12:00:00.000Z"), // 29 days before reference
			commit("2026-05-11T12:00:00.000Z"), // 31 days before reference
			repoSnapshot("2026-06-11T12:00:00.000Z"),
		];
		expect(buildAnalysisPayload(events, META).repo.commit_count_30d).toBe(1);
	});

	test("guards division by zero → null, never a fake 0", () => {
		// One session, one prompt that is not a question, no accepts; no churn
		// additions. Every rate must be null (no data), not 0.
		const events: SessionEvent[] = [
			prompt("s1", "2026-06-11T10:00:00.000Z"),
			churnSnapshot("2026-06-11T12:00:00.000Z", {
				linesAdded: 0,
				linesChurned: 0,
			}),
		];
		const payload = buildAnalysisPayload(events, META);
		expect(payload.repo.churn_ratio_14d).toBeNull();
		expect(payload.sessions[0].validation_after_accept_rate).toBeNull();
		// One non-question prompt → a real 0 rate, distinct from "no prompts".
		expect(payload.sessions[0].question_prompt_rate).toBe(0);
	});

	test("an empty stream yields empty sessions and null scores, never a throw", () => {
		const payload = buildAnalysisPayload([], META);
		expect(payload.sessions).toEqual([]);
		expect(payload.repo).toEqual({
			id_hash: "sha256:fixture-repo",
			has_tests: false,
			test_file_ratio: 0,
			commit_count_30d: 0,
			churn_ratio_14d: null,
			context_artifact_count: 0,
			doc_file_count: 0,
		});
		expect(payload.local_scores.ai_collaboration).toBeNull();
		expect(payload.local_scores.testing).toBeNull();
		expect(payload.local_scores.shipping).toBeNull();
	});

	test("emits no names or paths anywhere in the serialized payload", () => {
		// A blunt guard against regressions that smuggle identifiers through:
		// the wire form must not contain the fixture's tool names or 'path'.
		const wire = serializeAnalysisPayload(
			buildAnalysisPayload(goldenEvents, META),
		);
		expect(wire).not.toContain("Edit");
		expect(wire).not.toContain("Bash");
		expect(wire).not.toContain("Grep");
		expect(wire.toLowerCase()).not.toContain("path");
	});
});
