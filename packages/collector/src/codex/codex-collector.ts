import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { type SessionEvent, SessionEventSchema } from "@cosquared/schema";
import { z } from "zod";
import type { Collector, CollectorOptions } from "../collector";
import { mapRolloutToEvents } from "./event-mapping";
import {
	parseRolloutLine,
	type RolloutLine,
	SessionMetaPayloadSchema,
} from "./rollout-line";

/**
 * Codex CLI's well-known session store location. Codex's path, not product
 * configuration — keeping it here (and injectable via the constructor) keeps
 * this public package brand-free (PRD §6 open/closed boundary).
 */
export function defaultCodexSessionsDir(): string {
	return join(homedir(), ".codex", "sessions");
}

/** Matches the trailing UUID in `rollout-<ISO>-<uuid>.jsonl`. */
const ROLLOUT_UUID =
	/-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

/** Recovers the session UUID from a rollout filename, the fallback sessionId
 * when a rollout omits `session_meta` (older format). */
function rolloutSessionId(filePath: string): string {
	const match = ROLLOUT_UUID.exec(filePath);
	return match?.[1] ?? basename(filePath, ".jsonl");
}

/** Recursively lists every `*.jsonl` file under Codex's date-nested tree
 * (`YYYY/MM/DD/`). An unreadable directory degrades to fewer files, never a
 * throw (PRD §14 Risk #4). */
async function walkJsonlFiles(dir: string): Promise<string[]> {
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
			files.push(...(await walkJsonlFiles(full)));
		} else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
			files.push(full);
		}
	}
	return files;
}

/**
 * Streams a rollout file line by line (rollouts reach multiple megabytes —
 * never read whole) into parsed lines, but ONLY if it belongs to `repoPath`.
 *
 * Codex's sessions store is GLOBAL, not per-repo: every rollout declares its
 * own working directory in `session_meta.cwd`. We read that header first and
 * stop immediately if it isn't this repo — so a 1000-file store costs one line
 * per foreign session, not a full parse. Returns null to mean "skip this file"
 * (foreign repo, or no attributable `cwd`).
 */
async function readRolloutLinesForRepo(
	filePath: string,
	resolvedRepoPath: string,
): Promise<RolloutLine[] | null> {
	const lines: RolloutLine[] = [];
	let cwdMatches: boolean | null = null;
	// Hold the stream so we can DESTROY it in `finally`: `readline.Interface`'s
	// `close()` stops reading but does NOT close its input stream, so breaking out
	// early (the common foreign-repo case below) would otherwise leak the open
	// file descriptor. In a GLOBAL Codex store most rollouts are foreign, so that
	// leak accumulates ~one fd per session per repo across a multi-repo sync and
	// can exhaust the process fd limit (1024 on Linux) — a hang/EMFILE.
	const input = createReadStream(filePath, { encoding: "utf8" });
	const reader = createInterface({
		input,
		crlfDelay: Number.POSITIVE_INFINITY,
	});
	try {
		for await (const raw of reader) {
			const parsed = parseRolloutLine(raw);
			if (parsed === null) {
				continue;
			}
			if (cwdMatches === null && parsed.type === "session_meta") {
				const meta = SessionMetaPayloadSchema.safeParse(parsed.payload);
				const cwd = meta.success ? meta.data.cwd : undefined;
				if (typeof cwd === "string") {
					cwdMatches = resolve(cwd) === resolvedRepoPath;
					if (!cwdMatches) {
						break;
					}
				}
			}
			lines.push(parsed);
		}
	} finally {
		reader.close();
		input.destroy();
	}
	return cwdMatches === true ? lines : null;
}

/**
 * Reads Codex CLI's local session store and converts each rollout that ran in
 * `repoPath` into the normalized {@link SessionEvent} stream.
 *
 * Privacy by construction (CLAUDE.md invariant #1): raw lines are parsed with
 * loose schemas, reduced to structural features at parse time, and every
 * returned batch is re-validated against the strict `SessionEventSchema` — a
 * runtime proof that no free-text field can leave this collector. Strictly
 * read-only: the store is never written, moved, or locked.
 */
export class CodexCollector implements Collector {
	readonly source = "codex-cli" as const;
	private readonly sessionsDir: string;

	constructor({ sessionsDir }: { sessionsDir?: string } = {}) {
		this.sessionsDir = sessionsDir ?? defaultCodexSessionsDir();
	}

	/** True iff the Codex sessions store exists. Never throws. */
	async detect(): Promise<boolean> {
		try {
			return (await stat(this.sessionsDir)).isDirectory();
		} catch {
			return false;
		}
	}

	/**
	 * Parses every rollout recorded for `repoPath` into events, ordered by
	 * session start time. `since` semantics match the Claude collector: an
	 * exclusive cutoff applied AFTER mapping (so lookahead fields see the full
	 * session), with an mtime fast-path skip for files untouched since then.
	 * Any unreadable/foreign file is skipped, never fatal.
	 */
	async collect({
		repoPath,
		since,
	}: CollectorOptions): Promise<SessionEvent[]> {
		const resolvedRepoPath = resolve(repoPath);
		const files = await walkJsonlFiles(this.sessionsDir);
		const sessions: Array<{ startTimestamp: string; events: SessionEvent[] }> =
			[];
		for (const filePath of files) {
			try {
				if (since !== undefined) {
					const { mtime } = await stat(filePath);
					if (mtime.getTime() <= since.getTime()) {
						continue;
					}
				}
				const lines = await readRolloutLinesForRepo(filePath, resolvedRepoPath);
				if (lines === null) {
					continue;
				}
				const mapped = mapRolloutToEvents(lines, rolloutSessionId(filePath));
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
			} catch {}
		}
		sessions.sort((a, b) => a.startTimestamp.localeCompare(b.startTimestamp));
		const allEvents = sessions.flatMap((session) => session.events);
		// Runtime enforcement of the no-free-text invariant: every batch must
		// pass the strict schema before it leaves the collector.
		return z.array(SessionEventSchema).parse(allEvents);
	}
}
