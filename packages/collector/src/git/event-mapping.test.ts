import { describe, expect, test } from "vitest";
import { deriveRepoSnapshot, mapCommitsToEvents } from "./event-mapping";
import type { ReducedCommit } from "./log-reduction";

const USER_EMAIL = "fixture@example.com";
const OTHER_EMAIL = "someone-else@example.com";

function reducedCommit(overrides: Partial<ReducedCommit>): ReducedCommit {
	return {
		timestamp: "2026-06-11T10:00:00.000Z",
		authorEmail: USER_EMAIL,
		filesChanged: 1,
		insertions: 10,
		deletions: 2,
		touchedTestFiles: false,
		...overrides,
	};
}

describe("mapCommitsToEvents", () => {
	test("filtersOutOtherAuthors: only the user's commits become events", () => {
		const events = mapCommitsToEvents(
			[
				reducedCommit({ timestamp: "2026-06-11T10:00:00.000Z" }),
				reducedCommit({
					timestamp: "2026-06-10T09:00:00.000Z",
					authorEmail: OTHER_EMAIL,
				}),
			],
			USER_EMAIL,
		);
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({
			type: "commit",
			timestamp: "2026-06-11T10:00:00.000Z",
		});
	});

	test("matches the user email case-insensitively", () => {
		const events = mapCommitsToEvents(
			[reducedCommit({ authorEmail: "Fixture@Example.COM" })],
			USER_EMAIL,
		);
		expect(events).toHaveLength(1);
	});

	test("emailNeverInOutput: serialized events contain no email", () => {
		const events = mapCommitsToEvents(
			[reducedCommit({}), reducedCommit({ authorEmail: OTHER_EMAIL })],
			USER_EMAIL,
		);
		const serialized = JSON.stringify(events);
		expect(serialized).not.toContain(USER_EMAIL);
		expect(serialized).not.toContain(OTHER_EMAIL);
		expect(serialized).not.toContain("example.com");
	});

	test("sortsAscendingByTimestamp: newest-first git order is reversed", () => {
		const events = mapCommitsToEvents(
			[
				reducedCommit({ timestamp: "2026-06-11T10:00:00.000Z" }),
				reducedCommit({ timestamp: "2026-06-10T09:00:00.000Z" }),
				reducedCommit({ timestamp: "2026-06-09T08:00:00.000Z" }),
			],
			USER_EMAIL,
		);
		expect(events.map((event) => event.timestamp)).toEqual([
			"2026-06-09T08:00:00.000Z",
			"2026-06-10T09:00:00.000Z",
			"2026-06-11T10:00:00.000Z",
		]);
	});
});

describe("deriveRepoSnapshot", () => {
	const trackedPaths = [
		"src/index.ts",
		"src/index.test.ts",
		"tests/test_api.py",
		"README.md",
		"docs/guide.md",
		"CHANGELOG.md",
		"CLAUDE.md",
		".cursorrules",
		".claude/skills/review.md",
		".claude/settings.json",
	];

	test("derivesSnapshotCounts: exact counts from a mixed path list", () => {
		const snapshot = deriveRepoSnapshot(
			trackedPaths,
			"2026-06-11T10:00:00.000Z",
		);
		expect(snapshot).toEqual({
			sessionId: null,
			source: "git",
			timestamp: "2026-06-11T10:00:00.000Z",
			type: "repo_snapshot",
			trackedFileCount: 10,
			testFileCount: 2,
			docFileCount: 2,
			contextFileCount: 2,
			automationFileCount: 1,
		});
	});

	test("snapshotContainsNoPaths: serialized snapshot has no path text", () => {
		const serialized = JSON.stringify(
			deriveRepoSnapshot(trackedPaths, "2026-06-11T10:00:00.000Z"),
		);
		for (const path of trackedPaths) {
			expect(serialized).not.toContain(path);
		}
	});
});
