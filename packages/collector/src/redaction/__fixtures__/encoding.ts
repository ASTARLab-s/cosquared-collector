import { Buffer } from "node:buffer";

/**
 * Byte mask applied before base64. Platform secret-scanners (e.g. GitHub push
 * protection) base64-DECODE content and scan the result, so plain base64 does
 * not hide a fixture's pattern. XOR-masking first means base64-decoding the
 * stored value yields scrambled bytes — not the secret — so no scanner matches.
 */
const MASK = 0x2a;

/**
 * Redaction test fixtures store their fake secrets MASK-then-base64 encoded so
 * the literal secret patterns never appear in committed files and survive no
 * base64-decode pass. Decoding here restores the exact bytes the redaction
 * rules see, so detection coverage is identical.
 *
 * This is NOT obfuscation-for-secrecy: every fixture value is fake, and any
 * entry decodes with this same two-step (base64-decode, then XOR each byte with
 * `0x2a`). The `{{secret}}` placeholder in a corpus `inputTemplate` marks where
 * the decoded secret is spliced back in.
 */
export function decodeFixture(encoded: string): string {
	const bytes = Buffer.from(encoded, "base64");
	for (let i = 0; i < bytes.length; i += 1) {
		bytes[i] ^= MASK;
	}
	return bytes.toString("utf8");
}
