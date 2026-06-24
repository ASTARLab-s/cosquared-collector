import type { SessionEvent } from "@cosquared/schema";
import { cappedRefs, evidenceRef } from "../evidence";
import { scaleLinear, weightedMean } from "../scale";
import type { SessionView } from "../sessions";
import type { ScoredSignal, ScoreResult } from "../types";
import {
	COMMIT_LINKAGE_GRACE_MINUTES,
	confidenceForDenominator,
	SM_CADENCE_FULL_AT_RATE,
	SM_CADENCE_WEIGHT,
	SM_CADENCE_WINDOW_DAYS,
	SM_CHURN_RATIO_FULL_AT,
	SM_CHURN_RATIO_ZERO_AT,
	SM_CHURN_WEIGHT,
	SM_COMPLETION_FULL_AT_RATE,
	SM_COMPLETION_WEIGHT,
	weakestConfidence,
} from "../weights";

const DAY_MILLIS = 86_400_000;

function latestChurnSnapshot(repoEvents: SessionEvent[]) {
	for (let index = repoEvents.length - 1; index >= 0; index -= 1) {
		const event = repoEvents[index];
		if (event.type === "churn_snapshot") {
			return event;
		}
	}
	return null;
}

/**
 * Shipping Momentum — weighted mean of three published components
 * (PRD §7.3 Shipping Momentum row):
 *
 * 1. Commit cadence (weight 0.4): distinct UTC days with ≥1 commit in the
 *    14 days ending at the reference time (the stream's max timestamp —
 *    NEVER the wall clock, so re-scoring old data is identical forever),
 *    over 14, scaled 0 → 0.5.
 * 2. Session completion arcs (weight 0.3): coding sessions whose window
 *    [first event, last event + 60min grace] contains a commit, over all
 *    coding sessions, scaled 0 → 0.7. HONESTY (PRD §7.6): this is timestamp
 *    correlation, not attribution — a nearby commit is evidence of an arc
 *    completing (finished vs. abandoned threads), not proof the commit
 *    contains that session's work. A commit can complete more than one
 *    overlapping session's arc. Null when the stream contains NO commit
 *    events at all — absence of git data must not read as abandonment.
 * 3. Churn health (weight 0.3): 100 − scale(linesChurned / linesAdded,
 *    0.1 → 0.5) from the latest churn snapshot (GitClear: high commits +
 *    high churn ≠ shipping). Null when no snapshot exists or
 *    linesAdded is 0 (division guard).
 *
 * Weights renormalize over components with data.
 *
 * Pure and deterministic: no clock, no randomness, no I/O.
 */
export function shippingMomentum(
	sessions: SessionView[],
	repoEvents: SessionEvent[],
	referenceTime: string | null,
): ScoreResult {
	const commits = repoEvents.filter((event) => event.type === "commit");

	let cadence: ScoredSignal;
	if (commits.length === 0 || referenceTime === null) {
		cadence = {
			id: "shipping_momentum",
			value: null,
			confidence: "none",
			evidence: [
				{
					kind: "commit_cadence_days",
					numerator: 0,
					denominator: SM_CADENCE_WINDOW_DAYS,
					refs: [],
				},
			],
		};
	} else {
		const referenceMillis = Date.parse(referenceTime);
		const windowStartMillis =
			referenceMillis - SM_CADENCE_WINDOW_DAYS * DAY_MILLIS;
		const commitsInWindow = commits.filter((commit) => {
			const millis = Date.parse(commit.timestamp);
			return millis > windowStartMillis && millis <= referenceMillis;
		});
		const distinctUtcDays = new Set(
			commitsInWindow.map((commit) =>
				new Date(Date.parse(commit.timestamp)).toISOString().slice(0, 10),
			),
		);
		cadence = {
			id: "shipping_momentum",
			value: scaleLinear(
				distinctUtcDays.size / SM_CADENCE_WINDOW_DAYS,
				0,
				SM_CADENCE_FULL_AT_RATE,
			),
			confidence: confidenceForDenominator(commits.length),
			evidence: [
				{
					kind: "commit_cadence_days",
					numerator: distinctUtcDays.size,
					denominator: SM_CADENCE_WINDOW_DAYS,
					refs: cappedRefs(commitsInWindow),
				},
			],
		};
	}

	// Completion measures coding threads finished vs. abandoned, so the
	// denominator is coding sessions (≥1 file edit) — a /model or read-only
	// session has no work to ship and must not read as an abandoned arc
	// (same scoping as Testing Discipline's session rate).
	const codingSessions = sessions.filter((session) =>
		session.events.some(
			(event) => event.type === "tool_call" && event.category === "file_edit",
		),
	);
	const graceMillis = COMMIT_LINKAGE_GRACE_MINUTES * 60_000;
	const completedArcSessions = codingSessions.filter((session) => {
		const startMillis = Date.parse(session.events[0].timestamp);
		const endMillis =
			Date.parse(session.events[session.events.length - 1].timestamp) +
			graceMillis;
		return commits.some((commit) => {
			const commitMillis = Date.parse(commit.timestamp);
			return commitMillis >= startMillis && commitMillis <= endMillis;
		});
	});
	const completionApplicable = commits.length > 0 && codingSessions.length > 0;
	const completion: ScoredSignal = {
		id: "shipping_momentum",
		value: completionApplicable
			? scaleLinear(
					completedArcSessions.length / codingSessions.length,
					0,
					SM_COMPLETION_FULL_AT_RATE,
				)
			: null,
		confidence: completionApplicable
			? confidenceForDenominator(codingSessions.length)
			: "none",
		evidence: [
			{
				kind: "sessions_ending_in_commit",
				numerator: completedArcSessions.length,
				denominator: completionApplicable ? codingSessions.length : 0,
				refs: cappedRefs(
					completedArcSessions.map((session) => session.events[0]),
				),
			},
		],
	};

	const churnSnapshot = latestChurnSnapshot(repoEvents);
	const churnApplicable =
		churnSnapshot !== null && churnSnapshot.linesAdded > 0;
	const churnHealth: ScoredSignal = {
		id: "shipping_momentum",
		value: churnApplicable
			? 100 -
				scaleLinear(
					churnSnapshot.linesChurned / churnSnapshot.linesAdded,
					SM_CHURN_RATIO_ZERO_AT,
					SM_CHURN_RATIO_FULL_AT,
				)
			: null,
		confidence: churnApplicable ? "normal" : "none",
		evidence: [
			{
				kind: "recent_churn_ratio",
				numerator: churnSnapshot?.linesChurned ?? 0,
				denominator: churnSnapshot?.linesAdded ?? 0,
				refs: churnSnapshot === null ? [] : [evidenceRef(churnSnapshot)],
			},
		],
	};

	const components = [
		{ signal: cadence, weight: SM_CADENCE_WEIGHT },
		{ signal: completion, weight: SM_COMPLETION_WEIGHT },
		{ signal: churnHealth, weight: SM_CHURN_WEIGHT },
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
