import { describe, expect, test } from "vitest";
import {
	AI_COLLABORATION_WEIGHTS,
	confidenceForDenominator,
	SM_CADENCE_WEIGHT,
	SM_CHURN_WEIGHT,
	SM_COMPLETION_WEIGHT,
	TD_COMMIT_RATE_WEIGHT,
	TD_REPO_RATIO_WEIGHT,
	TD_SESSION_RATE_WEIGHT,
	TWJ_BALANCED_WEIGHT,
	TWJ_CONTEXT_WEIGHT,
	TWJ_LEVERAGE_WEIGHT,
	VC_TEST_AFTER_ACCEPT_WEIGHT,
	VC_VALIDATION_RATE_WEIGHT,
	weakestConfidence,
} from "./weights";

/**
 * Executable invariants over the published weights — these tests pin the
 * PRD's structural commitments so a retune can't silently break them.
 */

describe("published weights", () => {
	test("AI Collaboration sub-signal weights sum to 1", () => {
		const total = Object.values(AI_COLLABORATION_WEIGHTS).reduce(
			(sum, weight) => sum + weight,
			0,
		);
		expect(total).toBeCloseTo(1, 10);
	});

	// PRD §7.3: "Verification & Calibration ... Weighted heaviest." — the
	// METR RCT verification gap. Strictly largest, not tied.
	test("Verification & Calibration carries the strictly largest sub-signal weight", () => {
		const { verification_calibration: vcWeight, ...others } =
			AI_COLLABORATION_WEIGHTS;
		for (const weight of Object.values(others)) {
			expect(vcWeight).toBeGreaterThan(weight);
		}
	});

	test("Tool & Workflow Judgment component weights sum to 1", () => {
		expect(
			TWJ_BALANCED_WEIGHT + TWJ_LEVERAGE_WEIGHT + TWJ_CONTEXT_WEIGHT,
		).toBeCloseTo(1, 10);
	});

	test("Verification & Calibration component weights sum to 1", () => {
		expect(VC_VALIDATION_RATE_WEIGHT + VC_TEST_AFTER_ACCEPT_WEIGHT).toBeCloseTo(
			1,
			10,
		);
	});

	test("Testing Discipline component weights sum to 1", () => {
		expect(
			TD_REPO_RATIO_WEIGHT + TD_SESSION_RATE_WEIGHT + TD_COMMIT_RATE_WEIGHT,
		).toBeCloseTo(1, 10);
	});

	test("Shipping Momentum component weights sum to 1", () => {
		expect(
			SM_CADENCE_WEIGHT + SM_COMPLETION_WEIGHT + SM_CHURN_WEIGHT,
		).toBeCloseTo(1, 10);
	});
});

describe("confidenceForDenominator", () => {
	const fixtures: Record<string, { denominator: number; expected: string }> = {
		zeroDataIsNone: { denominator: 0, expected: "none" },
		fourSessionsIsLow: { denominator: 4, expected: "low" },
		fiveSessionsIsNormal: { denominator: 5, expected: "normal" },
	};

	test.each(Object.entries(fixtures))("%s", (_name, {
		denominator,
		expected,
	}) => {
		expect(confidenceForDenominator(denominator)).toBe(expected);
	});
});

describe("weakestConfidence", () => {
	test("any low component makes the score low", () => {
		expect(weakestConfidence(["normal", "low", "normal"])).toBe("low");
	});

	test("none components are excluded — they carry no data", () => {
		expect(weakestConfidence(["none", "normal"])).toBe("normal");
	});

	test("all-none means the score has no data", () => {
		expect(weakestConfidence(["none", "none"])).toBe("none");
	});
});
