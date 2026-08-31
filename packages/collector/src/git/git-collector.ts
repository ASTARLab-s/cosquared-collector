import {
	type ChildProcess,
	execFile as execFileCallback,
	spawn,
} from "node:child_process";
import { resolve } from "node:path";
import { createInterface, type Interface } from "node:readline";
import { promisify } from "node:util";
import { type SessionEvent, SessionEventSchema } from "@cosquared/schema";
import { z } from "zod";
import type { Collector, CollectorOptions } from "../collector";
import {
	CHURN_WINDOW_DAYS,
	type ChurnTotals,
	reduceChurnLines,
} from "./churn-reduction";
import { deriveRepoSnapshot, mapCommitsToEvents } from "./event-mapping";
import {
	buildCommitIdentity,
	type CommitIdentity,
	hasIdentity,
} from "./identity";
import { type ReducedCommit, reduceLogLines } from "./log-reduction";

const execFile = promisify(execFileCallback);

/**
 * Wall-clock cap on a single non-streaming git invocation (`rev-parse`,
 * `config`, `ls-files`, `log -1`). iCloud Drive can block `git` forever
 * while materializing offloaded files (2026-08-25: `git log --numstat`
 * hung on a Documents/ repo during calibration). Degrade to no events
 * rather than stall `cosq analyze` / `sync`.
 */
export const GIT_COMMAND_TIMEOUT_MS = 30_000;

/**
 * Silence cap on a streaming `git log --numstat`. If no stdout arrives
 * for this long the process is treated as hung (iCloud / git-lfs) and
 * killed. A log that is still emitting lines on a large repo keeps
 * running — this is a stall timeout, not a total-duration cap.
 */
export const GIT_STALL_TIMEOUT_MS = 30_000;

/**
 * Reads a repo's git metadata and converts it into the normalized
 * {@link SessionEvent} stream: one `commit` event per commit authored by
 * any of the user's identities (effective `user.email`/`user.name` plus any
 * configured extras — see {@link resolveIdentity}), plus one `repo_snapshot`
 * of repo-shape counts at HEAD.
 *
 * Privacy by construction (CLAUDE.md invariant #1): commit messages are
 * never read (the log format string does not request them); file paths and
 * the author email/name are inspected transiently and reduced to counts and
 * booleans; every returned batch is re-validated against the strict
 * `SessionEventSchema`. Strictly read-only: the repo is never written,
 * moved, or locked.
 *
 * Invokes the system `git` binary directly (array argv, no shell — no
 * injection surface) so this public package carries zero runtime
 * dependencies beyond the schema (PRD §8: auditability is the trust
 * strategy). Every git failure degrades to fewer/zero events, never a
 * throw (PRD §14 Risk #4).
 */
export class GitCollector implements Collector {
	readonly source = "git" as const;
	private readonly gitBinary: string;
	private readonly commandTimeoutMs: number;
	private readonly stallTimeoutMs: number;

	constructor({
		gitBinary,
		commandTimeoutMs = GIT_COMMAND_TIMEOUT_MS,
		stallTimeoutMs = GIT_STALL_TIMEOUT_MS,
	}: {
		gitBinary?: string;
		commandTimeoutMs?: number;
		stallTimeoutMs?: number;
	} = {}) {
		this.gitBinary = gitBinary ?? "git";
		this.commandTimeoutMs = commandTimeoutMs;
		this.stallTimeoutMs = stallTimeoutMs;
	}

	/** True iff the git binary runs. Never throws. */
	async detect(): Promise<boolean> {
		try {
			await execFile(this.gitBinary, ["--version"], {
				timeout: this.commandTimeoutMs,
				killSignal: "SIGKILL",
			});
			return true;
		} catch {
			return false;
		}
	}

