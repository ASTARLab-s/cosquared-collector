import { isTestFilePath } from "./heuristics";

/**
 * Pure, streaming reduction of raw `git log` output lines to per-commit
 * structural stats — no filesystem, no network, fully unit-testable.
 *
 * The collector invokes git with `--format=%x1e%cI%x1f%ae --numstat`, so
 * the line grammar this module parses is:
 *   header line:  `\x1e<committerDateIso>\x1f<authorEmail>`
 *   numstat line: `<insertions>\t<deletions>\t<path>` (`-` for binary)
 *   blank lines between records
 *
 * Commit messages are NEVER read — the format string simply does not
 * request them. Each numstat path is inspected on its line and discarded:
 * no file list is ever accumulated (privacy by construction, CLAUDE.md
 * invariant #1, and O(commits) memory on huge repos). Unparseable lines
 * are skipped, never fatal (PRD §14 Risk #4).
 */

/** Record separator emitted by `%x1e` at the start of each header line. */
const HEADER_PREFIX = "\x1e";
/** Field separator emitted by `%x1f` between date and email. */
const FIELD_SEPARATOR = "\x1f";

export interface ReducedCommit {
	/** Committer date, normalized to UTC `Z` form (see header parsing note). */
	timestamp: string;
	/** TRANSIENT — used for exact-match author filtering, then dropped. */
	authorEmail: string;
	filesChanged: number;
	insertions: number;
	deletions: number;
	touchedTestFiles: boolean;
}

/**
 * Parses a header line into a started commit, or null if malformed.
 *
 * `%cI` emits the committer's local offset (`2026-06-11T09:30:00+02:00`),
 * but the schema envelope's `z.iso.datetime()` accepts only the UTC `Z`
 * form — so the date is normalized here via `Date#toISOString`. An
 * unparseable date drops the commit rather than failing the run.
 */
function parseHeaderLine(line: string): ReducedCommit | null {
	const separatorIndex = line.indexOf(FIELD_SEPARATOR);
	if (separatorIndex === -1) {
		return null;
	}
	const rawDate = line.slice(HEADER_PREFIX.length, separatorIndex);
	const parsedMillis = Date.parse(rawDate);
	if (Number.isNaN(parsedMillis)) {
		return null;
	}
	return {
		timestamp: new Date(parsedMillis).toISOString(),
		authorEmail: line.slice(separatorIndex + 1),
		filesChanged: 0,
		insertions: 0,
		deletions: 0,
		touchedTestFiles: false,
	};
}

/** `<insertions>\t<deletions>\t<path>`; `-` counts (binary files) parse as 0. */
const NUMSTAT_LINE = /^(\d+|-)\t(\d+|-)\t(.+)$/;

/**
 * Reduces a stream of raw log lines to one {@link ReducedCommit} per
 * commit. A header line finalizes the previous commit and starts a new
 * one; a numstat line increments `filesChanged`, adds line counts (binary
 * `-` counts as 0 but still increments `filesChanged`), and ORs
 * `touchedTestFiles` via {@link isTestFilePath}. Feeds the `commit` event
 * (Shipping Momentum + Testing Discipline, PRD §7.3).
 */
export async function reduceLogLines(
	lines: AsyncIterable<string> | Iterable<string>,
): Promise<ReducedCommit[]> {
	const commits: ReducedCommit[] = [];
	let current: ReducedCommit | null = null;
	for await (const line of lines) {
		if (line.startsWith(HEADER_PREFIX)) {
			if (current !== null) {
				commits.push(current);
			}
			current = parseHeaderLine(line);
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
		current.filesChanged += 1;
		current.insertions += rawInsertions === "-" ? 0 : Number(rawInsertions);
		current.deletions += rawDeletions === "-" ? 0 : Number(rawDeletions);
		current.touchedTestFiles = current.touchedTestFiles || isTestFilePath(path);
	}
	if (current !== null) {
		commits.push(current);
	}
	return commits;
}
