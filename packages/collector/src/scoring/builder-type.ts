import type { BuilderType, ScoredSignal, ScoreResult } from "./types";

/**
 * Builder Type classification — rule-based with published criteria
 * (PRD §7.2: "must feel accurate or it kills credibility").
 *
 * PUBLISHED DECISION TABLE — priority-ordered, first match wins. A
 * null-valued signal never matches a `≥` or `<` test (no data is not
 * evidence of anything, PRD §7.6).
 *
 * Precedence is intentional, not incidental: when someone is BOTH a
 * careful validator (rule 1) and a methodical planner (rule 2), the
 * scarcer, higher-valued discipline wins. Verification is the field's
 * documented blind spot and is weighted heaviest inside AI Collaboration
 * (METR RCT, PRD §7.3), so "Careful Validator" is the deliberate label for
 * a planner-who-also-verifies — reordering would mislabel true validators.
 *
 * 1. careful_validator:    Verification & Calibration ≥ 70 AND
 *                          Testing Discipline ≥ 60
 * 2. methodical_architect: Task Framing ≥ 70
 * 3. rapid_prototyper:     Shipping Momentum ≥ 70 AND Task Framing < 50
 * 4. explorer:             Cognitive Engagement ≥ 70
 * 5. ai_delegator:         (leverage sessions ≥ 50% OR sessions with an
 *                          accepted change ≥ 60%) AND VC < 50 AND CE < 50
 *                          — heavy delegation without the verification or
 *                          engagement habits to match.
 * 6. Fallback: the highest-valued leaf signal mapped to its nearest type
 *    (VC or Testing Discipline → careful_validator, Task Framing →
 *    methodical_architect, Shipping Momentum → rapid_prototyper,
 *    Cognitive Engagement → explorer, Tool & Workflow Judgment →
 *    ai_delegator); ties broken by that fixed order. All signals null →
 *    null (insufficient data — never a guessed type).
 */
export interface BuilderTypeInputs {
	taskFraming: ScoredSignal;
	toolWorkflowJudgment: ScoredSignal;
	verificationCalibration: ScoredSignal;
	cognitiveEngagement: ScoredSignal;
	testingDiscipline: ScoreResult;
	shippingMomentum: ScoreResult;
	/** Sessions with skills/commands/subagent use ÷ sessions; null = no sessions. */
	leverageSessionRate: number | null;
	/** Sessions with ≥1 accepted change ÷ sessions; null = no sessions. */
	acceptedSessionRate: number | null;
}

function atLeast(value: number | null, threshold: number): boolean {
	return value !== null && value >= threshold;
}

function below(value: number | null, threshold: number): boolean {
	return value !== null && value < threshold;
}

export function classifyBuilderType(
	inputs: BuilderTypeInputs,
): BuilderType | null {
	const vc = inputs.verificationCalibration.value;
	const tf = inputs.taskFraming.value;
	const ce = inputs.cognitiveEngagement.value;
	const twj = inputs.toolWorkflowJudgment.value;
	const td = inputs.testingDiscipline.value;
	const sm = inputs.shippingMomentum.value;

	if (atLeast(vc, 70) && atLeast(td, 60)) {
		return "careful_validator";
	}
	if (atLeast(tf, 70)) {
		return "methodical_architect";
	}
	if (atLeast(sm, 70) && below(tf, 50)) {
		return "rapid_prototyper";
	}
	if (atLeast(ce, 70)) {
		return "explorer";
	}
	if (
		(atLeast(inputs.leverageSessionRate, 0.5) ||
			atLeast(inputs.acceptedSessionRate, 0.6)) &&
		below(vc, 50) &&
		below(ce, 50)
	) {
		return "ai_delegator";
	}

	// Fallback argmax, ties broken by this fixed order.
	const ranked: Array<{ value: number | null; type: BuilderType }> = [
		{ value: vc, type: "careful_validator" },
		{ value: td, type: "careful_validator" },
		{ value: tf, type: "methodical_architect" },
		{ value: sm, type: "rapid_prototyper" },
		{ value: ce, type: "explorer" },
		{ value: twj, type: "ai_delegator" },
	];
	let best: { value: number; type: BuilderType } | null = null;
	for (const candidate of ranked) {
		if (
			candidate.value !== null &&
			(best === null || candidate.value > best.value)
		) {
			best = { value: candidate.value, type: candidate.type };
		}
	}
	return best?.type ?? null;
}