	/**
	 * Collects the current user's commit history and the HEAD repo
	 * snapshot for `repoPath`.
	 *
	 * `since` is an exclusive cutoff (events with `timestamp > since`
	 * survive), applied uniformly to commits AND the snapshot — an
	 * unchanged repo re-synced emits nothing, including no stale
	 * snapshot. Git's own `--since` is used only as a coarse pre-filter.
	 */
	async collect({
		repoPath,
		since,
		identities,
	}: CollectorOptions): Promise<SessionEvent[]> {
		const repo = resolve(repoPath);
		if (!(await this.isWorkTree(repo))) {
			return [];
		}

		const allEvents: SessionEvent[] = [];

		// No known identity → skip commit events but still emit the snapshot
		// (the snapshot is authorship-independent; churn is NOT — it measures
		// the user's own rework, so it is skipped too). Identities live only in
		// this local and inside the reducers' comparisons — never stored.
		const identity = await this.resolveIdentity(repo, identities);
		if (hasIdentity(identity)) {
			const commits = await this.streamCommitLog(repo, since);
			allEvents.push(...mapCommitsToEvents(commits, identity));
		}

		// No HEAD (fresh `git init`) → no deterministic timestamp → no
		// snapshot and no churn. Both stamp HEAD's committer date so an
		// unchanged repo re-synced under `since` emits nothing.
		const headIso = await this.headCommitDate(repo);
		if (headIso !== null) {
			const snapshot = await this.headSnapshot(repo, headIso);
			if (snapshot !== null) {
				allEvents.push(snapshot);
			}
			if (hasIdentity(identity)) {
				const churn = await this.churnSnapshot(repo, headIso, identity);
				if (churn !== null) {
					allEvents.push(churn);
				}
			}
		}

		const events =
			since === undefined
				? allEvents
				: allEvents.filter(
						(event) => Date.parse(event.timestamp) > since.getTime(),
					);
		// Runtime enforcement of the no-free-text invariant: every batch must
		// pass the strict schema before it leaves the collector.
		return z.array(SessionEventSchema).parse(events);
	}

	private async git(repo: string, args: string[]): Promise<string | null> {
		try {
			const { stdout } = await execFile(this.gitBinary, ["-C", repo, ...args], {
				timeout: this.commandTimeoutMs,
				killSignal: "SIGKILL",
			});
			return stdout;
		} catch {
			return null;
		}
	}

	private async isWorkTree(repo: string): Promise<boolean> {
		const result = await this.git(repo, ["rev-parse", "--is-inside-work-tree"]);
		return result !== null && result.trim() === "true";
	}

	/**
	 * The user's git identities for THIS repo: the effective `user.email` and
	 * `user.name` (repo-local config overriding global, exactly as git resolves
	 * them for new commits), plus any extra emails/names the caller supplies from
	 * `~/.cosquared/config.toml`. A commit is attributed if its author email OR
	 * name matches any of these — see {@link CommitIdentity}. All values are
	 * TRANSIENT: compared and dropped, never emitted.
	 */
	private async resolveIdentity(
		repo: string,
		extras: CollectorOptions["identities"],
	): Promise<CommitIdentity> {
		const [email, name] = await Promise.all([
			this.gitConfigValue(repo, "user.email"),
			this.gitConfigValue(repo, "user.name"),
		]);
		return buildCommitIdentity({
			emails: [...(email !== null ? [email] : []), ...(extras?.emails ?? [])],
			names: [...(name !== null ? [name] : []), ...(extras?.names ?? [])],
		});
	}

	/** A single `git config <key>` value, trimmed; null when unset/empty. */
	private async gitConfigValue(
		repo: string,
		key: string,
	): Promise<string | null> {
		const result = await this.git(repo, ["config", key]);
		const value = result?.trim() ?? "";
		return value.length > 0 ? value : null;
	}

	/**
	 * Streams `git log` straight through the line reducer — spawn, not
	 * execFile, because full-history `--numstat` on a large monorepo can
	 * exceed any sane `maxBuffer`; lines are reduced as they arrive and
	 * never accumulated (mirrors the claude-code collector's "never read
	 * whole" rationale).
	 *
	 * `--no-merges`: merge commits carry no authored work and no numstat —
	 * including them would emit empty `commit` events that dilute cadence.
	 * Committer date (`%cI`), not author date: it aligns with git's
	 * `--since` filtering and with incremental-sync semantics — a rebased
	 * commit re-enters history with a new committer date and resurfaces
	 * instead of being silently lost behind the cutoff.
	 */
	private streamCommitLog(
		repo: string,
		since: Date | undefined,
	): Promise<ReducedCommit[]> {
		return this.streamGitLog(
			repo,
			[
				"--no-merges",
				"--numstat",
				"--format=%x1e%cI%x1f%ae%x1f%an",
				...(since ? [`--since=${since.toISOString()}`] : []),
			],
			(lines) => reduceLogLines(lines),
			[],
		);
	}

	/** HEAD committer date, UTC-normalized — null when the repo has no HEAD. */
	private async headCommitDate(repo: string): Promise<string | null> {
		const headDate = await this.git(repo, ["log", "-1", "--format=%cI"]);
		const headMillis = Date.parse(headDate?.trim() ?? "");
		return Number.isNaN(headMillis) ? null : new Date(headMillis).toISOString();
	}

