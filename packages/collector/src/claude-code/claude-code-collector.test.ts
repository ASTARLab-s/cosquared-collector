import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SessionEvent } from "@cosquared/schema";
import { describe, expect, test } from "vitest";
import {
	ClaudeCodeCollector,
	encodeProjectDirName,
} from "./claude-code-collector";

/**
 * Golden-file tests against a synthetic fixture store. The golden file IS
 * the public contract for how Claude Code's v2.1.170 transcript format
 * maps to events — when Claude Code's format drifts, these tests break
 * loudly (CLAUDE.md collector test standard; PRD §14 Risk #4). Updating
 * the golden file is a deliberate, reviewed act.
 */

const fixtureProjectsDir = fileURLToPath(
	new URL("./__fixtures__/projects", import.meta.url),
);
const FIXTURE_REPO_PATH = "/tmp/fixture-repo";
const BASIC_SESSION_ID = "00000000-0000-4000-8000-000000000001";
const DRIFT_SESSION_ID = "00000000-0000-4000-8000-000000000002";

function fixtureCollector(): ClaudeCodeCollector {
	return new ClaudeCodeCollector({ projectsDir: fixtureProjectsDir });
}

async function collectFixtureEvents(since?: Date): Promise<SessionEvent[]> {
	return fixtureCollector().collect({ repoPath: FIXTURE_REPO_PATH, since });
}

describe("encodeProjectDirName", () => {
	const fixtures: Record<string, { repoPath: string; expected: string }> = {
		plainAbsolutePath: {
			repoPath: "/Users/dev/Developer/sandbox",
			expected: "-Users-dev-Developer-sandbox",
		},
		dotsAndUnderscoresBecomeDashes: {
			repoPath: "/Users/x/my.app_v2",
			expected: "-Users-x-my-app-v2",
		},
		fixtureRepoPath: {
			repoPath: "/tmp/fixture-repo",
			expected: "-tmp-fixture-repo",
		},
	};

	test.each(
		Object.entries(fixtures),
	)("derives the project directory name: %s", (_name, {
		repoPath,
		expected,
	}) => {
		expect(encodeProjectDirName(repoPath)).toBe(expected);
	});
});

describe("ClaudeCodeCollector", () => {
	test("detect is true when the projects dir exists", async () => {
		await expect(fixtureCollector().detect()).resolves.toBe(true);
	});

	test("detect is false when the projects dir is absent", async () => {
		const collector = new ClaudeCodeCollector({
			projectsDir: "/nonexistent/claude/projects",
		});
		await expect(collector.detect()).resolves.toBe(false);
	});

	test("collects the basic fixture session into the golden event stream", async () => {
		const events = await collectFixtureEvents();
		const basicSessionEvents = events.filter(
			(event) => event.sessionId === BASIC_SESSION_ID,
		);
		const golden = JSON.parse(
			readFileSync(
				`${fixtureProjectsDir}/-tmp-fixture-repo/session-basic.expected.json`,
				"utf8",
			),
		) as SessionEvent[];
		expect(basicSessionEvents).toEqual(golden);
	});

	test("survives format drift: malformed lines and unknown types yield partial events, not a crash", async () => {
		const events = await collectFixtureEvents();
		const driftEvents = events.filter(
			(event) => event.sessionId === DRIFT_SESSION_ID,
		);
		expect(driftEvents).toEqual([
			expect.objectContaining({ type: "session_start" }),
			expect.objectContaining({ type: "user_prompt", wordCount: 4 }),
			expect.objectContaining({
				type: "tool_call",
				toolName: "FutureTool",
				category: "other",
			}),
			expect.objectContaining({ type: "session_end", durationMinutes: 1 }),
		]);
	});

	test("orders sessions by their start timestamp", async () => {
		const events = await collectFixtureEvents();
		const sessionStarts = events.filter(
			(event) => event.type === "session_start",
		);
		expect(sessionStarts.map((event) => event.sessionId)).toEqual([
			BASIC_SESSION_ID,
			DRIFT_SESSION_ID,
		]);
	});

	test("returns empty for a repo with no session store", async () => {
		const events = await fixtureCollector().collect({
			repoPath: "/tmp/never-analyzed-repo",
		});
		expect(events).toEqual([]);
	});

	test("since filters out events at or before the cutoff", async () => {
		// Exclusive cutoff exactly on the basic session's test_run timestamp:
		// that event and everything before it drop; later events survive.
		const since = new Date("2026-06-10T10:02:00.000Z");
		const events = await collectFixtureEvents(since);
		expect(events.length).toBeGreaterThan(0);
		expect(events.some((event) => event.type === "test_run")).toBe(false);
		expect(
			events.every((event) => Date.parse(event.timestamp) > since.getTime()),
		).toBe(true);
		// Lookahead fields are still computed from the FULL session.
		expect(
			events.filter((event) => event.type === "error_encountered"),
		).toEqual([expect.objectContaining({ resolved: true })]);
	});

	test("output is byte-stable JSON", async () => {
		const first = JSON.stringify(await collectFixtureEvents());
		const second = JSON.stringify(await collectFixtureEvents());
		expect(first).toBe(second);
	});

	// The privacy guard for the whole collector: none of the raw strings
	// planted in the fixture transcript may survive into the event stream
	// (CLAUDE.md invariant #1 — raw transcript text never leaves the parser).
	test("serialized output never contains transcript text", async () => {
		const serialized = JSON.stringify(await collectFixtureEvents());
		const plantedRawStrings = [
			"implement the collector", // typed prompt
			"strict objects for every event", // typed prompt
			"PLANTED_", // every edit/write/result body marker
			".agents/plans/feature.md", // file path from Write input
			"pnpm typecheck", // Bash command text
			"doesn't want to proceed", // rejection result text
			"src/secret-notes.ts", // sidechain Read target
		];
		for (const raw of plantedRawStrings) {
			expect(serialized).not.toContain(raw);
		}
	});
});

