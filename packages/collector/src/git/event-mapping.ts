import type { SessionEvent } from "@cosquared/schema";
import {
	isAutomationConfigPath,
	isContextFilePath,
	isDocFilePath,
	isTestFilePath,
} from "./heuristics";
import type { ReducedCommit } from "./log-reduction";

/**
 * Pure mapping from reduced git data to the normalized `SessionEvent[]`
 * stream — no filesystem, no network, fully unit-testable.
 *
 * Author emails and file paths are read transiently inside this module,
 * reduced to counts and booleans, and dropped. No emitted event carries
 * any of them (CLAUDE.md invariant #1); the collector re-validates every
 * batch against the strict schema as a runtime proof.
 */

/**
 * Maps the current user's commits to `commit` events, ascending by
 * timestamp (git log emits newest-first, so the kept commits are
 * reversed). Feeds Shipping Momentum's commit consistency and Testing
 * Discipline's tests-before-commit pattern (PRD §7.3).
 *
 * Identity is used TRANSIENTLY for attribution and never transmitted
 * (PRD §4 data handling): the email exists only inside this comparison
 * and appears in no event. Matching is case-insensitive — git stores
 * whatever case was configured, and the same human routinely has both
 * `Foo@Bar.com` and `foo@bar.com` in history.
 */
export function mapCommitsToEvents(
	commits: ReducedCommit[],
	userEmail: string,
): SessionEvent[] {
	const normalizedUserEmail = userEmail.toLowerCase();
	return commits
		.filter(
			(commit) => commit.authorEmail.toLowerCase() === normalizedUserEmail,
		)
		.map(
			(commit): SessionEvent => ({
				sessionId: null,
				source: "git",
				timestamp: commit.timestamp,
				type: "commit",
				filesChanged: commit.filesChanged,
				insertions: commit.insertions,
				deletions: commit.deletions,
				touchedTestFiles: commit.touchedTestFiles,
			}),
		)
		.reverse();
}

/**
 * Derives the `repo_snapshot` event from the tracked-file list at HEAD:
 * one pass counting `trackedFileCount`, `testFileCount`
 * ({@link isTestFilePath}), `docFileCount` ({@link isDocFilePath}),
 * `contextFileCount` ({@link isContextFilePath}), and
 * `automationFileCount` ({@link isAutomationConfigPath}); each path is
 * inspected and dropped. Feeds Testing Discipline's test-file
 * presence/ratio, repo-shape signals, and Tool & Workflow Judgment's
 * context-engineering artifacts (PRD §7.3, §4).
 *
 * The timestamp is HEAD's committer date (already UTC-normalized by the
 * caller), so repeated runs on an unchanged repo are byte-identical.
 */
export function deriveRepoSnapshot(
	trackedFilePaths: Iterable<string>,
	headTimestampIso: string,
): SessionEvent {
	let trackedFileCount = 0;
	let testFileCount = 0;
	let docFileCount = 0;
	let contextFileCount = 0;
	let automationFileCount = 0;
	for (const path of trackedFilePaths) {
		trackedFileCount += 1;
		if (isTestFilePath(path)) {
			testFileCount += 1;
		}
		if (isDocFilePath(path)) {
			docFileCount += 1;
		}
		if (isContextFilePath(path)) {
			contextFileCount += 1;
		}
		if (isAutomationConfigPath(path)) {
			automationFileCount += 1;
		}
	}
	return {
		sessionId: null,
		source: "git",
		timestamp: headTimestampIso,
		type: "repo_snapshot",
		trackedFileCount,
		testFileCount,
		docFileCount,
		contextFileCount,
		automationFileCount,
	};
}
