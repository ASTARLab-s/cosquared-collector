import type { SessionEvent } from "@cosquared/schema";
import { cappedRefs } from "../evidence";
import type { SessionView } from "../sessions";
import type { ScoredSignal } from "../types";
import { CE_SESSION_FULL_COUNT, confidenceForDenominator } from "../weights";

/**
 * Cognitive Engagement — is the user learning or atrophying?
 *
 * Rule: depth, not presence. Each applicable session (≥1 `user_prompt`)
 * scores `min(acts, CE_SESSION_FULL_COUNT) / CE_SESSION_FULL_COUNT`, where
 * `acts` = explanation requests + question prompts; the signal value is the
 * mean of those per-session scores × 100. So a session with one question
 * scores half-engaged, two or more fully; and one chatty session cannot max
 * the whole signal (the earlier binary "≥1 question?" rule saturated at
 * 100 — see PRD §7.6: no number should read as false-perfect).
 * Signals read: `explanation_request`, `user_prompt.isQuestion`.
 * Grounding: PRD §7.3 CE row — Anthropic skill-formation study: AI
 * assistance lowered comprehension 17%, but engaged interaction patterns
 * (follow-ups, explanations alongside generation) preserved skill.
 *
 * Pure and deterministic: no clock, no randomness, no I/O.
 */
export function cognitiveEngagement(sessions: SessionView[]): ScoredSignal {
	const qualifyingEvents: SessionEvent[] = [];
	let applicableSessions = 0;
	let cappedActsSum = 0;

	for (const session of sessions) {
		const hasHumanPrompt = session.events.some(
			(event) => event.type === "user_prompt",
		);
		if (!hasHumanPrompt) {
			continue;
		}
		applicableSessions += 1;
		const engagementActs = session.events.filter(
			(event) =>
				event.type === "explanation_request" ||
				(event.type === "user_prompt" && event.isQuestion),
		);
		cappedActsSum += Math.min(engagementActs.length, CE_SESSION_FULL_COUNT);
		if (engagementActs[0] !== undefined) {
			qualifyingEvents.push(engagementActs[0]);
		}
	}

	// denominator is the max achievable capped acts; value === num/den × 100,
	// so the cited ratio exactly reconstructs the score (PRD §7.6).
	const denominator = applicableSessions * CE_SESSION_FULL_COUNT;
	return {
		id: "cognitive_engagement",
		value:
			applicableSessions === 0 ? null : (cappedActsSum / denominator) * 100,
		confidence: confidenceForDenominator(applicableSessions),
		evidence: [
			{
				kind: "engagement_depth",
				numerator: cappedActsSum,
				denominator,
				refs: cappedRefs(qualifyingEvents),
			},
		],
	};
}
