import { createReadStream, existsSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import type { SessionSource } from "@cosquared/schema";
import {
	defaultClaudeProjectsDir,
	encodeProjectDirName,
} from "../claude-code/claude-code-collector";
import { defaultCodexSessionsDir } from "../codex/codex-collector";
import {
	defaultCursorUserDir,
	readWorkspaceFolder,
} from "../cursor/cursor-collector";
import { readWorkspaceComposerIds } from "../cursor/cursor-store";
import { openSqlite } from "../cursor/sqlite-reader";

/**
 * A local repo where the user has AI coding sessions, with just enough
 * metadata to list it for selection. METADATA ONLY (CLAUDE.md invariant #1):
 * `repoPath` is recovered from session metadata to LABEL the repo for the user
 * locally; this struct is never serialized into an upload payload — it exists
 * purely to drive the on-device picker / `cosq analyze --list` listing.
 */
export interface DiscoveredRepo {
	/** Absolute path of the repo, recovered from a session's `cwd`. */
	repoPath: string;
	/** Which AI tool's store the sessions came from. */
	source: SessionSource;
	/** Number of session transcripts found for this repo. */
	sessionCount: number;
	/** ISO timestamp of the most recent session, or null if unknown. */
	lastSessionAt: string | null;
	/**
	 * True when the recovered repo path no longer exists on disk — a renamed or
	 * moved project's orphaned session bucket (PRD §12). The path is recovered
	 * from a session `cwd`, which for a moved repo points at the OLD location, so
	 * this flags a "phantom" repo. Still listed so the user can recover it (via a
	 * `[[project_alias]]` in `~/.cosquared/config.toml`), but never silently
	 * analyzed/scored as if it were a real repo. Pure filesystem metadata — no
	 * product/config concept crosses into this public collector (PRD §6).
	 */
	orphaned: boolean;
}

/**
 * Enumerates every repo that has AI coding sessions on this machine, across
 * all supported tools (Claude Code, Codex CLI, Cursor).
 *
 * READ-ONLY and METADATA-ONLY (CLAUDE.md invariant #1): no store is ever
 * written, and the only thing read out of each store is the repo path (a
 * session `cwd` or a Cursor workspace folder) — used purely to label repos for
 * the user. Nothing here is ever serialized into an upload payload; the real
 * path stays on the machine.
 *
 * Each tool is a separate scan branch that merges into the SAME
 * `byRepoPath` map, so a repo with sessions from several tools collapses to one
 * entry with summed counts (`mergeRepo`). When sources differ the first writer's
 * `source` wins — it is only a display hint for the picker; analysis always runs
 * every collector regardless (see `collectEvents`). Branch order
 * (Claude → Codex → Cursor) therefore decides only that hint.
 *
 * Graceful degradation (PRD §14 Risk #4): a missing store, an unreadable
 * directory/file/DB, SQLite being unavailable, or a session with no recoverable
 * path is skipped — never thrown.
 */
export async function discoverRepositories(
	options: {
		claudeProjectsDir?: string;
		codexSessionsDir?: string;
		cursorUserDir?: string;
	} = {},
): Promise<DiscoveredRepo[]> {
	// Keyed by recovered repoPath so multiple dirs/tools resolving to the same
	// path merge into one entry instead of double counting.
	const byRepoPath = new Map<string, DiscoveredRepo>();
	await scanClaudeCode(
		byRepoPath,
		options.claudeProjectsDir ?? defaultClaudeProjectsDir(),
	);
	await scanCodex(
		byRepoPath,
		options.codexSessionsDir ?? defaultCodexSessionsDir(),
	);
	await scanCursor(byRepoPath, options.cursorUserDir ?? defaultCursorUserDir());
	return [...byRepoPath.values()].sort(byRecencyDesc);
}

/**
 * Claude Code branch. Each project directory is named `encodeProjectDirName(cwd)`,
 * a lossy `[^A-Za-z0-9]→-` transform that cannot be reversed (`-tmp-x` could be
 * `/tmp/x` or `/tmp-x`), so the real path is recovered from a session's own
 * `cwd` and verified against the dir name.
 */
async function scanClaudeCode(
	byRepoPath: Map<string, DiscoveredRepo>,
	base: string,
): Promise<void> {
	let entries: string[];
	try {
		entries = await readdir(base);
	} catch {
		return;
	}
	for (const dirName of entries) {
		try {
			const projectDir = join(base, dirName);
			if (!(await stat(projectDir)).isDirectory()) {
				continue;
			}
			const sessionFiles = (await readdir(projectDir)).filter((name) =>
				name.endsWith(".jsonl"),
			);
			if (sessionFiles.length === 0) {
				continue;
			}

			// Pair each transcript with its mtime, newest first: the newest is
			// both the freshest source of a `cwd` and the repo's last-session time.
			const stated = await statSessionFiles(projectDir, sessionFiles);
			if (stated.length === 0) {
				continue;
			}
			stated.sort((a, b) => b.mtimeMs - a.mtimeMs);

			const repoPath = await recoverRepoPath(stated, dirName);
			if (repoPath === null) {
				// No session carried a usable `cwd` — the dir name alone can't be
				// turned back into a path, so we cannot label this repo. Skip it.
				continue;
			}

			mergeRepo(byRepoPath, {
				repoPath,
				source: "claude-code",
				sessionCount: sessionFiles.length,
				lastSessionAt: new Date(stated[0].mtimeMs).toISOString(),
			});
		} catch {
			// Unreadable entry — skip it, never fatal (PRD §14 Risk #4).
		}
	}
}

/**
 * Codex CLI branch. Codex's store is global, so each rollout declares its own
 * repo via `session_meta.payload.cwd`; one rollout file counts as one session,
 * its mtime the session time.
 */
async function scanCodex(
	byRepoPath: Map<string, DiscoveredRepo>,
	sessionsDir: string,
): Promise<void> {
	for (const file of await listJsonlFiles(sessionsDir)) {
		try {
			const cwd = await readCodexCwd(file);
			if (cwd === null) {
				continue;
			}
			const { mtimeMs } = await stat(file);
			mergeRepo(byRepoPath, {
				repoPath: resolve(cwd),
				source: "codex-cli",
				sessionCount: 1,
				lastSessionAt: new Date(mtimeMs).toISOString(),
			});
		} catch {
			// Unreadable rollout — skip it.
		}
	}
}

/**
 * Cursor branch. Each `workspaceStorage/<hash>/workspace.json` names the repo
 * folder; the workspace's `state.vscdb` lists its conversation ids (the session
 * count), and that DB's mtime approximates the last-session time. Uses the
 * read-only SQLite adapter; a workspace is skipped if SQLite is unavailable.
 */
async function scanCursor(
	byRepoPath: Map<string, DiscoveredRepo>,
	userDir: string,
): Promise<void> {
	const workspaceStorage = join(userDir, "workspaceStorage");
	let entries: import("node:fs").Dirent[];
	try {
		entries = await readdir(workspaceStorage, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		if (!entry.isDirectory()) {
			continue;
		}
		try {
			const workspaceDir = join(workspaceStorage, entry.name);
			const folder = await readWorkspaceFolder(
				join(workspaceDir, "workspace.json"),
			);
			if (folder === null) {
				continue;
			}
			const dbPath = join(workspaceDir, "state.vscdb");
			const reader = await openSqlite(dbPath);
			if (reader === null) {
				continue;
			}
			let composerCount: number;
			try {
				composerCount = readWorkspaceComposerIds(reader).length;
			} finally {
				reader.close();
			}
			if (composerCount === 0) {
				continue;
			}
			const { mtimeMs } = await stat(dbPath);
			mergeRepo(byRepoPath, {
				repoPath: resolve(folder),
				source: "cursor",
				sessionCount: composerCount,
				lastSessionAt: new Date(mtimeMs).toISOString(),
			});
		} catch {
			// Unreadable workspace — skip it.
		}
	}
}

/** Recursively lists every `*.jsonl` under `dir` (Codex's `YYYY/MM/DD` tree).
 * An unreadable directory degrades to fewer files, never a throw. */
async function listJsonlFiles(dir: string): Promise<string[]> {
	let entries: import("node:fs").Dirent[];
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		return [];
	}
	const files: string[] = [];
	for (const entry of entries) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			files.push(...(await listJsonlFiles(full)));
		} else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
			files.push(full);
		}
	}
	return files;
}