	private async headSnapshot(
		repo: string,
		headIso: string,
	): Promise<SessionEvent | null> {
		// `-z` NUL-terminates entries because paths can contain newlines.
		const lsFiles = await this.git(repo, ["ls-files", "-z"]);
		if (lsFiles === null) {
			return null;
		}
		const trackedPaths = lsFiles.split("\0").filter((path) => path.length > 0);
		return deriveRepoSnapshot(trackedPaths, headIso);
	}

	/**
	 * The `churn_snapshot` event: one extra bounded `git log` pass over the
	 * trailing scan window, streamed through {@link reduceChurnLines}. The
	 * scan window is 2 × {@link CHURN_WINDOW_DAYS} (derived, not a second
	 * magic number) so a deletion early in the 14-day cohort can still see
	 * the additions up to 14 days before it that it churns.
	 */
	private async churnSnapshot(
		repo: string,
		headIso: string,
		identity: CommitIdentity,
	): Promise<SessionEvent | null> {
		const scanWindowMillis = CHURN_WINDOW_DAYS * 2 * 86_400_000;
		const scanSinceIso = new Date(
			Date.parse(headIso) - scanWindowMillis,
		).toISOString();
		const totals = await this.streamChurnLog(repo, scanSinceIso, {
			windowDays: CHURN_WINDOW_DAYS,
			identity,
			referenceTime: headIso,
		});
		if (totals === null) {
			return null;
		}
		return {
			sessionId: null,
			source: "git",
			timestamp: headIso,
			type: "churn_snapshot",
			windowDays: totals.windowDays,
			linesAdded: totals.linesAdded,
			linesChurned: totals.linesChurned,
		};
	}

	/** Mirrors {@link streamCommitLog}: spawn, stream, degrade — never throw. */
	private streamChurnLog(
		repo: string,
		scanSinceIso: string,
		options: {
			windowDays: number;
			identity: CommitIdentity;
			referenceTime: string;
		},
	): Promise<ChurnTotals | null> {
		return this.streamGitLog(
			repo,
			[
				"--no-merges",
				"--numstat",
				"--format=%x1e%cI%x1f%ae%x1f%an",
				`--since=${scanSinceIso}`,
			],
			(lines) => reduceChurnLines(lines, options),
			null,
		);
	}

	/**
	 * Spawn `git log …`, reduce stdout line-by-line, kill the child if it
	 * goes silent for {@link GIT_STALL_TIMEOUT_MS}. stdio is
	 * `["ignore","pipe","ignore"]`: we consume ONLY stdout. Leaving
	 * stdin/stderr as inheritable pipes lets a child git spawns (e.g.
	 * `git-lfs filter-process` in an LFS repo) inherit and hold them open,
	 * which can stall the read; and an unread stderr pipe deadlocks if git
	 * ever writes >64KB to it.
	 */
	private streamGitLog<T>(
		repo: string,
		logArgs: string[],
		reduce: (lines: Interface) => Promise<T>,
		fallback: T,
	): Promise<T> {
		return new Promise((resolveResult) => {
			const child = spawn(this.gitBinary, ["-C", repo, "log", ...logArgs], {
				stdio: ["ignore", "pipe", "ignore"],
			});
			if (child.stdout === null) {
				killHungGit(child);
				resolveResult(fallback);
				return;
			}
			const stall = setTimeout(() => killHungGit(child), this.stallTimeoutMs);
			child.stdout.on("data", () => {
				stall.refresh();
			});
			const reduced = reduce(
				createInterface({
					input: child.stdout,
					crlfDelay: Number.POSITIVE_INFINITY,
				}),
			).catch((): T => fallback);

			let settled = false;
			const finish = (value: T | Promise<T>) => {
				if (settled) {
					return;
				}
				settled = true;
				clearTimeout(stall);
				resolveResult(value);
			};
			child.once("error", () => finish(fallback));
			// `close` fires after stdout has ended, so `reduced` has seen every
			// line by then. Non-zero exit (e.g. 128 on a repo with no commits,
			// or SIGKILL after a stall) means "no history to report" — degrade.
			child.once("close", (code) => {
				finish(code === 0 ? reduced : fallback);
			});
		});
	}
}

function killHungGit(child: ChildProcess): void {
	if (!child.killed) {
		child.kill("SIGKILL");
	}
	child.stdout?.destroy();
}
