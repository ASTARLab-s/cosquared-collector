import { describe, expect, test } from "vitest";
import { type ReducedCommit, reduceLogLines } from "./log-reduction";

/**
 * Named raw-log fixtures pinning every numstat edge case the reducer must
 * handle. Lines mirror `git log --format=%x1e%cI%x1f%ae%x1f%an --numstat` output
 * exactly (header = \x1e + date + \x1f + email + \x1f + name).
 */

const AUTHOR_NAME = "Author Name";

function header(dateIso: string, email: string, name = AUTHOR_NAME): string {
	return `\x1e${dateIso}\x1f${email}\x1f${name}`;
}

const fixtures: Record<string, { lines: string[]; expected: ReducedCommit[] }> =
	{
		twoCommitsPlainText: {
			lines: [
				header("2026-06-11T10:00:00Z", "a@example.com", "Ada Lovelace"),
				"",
				"10\t2\tsrc/index.ts",
				"5\t0\tsrc/util.ts",
				"",
				header("2026-06-10T09:00:00Z", "b@example.com", "Babbage"),
				"",
				"1\t1\tREADME.md",
			],
			expected: [
				{
					timestamp: "2026-06-11T10:00:00.000Z",
					authorEmail: "a@example.com",
					authorName: "Ada Lovelace",
					filesChanged: 2,
					insertions: 15,
					deletions: 2,
					touchedTestFiles: false,
				},
				{
					timestamp: "2026-06-10T09:00:00.000Z",
					authorEmail: "b@example.com",
					authorName: "Babbage",
					filesChanged: 1,
					insertions: 1,
					deletions: 1,
					touchedTestFiles: false,
				},
			],
		},
		binaryFileNumstat: {
			lines: [
				header("2026-06-11T10:00:00Z", "a@example.com"),
				"",
				"-\t-\tlogo.png",
			],
			expected: [
				{
					timestamp: "2026-06-11T10:00:00.000Z",
					authorEmail: "a@example.com",
					authorName: AUTHOR_NAME,
					filesChanged: 1,
					insertions: 0,
					deletions: 0,
					touchedTestFiles: false,
				},
			],
		},
		renamedTestFile: {
			lines: [
				header("2026-06-11T10:00:00Z", "a@example.com"),
				"",
				"0\t0\tsrc/{old => new}/file.test.ts",
			],
			expected: [
				{
					timestamp: "2026-06-11T10:00:00.000Z",
					authorEmail: "a@example.com",
					authorName: AUTHOR_NAME,
					filesChanged: 1,
					insertions: 0,
					deletions: 0,
					touchedTestFiles: true,
				},
			],
		},
		emptyCommitNoNumstat: {
			lines: [header("2026-06-11T10:00:00Z", "a@example.com")],
			expected: [
				{
					timestamp: "2026-06-11T10:00:00.000Z",
					authorEmail: "a@example.com",
					authorName: AUTHOR_NAME,
					filesChanged: 0,
					insertions: 0,
					deletions: 0,
					touchedTestFiles: false,
				},
			],
		},
		emptyAuthorNameIsKept: {
			// `%an` can be empty if a commit was authored with no configured name.
			lines: [`\x1e2026-06-11T10:00:00Z\x1fa@example.com\x1f`],
			expected: [
				{
					timestamp: "2026-06-11T10:00:00.000Z",
					authorEmail: "a@example.com",
					authorName: "",
					filesChanged: 0,
					insertions: 0,
					deletions: 0,
					touchedTestFiles: false,
				},
			],
		},
		headerMissingNameFieldSkipped: {
			// A two-field header (no \x1f name) is malformed and dropped.
			lines: [
				"\x1e2026-06-11T10:00:00Z\x1fa@example.com",
				"1\t0\tsrc/index.ts",
			],
			expected: [],
		},
		offsetTimestampNormalizedToUtc: {
			lines: [header("2026-06-11T09:30:00+02:00", "a@example.com")],
			expected: [
				{
					timestamp: "2026-06-11T07:30:00.000Z",
					authorEmail: "a@example.com",
					authorName: AUTHOR_NAME,
					filesChanged: 0,
					insertions: 0,
					deletions: 0,
					touchedTestFiles: false,
				},
			],
		},
		garbageLinesSkipped: {
			lines: [
				"orphan numstat before any header\t3\tx.ts",
				header("not-a-date\x00", "broken@example.com"),
				header("2026-06-11T10:00:00Z", "a@example.com"),
				"this line matches no grammar",
				"2\t1\tsrc/ok.ts",
			],
			expected: [
				{
					timestamp: "2026-06-11T10:00:00.000Z",
					authorEmail: "a@example.com",
					authorName: AUTHOR_NAME,
					filesChanged: 1,
					insertions: 2,
					deletions: 1,
					touchedTestFiles: false,
				},
			],
		},
		pathWithSpaces: {
			lines: [
				header("2026-06-11T10:00:00Z", "a@example.com"),
				"3\t0\tmy docs folder/notes file.txt",
			],
			expected: [
				{
					timestamp: "2026-06-11T10:00:00.000Z",
					authorEmail: "a@example.com",
					authorName: AUTHOR_NAME,
					filesChanged: 1,
					insertions: 3,
					deletions: 0,
					touchedTestFiles: false,
				},
			],
		},
	};

describe("reduceLogLines", () => {
	test.each(Object.entries(fixtures))("%s", async (_name, fixture) => {
		await expect(reduceLogLines(fixture.lines)).resolves.toEqual(
			fixture.expected,
		);
	});

	test("accepts an async iterable of lines (the streaming path)", async () => {
		async function* stream(): AsyncIterable<string> {
			yield header("2026-06-11T10:00:00Z", "a@example.com");
			yield "1\t0\tsrc/index.ts";
		}
		const commits = await reduceLogLines(stream());
		expect(commits).toHaveLength(1);
		expect(commits[0].filesChanged).toBe(1);
	});
});