/**
 * Reads the first `session_meta` line's `payload.cwd` from a Codex rollout.
 * Deliberately a minimal local `JSON.parse` (not the full rollout parser) — it
 * only needs the repo path, which never leaves the machine. Returns null on any
 * failure or absence.
 */
async function readCodexCwd(filePath: string): Promise<string | null> {
	const reader = createInterface({
		input: createReadStream(filePath, { encoding: "utf8" }),
		crlfDelay: Number.POSITIVE_INFINITY,
	});
	try {
		for await (const raw of reader) {
			let parsed: unknown;
			try {
				parsed = JSON.parse(raw);
			} catch {
				continue;
			}
			if (typeof parsed !== "object" || parsed === null) {
				continue;
			}
			if ((parsed as { type?: unknown }).type !== "session_meta") {
				continue;
			}
			const payload = (parsed as { payload?: unknown }).payload;
			if (typeof payload === "object" && payload !== null) {
				const cwd = (payload as { cwd?: unknown }).cwd;
				if (typeof cwd === "string" && cwd.length > 0) {
					return cwd;
				}
			}
			return null;
		}
	} finally {
		reader.close();
	}
	return null;
}

interface StatedSession {
	path: string;
	mtimeMs: number;
}

/** `stat` each session file, dropping any that can't be read. */
async function statSessionFiles(
	projectDir: string,
	sessionFiles: string[],
): Promise<StatedSession[]> {
	const stated: StatedSession[] = [];
	for (const name of sessionFiles) {
		try {
			const path = join(projectDir, name);
			const { mtimeMs } = await stat(path);
			stated.push({ path, mtimeMs });
		} catch {
			// Unreadable file — skip it.
		}
	}
	return stated;
}

