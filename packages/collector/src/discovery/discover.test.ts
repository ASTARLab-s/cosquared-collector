import { utimes } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, test } from "vitest";
import { discoverRepositories } from "./discover";

/**
 * Fixture-driven scan tests. The fixture store mirrors Claude Code's layout
 * (`<encoded-repo>/<session>.jsonl`) and plants the cases that matter:
 * multi-session counting, a non-`.jsonl` sibling that must be ignored, an empty
 * dir, and a session with no recoverable `cwd`.
 *
 * `lastSessionAt`/recency come from file mtime, which is nondeterministic after
 * a git checkout, so we pin the fixtures' mtimes here to make ordering stable
 * and the suite reproducible (no real-clock dependence).
 */
const fixtureProjectsDir = fileURLToPath(
	new URL("./__fixtures__/projects", import.meta.url),
);

const REPO_ONE_OLDER = new Date("2026-06-10T10:00:00.000Z");
const REPO_ONE_NEWER = new Date("2026-06-11T10:00:00.000Z");
const REPO_TWO = new Date("2026-06-15T10:00:00.000Z");

beforeAll(async () => {
	await utimes(
		`${fixtureProjectsDir}/-tmp-repo-one/session-a.jsonl`,
		REPO_ONE_OLDER,
		REPO_ONE_OLDER,
	);
	await utimes(
		`${fixtureProjectsDir}/-tmp-repo-one/session-b.jsonl`,
		REPO_ONE_NEWER,
		REPO_ONE_NEWER,
	);
	await utimes(
		`${fixtureProjectsDir}/-tmp-repo-two/session-c.jsonl`,
		REPO_TWO,
		REPO_TWO,
	);
});

describe("discoverRepositories", () => {
	test("lists every repo with sessions, most recent first", async () => {
		const repos = await discoverRepositories({
			claudeProjectsDir: fixtureProjectsDir,
		});
		expect(repos.map((repo) => repo.repoPath)).toEqual([
			"/tmp/repo-two",
			"/tmp/repo-one",
		]);
	});

	test("counts only .jsonl transcripts, ignoring sibling files", async () => {
		const repos = await discoverRepositories({
			claudeProjectsDir: fixtureProjectsDir,
		});
		const byPath = new Map(repos.map((repo) => [repo.repoPath, repo]));
		expect(byPath.get("/tmp/repo-one")?.sessionCount).toBe(2);
		expect(byPath.get("/tmp/repo-two")?.sessionCount).toBe(1);
	});

	test("reports the newest session time and claude-code source per repo", async () => {
		const repos = await discoverRepositories({
			claudeProjectsDir: fixtureProjectsDir,
		});
		const repoOne = repos.find((repo) => repo.repoPath === "/tmp/repo-one");
		expect(repoOne?.lastSessionAt).toBe(REPO_ONE_NEWER.toISOString());
		expect(repoOne?.source).toBe("claude-code");
	});

	test("skips empty dirs and sessions with no recoverable cwd", async () => {
		const repos = await discoverRepositories({
			claudeProjectsDir: fixtureProjectsDir,
		});
		expect(repos).toHaveLength(2);
		expect(repos.map((repo) => repo.repoPath)).not.toContain("/tmp/nocwd");
	});

	test("returns [] when the projects store does not exist", async () => {
		const repos = await discoverRepositories({
			claudeProjectsDir: "/nonexistent/claude/projects",
		});
		expect(repos).toEqual([]);
	});
});
