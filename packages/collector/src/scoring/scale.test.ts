import { describe, expect, test } from "vitest";
import { scaleLinear, weightedMean } from "./scale";

describe("scaleLinear", () => {
	const fixtures: Record<
		string,
		{ value: number; zeroAt: number; fullAt: number; expected: number }
	> = {
		midpointScalesLinearly: {
			value: 0.4,
			zeroAt: 0,
			fullAt: 0.8,
			expected: 50,
		},
		atZeroThresholdScoresZero: {
			value: 0.1,
			zeroAt: 0.1,
			fullAt: 0.5,
			expected: 0,
		},
		atFullThresholdScoresFull: {
			value: 0.5,
			zeroAt: 0.1,
			fullAt: 0.5,
			expected: 100,
		},
		belowZeroThresholdClampsToZero: {
			value: 0.05,
			zeroAt: 0.1,
			fullAt: 0.5,
			expected: 0,
		},
		aboveFullThresholdClampsToHundred: {
			value: 0.9,
			zeroAt: 0,
			fullAt: 0.5,
			expected: 100,
		},
	};

	test.each(Object.entries(fixtures))("%s", (_name, {
		value,
		zeroAt,
		fullAt,
		expected,
	}) => {
		expect(scaleLinear(value, zeroAt, fullAt)).toBe(expected);
	});

	test("degenerate zeroAt === fullAt is a step function, not NaN", () => {
		expect(scaleLinear(0.4, 0.5, 0.5)).toBe(0);
		expect(scaleLinear(0.5, 0.5, 0.5)).toBe(100);
		expect(scaleLinear(0.6, 0.5, 0.5)).toBe(100);
	});
});

describe("weightedMean", () => {
	test("averages non-null entries by weight", () => {
		expect(
			weightedMean([
				{ value: 100, weight: 0.6 },
				{ value: 50, weight: 0.4 },
			]),
		).toBe(80);
	});

	test("renormalizes weights when a component is null", () => {
		// The null 0.5-weight entry redistributes: (100*0.3 + 40*0.2) / 0.5.
		expect(
			weightedMean([
				{ value: null, weight: 0.5 },
				{ value: 100, weight: 0.3 },
				{ value: 40, weight: 0.2 },
			]),
		).toBe(76);
	});

	test("returns null when all entries are null — no fake numbers", () => {
		expect(
			weightedMean([
				{ value: null, weight: 0.5 },
				{ value: null, weight: 0.5 },
			]),
		).toBeNull();
	});

	test("returns null for an empty entry list", () => {
		expect(weightedMean([])).toBeNull();
	});
});
