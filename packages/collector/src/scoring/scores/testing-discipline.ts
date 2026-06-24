import type { SessionEvent } from "@cosquared/schema";
import { cappedRefs, evidenceRef } from "../evidence";
import { scaleLinear, weightedMean } from "../scale";
import type { SessionView } from "../sessions";
import type { ScoredSignal, ScoreResult } from "../types";
import {
	confidenceForDenominator,
	TD_COMMIT_RATE_FULL_AT,
	TD_COMMIT_RATE_WEIGHT,
	TD_REPO_RATIO_FULL_AT,
	TD_REPO_RATIO_WEIGHT,
	TD_SESSION_RATE_FULL_AT,
	TD_SESSION_RATE_WEIGHT,
	weakestConfidence,
} from "../weights";

function latestRepoSnapshot(repoEvents: SessionEvent[]) {
	for (let index = repoEvents.length - 1; index >= 0; index -= 1) {
		const event = repoEvents[index];
		if (event.type === "repo_snapshot") {
			return event;
		}
	}
	return null;
}

/**
 * Testing Discipline — weighted mean of three published components
 * (PRD §7.3 Testing Discipline row):
 *
 * 1. Repo test-file ratio (weight 0.3): testFileCount / trackedFileCount
 *    from the latest repo snapshot, scaled 0 → 0.2. Null when no snapshot
 *    exists or the repo has zero tracked files (division guard).
 * 2. Session test-run rate (weight 0.4): coding sessions (≥1 file edit)
 *    with ≥1 `test_run`, over coding sessions, scaled 0 → 0.6 — the
 *    strongest behavioral signal. The denominator is coding sessions, not
 *    all sessions: a `/model` or read-only session never had code to test,
 *    so counting it as "untested" would wrongly drag the score down (same
 *    scoping Tool & Workflow Judgment uses for balanced sessions).
 * 3. Commit test-touch rate (weight 0.3): commits with
 *    `touchedTestFiles` over all commits, scaled 0 → 0.5 — the
 *    tests-before-commit pattern.
 *
 * Weights renormalize over components with data (a Claude-Code-only
 * stream with no git history degrades gracefully, never to NaN).
 *
 * Pure and deterministic: no clock, no randomness, no I/O.
 */
export function testingDiscipline(
	sessions: SessionView[],
	repoEvents: SessionEvent[],
): ScoreResult {
	const snapshot = latestRepoSnapshot(repoEvents);
	const repoRatioApplicable =
		snapshot !== null && snapshot.trackedFileCount > 0;
	const repoRatio: ScoredSignal = {
		id: "testing_discipline",
		value: repoRatioApplicable
			? scaleLinear(
					snapshot.testFileCount / snapshot.trackedFileCount,
					0,
					TD_REPO_RATIO_FULL_AT,
				)
			: null,
		confidence: repoRatioApplicable ? "normal" : "none",
		evidence: [
			{
				kind: "repo_test_file_ratio",
				numerator: snapshot?.testFileCount ?? 0,
				denominator: snapshot?.trackedFileCount ?? 0,
				refs: snapshot === null ? [] : [evidenceRef(snapshot)],
			},
		],
	};

	const codingSessions = sessions.filter((session) =>
		session.events.some(
			(event) => event.type === "tool_call" && event.category === "file_edit",
		),
	);
	const sessionsWithTestRun: SessionEvent[] = [];
	for (const session of codingSessions) {
		const firstTestRun = session.events.find(
			(event) => event.type === "test_run",
		);
		if (firstTestRun !== undefined) {
			sessionsWithTestRun.push(firstTestRun);
		}
	}
	const sessionRate: ScoredSignal = {
		id: "testing_discipline",
		value:
			codingSessions.length === 0
				? null
				: scaleLinear(
						sessionsWithTestRun.length / codingSessions.length,
						0,
						TD_SESSION_RATE_FULL_AT,
					),
		confidence: confidenceForDenominator(codingSessions.length),
		evidence: [
			{
				kind: "sessions_with_test_run",
				numerator: sessionsWithTestRun.length,
				denominator: codingSessions.length,
				refs: cappedRefs(sessionsWithTestRun),
			},
		],
	};

	const commits = repoEvents.filter((event) => event.type === "commit");
	const commitsTouchingTests = commits.filter(
		(commit) => commit.type === "commit" && commit.touchedTestFiles,
	);
	const commitRate: ScoredSignal = {
		id: "testing_discipline",
		value:
			commits.length === 0
				? null
				: scaleLinear(
						commitsTouchingTests.length / commits.length,
						0,
						TD_COMMIT_RATE_FULL_AT,
					),
		confidence: confidenceForDenominator(commits.length),
		evidence: [
			{
				kind: "commits_touching_tests",
				numerator: commitsTouchingTests.length,
				denominator: commits.length,
				refs: cappedRefs(commitsTouchingTests),
			},
		],
	};

	const components = [
		{ signal: repoRatio, weight: TD_REPO_RATIO_WEIGHT },
		{ signal: sessionRate, weight: TD_SESSION_RATE_WEIGHT },
		{ signal: commitRate, weight: TD_COMMIT_RATE_WEIGHT },
	];
	const mean = weightedMean(
		components.map(({ signal, weight }) => ({ value: signal.value, weight })),
	);
	return {
		value: mean === null ? null : Math.round(mean),
		confidence: weakestConfidence(
			components.map(({ signal }) => signal.confidence),
		),
		components,
	};
}
