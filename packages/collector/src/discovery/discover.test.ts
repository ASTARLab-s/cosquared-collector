import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { openWritable } from "../cursor/__fixtures__/sqlite-write";
import { discoverRepositories } from "./discover";

/**
 * Fixture-driven scan tests. The Claude fixture store mirrors Claude Code's
 * layout (`<encoded-repo>/<session>.jsonl`); the Codex and Cursor stores are
 * built in `beforeAll` so the multi-tool merge can be exercised deterministically.
 *
 * `lastSessionAt`/recency come from file mtime, which is nondeterministic after
 * a git checkout, so we pin the Claude fixtures' mtimes here to make ordering
 * stable and the suite reproducible (no real-clock dependence). Codex/Cursor
 * tests assert membership and counts, not absolute recency order.
 */
const fixtureProjectsDir = fileURLToPath(
	new URL("./__fixtures__/projects", import.meta.url),
);

const REPO_ONE_OLDER = new Date("2026-06-10T10:00:00.000Z");
const REPO_ONE_NEWER = new Date("2026-06-11T10:00:00.000Z");
const REPO_TWO = new Date("2026-06-15T10:00:00.000Z");

// Isolate the Claude-only tests from any real Codex/Cursor store on the dev
// machine by pointing those branches at nonexistent dirs (they degrade to no
// results, exactly as on a clean CI runner).
const NO_CODEX_OR_CURSOR = {
	codexSessionsDir: "/nonexistent/codex/sessions",
	cursorUserDir: "/nonexistent/cursor/user",
};

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

describe("discoverRepositories (Claude Code)", () => {
	test("lists every repo with sessions, most recent first", async () => {
		const repos = await discoverRepositories({
			claudeProjectsDir: fixtureProjectsDir,
			...NO_CODEX_OR_CURSOR,
		});
		expect(repos.map((repo) => repo.repoPath)).toEqual([
			"/tmp/repo-two",
			"/tmp/repo-one",
		]);
	});

	test("counts only .jsonl transcripts, ignoring sibling files", async () => {
		const repos = await discoverRepositories({
			claudeProjectsDir: fixtureProjectsDir,
			...NO_CODEX_OR_CURSOR,
		});
		const byPath = new Map(repos.map((repo) => [repo.repoPath, repo]));
		expect(byPath.get("/tmp/repo-one")?.sessionCount).toBe(2);
		expect(byPath.get("/tmp/repo-two")?.sessionCount).toBe(1);
	});

	test("reports the newest session time and claude-code source per repo", async () => {
		const repos = await discoverRepositories({
			claudeProjectsDir: fixtureProjectsDir,
			...NO_CODEX_OR_CURSOR,
		});
		const repoOne = repos.find((repo) => repo.repoPath === "/tmp/repo-one");
		expect(repoOne?.lastSessionAt).toBe(REPO_ONE_NEWER.toISOString());
		expect(repoOne?.source).toBe("claude-code");
	});

	test("skips empty dirs and sessions with no recoverable cwd", async () => {
		const repos = await discoverRepositories({
			claudeProjectsDir: fixtureProjectsDir,
			...NO_CODEX_OR_CURSOR,
		});
		expect(repos).toHaveLength(2);
		expect(repos.map((repo) => repo.repoPath)).not.toContain("/tmp/nocwd");
	});

	test("returns [] when no store exists", async () => {
		const repos = await discoverRepositories({
			claudeProjectsDir: "/nonexistent/claude/projects",
			...NO_CODEX_OR_CURSOR,
		});
		expect(repos).toEqual([]);
	});
});