/**
 * Recovers the repo's real path from the newest session whose `cwd` encodes
 * back to this directory's name. The encode check is a cheap integrity guard:
 * Claude Code derives the dir name from the `cwd` via the same lossy transform,
 * so a legitimate session always matches, while a stray/foreign `cwd` is
 * rejected. Returns null when no session yields a matching `cwd`.
 */
async function recoverRepoPath(
	stated: StatedSession[],
	dirName: string,
): Promise<string | null> {
	for (const { path } of stated) {
		const cwd = await readFirstCwd(path);
		if (cwd !== null && encodeProjectDirName(cwd) === dirName) {
			return cwd;
		}
	}
	return null;
}

/**
 * Streams a transcript line by line (transcripts reach multiple megabytes —
 * never read whole) and returns the first non-empty string `cwd` it finds.
 *
 * Deliberately does NOT use `parseTranscriptLine`: that parser models only the
 * fields scoring needs and intentionally drops `cwd`. We read `cwd` with a
 * minimal local `JSON.parse` instead, and it never leaves this machine. Every
 * failure path yields null — one bad line must not abort discovery.
 */
async function readFirstCwd(filePath: string): Promise<string | null> {
	const reader = createInterface({
		input: createReadStream(filePath, { encoding: "utf8" }),
		crlfDelay: Number.POSITIVE_INFINITY,
	});
	try {
		for await (const raw of reader) {
			let parsed: unknown;
			try {
				parsed = JSON.parse(raw);
			} catch {
				continue;
			}
			if (typeof parsed !== "object" || parsed === null) {
				continue;
			}
			const cwd = (parsed as { cwd?: unknown }).cwd;
			if (typeof cwd === "string" && cwd.length > 0) {
				return cwd;
			}
		}
	} finally {
		reader.close();
	}
	return null;
}

/**
 * Merge a discovered repo into the map, accumulating across dir collisions.
 *
 * `orphaned` is computed HERE (the single finalization point) from the recovered
 * path's on-disk existence — a property of the path, so it is identical across
 * every tool that resolved to the same repo; the first writer's value stands on
 * a later merge.
 */
function mergeRepo(
	map: Map<string, DiscoveredRepo>,
	repo: Omit<DiscoveredRepo, "orphaned">,
): void {
	const existing = map.get(repo.repoPath);
	if (existing === undefined) {
		map.set(repo.repoPath, { ...repo, orphaned: !existsSync(repo.repoPath) });
		return;
	}
	existing.sessionCount += repo.sessionCount;
	existing.lastSessionAt = maxIso(existing.lastSessionAt, repo.lastSessionAt);
}

/** The later of two ISO timestamps (string compare is correct for UTC `Z`). */
function maxIso(a: string | null, b: string | null): string | null {
	if (a === null) {
		return b;
	}
	if (b === null) {
		return a;
	}
	return a >= b ? a : b;
}

/** Most recent first; repos with an unknown last-session time sort last. */
function byRecencyDesc(a: DiscoveredRepo, b: DiscoveredRepo): number {
	if (a.lastSessionAt === b.lastSessionAt) {
		return 0;
	}
	if (a.lastSessionAt === null) {
		return 1;
	}
	if (b.lastSessionAt === null) {
		return -1;
	}
	return a.lastSessionAt > b.lastSessionAt ? -1 : 1;
}
