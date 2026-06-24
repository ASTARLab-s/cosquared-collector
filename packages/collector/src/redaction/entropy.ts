/**
 * Shannon entropy of a string in bits per character.
 *
 * Used by entropy-gated redaction rules (notably `generic-api-key`) to
 * separate real credentials — high-entropy random values — from benign
 * assignments like `password = "changeme"`. The per-rule thresholds are
 * carried over from gitleaks, which gates the same patterns the same way;
 * see the `minEntropy` fields in `rules.ts`.
 */
export function shannonEntropy(value: string): number {
	if (value.length === 0) {
		return 0;
	}
	const counts = new Map<string, number>();
	for (const char of value) {
		counts.set(char, (counts.get(char) ?? 0) + 1);
	}
	// `for…of` iterates code points, so length must match that unit.
	const total = [...value].length;
	let entropy = 0;
	for (const count of counts.values()) {
		const probability = count / total;
		entropy -= probability * Math.log2(probability);
	}
	return entropy;
}
