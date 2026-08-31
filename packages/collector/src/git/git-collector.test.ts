import { execFile as execFileCallback } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { SessionEvent } from "@cosquared/schema";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { GitCollector } from "./git-collector";

const execFile = promisify(execFileCallback);

/**
 * Integration tests against a real throwaway git repo (git is guaranteed
 * present — this project is one). Identity and dates are pinned per
 * commit so the event stream is the golden-stream equivalent of the
 * claude-code fixture store: built programmatically, asserted exactly.
 */

const USER_EMAIL = "fixture@example.com";
const OTHER_EMAIL = "someone-else@example.com";
// Offsets (not `Z`) on purpose: the collector must emit UTC-normalized
// `Z` timestamps, pinning the zod `z.iso.datetime()` offset gotcha.
const COMMIT_1_DATE = "2026-06-01T10:00:00+02:00";
const COMMIT_2_DATE = "2026-06-02T11:00:00+02:00";
const COMMIT_3_DATE = "2026-06-03T12:00:00+02:00";
const COMMIT_4_DATE = "2026-06-04T13:00:00+02:00";
const COMMIT_1_UTC = "2026-06-01T08:00:00.000Z";
const COMMIT_3_UTC = "2026-06-03T10:00:00.000Z";
const COMMIT_4_UTC = "2026-06-04T11:00:00.000Z";

let repoDir: string;
let emptyDir: string;
let noEmailRepoDir: string;

async function git(args: string[], dateIso?: string): Promise<void> {
	await execFile("git", ["-C", repoDir, ...args], {
		env: {
			...process.env,
			...(dateIso
				? { GIT_AUTHOR_DATE: dateIso, GIT_COMMITTER_DATE: dateIso }
				: {}),
		},
	});
}

async function commitAs(
	email: string,
	dateIso: string,
	message: string,
	name = "Fixture User",
): Promise<void> {
	await git(
		[
			"-c",
			`user.name=${name}`,
			"-c",
			`user.email=${email}`,
			"commit",
			"-m",
			message,
		],
		dateIso,
	);
}

beforeAll(async () => {
	repoDir = await mkdtemp(join(tmpdir(), "cosquared-git-collector-"));
	emptyDir = await mkdtemp(join(tmpdir(), "cosquared-not-a-repo-"));
	noEmailRepoDir = await mkdtemp(join(tmpdir(), "cosquared-no-email-repo-"));
	await git(["init"]);
	// Repo-level user.email is what the collector reads for attribution.
	await git(["config", "user.email", USER_EMAIL]);
	await git(["config", "user.name", "Fixture User"]);

	await writeFile(
		join(repoDir, "index.ts"),
		"export const PLANTED_SOURCE_CONTENT = 1;\n",
	);
	await writeFile(join(repoDir, "README.md"), "# PLANTED_SOURCE_CONTENT\n");
	// Context + automation files pin the v1.2.0 repo_snapshot counts.
	await writeFile(join(repoDir, "CLAUDE.md"), "# PLANTED_AGENT_RULES\n");
	await mkdir(join(repoDir, ".claude", "skills"), { recursive: true });
	await writeFile(
		join(repoDir, ".claude", "skills", "review.md"),
		"# PLANTED_SKILL_CONTENT\n",
	);
	await git([
		"add",
		"index.ts",
		"README.md",
		"CLAUDE.md",
		".claude/skills/review.md",
	]);
	await commitAs(
		USER_EMAIL,
		COMMIT_1_DATE,
		"PLANTED: fix prod credentials leak",
	);

	await writeFile(join(repoDir, "other.ts"), "export const other = 2;\n");
	await git(["add", "other.ts"]);
	// A genuinely different person: different email AND name → excluded by both.
	await commitAs(
		OTHER_EMAIL,
		COMMIT_2_DATE,
		"PLANTED: someone else's work",
		"Other Person",
	);

	// Uppercase email proves case-insensitive author matching.
	await writeFile(
		join(repoDir, "index.test.ts"),
		"import { test } from 'vitest';\ntest('PLANTED', () => {});\n",
	);
	await git(["add", "index.test.ts"]);
	await commitAs(
		"Fixture@Example.COM",
		COMMIT_3_DATE,
		"PLANTED: add test coverage",
	);

	// Rewrites the line committed three days earlier: 1 insertion +
	// 1 deletion on index.ts — the deletion churns commit 1's addition
	// (within the 14-day window) and pins the churn_snapshot totals.
	await writeFile(
		join(repoDir, "index.ts"),
		"export const PLANTED_SOURCE_CONTENT = 2;\n",
	);
	await git(["add", "index.ts"]);
	await commitAs(USER_EMAIL, COMMIT_4_DATE, "PLANTED: rework the export");

	// A repo whose local user.email AND user.name are explicitly empty (overriding
	// any global config): with no identity at all, authorship-scoped events must
	// be absent. Both are cleared so the result never depends on the ambient
	// global git identity of the machine running the tests.
	const noEmailGit = (args: string[], dateIso?: string) =>
		execFile("git", ["-C", noEmailRepoDir, ...args], {
			env: {
				...process.env,
				...(dateIso
					? { GIT_AUTHOR_DATE: dateIso, GIT_COMMITTER_DATE: dateIso }
					: {}),
			},
		});
	await noEmailGit(["init"]);
	await writeFile(join(noEmailRepoDir, "solo.ts"), "export const solo = 1;\n");
	await noEmailGit(["add", "solo.ts"]);
	await noEmailGit(
		[
			"-c",
			"user.name=Fixture User",
			"-c",
			`user.email=${OTHER_EMAIL}`,
			"commit",
			"-m",
			"PLANTED: unattributed work",
		],
		COMMIT_1_DATE,
	);
	await noEmailGit(["config", "user.email", ""]);
	await noEmailGit(["config", "user.name", ""]);
});

