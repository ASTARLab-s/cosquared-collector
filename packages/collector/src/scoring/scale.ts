/**
 * Pure numeric helpers shared by every scoring rule. No clock, no
 * randomness, no I/O — byte-identical output for byte-identical input
 * (the same purity contract as the redaction engine).
 */

/**
 * Maps `value` linearly onto 0–100: `zeroAt` and below score 0, `fullAt`
 * and above score 100. Published scaling — every threshold pair lives in
 * `weights.ts` so the full formula is auditable in one place (PRD §7.6).
 * Degenerate `zeroAt === fullAt` is a step function at the threshold.
 */
export function scaleLinear(
	value: number,
	zeroAt: number,
	fullAt: number,
): number {
	if (zeroAt === fullAt) {
		return value >= fullAt ? 100 : 0;
	}
	const fraction = (value - zeroAt) / (fullAt - zeroAt);
	return Math.min(100, Math.max(0, fraction * 100));
}

/**
 * Weighted average over the non-null entries, with weights renormalized to
 * the entries that have data — a missing component (e.g. no git history)
 * redistributes its weight instead of dragging the score down or producing
 * NaN. All-null input means "no data": returns null, never a fake number
 * (PRD §7.6 honest confidence).
 */
export function weightedMean(
	entries: Array<{ value: number | null; weight: number }>,
): number | null {
	let weightedSum = 0;
	let weightTotal = 0;
	for (const entry of entries) {
		if (entry.value !== null) {
			weightedSum += entry.value * entry.weight;
			weightTotal += entry.weight;
		}
	}
	return weightTotal === 0 ? null : weightedSum / weightTotal;
}
