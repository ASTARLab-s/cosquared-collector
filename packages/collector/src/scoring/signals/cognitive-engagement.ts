import type { SessionEvent } from "@cosquared/schema";
import { cappedRefs } from "../evidence";
import type { SessionView } from "../sessions";
import type { ScoredSignal } from "../types";
import {
	CE_EXPLANATION_POINTS,
	CE_QUESTION_POINTS,
	CE_SESSION_FULL_POINTS,
	confidenceForDenominator,
} from "../weights";

/**
 * Cognitive Engagement — is the user learning or atrophying?
 *
 * Rule: weighted depth, not presence. Each applicable session (≥1
 * `user_prompt`) earns engagement points — {@link CE_EXPLANATION_POINTS}
 * per explanation request, {@link CE_QUESTION_POINTS} per question
 * prompt — capped at {@link CE_SESSION_FULL_POINTS}; the signal value is
 * the mean of per-session `min(points, full) / full` × 100. Explanation
 * requests weigh double because they are the direct comprehension-seeking
 * behavior; a `?` prompt is a coarser proxy (see the weights doc for the
 * 2026-08-25 calibration grounding — the earlier unweighted 2-act cap
 * saturated at 100 on question-mark counts a human read scored 40–45).
 * One chatty session still cannot max the whole signal.
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
	let cappedPointsSum = 0;
	let achievablePointsSum = 0;

	for (const session of sessions) {
		const hasHumanPrompt = session.events.some(
			(event) => event.type === "user_prompt",
		);
		if (!hasHumanPrompt) {
			continue;
		}
		applicableSessions += 1;
		let promptCount = 0;
		let sessionPoints = 0;
		let firstAct: SessionEvent | undefined;
		for (const event of session.events) {
			if (event.type === "user_prompt") {
				promptCount += 1;
			}
			if (event.type === "explanation_request") {
				sessionPoints += CE_EXPLANATION_POINTS;
			} else if (event.type === "user_prompt" && event.isQuestion) {
				sessionPoints += CE_QUESTION_POINTS;
			} else {
				continue;
			}
			firstAct ??= event;
		}
		// Never ask a session for more engagement than its prompts could
		// physically carry: one prompt can be at most one explanation request
		// AND one question, so a single-prompt session's ceiling is 3, not 4.
		// Scoring it out of 4 made brevity look like disengagement.
		const achievable = Math.min(
			CE_SESSION_FULL_POINTS,
			promptCount * (CE_EXPLANATION_POINTS + CE_QUESTION_POINTS),
		);
		achievablePointsSum += achievable;
		cappedPointsSum += Math.min(sessionPoints, achievable);
		if (firstAct !== undefined) {
			qualifyingEvents.push(firstAct);
		}
	}

	// denominator is the max achievable capped points; value === num/den × 100,
	// so the cited ratio exactly reconstructs the score (PRD §7.6).
	const denominator = achievablePointsSum;
	return {
		id: "cognitive_engagement",
		value:
			applicableSessions === 0 || denominator === 0
				? null
				: (cappedPointsSum / denominator) * 100,
		confidence: confidenceForDenominator(applicableSessions),
		evidence: [
			{
				kind: "engagement_depth",
				numerator: cappedPointsSum,
				denominator,
				refs: cappedRefs(qualifyingEvents),
			},
		],
	};
}