describe("ClaudeCodeCollector conversation dedupe", () => {
	/**
	 * Claude Code APPENDS to one file on resume, so it duplicates far less
	 * than Codex — but it does FORK: interrupting a turn and branching
	 * writes a second transcript that replays the shared opening. Measured
	 * on the operator's store (calibration 2026-08-31): one overlapping
	 * pair, 6 replayed prompts, 2.3% of the local corpus.
	 */
	const REPO = "/tmp/fork-repo";

	function store(files: Record<string, string[]>): string {
		const dir = mkdtempSync(join(tmpdir(), "claude-fork-"));
		const projectDir = join(dir, "-tmp-fork-repo");
		mkdirSync(projectDir, { recursive: true });
		let sessionOrdinal = 0;
		for (const [name, prompts] of Object.entries(files)) {
			sessionOrdinal += 1;
			const sessionId = `00000000-0000-4000-8000-00000000010${sessionOrdinal}`;
			const lines = prompts.map((text, index) => ({
				type: "user",
				sessionId,
				timestamp: `2026-06-12T10:${String(index).padStart(2, "0")}:00.000Z`,
				message: { content: text },
			}));
			writeFileSync(
				join(projectDir, `${name}.jsonl`),
				`${lines.map((line) => JSON.stringify(line)).join("\n")}\n`,
			);
		}
		return dir;
	}

	async function promptCount(files: Record<string, string[]>) {
		const events = await new ClaudeCodeCollector({
			projectsDir: store(files),
		}).collect({ repoPath: REPO });
		const prompts = events.filter((event) => event.type === "user_prompt");
		return {
			prompts: prompts.length,
			sessions: new Set(prompts.map((event) => event.sessionId)).size,
		};
	}

	test("counts a forked conversation's shared opening only once", async () => {
		const shared = ["plan the migration", "now add the index", "run the tests"];
		expect(
			await promptCount({
				original: [...shared, "ship it"],
				fork: [...shared, "retry"],
			}),
		).toEqual({ prompts: 4, sessions: 1 });
	});

	test("keeps both branches when a fork became real work of its own", async () => {
		const shared = ["plan the migration", "now add the index"];
		expect(
			await promptCount({
				original: [...shared, "ship it", "tag the release"],
				branch: [...shared, "actually revert that", "try postgres instead"],
			}),
		).toEqual({ prompts: 8, sessions: 2 });
	});

	test("harness-authored lines never become prompts", async () => {
		expect(
			await promptCount({
				only: [
					"fix the flaky test",
					"[Request interrupted by user]",
					"[Request interrupted by user for tool use]",
					"try again with a longer timeout",
				],
			}),
		).toEqual({ prompts: 2, sessions: 1 });
	});
});
