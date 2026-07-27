import type { SessionEvent, SessionSource } from "@cosquared/schema";

/**
 * Options passed to every collector run.
 *
 * Collectors receive all filesystem locations as parameters — they never
 * read product configuration or constants, so this public package stays
 * brand-free (PRD §6 open/closed boundary).
 */
export interface CollectorOptions {
	/** Absolute path to the repo being analyzed. */
	repoPath: string;
	/** Only return events after this time (incremental sync). */
	since?: Date;
	/**
	 * Extra git identities that also count as "the user", merged with the ones the
	 * git collector reads from the repo's own config (effective `user.email` +
	 * `user.name`). Lets a developer who commits under several emails/names declare
	 * the rest (`git_emails`/`git_names` in `~/.cosquared/config.toml`) so none of
	 * their commits are dropped. Other collectors ignore it.
	 */
	identities?: {
		emails?: readonly string[];
		names?: readonly string[];
	};
}

/**
 * A collector reads one tool's local session store (or git metadata) and
 * converts it into the normalized {@link SessionEvent} stream defined in
 * `@cosquared/schema`. Adding a new tool integration means adding a new
 * Collector implementation — never a parallel schema or scoring path
 * (CLAUDE.md "Event normalization" pattern).
 *
 * Implementations MUST be read-only with respect to the stores they parse:
 * analysis must never mutate a user's session history or repo.
 */
export interface Collector {
	/** Which tool this collector reads. Must match SessionEvent.source. */
	readonly source: SessionSource;
	/** True if this tool's session store exists on this machine. Read-only check. */
	detect(): Promise<boolean>;
	/** Parse local session stores into normalized events. MUST be read-only. */
	collect(options: CollectorOptions): Promise<SessionEvent[]>;
}
