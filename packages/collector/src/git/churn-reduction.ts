import { type CommitIdentity, isUserCommit } from "./identity";

/**
 * Pure, streaming reduction of raw `git log --numstat` output lines to
 * aggregate churn totals — no filesystem, no network, fully unit-testable.
 *
 * Parses the same line grammar as `log-reduction.ts` (the collector invokes
 * git with `--format=%x1e%cI%x1f%ae%x1f%an --numstat`):
 *   header line:  `\x1e<committerDateIso>\x1f<authorEmail>\x1f<authorName>`
 *   numstat line: `<insertions>\t<deletions>\t<path>` (`-` for binary)
 *
 * PRIVACY CONTRACT: this module relaxes the "inspect a path on its line,
 * never accumulate" posture TRANSIENTLY — per-path addition FIFOs are held
 * inside one reduction, scoped to a bounded scan window (2 × windowDays of
 * commits, never full history), and dropped when it returns. Only the two
 * aggregate totals leave; no path, email, hash, or message appears in the
 * result (CLAUDE.md invariant #1). Unparseable lines are skipped, never
 * fatal (PRD §14 Risk #4).
 *
 * PUBLISHED RULE (PRD §7.3 Shipping Momentum — GitClear 14-day churn):
 * - `linesAdded` = sum of the user's insertions in commits whose timestamp
 *   falls within `windowDays` before `referenceTime` (HEAD committer date).
 * - `linesChurned` = sum of the user's deletions matched FIFO against the
 *   SAME path's additions made within `windowDays` before the deleting
 *   commit — an approximation of "lines deleted shortly after being added".
 * - Binary `-` numstat counts as 0. Non-user commits are skipped entirely:
 *   their additions never seed FIFOs and their deletions never match
 *   (personal scope — churn measures the user's own rework).
 *
 * HONESTY NOTE: numstat-FIFO churn is an approximation. There is no line
 * identity, and renames are NOT resolved — a rename numstat path like
 * `src/{old => new}/file.ts` is treated as its own literal path key
 * (consistent and deterministic, but a rename breaks the add→delete chain).
 * Still strictly more informative than raw commit counts (GitClear: high
 * commits + high churn ≠ shipping); overclaiming precision would violate
 * the PRD §7.6 honesty rule.
 */

/**
 * The churn trailing window (PRD §7.3: "lines reverted/rewritten within
 * 2 weeks"). The collector scans 2 × this many days of history so a
 * deletion early in the window can still see the additions it churns.
 */
export const CHURN_WINDOW_DAYS = 14;

const DAY_MILLIS = 86_400_000;

/** Record separator emitted by `%x1e` at the start of each header line. */
const HEADER_PREFIX = "\x1e";
/** Field separator emitted by `%x1f` between the date, email, and name fields. */
const FIELD_SEPARATOR = "\x1f";
/** `<insertions>\t<deletions>\t<path>`; `-` counts (binary files) parse as 0. */
const NUMSTAT_LINE = /^(\d+|-)\t(\d+|-)\t(.+)$/;

/** Aggregate churn counts — the only data that leaves this module. */
export interface ChurnTotals {
	windowDays: number;
	linesAdded: number;
	linesChurned: number;
}

export interface ReduceChurnOptions {
	windowDays: number;
	/** TRANSIENT — the user's identities; each commit's author is matched against
	 * them ({@link isUserCommit}) and dropped. Churn is personal-scoped. */
	identity: CommitIdentity;
	/** ISO timestamp the `linesAdded` window ends at (HEAD committer date). */
	referenceTime: string;
}

/** TRANSIENT parse buffer: one of the user's commits, paths included. */
interface ChurnCommit {
	timestampMillis: number;
	files: Array<{ path: string; insertions: number; deletions: number }>;
}

/** TRANSIENT: an addition batch awaiting later deletions on the same path. */
interface AdditionBatch {
	timestampMillis: number;
	remaining: number;
}

function parseCount(raw: string): number {
	return raw === "-" ? 0 : Number(raw);
}

/**
 * Reduces a stream of raw log lines to {@link ChurnTotals} per the
 * published rule above. Buffers the user's parsed commits (bounded by the
 * collector's scan window) because git emits newest-first while FIFO
 * matching must run oldest-first.
 */
export async function reduceChurnLines(
	lines: AsyncIterable<string> | Iterable<string>,
	{ windowDays, identity, referenceTime }: ReduceChurnOptions,
): Promise<ChurnTotals> {
	const commits: ChurnCommit[] = [];
	let current: ChurnCommit | null = null;

	for await (const line of lines) {
		if (line.startsWith(HEADER_PREFIX)) {
			// `<date>\x1f<email>\x1f<name>` — three fields (see log-reduction).
			const parts = line.slice(HEADER_PREFIX.length).split(FIELD_SEPARATOR);
			if (parts.length < 3) {
				current = null;
				continue;
			}
			const [rawDate, authorEmail, ...nameParts] = parts;
			const timestampMillis = Date.parse(rawDate);
			const authorName = nameParts.join(FIELD_SEPARATOR);
			// Non-user commits are skipped entirely (published rule above).
			current =
				Number.isNaN(timestampMillis) ||
				!isUserCommit(identity, authorEmail, authorName)
					? null
					: { timestampMillis, files: [] };
			if (current !== null) {
				commits.push(current);
			}
			continue;
		}
		if (current === null) {
			continue;
		}
		const numstat = NUMSTAT_LINE.exec(line);
		if (numstat === null) {
			continue;
		}
		const [, rawInsertions, rawDeletions, path] = numstat;
		current.files.push({
			path,
			insertions: parseCount(rawInsertions),
			deletions: parseCount(rawDeletions),
		});
	}

	const windowMillis = windowDays * DAY_MILLIS;
	const referenceMillis = Date.parse(referenceTime);
	// Path-keyed FIFO of addition batches — transient, scoped to this call.
	const additionBatchesByPath = new Map<string, AdditionBatch[]>();
	let linesAdded = 0;
	let linesChurned = 0;

	// git emits newest-first; FIFO matching needs oldest-first.
	for (const commit of commits.slice().reverse()) {
		for (const file of commit.files) {
			// Deletions match BEFORE this commit's own additions are pushed:
			// a rewrite (+n/-n on one path) deletes old lines, not its own.
			if (file.deletions > 0) {
				const batches = additionBatchesByPath.get(file.path) ?? [];
				let toMatch = file.deletions;
				while (toMatch > 0 && batches.length > 0) {
					const oldest = batches[0];
					if (oldest.timestampMillis < commit.timestampMillis - windowMillis) {
						// Expired: commits are processed in ascending time, so this
						// batch can never match a later deletion either — drop it.
						batches.shift();
						continue;
					}
					const matched = Math.min(toMatch, oldest.remaining);
					linesChurned += matched;
					toMatch -= matched;
					oldest.remaining -= matched;
					if (oldest.remaining === 0) {
						batches.shift();
					}
				}
			}
			if (file.insertions > 0) {
				const batches = additionBatchesByPath.get(file.path) ?? [];
				batches.push({
					timestampMillis: commit.timestampMillis,
					remaining: file.insertions,
				});
				additionBatchesByPath.set(file.path, batches);
				if (
					!Number.isNaN(referenceMillis) &&
					commit.timestampMillis >= referenceMillis - windowMillis
				) {
					linesAdded += file.insertions;
				}
			}
		}
	}

	return { windowDays, linesAdded, linesChurned };
}
