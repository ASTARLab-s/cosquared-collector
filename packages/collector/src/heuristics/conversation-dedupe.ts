/**
 * Shared conversation-identity rules, used by every collector whose tool
 * can record one conversation into more than one session file.
 *
 * Published methodology (PRD §7.6): these rules change session- and
 * prompt-denominated scores, so they live in the open collector package
 * with their grounding stated, exactly like `text-features.ts`. The
 * fingerprints they build are transient — hashed inside the collector,
 * compared, and discarded. No fingerprint is ever emitted on a
 * `SessionEvent` or uploaded (CLAUDE.md invariant #1).
 */

/**
 * Minimum shared prompts before two recordings may be called the same
 * conversation.
 *
 * A single generic opener ("continue", "fix the tests") genuinely recurs
 * across unrelated sessions, and merging those would DELETE real work;
 * dropping a duplicate is the safer error only once the shared sequence is
 * long enough to be improbable by chance. A recording with no authored
 * prompts is likewise never deduped — there is no conversation to have
 * re-recorded.
 */
export const MIN_DEDUPE_PROMPTS = 2;

/**
 * FNV-1a over the prompt text, suffixed with its length. Not cryptographic
 * and does not need to be — it only has to make two recordings of the same
 * prompt compare equal. Hand-rolled to keep this package dependency-free
 * (PRD §8).
 */
export function hashPrompt(text: string): string {
	let hash = 0x811c9dc5;
	for (let index = 0; index < text.length; index += 1) {
		hash ^= text.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return `${hash.toString(16)}:${text.length}`;
}

/** Length of the leading run of prompts two fingerprints share. */
export function sharedPromptPrefix(
	a: readonly string[],
	b: readonly string[],
): number {
	const limit = Math.min(a.length, b.length);
	let shared = 0;
	while (shared < limit && a[shared] === b[shared]) {
		shared += 1;
	}
	return shared;
}

/**
 * Drops session recordings that are re-recordings of a conversation another
 * recording already covers.
 *
 * WHY: some tools write a NEW session file every time a conversation is
 * resumed or forked, replaying the ENTIRE prior history before appending
 * new turns. Left alone, one conversation is ingested once per resume, so
 * every session- and prompt-denominated signal inflates with how often the
 * developer picked a thread back up — a usage pattern, not a behavior we
 * mean to score.
 *
 * Measured (calibration 2026-08-28, Codex): one repo held 47 rollout files
 * carrying 1028 prompts but only 82 distinct ones (12.5x), 34 of the 47 a
 * strict prefix of a longer file; corpus-wide 1.6x — concentrated, so it
 * distorts some users badly and leaves others untouched. Claude Code
 * appends to one file on resume, so it duplicates far less (2026-08-31: a
 * single overlapping pair, 6 replayed prompts, 2.3% of the local corpus) —
 * but it does FORK, which the original strict-prefix rule could not see.
 *
 * RULE: keep the LONGEST recording of each conversation. A recording is
 * dropped when it replays another's opening run of at least
 * {@link MIN_DEDUPE_PROMPTS} prompts AND adds fewer than that many prompts
 * of its own. Equal-length duplicates keep the first seen, so the result
 * does not depend on filesystem walk order.
 *
 * The "adds fewer than N of its own" clause is what makes this safe for
 * FORKS. A resume that merely re-records and stops is covered (its tail is
 * empty — the strict-prefix case this rule subsumes). A genuine branch, in
 * which the developer went back and took a conversation somewhere new,
 * keeps its own session: dropping it would delete work that was really
 * done. The measured fork on the operator's store replayed 6 prompts and
 * added 1, so it is covered; a conversation forked into two substantial
 * branches is not.
 *
 * KNOWN LIMITATIONS, both accepted deliberately:
 *  1. A short generic sequence repeated verbatim (two sessions that are
 *     exactly "continue" then "thanks") can still merge.
 *  2. When a genuine branch IS kept, the opening run it shares with its
 *     parent is still counted in both. Trimming the replayed prefix
 *     instead would leave the branch's first prompt somewhere mid-
 *     conversation, and Task Framing judges first prompts — so trimming
 *     would report a framed conversation as unframed. Double-counting a
 *     shared opening is the smaller distortion of the two.
 */
export function dropResumedDuplicates<T extends { fingerprint: string[] }>(
	candidates: T[],
): T[] {
	const byLengthDesc = [...candidates].sort(
		(a, b) => b.fingerprint.length - a.fingerprint.length,
	);
	const kept: T[] = [];
	for (const candidate of byLengthDesc) {
		const covered =
			candidate.fingerprint.length >= MIN_DEDUPE_PROMPTS &&
			kept.some((existing) => {
				const shared = sharedPromptPrefix(
					candidate.fingerprint,
					existing.fingerprint,
				);
				const ownTail = candidate.fingerprint.length - shared;
				return shared >= MIN_DEDUPE_PROMPTS && ownTail < MIN_DEDUPE_PROMPTS;
			});
		if (!covered) {
			kept.push(candidate);
		}
	}
	return kept;
}
