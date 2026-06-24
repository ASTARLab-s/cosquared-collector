import { describe, expect, test } from "vitest";
import { shannonEntropy } from "./entropy";

describe("shannonEntropy", () => {
	const fixtures: Record<string, { value: string; min: number; max: number }> =
		{
			emptyStringHasZeroEntropy: { value: "", min: 0, max: 0 },
			singleRepeatedCharHasZeroEntropy: { value: "aaaa", min: 0, max: 0 },
			twoEquallyLikelyCharsHaveOneBit: { value: "ab", min: 1, max: 1 },
			randomLookingTokenIsHighEntropy: {
				value: "x9T2mQ7wL4pK8vR3nJ6dB1sF5hY0aGcU",
				min: 4,
				max: 5,
			},
			englishProseSitsInTheMidRange: {
				value:
					"the api key is stored in the keychain and never written to disk",
				min: 3.5,
				max: 4.5,
			},
		};

	test.each(Object.entries(fixtures))("%s", (_name, { value, min, max }) => {
		const entropy = shannonEntropy(value);
		expect(entropy).toBeGreaterThanOrEqual(min);
		expect(entropy).toBeLessThanOrEqual(max);
	});

	test("is deterministic: the same input always yields the same value", () => {
		const value = "sk-ant-api03-fixture";
		expect(shannonEntropy(value)).toBe(shannonEntropy(value));
	});
});
