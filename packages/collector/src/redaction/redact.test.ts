import { describe, expect, test } from "vitest";
import { decodeFixture } from "./__fixtures__/encoding";
import { redactText } from "./redact";
import type { RedactedText } from "./redacted-text";
import type { RedactionRule } from "./rules";

/** AWS's own documented example key id — fake by definition. */
const FAKE_AWS_KEY = "AKIAIOSFODNN7EXAMPLE";

describe("redactText", () => {
	test("replaces a detected secret with its rule-id placeholder", () => {
		const result = redactText(`creds: ${FAKE_AWS_KEY} in use`);
		expect(result.text).toBe("creds: [REDACTED:aws-access-token] in use");
		expect(result.findings).toEqual([{ ruleId: "aws-access-token", count: 1 }]);
	});

	test("preserves surrounding context when the rule scopes a secret group", () => {
		const result = redactText('api_key = "VwNoFg7YzQrIjAb2TuLm"');
		expect(result.text).toBe('api_key = "[REDACTED:generic-api-key]"');
	});

	test("reports findings as rule id and count only — never matched text", () => {
		const result = redactText(`token ${FAKE_AWS_KEY} and brian@example.com`);
		const serializedFindings = JSON.stringify(result.findings);
		expect(serializedFindings).not.toContain(FAKE_AWS_KEY);
		expect(serializedFindings).not.toContain("brian@example.com");
		for (const finding of result.findings) {
			expect(Object.keys(finding).sort()).toEqual(["count", "ruleId"]);
		}
	});

	test("counts multiple occurrences of the same rule", () => {
		const result = redactText(
			`first ${FAKE_AWS_KEY} then again ${FAKE_AWS_KEY}`,
		);
		expect(result.findings).toEqual([{ ruleId: "aws-access-token", count: 2 }]);
		expect(result.text).not.toContain(FAKE_AWS_KEY);
	});

	test("redacts multiple different secret types in one pass", () => {
		const result = redactText(
			`key ${FAKE_AWS_KEY} mail user@example.com at /Users/dev/projects`,
		);
		expect(result.findings.map((finding) => finding.ruleId)).toEqual([
			"aws-access-token",
			"email-address",
			"absolute-home-path",
		]);
		expect(result.text).toBe(
			"key [REDACTED:aws-access-token] mail [REDACTED:email-address] at [REDACTED:absolute-home-path]",
		);
	});

	test("is idempotent: redacting redacted text changes nothing", () => {
		const once = redactText(
			`AWS_SECRET_KEY=${FAKE_AWS_KEY} postgres://u:p4ssw0rdXyz@db.internal/app brian@example.com`,
		);
		const twice = redactText(once.text);
		expect(twice.text).toBe(once.text);
		expect(twice.findings).toEqual([]);
	});

	test("is deterministic: identical input yields byte-identical output", () => {
		const input = `mixed ${FAKE_AWS_KEY} and /home/alice/project and x@y.io`;
		const first = redactText(input);
		const second = redactText(input);
		expect(JSON.stringify(first)).toBe(JSON.stringify(second));
	});

	test("skips low-entropy matches on entropy-gated rules", () => {
		const input = 'password = "changeme"';
		const result = redactText(input);
		expect(result.text).toBe(input);
		expect(result.findings).toEqual([]);
	});

	test("applies caller-supplied additional rules after built-ins", () => {
		const internalHostRule: RedactionRule = {
			id: "internal-hostname",
			category: "secret",
			description: "test-only rule for internal hostnames",
			pattern: /\binternal-[a-z]+\.corp\b/g,
		};
		const result = redactText(
			`deploy to internal-billing.corp as ${FAKE_AWS_KEY}`,
			{ additionalRules: [internalHostRule] },
		);
		expect(result.text).toBe(
			"deploy to [REDACTED:internal-hostname] as [REDACTED:aws-access-token]",
		);
		// Built-in findings come first: additional rules run after the table.
		expect(result.findings.map((finding) => finding.ruleId)).toEqual([
			"aws-access-token",
			"internal-hostname",
		]);
	});

	test("returns the input unchanged with zero findings for clean text", () => {
		const input = "refactor the parser and add table-driven tests";
		const result = redactText(input);
		expect(result.text).toBe(input);
		expect(result.findings).toEqual([]);
	});

	test("handles empty and whitespace-only input", () => {
		expect(redactText("").text).toBe("");
		expect(redactText("  \n\t ").text).toBe("  \n\t ");
		expect(redactText("").findings).toEqual([]);
	});

	test("redacts two adjacent secrets on one line", () => {
		const result = redactText(`${FAKE_AWS_KEY} ${FAKE_AWS_KEY}`);
		expect(result.text).toBe(
			"[REDACTED:aws-access-token] [REDACTED:aws-access-token]",
		);
	});

	test("redacts secrets at the very start and very end of the input", () => {
		const result = redactText(`${FAKE_AWS_KEY} middle ${FAKE_AWS_KEY}`);
		expect(result.text.startsWith("[REDACTED:aws-access-token]")).toBe(true);
		expect(result.text.endsWith("[REDACTED:aws-access-token]")).toBe(true);
	});

	test("preserves surrounding unicode and emoji intact", () => {
		const result = redactText(`🔑 creds ${FAKE_AWS_KEY} fertig ✅ — naïve`);
		expect(result.text).toBe(
			"🔑 creds [REDACTED:aws-access-token] fertig ✅ — naïve",
		);
	});

	test("redacts a multiline PEM private key block", () => {
		// Fake PEM stored base64-encoded so the literal block stays out of the
		// repo text (see `__fixtures__/encoding.ts`); decoding restores it.
		const pem = decodeFixture(
			"BwcHBwdob21jZAp4eWsKenhjfGt+bwphb3MHBwcHByBnY2NvRV1jaGtrYWlre29rTEtBT0xLQU9MS0FPTEtBT0xLQU9MS0FPTEtBT0xLQU9MS0FPTEtBT0xLQU9MS0FPIExLQU9MS0FPTEtBT0xLQU9MS0FPTEtBT0xLQU9MS0FPTEtBT0xLQU9MS0FPTEtBT0xLQU9MS0FPTEtBT0xLQU8gBwcHBwdvZG4KeHlrCnp4Y3xrfm8KYW9zBwcHBwc=",
		);
		const result = redactText(`dump:\n${pem}\ndone`);
		expect(result.text).toBe("dump:\n[REDACTED:private-key]\ndone");
	});

	test("a bare string is not assignable to RedactedText", () => {
		// @ts-expect-error — only redactText() may produce RedactedText
		// (CLAUDE.md invariant #1: the brand is the enforcement point).
		const forbidden: RedactedText = "raw unredacted string";
		expect(typeof forbidden).toBe("string");
	});
});
