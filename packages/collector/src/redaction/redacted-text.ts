declare const redactedBrand: unique symbol;

/**
 * A string that has passed through `redactText()`. The ONLY producer is the
 * redaction engine — upload-payload and crash-report types must declare
 * their free-text fields as `RedactedText`, which makes "unredacted text
 * reaches the network layer" a compile error, not a code-review hope
 * (CLAUDE.md invariant #1).
 */
export type RedactedText = string & { readonly [redactedBrand]: true };

/** INTERNAL to the redaction module — never export from the package barrel. */
export function brandRedacted(text: string): RedactedText {
	return text as RedactedText;
}
