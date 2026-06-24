import type { SessionEvent } from "@cosquared/schema";
import { cappedRefs } from "../evidence";
import { scaleLinear, weightedMean } from "../scale";
import type { SessionView } from "../sessions";
import type { ScoredSignal } from "../types";
import {
	LOW_CONFIDENCE_MIN_SESSIONS,
	VC_FULL_AT_RATE,
	VC_TEST_AFTER_ACCEPT_WEIGHT,
	VC_VALIDATION_RATE_WEIGHT,
} from "../weights";

function isChangeOutcome(
	event: SessionEvent,
): event is Extract<
	SessionEvent,
	{ type: "change_accepted" | "change_rejected" }
> {
	return event.type === "change_accepted" || event.type === "change_rejected";
}

/**
 * Verification & Calibration — does the user check AI output?
 *
 * Rule: 0.6 × validation-after-accept rate (scaled 0 → 0.75) + 0.4 ×
 * sessions-with-accept-and-test-run rate (scaled 0 → 0.75). The
 * validation rate counts accepted AND rejected changes whose
 * `followedByValidation` is `true`, over those where it is non-null —
 * `null` means the change was too close to the session end to judge and
 * is excluded from BOTH sides of the rate. Raw accept/reject counts are a
 * deliberately demoted signal (PRD §7.3 demotion note) and are never a
 * primary input here; only post-acceptance outcomes matter.
 * Signals read: `change_accepted`/`change_rejected`
 * (followedByValidation), `test_run`.
 * Grounding: PRD §7.3 VC row — METR RCT (devs 19% slower while believing
 * 20% faster); verification is the field's best-documented blind spot.
 * Weighted heaviest inside AI Collaboration.
 *
 * Pure and deterministic: no clock, no randomness, no I/O.
 */
export function verificationCalibration(sessions: SessionView[]): ScoredSignal {
	const judgeableChanges: SessionEvent[] = [];
	const validatedChanges: SessionEvent[] = [];
	const sessionsWithAccept: SessionView[] = [];
	const acceptAndTestEvents: SessionEvent[] = [];
	let sessionsWithChangeOutcome = 0;

	for (const session of sessions) {
		let sessionHasOutcome = false;
		let sessionHasAccept = false;
		for (const event of session.events) {
			if (!isChangeOutcome(event)) {
				continue;
			}
			sessionHasOutcome = true;
			if (event.type === "change_accepted") {
				sessionHasAccept = true;
			}
			if (event.followedByValidation !== null) {
				judgeableChanges.push(event);
				if (event.followedByValidation) {
					validatedChanges.push(event);
				}
			}
		}
		if (sessionHasOutcome) {
			sessionsWithChangeOutcome += 1;
		}
		if (sessionHasAccept) {
			sessionsWithAccept.push(session);
			const firstTestRun = session.events.find(
				(event) => event.type === "test_run",
			);
			if (firstTestRun !== undefined) {
				acceptAndTestEvents.push(firstTestRun);
			}
		}
	}

	const validationRate =
		judgeableChanges.length === 0
			? null
			: scaleLinear(
					validatedChanges.length / judgeableChanges.length,
					0,
					VC_FULL_AT_RATE,
				);
	const acceptTestRate =
		sessionsWithAccept.length === 0
			? null
			: scaleLinear(
					acceptAndTestEvents.length / sessionsWithAccept.length,
					0,
					VC_FULL_AT_RATE,
				);

	const value = weightedMean([
		{ value: validationRate, weight: VC_VALIDATION_RATE_WEIGHT },
		{ value: acceptTestRate, weight: VC_TEST_AFTER_ACCEPT_WEIGHT },
	]);

	return {
		id: "verification_calibration",
		value,
		confidence:
			value === null
				? "none"
				: sessionsWithChangeOutcome < LOW_CONFIDENCE_MIN_SESSIONS
					? "low"
					: "normal",
		evidence: [
			{
				kind: "validation_after_accept",
				numerator: validatedChanges.length,
				denominator: judgeableChanges.length,
				refs: cappedRefs(validatedChanges),
			},
			{
				kind: "sessions_with_accept_and_test_run",
				numerator: acceptAndTestEvents.length,
				denominator: sessionsWithAccept.length,
				refs: cappedRefs(acceptAndTestEvents),
			},
		],
	};
}
