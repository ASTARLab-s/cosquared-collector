import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type SessionEvent, SessionEventSchema } from "@cosquared/schema";
import { z } from "zod";
import type { Collector, CollectorOptions } from "../collector";
import {
	type RawBubble,
	readBubble,
	readComposerMeta,
	readWorkspaceComposerIds,
} from "./cursor-store";
import { mapCursorConversationToEvents } from "./event-mapping";
import { type OpenSqlite, openSqlite } from "./sqlite-reader";

/**
 * Cursor's `User` data directory, per platform. Cursor's path, not product
 * configuration — keeping it here (and injectable via the constructor) keeps
 * this public package brand-free (PRD §6 open/closed boundary).
 */
export function defaultCursorUserDir(): string {
	const home = homedir();
	if (process.platform === "darwin") {
		return join(home, "Library", "Application Support", "Cursor", "User");
	}
	if (process.platform === "win32") {
		const appData = process.env.APPDATA ?? join(home, "AppData", "Roaming");
		return join(appData, "Cursor", "User");
	}
	// Linux and other Unixes.
	return join(home, ".config", "Cursor", "User");
}

/**
 * Resolves a workspace's `workspace.json` to the absolute folder path of the
 * repo it represents, or null when it does not name a single repo directory.
 *
 * Cursor stores `folder: "file:///abs/project"` for a single-folder window —
 * the repo directory we match against. A multi-root window instead stores
 * `workspace: "file:///…/x.code-workspace"` (or an internal, generated
 * `…/Workspaces/<ts>/workspace.json`), which is a CONFIG FILE listing several
 * folders — NOT a repo directory. Treating that file path as a repo minted junk
 * dashboard "repos" literally named `workspace.json` / `foo.code-workspace` (and
 * uploaded them). We therefore accept ONLY `folder`; multi-root windows are
 * skipped here — proper multi-root fan-out (reading the config's folder list) is
 * a deliberate follow-up. Returns null on any read/parse failure.
 */
export async function readWorkspaceFolder(
	workspaceJsonPath: string,
): Promise<string | null> {
	let raw: string;
	try {
		raw = await readFile(workspaceJsonPath, "utf8");
	} catch {
		return null;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}
	if (typeof parsed !== "object" || parsed === null) {
		return null;
	}
	const uri = (parsed as { folder?: unknown }).folder;
	if (typeof uri !== "string") {
		return null;
	}
	let path: string;
	try {
		path = uri.startsWith("file:") ? fileURLToPath(uri) : uri;
	} catch {
		return null;
	}
	// Defensive: even a `folder` that somehow resolves to a workspace CONFIG file
	// (not a project dir) must never become a repo.
	return isWorkspaceConfigFile(path) ? null : path;
}

/** True for a Cursor/VS Code workspace CONFIG file — a multi-root
 * `.code-workspace`, or the internal generated `workspace.json` — none of which
 * is a project directory. Guards discovery against minting a repo named after
 * the config file. */
function isWorkspaceConfigFile(path: string): boolean {
	const base = basename(path).toLowerCase();
	return base === "workspace.json" || base.endsWith(".code-workspace");
}

/**
 * Reads Cursor's local SQLite chat store and converts each conversation that
 * belongs to `repoPath` into the normalized {@link SessionEvent} stream.
 *
 * Privacy by construction (CLAUDE.md invariant #1): bubble text/params/results
 * are read with loose schemas, reduced to structural features at parse time,
 * and every returned batch is re-validated against the strict
 * `SessionEventSchema`. Strictly READ-ONLY: the store is opened read-only and
 * never written; every reader is closed, and any failure (SQLite unavailable,
 * unreadable DB/row) degrades to fewer/zero events — never a throw.
 */
export class CursorCollector implements Collector {
	readonly source = "cursor" as const;
	private readonly userDir: string;
	private readonly open: OpenSqlite;

	constructor({
		userDir,
		openSqlite: openSqliteOverride,
	}: { userDir?: string; openSqlite?: OpenSqlite } = {}) {
		this.userDir = userDir ?? defaultCursorUserDir();
		this.open = openSqliteOverride ?? openSqlite;
	}

