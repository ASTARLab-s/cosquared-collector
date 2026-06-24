import { describe, expect, test } from "vitest";
import { decodeFixture } from "./__fixtures__/encoding";
import { ruleMatches } from "./redact";
import { REDACTION_RULES, type RedactionRule } from "./rules";

/**
 * One fixture table per rule, exercised through `ruleMatches` (full engine
 * semantics: secret-group participation + entropy gate), never bare
 * `pattern.test()`. These fixtures ARE the public methodology documentation:
 * every secret value is fake — vendor-documented examples or generated
 * bodies that fail vendor checksums.
 */

function ruleById(id: string): RedactionRule {
	const rule = REDACTION_RULES.find((candidate) => candidate.id === id);
	if (rule === undefined) {
		throw new Error(`unknown rule id: ${id}`);
	}
	return rule;
}

const fixturesByRule: Record<
	string,
	Record<string, { input: string; expected: boolean }>
> = {
	"private-key": {
		pemRsaPrivateKeyBlock: {
			input: decodeFixture(
				"BwcHBwdob21jZAp4eWsKenhjfGt+bwphb3MHBwcHByBnY2NvRV1jaGtrYWlre29rTEtBT0xLQU9MS0FPTEtBT0xLQU9MS0FPTEtBT0xLQU9MS0FPTEtBT0xLQU9MS0FPIExLQU9MS0FPTEtBT0xLQU9MS0FPTEtBT0xLQU9MS0FPTEtBT0xLQU9MS0FPTEtBT0xLQU9MS0FPTEtBT0xLQU8gBwcHBwdvZG4KeHlrCnp4Y3xrfm8KYW9zBwcHBwc=",
			),
			expected: true,
		},
		opensshPrivateKeyBlock: {
			input: decodeFixture(
				"BwcHBwdob21jZAplem9keXliCnp4Y3xrfm8KYW9zBwcHBwcgSBloRkhEZFBLaRtYcHJBXk5Ab2tra2trTEtBT0xLQU9MS0FPTEtBT0xLQU9MS0FPTEtBT0xLQU9MS0FPTEtBT0xLQU8gBwcHBwdvZG4KZXpvZHl5Ygp6eGN8a35vCmFvcwcHBwcH",
			),
			expected: true,
		},
		// Public keys are not secrets.
		publicKeyBlockIsNotPrivate: {
			input:
				"-----BEGIN PUBLIC KEY-----\nMFwwDQYJKoZIhvcNAQEBBQADSwAwSAJBfakefakefakefakefakefakefakefake\n-----END PUBLIC KEY-----",
			expected: false,
		},
		truncatedBlockWithoutEndMarker: {
			input: decodeFixture(
				"BwcHBwdob21jZAp4eWsKenhjfGt+bwphb3MHBwcHByBnY2NvRV1jaGtrYWlre29rTEtBTw==",
			),
			expected: false,
		},
	},
	"aws-access-token": {
		// AWS's own documented example key id.
		vendorExampleAccessKeyId: {
			input: decodeFixture("SVhPTlkQCmthY2tjZXlsZW5kZB1vcmtnemZv"),
			expected: true,
		},
		truncatedKeyIdIsTooShort: {
			input: "creds: AKIAIOSFODNN7",
			expected: false,
		},
		lowercasePrefixDoesNotMatch: {
			input: "akiaiosfodnn7example",
			expected: false,
		},
		// Entropy gate: format-valid but degenerate body.
		lowEntropyBodyIsGated: {
			input: decodeFixture("a2Fja2tra2tra2tra2tra2tra2s="),
			expected: false,
		},
	},
	"github-pat": {
		classicPat: {
			input: decodeFixture(
				"XkVBT0QKTUJadWtmfUJZGW96S0ZdHWN+T1oaaGdyQ14ebHtIR1ISYH9MWxtpZA==",
			),
			expected: true,
		},
		bodyOf35CharsIsTooShort: {
			input: decodeFixture(
				"XkVBT0QKTUJadWtmfUJZGW96S0ZdHWN+T1oaaGdyQ14ebHtIR1ISYH9MWxtp",
			),
			expected: false,
		},
	},
	"github-fine-grained-pat": {
		fineGrainedPat: {
			input: decodeFixture(
				"TUNeQl9IdVpLXnVrZEtEGm57TlsZbX5NXhxgfUBdE2dwR1BpeklaGGx5TFkfY3xDXBJmc0ZTaGVIRRtveE9YHmJ/Ql8dYXJBUmtkS0QabntOWxltfk1eHGB9QF0T",
			),
			expected: true,
		},
		bodyOf81CharsIsTooShort: {
			input: decodeFixture(
				"TUNeQl9IdVpLXnVrZEtEGm57TlsZbX5NXhxgfUBdE2dwR1BpeklaGGx5TFkfY3xDXBJmc0ZTaGVIRRtveE9YHmJ/Ql8dYXJBUmtkS0QabntOWxltfk1eHGB9QF0=",
			),
			expected: false,
		},
	},
	"github-oauth": {
		oauthAccessToken: {
			input: decodeFixture(
				"TUJFdWx5TFkfY3xDXBJmc0ZTaGVIRRtveE9YHmJ/Ql8dYXJBUmtkSw==",
			),
			expected: true,
		},
		truncatedTokenIsTooShort: {
			input: decodeFixture(
				"TUJFdWx5TFkfY3xDXBJmc0ZTaGVIRRtveE9YHmJ/Ql8dYXJBUmtk",
			),
			expected: false,
		},
	},
	"github-app-token": {
		serverToServerToken: {
			input: decodeFixture(
				"TUJZdWl+QRtjcFsdZUxdbn9GGGBLWBJ6TVJvfEcZYUhZE3tCU2x9RA==",
			),
			expected: true,
		},
		userToServerToken: {
			input: decodeFixture(
				"TUJfdWl+QRtjcFsdZUxdbn9GGGBLWBJ6TVJvfEcZYUhZE3tCU2x9RA==",
			),
			expected: true,
		},
		unknownPrefixDoesNotMatch: {
			input: "ghx_CTk1IZq7OfwDUl2Jar8PgxEVm3Kbs9QhyFWn",
			expected: false,
		},
	},
	"github-refresh-token": {
		refreshToken: {
			input: decodeFixture(
				"TUJYdW59WhJ4QRlnTFNiS15pfEUde0AYZk9SbXBZaH9EHHpDG2FOXQ==",
			),
			expected: true,
		},
		truncatedTokenIsTooShort: {
			input: decodeFixture(
				"TUJYdW59WhJ4QRlnTFNiS15pfEUde0AYZk9SbXBZaH9EHHpDG2FO",
			),
			expected: false,
		},
	},
	"gitlab-pat": {
		personalAccessToken: {
			input: decodeFixture("TUZaS14HYn9CXx1hckFSa2RLRBpue05bGW0="),
			expected: true,
		},
		bodyOf11CharsIsTooShort: {
			input: decodeFixture("TUZaS14HYn9CXx1hckFSa2Q="),
			expected: false,
		},
	},
	"slack-bot-token": {
		botToken: {
			input: decodeFixture(
				"eWZraWF1aGV+F1JFUkgHGBIZHR4cHxMYGhsZBxMbEhgdGRweHxoYExsHZnNGU2hlSEUbb3hPWB5if0JfHWFyQVJr",
			),
			expected: true,
		},
		digitGroupsTooShort: {
			input: decodeFixture("UkVSSAcbGBkeHwccHRITGg=="),
			expected: false,
		},
	},
	"slack-user-token": {
		userToken: {
			input: decodeFixture(
				"UkVSWgcYEhkdHhwfExgaBxMbEhgdGRweHxoHGxoYExkSHh0fHAcaHU8fSRlLGxJMHE4eSBgTGh1PH0kZSxsSTBxOHkg=",
			),
			expected: true,
		},
		onlyTwoDigitGroupsDoesNotMatch: {
			input: decodeFixture("UkVSWgcYEhkdHhwfExgaBxMbEhgdGRweHxo="),
			expected: false,
		},
	},
	"slack-webhook-url": {
		incomingWebhookUrl: {
			input: decodeFixture(
				"Ql5eWlkQBQVCRUVBWQRZRktJQQRJRUcFWU9YXENJT1kFfhgSGR0eHB8TBWgTGxIYHRkcHgVvSFNmQx95WmlwXWBNGXtEa3JfYk8bZUY=",
			),
			expected: true,
		},
		pathTooShortToBeACredential: {
			input: decodeFixture(
				"Ql5eWlkQBQVCRUVBWQRZRktJQQRJRUcFWU9YXENJT1kFWUJFWF4=",
			),
			expected: false,
		},
	},
	"stripe-access-token": {
		testModeSecretKey: {
			input: decodeFixture(
				"eX54Y3pvdWFvcxdZQXVeT1ledW1AaUwSSB5yGn5dellmRWJBbk0TSR9zGw==",
			),
			expected: true,
		},
		// Publishable keys (pk_) are not secrets.
		publishableKeyIsNotASecret: {
			input: "pk_live_GjCf8b4X0TwPsLoHkDg9c5Y1",
			expected: false,
		},
	},
	"openai-api-key": {
		legacyKeyWithMarker: {
			input: decodeFixture(
				"RVpPREtDBEtaQ3VBT1MKFwoNWUEHY1pnXntSfxtzH0kTTW5BYkVmWXp+GWhGSEFsYGBffBxCY15/H01iWX4eTG1YeRlPDQ==",
			),
			expected: true,
		},
		// The T3BlbkFJ marker is part of the format; sk- alone is not enough.
		skPrefixWithoutMarkerDoesNotMatch: {
			input: "sk-IpMtQxU1Y5c9gDkHoLsPJuV6hItU5gHsT4fGrS3e",
			expected: false,
		},
	},
	"anthropic-api-key": {
		apiKey: {
			input: decodeFixture(
				"a2R+YnhlemNpdWt6Y3Vhb3MXWUEHS0ReB0taQxoZB2FQT2BTTmNSSWJdSG1cS2xfcG9ec25ZcmlYfWhbfGtafxNFfhJEeR1HeBxGex9Beh5AZRlDZBhCZxtNZhpMYVBPYFNOY1JJYl1IbVxLbF9wb15zbllyaVh9aFt8a2tr",
			),
			expected: true,
		},
		truncatedBodyIsTooShort: {
			input: decodeFixture(
				"WUEHS0ReB0taQxoZB2FQT2BTTmNSSWJdSG1cS2xfcG9ec25ZcmlYfWhbfGtraw==",
			),
			expected: false,
		},
	},
	"anthropic-admin-api-key": {
		adminKey: {
			input: decodeFixture(
				"WUEHS0ReB0tOR0NEGhsHZxlBeBJafW5fSGNQTWQeRnkTW3JvXElgGkJlH0d+a1hzbF1OYRtDehxEf2hZcG1ST2YYQHsdRXxpXktiU0xnGUF4Elp9bl9IY1BNZB5GeRNbcm9cSWAaQmUfR35ra2s=",
			),
			expected: true,
		},
		truncatedBodyIsTooShort: {
			input: decodeFixture(
				"WUEHS0ReB0tOR0NEGhsHZxlBeBJafW5fSGNQTWQeRnkTW3JvXElraw==",
			),
			expected: false,
		},
	},
	"gcp-api-key": {
		apiKey: {
			input: decodeFixture(
				"QU9TF2tjUEtkEl5PemtcTXhpUkN+b1BBfG0bR3JjGUVwYR9bSGcdWU5lEw==",
			),
			expected: true,
		},
		bodyOf16CharsIsTooShort: {
			input: decodeFixture("a2NQS2QSXk96a1xNeGlSQ35vUEE="),
			expected: false,
		},
	},
	"npm-access-token": {
		registryToken: {
			input: decodeFixture(
				"RFpHdUtCRVwYE01EXxsSTEdeGh1PRllQHE5BWFMfSUBbUh5IQ1pdGQ==",
			),
			expected: true,
		},
		truncatedTokenIsTooShort: {
			input: decodeFixture("RFpHdUtCRVwYE01EXxsSTEdeGh1PRllQ"),
			expected: false,
		},
	},
	"pypi-upload-token": {
		uploadToken: {
			input: decodeFixture(
				"WlNaQwdrTW9jSWJGXUt5H1xJR0llbBxSRUx9ZG8fXURPfGduHlxHTn9maRlfRkl+YWgYXkFIeWBrG1lAS3hjExpYQ3B7YhJQW0Jzem0dU1o=",
			),
			expected: true,
		},
		bodyTooShortAfterFixedPrefix: {
			input: decodeFixture("WlNaQwdrTW9jSWJGXUt5H1xJR0llbBxSRUx9ZG8fXURP"),
			expected: false,
		},
	},
	"huggingface-access-token": {
		accessToken: {
			input: decodeFixture(
				"Qkx1bmF4c0xHXmtiZXxJQFtSb2Z5cE1EX2hjen1OQVhTbGd+Sw==",
			),
			expected: true,
		},
		// The token body is letters-only; a digit breaks the format.
		digitInBodyDoesNotMatch: {
			input: decodeFixture(
				"Qkx1bmF4c0xHXmtiZXxJQFtSGWZ5cE1EX2hjen1OQVhTbGd+Sw==",
			),
			expected: false,
		},
	},
	"sendgrid-api-token": {
		apiToken: {
			input: decodeFixture(
				"eW0EemdgbW5rHR4bU1xZWkdATU5Lcn94ZQR7emVkZ2ZhYGNibWxvbmloaxMSHRwfHhkYGxpQU1JdXF9eWVhbWkVER0ZB",
			),
			expected: true,
		},
		bodyTooShort: {
			input: decodeFixture("eW0EemdgbW5rHR4bU1xZWkdATU5L"),
			expected: false,
		},
	},
	"twilio-api-key": {
		apiKeySid: {
			input: decodeFixture("eWEZSxsSTBxOHkgYExodTx9JGUsbEkwcTh5IGBMaHU8fSQ=="),
			expected: true,
		},
		bodyOf31HexCharsIsTooShort: {
			input: "SK3a18f6d4b2907e5c3a18f6d4b2907e5",
			expected: false,
		},
	},
	"flyio-access-token": {
		deployToken: {
			input: decodeFixture(
				"TEUbdXhBGWdMU2JLXml8RR17QBhmT1JtcFlof0QcekMbYU5dbHNYa35HH2VCGmA=",
			),
			expected: true,
		},
		truncatedTokenIsTooShort: {
			input: decodeFixture("TEUbdXhBGWdMU2JLXml8RR17QBg="),
			expected: false,
		},
	},
	"resend-api-key": {
		apiKey: {
			input: decodeFixture(
				"eG95b2RudWFvcxdYT3V5WmlwXWBNGXtEa3JfYk8bZUYSfFlsSVA=",
			),
			expected: true,
		},
		// Word-boundary + length guard: prose with a short re_ identifier.
		shortIdentifierInProse: {
			input: "consider more re_use of the helpers",
			expected: false,
		},
	},
	jwt: {
		supabaseShapedAnonKey: {
			input: decodeFixture(
				"T1NgQkhtSUNlQ2Bjf1BjG2RDY1ljRHgfSWljHGNBWnJ8aWATBE9TYFpJGWdDZUNgUE5yaEJzR2xQcHljWWNEYEZwQ2McY0dsQ3MYeEZwR05FS31aWEhtG19IGWhSSURkGmNDXUNJRxNZcHljHGNHbF9IGB5DTHsETm1CWkkYRlBzfXBCSxh8UEt9Tl9zcngbSUd8R0gZYBpwcmQaS30fRA==",
			),
			expected: true,
		},
		// Two segments without the second dot are not a JWT.
		twoSegmentEyStringIsNotAJwt: {
			input: decodeFixture(
				"T1NgQkhtSUNlQ2Bjf1BjG2RDY1ljRHgfSWljHGNBWnJ8aWATBE9TYFpJGWdDZUNgUE5yaEJzR2xQcHlgEw==",
			),
			expected: false,
		},
	},
	"generic-api-key": {
		highEntropyKeywordAssignment: {
			input: 'api_key = "VwNoFg7YzQrIjAb2TuLm"',
			expected: true,
		},
		// Entropy gate: placeholder-looking values don't fire.
		lowEntropyPlaceholderValue: {
			input: 'password = "changeme"',
			expected: false,
		},
		// Regression guard: keyword-substring identifiers with prose-like values.
		secretSantaVariableIsNotACredential: {
			input: "const secretSantaPairs = participants",
			expected: false,
		},
	},
	"env-value-assignment": {
		// No entropy gate here: a low-entropy real password still gets caught
		// (the secret-ish VARIABLE NAME is the signal, not the value's shape).
		exportedLowEntropyPassword: {
			input: decodeFixture(
				"T1JaRVheCnptemt5eX1leG4XS0tLSwdISEhIB0tLS0sHSEhISA==",
			),
			expected: true,
		},
		quotedValueWithSpaces: {
			input: 'SMTP_PASSWORD="letmein letmein"',
			expected: true,
		},
		nonSecretVariableNameDoesNotMatch: {
			input: "PATH=/usr/local/bin",
			expected: false,
		},
	},
	"credential-url": {
		postgresConnectionString: {
			input: decodeFixture(
				"WkVZXk1YT1kQBQVLTkdDRBBZGUlYT156HllZXRpYTmpOSARDRF5PWERLRhAfHhkYBUtaWg==",
			),
			expected: true,
		},
		emptyUserRedisUrl: {
			input: decodeFixture(
				"WE9OQ1kQBQUQWh5ZWV0aWE54T05DWWpJS0lCTwRDRF5PWERLRhAcGR0T",
			),
			expected: true,
		},
		urlWithoutUserinfoDoesNotMatch: {
			input: "https://github.com/org/repo.git",
			expected: false,
		},
	},
	"email-address": {
		plainAddressInProse: {
			input: decodeFixture(
				"WkNETQpIWENLRGpPUktHWkZPBElFRwpdQk9ECl5CTwpYT1pFWF4KRktETlk=",
			),
			expected: true,
		},
		hostWithoutTldDoesNotMatch: {
			input: "user@localhost",
			expected: false,
		},
	},
	"absolute-home-path": {
		macosHomePath: {
			input: decodeFixture(
				"T1hYRVgKS14KBX9ZT1hZBU5PXAVuT1xPRkVaT1gFWUtETkhFUgVZWEkFQ0ROT1IEXlkQHhg=",
			),
			expected: true,
		},
		linuxHomePath: {
			input: decodeFixture(
				"SUVETENNCkZFS05PTgpMWEVHCgVCRUdPBUtGQ0lPBQRJRURMQ00FSUVZW19LWE9OBUlFRExDTQReRUdG",
			),
			expected: true,
		},
		windowsHomePath: {
			input: decodeFixture(
				"XVhFXk8KaRB2f1lPWFl2SEVIdm5FSV9HT0ReWXZYT1pFWF4EQl5HRg==",
			),
			expected: true,
		},
		relativePathDoesNotMatch: {
			input: "see src/redaction/rules.ts for the rule table",
			expected: false,
		},
		systemPathOutsideHomeDoesNotMatch: {
			input: "PATH includes /usr/local/bin",
			expected: false,
		},
	},
};

describe.each(Object.entries(fixturesByRule))("%s", (ruleId, cases) => {
	test.each(Object.entries(cases))("%s", (_name, { input, expected }) => {
		expect(ruleMatches(ruleById(ruleId), input)).toBe(expected);
	});
});

describe("rules table", () => {
	test("every redaction rule has per-rule fixtures", () => {
		const covered = new Set(Object.keys(fixturesByRule));
		const missing = REDACTION_RULES.map((rule) => rule.id).filter(
			(id) => !covered.has(id),
		);
		expect(missing).toEqual([]);
	});

	test("every rule pattern carries the g flag", () => {
		for (const rule of REDACTION_RULES) {
			expect(rule.pattern.flags).toContain("g");
		}
	});

	test("rule ids are unique", () => {
		const ids = REDACTION_RULES.map((rule) => rule.id);
		expect(new Set(ids).size).toBe(ids.length);
	});
});