describe("discoverRepositories (multi-tool)", () => {
	let codexDir: string;
	let cursorDir: string;

	beforeAll(() => {
		// Codex store: one rollout in /tmp/repo-one (overlaps Claude), one in a
		// Codex-only repo.
		codexDir = mkdtempSync(join(tmpdir(), "cosq-codex-disc-"));
		const day = join(codexDir, "2026", "06", "20");
		mkdirSync(day, { recursive: true });
		const rollout = (cwd: string) =>
			`${JSON.stringify({
				timestamp: "2026-06-20T10:00:00.000Z",
				type: "session_meta",
				payload: { id: "x", cwd },
			})}\n`;
		writeFileSync(join(day, "rollout-a.jsonl"), rollout("/tmp/repo-one"));
		writeFileSync(
			join(day, "rollout-b.jsonl"),
			rollout("/tmp/codex-only-repo"),
		);

		// Cursor store: one workspace in /tmp/repo-one (overlaps Claude+Codex),
		// one Cursor-only workspace with two conversations.
		cursorDir = mkdtempSync(join(tmpdir(), "cosq-cursor-disc-"));
		buildCursorWorkspace(cursorDir, "wsRepoOne", "/tmp/repo-one", ["c1"]);
		buildCursorWorkspace(cursorDir, "wsCursorOnly", "/tmp/cursor-only-repo", [
			"c2",
			"c3",
		]);
	});

	afterAll(() => {
		rmSync(codexDir, { recursive: true, force: true });
		rmSync(cursorDir, { recursive: true, force: true });
	});

	async function discoverAll() {
		return discoverRepositories({
			claudeProjectsDir: fixtureProjectsDir,
			codexSessionsDir: codexDir,
			cursorUserDir: cursorDir,
		});
	}

	test("lists a Codex-only repo with the codex-cli source", async () => {
		const repos = await discoverAll();
		const repo = repos.find((r) => r.repoPath === "/tmp/codex-only-repo");
		expect(repo?.source).toBe("codex-cli");
		expect(repo?.sessionCount).toBe(1);
	});

	test("lists a Cursor-only repo with the cursor source and composer count", async () => {
		const repos = await discoverAll();
		const repo = repos.find((r) => r.repoPath === "/tmp/cursor-only-repo");
		expect(repo?.source).toBe("cursor");
		expect(repo?.sessionCount).toBe(2);
	});

	test("merges a repo with sessions from multiple tools into one entry", async () => {
		const repos = await discoverAll();
		const merged = repos.filter((r) => r.repoPath === "/tmp/repo-one");
		expect(merged).toHaveLength(1);
		// 2 Claude sessions + 1 Codex rollout + 1 Cursor conversation.
		expect(merged[0].sessionCount).toBe(4);
		// First writer (Claude) wins the display-hint source.
		expect(merged[0].source).toBe("claude-code");
	});
});

describe("discoverRepositories (orphaned flagging)", () => {
	let codexDir: string;
	let liveRepo: string;
	const goneRepo = "/nonexistent/moved/repo-old";

	beforeAll(() => {
		// A repo that still exists on disk vs. a path that was renamed/moved away.
		liveRepo = mkdtempSync(join(tmpdir(), "cosq-live-repo-"));
		codexDir = mkdtempSync(join(tmpdir(), "cosq-codex-orphan-"));
		const day = join(codexDir, "2026", "06", "22");
		mkdirSync(day, { recursive: true });
		const rollout = (cwd: string) =>
			`${JSON.stringify({
				timestamp: "2026-06-22T10:00:00.000Z",
				type: "session_meta",
				payload: { id: "x", cwd },
			})}\n`;
		writeFileSync(join(day, "rollout-live.jsonl"), rollout(liveRepo));
		writeFileSync(join(day, "rollout-gone.jsonl"), rollout(goneRepo));
	});

	afterAll(() => {
		rmSync(codexDir, { recursive: true, force: true });
		rmSync(liveRepo, { recursive: true, force: true });
	});

	test("flags a bucket whose recovered path no longer exists as orphaned", async () => {
		const repos = await discoverRepositories({
			claudeProjectsDir: "/nonexistent/claude/projects",
			codexSessionsDir: codexDir,
			cursorUserDir: "/nonexistent/cursor/user",
		});
		const gone = repos.find((repo) => repo.repoPath === goneRepo);
		expect(gone?.orphaned).toBe(true);
	});

	test("does not flag a bucket whose recovered path still exists", async () => {
		const repos = await discoverRepositories({
			claudeProjectsDir: "/nonexistent/claude/projects",
			codexSessionsDir: codexDir,
			cursorUserDir: "/nonexistent/cursor/user",
		});
		const live = repos.find((repo) => repo.repoPath === liveRepo);
		expect(live?.orphaned).toBe(false);
	});
});

/** Writes a Cursor workspace (workspace.json + state.vscdb ItemTable) listing
 * the given conversation ids — exactly what the discovery cursor branch reads. */
function buildCursorWorkspace(
	userDir: string,
	hash: string,
	folder: string,
	composerIds: string[],
): void {
	const dir = join(userDir, "workspaceStorage", hash);
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, "workspace.json"),
		JSON.stringify({ folder: `file://${folder}` }),
	);
	const db = openWritable(join(dir, "state.vscdb"));
	db.exec("CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value BLOB)");
	db.run(
		"INSERT INTO ItemTable (key, value) VALUES (?, ?)",
		"composer.composerData",
		JSON.stringify({
			allComposers: composerIds.map((composerId) => ({ composerId })),
		}),
	);
	db.close();
}
