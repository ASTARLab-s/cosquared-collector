import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { SessionSource } from "@cosquared/schema";
import {
	defaultClaudeProjectsDir,
	encodeProjectDirName,
} from "../claude-code/claude-code-collector";

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
}

/**
 * Enumerates every repo that has Claude Code sessions on this machine.
 *
 * READ-ONLY and METADATA-ONLY (CLAUDE.md invariant #1): the store is never
 * written, and the only thing read out of each transcript is the `cwd` field —
 * used purely to label repos for the user. Nothing here is ever serialized into
 * an upload payload; the real path stays on the machine.
 *
 * WHY READ `cwd` INSTEAD OF DECODING THE DIR NAME: Claude Code names each
 * project directory `encodeProjectDirName(cwd)`, a lossy `[^A-Za-z0-9]→-`
 * transform that cannot be reversed (`-tmp-x` could be `/tmp/x` or `/tmp-x`).
 * The only faithful source of the real path is the session's own `cwd`.
 *
 * Graceful degradation (PRD §14 Risk #4): a missing store, an unreadable
 * directory or file, or a session with no recoverable `cwd` is skipped — never
 * thrown. Currently scans Claude Code only; a new tool means a new scan branch,
 * merged into the same `DiscoveredRepo[]`.
 */
export async function discoverRepositories(
	options: { claudeProjectsDir?: string } = {},
): Promise<DiscoveredRepo[]> {
	const base = options.claudeProjectsDir ?? defaultClaudeProjectsDir();
	let entries: string[];
	try {
		entries = await readdir(base);
	} catch {
		// No Claude Code store on this machine — nothing to discover.
		return [];
	}

	// Keyed by recovered repoPath so the rare lossy-encoding collision (two
	// dirs resolving to the same path) merges into one entry instead of double
	// counting.
	const byRepoPath = new Map<string, DiscoveredRepo>();

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

	return [...byRepoPath.values()].sort(byRecencyDesc);
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

/** Merge a discovered repo into the map, accumulating across dir collisions. */
function mergeRepo(
	map: Map<string, DiscoveredRepo>,
	repo: DiscoveredRepo,
): void {
	const existing = map.get(repo.repoPath);
	if (existing === undefined) {
		map.set(repo.repoPath, repo);
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
