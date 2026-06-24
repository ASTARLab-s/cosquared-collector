import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { decodeFixture } from "./__fixtures__/encoding";
import { redactText } from "./redact";
import { REDACTION_RULES } from "./rules";

/**
 * RELEASE GATE (CLAUDE.md Validation-before-merge; PRD §11): 100% catch on
 * the seeded secrets corpus, zero survivals, zero benign false positives.
 * A red run here blocks release, full stop.
 *
 * Every corpus secret is fake (vendor-documented examples or generated bodies
 * that fail vendor checksums). Fixtures are stored base64-encoded — `secretB64`
 * plus an `inputTemplate` with a `{{secret}}` placeholder — so their literal
 * patterns never appear in committed files and so they don't trip platform
 * secret-scanners on the public mirror (see `__fixtures__/encoding.ts`).
 * Decoding restores the exact bytes, so detection coverage is unchanged.
 */

interface SecretsCorpusEntry {
	name: string;
	expectedRuleId: string;
	secretB64: string;
	inputTemplate: string;
}

interface BenignCorpusEntry {
	name: string;
	input: string;
}

function loadFixture<T>(fileName: string): T {
	const path = fileURLToPath(
		new URL(`./__fixtures__/${fileName}`, import.meta.url),
	);
	return JSON.parse(readFileSync(path, "utf8")) as T;
}

const secretsCorpus = loadFixture<SecretsCorpusEntry[]>("secrets-corpus.json");
const benignCorpus = loadFixture<BenignCorpusEntry[]>("benign-corpus.json");

describe("secrets corpus (release gate)", () => {
	test.each(
		secretsCorpus.map((entry) => [entry.name, entry] as const),
	)("%s", (_name, { expectedRuleId, secretB64, inputTemplate }) => {
		const secret = decodeFixture(secretB64);
		const input = inputTemplate.replaceAll("{{secret}}", secret);
		const result = redactText(input);
		// The expected rule fired…
		expect(
			result.findings.some((finding) => finding.ruleId === expectedRuleId),
		).toBe(true);
		// …and the secret survived NOWHERE: not in the text (the assertion
		// that actually matters) and not echoed through the findings.
		expect(result.text).not.toContain(secret);
		expect(JSON.stringify(result.findings)).not.toContain(secret);
	});

	// What makes the corpus a LIVING gate: a new rule without a corpus
	// entry fails CI until someone seeds a fixture proving it works.
	test("every redaction rule has at least one corpus entry", () => {
		const covered = new Set(secretsCorpus.map((entry) => entry.expectedRuleId));
		const missing = REDACTION_RULES.map((rule) => rule.id).filter(
			(id) => !covered.has(id),
		);
		expect(missing).toEqual([]);
	});

	test("every corpus entry names a rule that exists", () => {
		const known = new Set(REDACTION_RULES.map((rule) => rule.id));
		const unknown = secretsCorpus
			.map((entry) => entry.expectedRuleId)
			.filter((id) => !known.has(id));
		expect(unknown).toEqual([]);
	});
});

describe("benign corpus (false-positive guard)", () => {
	test.each(
		benignCorpus.map((entry) => [entry.name, entry] as const),
	)("%s", (_name, { input }) => {
		const result = redactText(input);
		expect(result.findings).toEqual([]);
		expect(result.text).toBe(input);
	});
});