	private globalDbPath(): string {
		return join(this.userDir, "globalStorage", "state.vscdb");
	}

	/**
	 * True iff the global chat store exists AND SQLite can open it. A runtime
	 * without a SQLite module reports false (so analysis simply runs the other
	 * tools' collectors instead). Never throws.
	 */
	async detect(): Promise<boolean> {
		const reader = await this.open(this.globalDbPath());
		if (reader === null) {
			return false;
		}
		try {
			reader.close();
		} catch {}
		return true;
	}

	/** Union of the conversation ids for every workspace whose folder is
	 * `resolvedRepoPath`. A repo opened in several windows has several workspace
	 * hashes; we merge them. */
	private async composerIdsForRepo(
		resolvedRepoPath: string,
	): Promise<string[]> {
		const workspaceStorage = join(this.userDir, "workspaceStorage");
		let entries: import("node:fs").Dirent[];
		try {
			entries = await readdir(workspaceStorage, { withFileTypes: true });
		} catch {
			return [];
		}
		const ids = new Set<string>();
		for (const entry of entries) {
			if (!entry.isDirectory()) {
				continue;
			}
			const workspaceDir = join(workspaceStorage, entry.name);
			const folder = await readWorkspaceFolder(
				join(workspaceDir, "workspace.json"),
			);
			if (folder === null || resolve(folder) !== resolvedRepoPath) {
				continue;
			}
			const reader = await this.open(join(workspaceDir, "state.vscdb"));
			if (reader === null) {
				continue;
			}
			try {
				for (const id of readWorkspaceComposerIds(reader)) {
					ids.add(id);
				}
			} finally {
				reader.close();
			}
		}
		return [...ids];
	}

	/**
	 * Parses every Cursor conversation recorded for `repoPath`, ordered by
	 * conversation start time. `since` is an exclusive cutoff applied AFTER
	 * mapping (lookahead fields see the full conversation), with a fast-path
	 * skip for conversations whose `lastUpdatedAt` is at or before it.
	 */
	async collect({
		repoPath,
		since,
	}: CollectorOptions): Promise<SessionEvent[]> {
		const resolvedRepoPath = resolve(repoPath);
		const composerIds = await this.composerIdsForRepo(resolvedRepoPath);
		if (composerIds.length === 0) {
			return [];
		}
		const globalReader = await this.open(this.globalDbPath());
		if (globalReader === null) {
			return [];
		}
		const sessions: Array<{ startTimestamp: string; events: SessionEvent[] }> =
			[];
		try {
			for (const composerId of composerIds) {
				const composer = readComposerMeta(globalReader, composerId);
				if (composer === null) {
					continue;
				}
				if (
					since !== undefined &&
					typeof composer.lastUpdatedAt === "number" &&
					composer.lastUpdatedAt <= since.getTime()
				) {
					continue;
				}
				const headers = composer.fullConversationHeadersOnly ?? [];
				const bubbles = headers
					.map((header) =>
						readBubble(globalReader, composerId, header.bubbleId),
					)
					.filter((bubble): bubble is RawBubble => bubble !== null);
				const mapped = mapCursorConversationToEvents(
					composerId,
					composer,
					bubbles,
				);
				if (mapped.length === 0) {
					continue;
				}
				const startTimestamp = mapped[0].timestamp;
				const events =
					since === undefined
						? mapped
						: mapped.filter(
								(event) => Date.parse(event.timestamp) > since.getTime(),
							);
				if (events.length > 0) {
					sessions.push({ startTimestamp, events });
				}
			}
		} finally {
			globalReader.close();
		}
		sessions.sort((a, b) => a.startTimestamp.localeCompare(b.startTimestamp));
		const allEvents = sessions.flatMap((session) => session.events);
		// Runtime enforcement of the no-free-text invariant: every batch must
		// pass the strict schema before it leaves the collector.
		return z.array(SessionEventSchema).parse(allEvents);
	}
}