afterAll(async () => {
	await rm(repoDir, { recursive: true, force: true });
	await rm(emptyDir, { recursive: true, force: true });
	await rm(noEmailRepoDir, { recursive: true, force: true });
});

async function collectRepoEvents(since?: Date): Promise<SessionEvent[]> {
	return new GitCollector().collect({ repoPath: repoDir, since });
}

describe("GitCollector", () => {
	test("detect is true with real git", async () => {
		await expect(new GitCollector().detect()).resolves.toBe(true);
	});

	test("detect is false for a missing binary", async () => {
		const collector = new GitCollector({ gitBinary: "/nonexistent/git" });
		await expect(collector.detect()).resolves.toBe(false);
	});

	test("returns empty for a directory that is not a git repo", async () => {
		const events = await new GitCollector().collect({ repoPath: emptyDir });
		expect(events).toEqual([]);
	});

	test("collects the user's commits into the golden event stream", async () => {
		const events = await collectRepoEvents();
		expect(events).toEqual([
			{
				sessionId: null,
				source: "git",
				timestamp: COMMIT_1_UTC,
				type: "commit",
				filesChanged: 4,
				insertions: 4,
				deletions: 0,
				touchedTestFiles: false,
			},
			{
				sessionId: null,
				source: "git",
				timestamp: COMMIT_3_UTC,
				type: "commit",
				filesChanged: 1,
				insertions: 2,
				deletions: 0,
				touchedTestFiles: true,
			},
			{
				sessionId: null,
				source: "git",
				timestamp: COMMIT_4_UTC,
				type: "commit",
				filesChanged: 1,
				insertions: 1,
				deletions: 1,
				touchedTestFiles: false,
			},
			{
				sessionId: null,
				source: "git",
				timestamp: COMMIT_4_UTC,
				type: "repo_snapshot",
				trackedFileCount: 6,
				testFileCount: 1,
				docFileCount: 1,
				contextFileCount: 1,
				automationFileCount: 1,
			},
			{
				sessionId: null,
				source: "git",
				timestamp: COMMIT_4_UTC,
				type: "churn_snapshot",
				windowDays: 14,
				// All three user commits fall in the 14 days before HEAD
				// (4 + 2 + 1 insertions); commit 4's single deletion churns
				// commit 1's index.ts addition from three days earlier.
				linesAdded: 7,
				linesChurned: 1,
			},
		]);
	});

	test("authorship-scoped events are absent when no identity is configured", async () => {
		const events = await new GitCollector().collect({
			repoPath: noEmailRepoDir,
		});
		// Commits and churn drop (no identity to attribute them to); the
		// authorship-independent snapshot stays.
		expect(events.map((event) => event.type)).toEqual(["repo_snapshot"]);
	});

	test("excludes other authors' commits (different email AND name)", async () => {
		const events = await collectRepoEvents();
		const commitTimestamps = events
			.filter((event) => event.type === "commit")
			.map((event) => event.timestamp);
		expect(commitTimestamps).not.toContain("2026-06-02T09:00:00.000Z");
	});

	test("extra identities attribute a commit made under another address", async () => {
		// The git_emails/git_names escape hatch (config.toml → CollectorOptions):
		// declaring the other address makes its commit count as the user's.
		const events = await new GitCollector().collect({
			repoPath: repoDir,
			identities: { emails: [OTHER_EMAIL] },
		});
		const commitTimestamps = events
			.filter((event) => event.type === "commit")
			.map((event) => event.timestamp);
		expect(commitTimestamps).toContain("2026-06-02T09:00:00.000Z");
	});

	test("since filters out events at or before the cutoff", async () => {
		// Exclusive cutoff exactly on commit 1's timestamp: commit 1 drops,
		// later commits and both snapshots survive.
		const since = new Date(COMMIT_1_UTC);
		const events = await collectRepoEvents(since);
		expect(events.map((event) => event.type)).toEqual([
			"commit",
			"commit",
			"repo_snapshot",
			"churn_snapshot",
		]);
		expect(
			events.every((event) => Date.parse(event.timestamp) > since.getTime()),
		).toBe(true);
	});

	test("an unchanged repo re-synced from HEAD emits nothing, churn included", async () => {
		const events = await collectRepoEvents(new Date(COMMIT_4_UTC));
		expect(events).toEqual([]);
	});

	test("output is byte-stable JSON", async () => {
		const first = JSON.stringify(await collectRepoEvents());
		const second = JSON.stringify(await collectRepoEvents());
		expect(first).toBe(second);
	});

	// The privacy guard for the whole collector: none of the raw strings
	// planted in the fixture repo may survive into the event stream
	// (CLAUDE.md invariant #1 — no path, message, content, or identity
	// ever leaves the parser).
	test("serialized output never contains repo text, paths, messages, or identity", async () => {
		const serialized = JSON.stringify(await collectRepoEvents());
		const plantedRawStrings = [
			"PLANTED", // commit messages and file contents
			"index.ts", // file path (also covers index.test.ts)
			"README.md", // file path
			"fixture@example.com", // configured identity
			"Fixture User", // configured identity
		];
		for (const raw of plantedRawStrings) {
			expect(serialized).not.toContain(raw);
		}
	});

	test("a hung git binary degrades to no events instead of stalling", async () => {
		const hangAll = await writeFakeGit(`#!/bin/sh
sleep 30
`);
		const started = Date.now();
		const events = await new GitCollector({
			gitBinary: hangAll,
			commandTimeoutMs: 200,
			stallTimeoutMs: 200,
		}).collect({ repoPath: repoDir });
		expect(events).toEqual([]);
		expect(Date.now() - started).toBeLessThan(2_000);
		await rm(dirname(hangAll), { recursive: true, force: true });
	});

	test("a silent git log is killed and degrades rather than hanging", async () => {
		const hangLog = await writeFakeGit(`#!/bin/sh
case "$*" in
  *--numstat*) sleep 30 ;;
  *rev-parse*) echo true ;;
  *user.email*) echo hanglog@example.com ;;
  *user.name*) echo 'Hang Log' ;;
  *ls-files*) printf 'a.ts\\0' ;;
  *--format=%cI*) echo '2026-06-01T08:00:00Z' ;;
  *) exit 0 ;;
esac
`);
		const started = Date.now();
		const events = await new GitCollector({
			gitBinary: hangLog,
			commandTimeoutMs: 2_000,
			stallTimeoutMs: 200,
		}).collect({ repoPath: repoDir });
		expect(Date.now() - started).toBeLessThan(2_000);
		expect(events.filter((event) => event.type === "commit")).toEqual([]);
		await rm(dirname(hangLog), { recursive: true, force: true });
	});

	test("a slow-but-progressing git log is not killed", async () => {
		const slowLog = await writeFakeGit(`#!/bin/sh
case "$*" in
  *--numstat*)
    printf '\\0362026-06-01T08:00:00Z\\037slow@example.com\\037Slow User\\n1\\t0\\ta.ts\\n'
    sleep 0.15
    printf '\\0362026-06-02T08:00:00Z\\037slow@example.com\\037Slow User\\n1\\t0\\tb.ts\\n'
    ;;
  *rev-parse*) echo true ;;
  *user.email*) echo slow@example.com ;;
  *user.name*) echo 'Slow User' ;;
  *ls-files*) printf 'a.ts\\0' ;;
  *--format=%cI*) echo '2026-06-02T08:00:00Z' ;;
  *) exit 0 ;;
esac
`);
		const events = await new GitCollector({
			gitBinary: slowLog,
			commandTimeoutMs: 2_000,
			stallTimeoutMs: 400,
		}).collect({ repoPath: repoDir });
		expect(
			events
				.filter((event) => event.type === "commit")
				.map((event) => event.timestamp)
				.sort(),
		).toEqual(["2026-06-01T08:00:00.000Z", "2026-06-02T08:00:00.000Z"]);
		await rm(dirname(slowLog), { recursive: true, force: true });
	});
});

async function writeFakeGit(script: string): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "cosquared-fake-git-"));
	const path = join(dir, "git");
	await writeFile(path, script, { encoding: "utf8" });
	await chmod(path, 0o755);
	return path;
}
