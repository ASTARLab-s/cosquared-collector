import { describe, expect, test } from "vitest";
import { type BuilderTypeInputs, classifyBuilderType } from "./builder-type";
import type { ScoredSignal, ScoreResult, SignalId } from "./types";

function signal(id: SignalId, value: number | null): ScoredSignal {
	return {
		id,
		value,
		confidence: value === null ? "none" : "normal",
		evidence: [],
	};
}

function scoreResult(value: number | null): ScoreResult {
	return {
		value,
		confidence: value === null ? "none" : "normal",
		components: [],
	};
}

/**
 * Builds classifier inputs; every dimension defaults to null (no data) so
 * each fixture states only the values its rule reads.
 */
function inputs(overrides: {
	tf?: number | null;
	twj?: number | null;
	vc?: number | null;
	ce?: number | null;
	td?: number | null;
	sm?: number | null;
	leverageRate?: number | null;
	acceptedRate?: number | null;
}): BuilderTypeInputs {
	return {
		taskFraming: signal("task_framing", overrides.tf ?? null),
		toolWorkflowJudgment: signal(
			"tool_workflow_judgment",
			overrides.twj ?? null,
		),
		verificationCalibration: signal(
			"verification_calibration",
			overrides.vc ?? null,
		),
		cognitiveEngagement: signal("cognitive_engagement", overrides.ce ?? null),
		testingDiscipline: scoreResult(overrides.td ?? null),
		shippingMomentum: scoreResult(overrides.sm ?? null),
		leverageSessionRate: overrides.leverageRate ?? null,
		acceptedSessionRate: overrides.acceptedRate ?? null,
	};
}

describe("classifyBuilderType (published decision table)", () => {
	test("carefulValidator: VC ≥ 70 and Testing Discipline ≥ 60", () => {
		expect(classifyBuilderType(inputs({ vc: 70, td: 60 }))).toBe(
			"careful_validator",
		);
	});

	test("methodicalArchitect: Task Framing ≥ 70", () => {
		expect(classifyBuilderType(inputs({ tf: 70 }))).toBe(
			"methodical_architect",
		);
	});

	test("rapidPrototyper: Shipping Momentum ≥ 70 with weak Task Framing", () => {
		expect(classifyBuilderType(inputs({ sm: 80, tf: 30 }))).toBe(
			"rapid_prototyper",
		);
	});

	test("momentumWithDecentFramingFallsThroughToTheNextRule", () => {
		// SM 80 but TF 60 is not `< 50`, so rule 3 does not fire; rule 4
		// (explorer) gets its chance. Null TF would also not fire rule 3 —
		// no data is not evidence of haste.
		expect(classifyBuilderType(inputs({ sm: 80, tf: 60, ce: 75 }))).toBe(
			"explorer",
		);
	});

	test("explorer: Cognitive Engagement ≥ 70", () => {
		expect(classifyBuilderType(inputs({ ce: 75 }))).toBe("explorer");
	});

	test("aiDelegator: heavy delegation with low verification and engagement", () => {
		expect(
			classifyBuilderType(inputs({ leverageRate: 0.5, vc: 30, ce: 30 })),
		).toBe("ai_delegator");
	});

	test("aiDelegatorViaHighAcceptRate", () => {
		expect(
			classifyBuilderType(inputs({ acceptedRate: 0.6, vc: 40, ce: 20 })),
		).toBe("ai_delegator");
	});

	test("delegationWithStrongVerificationIsNotADelegator", () => {
		// VC 80 fails `< 50`; falls through to argmax → careful_validator.
		expect(
			classifyBuilderType(inputs({ leverageRate: 0.9, vc: 80, ce: 20 })),
		).toBe("careful_validator");
	});

	test("priorityPrecedence: validator beats architect when both match", () => {
		expect(classifyBuilderType(inputs({ vc: 90, td: 80, tf: 90 }))).toBe(
			"careful_validator",
		);
	});

	test("fallbackArgmaxMapsTheHighestLeafSignal", () => {
		// Nothing crosses a rule threshold; TWJ 65 is the max → ai_delegator.
		expect(
			classifyBuilderType(inputs({ vc: 50, tf: 40, ce: 30, twj: 65, sm: 20 })),
		).toBe("ai_delegator");
	});

	test("fallbackTiesBreakInTheFixedPublishedOrder", () => {
		// VC and SM tie at 60: VC comes first in the published order.
		expect(classifyBuilderType(inputs({ vc: 60, sm: 60 }))).toBe(
			"careful_validator",
		);
	});

	test("allNullSignalsYieldNullNotAGuess", () => {
		expect(classifyBuilderType(inputs({}))).toBeNull();
	});
});
