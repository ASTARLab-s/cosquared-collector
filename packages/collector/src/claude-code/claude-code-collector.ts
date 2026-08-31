import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { type SessionEvent, SessionEventSchema } from "@cosquared/schema";
import { z } from "zod";
import type { Collector, CollectorOptions } from "../collector";
import { dropResumedDuplicates } from "../heuristics/conversation-dedupe";
import {
	conversationFingerprint,
	mapTranscriptToEvents,
} from "./event-mapping";
import { parseTranscriptLine, type TranscriptLine } from "./transcript-line";

/**
 * Claude Code's well-known session store location. This is Claude Code's
 * path, not product configuration — keeping it here (and injectable via
 * the constructor) keeps this public package brand-free (PRD §6
 * open/closed boundary).
 */
export function defaultClaudeProjectsDir(): string {
	return join(homedir(), ".claude", "projects");
}

/**
 * Derives the per-repo directory name Claude Code uses inside its projects
 * store: every character that is not `[A-Za-z0-9]` becomes `-`
 * (verified against v2.1.170: `/Users/x/dev/repo` → `-Users-x-dev-repo`).
 */
export function encodeProjectDirName(repoPath: string): string {
	return repoPath.replace(/[^A-Za-z0-9]/g, "-");
}

/**
 * Streams one transcript file line by line (transcripts reach multiple
 * megabytes — never read whole) and drops every line that is not a
 * well-formed `user`/`assistant` line. Parse failures degrade gracefully:
 * a malformed line costs that line, not the session (PRD §14 Risk #4).
 */
async function readTranscriptLines(
	filePath: string,
): Promise<TranscriptLine[]> {
	const lines: TranscriptLine[] = [];
	const reader = createInterface({
		input: createReadStream(filePath, { encoding: "utf8" }),
		crlfDelay: Number.POSITIVE_INFINITY,
	});
	for await (const raw of reader) {
		const parsed = parseTranscriptLine(raw);
		if (parsed !== null) {
			lines.push(parsed);
		}
	}
	return lines;
}

/**
 * Reads Claude Code's local session store and converts each transcript
 * into the normalized {@link SessionEvent} stream.
 *
 * Privacy by construction (CLAUDE.md invariant #1): raw lines are parsed
 * with loose schemas, reduced to structural features at parse time, and
 * every returned batch is re-validated against the strict
 * `SessionEventSchema` — a runtime proof that nothing non-conforming
 * (including any free-text field) can leave this collector. Strictly
 * read-only: the store is never written, moved, or locked.
 */
export class ClaudeCodeCollector implements Collector {
	readonly source = "claude-code" as const;
	private readonly projectsDir: string;

	constructor({ projectsDir }: { projectsDir?: string } = {}) {
		this.projectsDir = projectsDir ?? defaultClaudeProjectsDir();
	}

	/** True iff the Claude Code projects store exists. Never throws. */
	async detect(): Promise<boolean> {
		try {
			return (await stat(this.projectsDir)).isDirectory();
		} catch {
			return false;
		}
	}

	/**
	 * Parses every session transcript recorded for `repoPath` into events,
	 * ordered by session start time.
	 *
	 * `since` is an exclusive cutoff (events with `timestamp > since`
	 * survive), applied AFTER mapping so lookahead fields
	 * (`followedByValidation`, `resolved`) are computed from the full
	 * session. Files whose mtime is at or before `since` are skipped
	 * entirely — a transcript only grows, so an old mtime guarantees no
	 * new events (the fast path for incremental sync, PRD §7.0).
	 *
	 * A file that cannot be read or contains no parseable lines is
	 * skipped, never fatal (PRD §14 Risk #4 graceful degradation).
	 */
	async collect({
		repoPath,
		since,
	}: CollectorOptions): Promise<SessionEvent[]> {
		const projectDir = join(
			this.projectsDir,
			encodeProjectDirName(resolve(repoPath)),
		);
		let entries: string[];
		try {
			entries = await readdir(projectDir);
		} catch {
			return [];
		}
		const sessions: Array<{
			startTimestamp: string;
			events: SessionEvent[];
			fingerprint: string[];
		}> = [];
		for (const entry of entries.filter((name) => name.endsWith(".jsonl"))) {
			const filePath = join(projectDir, entry);
			try {
				if (since !== undefined) {
					const { mtime } = await stat(filePath);
					if (mtime.getTime() <= since.getTime()) {
						continue;
					}
				}
				const lines = await readTranscriptLines(filePath);
				const mapped = mapTranscriptToEvents(lines);
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
					// Fingerprint the FULL transcript, not the `since`-filtered
					// events: a forked copy and its original must line up on
					// their shared history for the overlap test to see it.
					sessions.push({
						startTimestamp,
						events,
						fingerprint: conversationFingerprint(lines),
					});
				}
			} catch {}
		}
		const distinct = dropResumedDuplicates(sessions);
		distinct.sort((a, b) => a.startTimestamp.localeCompare(b.startTimestamp));
		const allEvents = distinct.flatMap((session) => session.events);
		// Runtime enforcement of the no-free-text invariant: every batch must
		// pass the strict schema before it leaves the collector.
		return z.array(SessionEventSchema).parse(allEvents);
	}
}
