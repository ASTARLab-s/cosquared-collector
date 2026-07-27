/**
 * The set of git identities that count as "the user", and the rule for matching
 * a commit against them. Pure and dependency-free — no filesystem, no git.
 *
 * WHY MATCH ON NAME, NOT JUST EMAIL: a developer commits under several emails
 * over a repo's life (work, personal, the GitHub `…@users.noreply.github.com`
 * address) while keeping ONE display name. Email-only attribution silently drops
 * those commits — the repo shows "0 commits" even though they are all the user's
 * (the reported bug). Matching the author NAME as well as the email recovers
 * them automatically.
 *
 * TRADEOFF (accepted): a different collaborator who shares the user's exact
 * display name would also match. That is far rarer than one person with several
 * emails, and the failure mode of email-only matching (undercounting the user's
 * own work, corrupting Shipping Momentum) is worse than the failure mode here
 * (a same-name teammate's commits counted). Shared/team repos where collaborators
 * have DIFFERENT names are still correctly excluded.
 *
 * Identity is used TRANSIENTLY for attribution and never transmitted (PRD §4):
 * emails and names live only inside the match and appear in no emitted event.
 */
export interface CommitIdentity {
	/** Lowercased author emails that are the user's. */
	emails: ReadonlySet<string>;
	/** Lowercased author display names that are the user's. */
	names: ReadonlySet<string>;
}

function normalize(value: string): string {
	return value.trim().toLowerCase();
}

/** Builds a {@link CommitIdentity} from raw emails/names, normalizing case and
 * whitespace and dropping empties. */
export function buildCommitIdentity(parts: {
	emails?: Iterable<string>;
	names?: Iterable<string>;
}): CommitIdentity {
	const emails = new Set<string>();
	for (const email of parts.emails ?? []) {
		const value = normalize(email);
		if (value.length > 0) {
			emails.add(value);
		}
	}
	const names = new Set<string>();
	for (const name of parts.names ?? []) {
		const value = normalize(name);
		if (value.length > 0) {
			names.add(value);
		}
	}
	return { emails, names };
}

/** True when at least one identity is known; false means "cannot attribute" —
 * the collector then skips authorship-scoped events (commits, churn). */
export function hasIdentity(identity: CommitIdentity): boolean {
	return identity.emails.size > 0 || identity.names.size > 0;
}

/** A commit is the user's if its author email OR author name matches a known
 * identity (case-insensitive). See the module doc for the name-match rationale. */
export function isUserCommit(
	identity: CommitIdentity,
	authorEmail: string,
	authorName: string,
): boolean {
	return (
		identity.emails.has(normalize(authorEmail)) ||
		identity.names.has(normalize(authorName))
	);
}
