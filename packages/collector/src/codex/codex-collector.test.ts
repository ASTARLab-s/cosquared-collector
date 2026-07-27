import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { SessionEvent } from "@cosquared/schema";
import { describe, expect, test } from "vitest";
import { CodexCollector } from "./codex-collector";

/**
 * Golden-file tests against a synthetic rollout store. The golden file IS the
 * public contract for how Codex CLI's rollout format (cli_version 0.142) maps
 * to events — when Codex's format drifts, these break loudly (CLAUDE.md
 * collector test standard; PRD §14 Risk #4).
 */

const fixtureSessionsDir = fileURLToPath(
	new URL("./__fixtures__/sessions", import.meta.url),
);
const FIXTURE_REPO_PATH = "/tmp/fixture-repo";
const BASIC_SESSION_ID = "019f0000-0000-7000-8000-000000000001";
const DRIFT_SESSION_ID = "019f0000-0000-7000-8000-000000000002";

function fixtureCollector(): CodexCollector {
	return new CodexCollector({ sessionsDir: fixtureSessionsDir });
}

async function collectFixtureEvents(since?: Date): Promise<SessionEvent[]> {
	return fixtureCollector().collect({ repoPath: FIXTURE_REPO_PATH, since });
}

describe("CodexCollector", () => {
	test("detect is true when the sessions dir exists", async () => {
		await expect(fixtureCollector().detect()).resolves.toBe(true);
	});

	test("detect is false when the sessions dir is absent", async () => {
		const collector = new CodexCollector({
			sessionsDir: "/nonexistent/codex/sessions",
		});
		await expect(collector.detect()).resolves.toBe(false);
	});

	test("collects the basic rollout into the golden event stream", async () => {
		const events = await collectFixtureEvents();
		const basicSessionEvents = events.filter(
			(event) => event.sessionId === BASIC_SESSION_ID,
		);
		const golden = JSON.parse(
			readFileSync(
				`${fixtureSessionsDir}/2026/06/10/session-basic.expected.json`,
				"utf8",
			),
		) as SessionEvent[];
		expect(basicSessionEvents).toEqual(golden);
	});

	test("excludes rollouts whose cwd is a different repo", async () => {
		const events = await collectFixtureEvents();
		// The foreign rollout (cwd /tmp/some-other-repo) must not appear.
		expect(
			events.some(
				(event) => event.sessionId === "019f0000-0000-7000-8000-000000000003",
			),
		).toBe(false);
	});

	test("survives format drift: malformed line, unknown type, unknown tool", async () => {
		const events = await collectFixtureEvents();
		const driftEvents = events.filter(
			(event) => event.sessionId === DRIFT_SESSION_ID,
		);
		expect(driftEvents).toEqual([
			expect.objectContaining({ type: "session_start" }),
			expect.objectContaining({ type: "user_prompt", wordCount: 4 }),
			expect.objectContaining({
				type: "tool_call",
				toolName: "quantum_tool",
				category: "other",
			}),
			expect.objectContaining({ type: "session_end" }),
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

	test("returns empty for a repo with no matching rollouts", async () => {
		const events = await fixtureCollector().collect({
			repoPath: "/tmp/never-analyzed-repo",
		});
		expect(events).toEqual([]);
	});

	test("since filters out events at or before the cutoff", async () => {
		// Exclusive cutoff on the basic session's test_run timestamp: that event
		// and everything before it drop; later events survive.
		const since = new Date("2026-06-10T10:01:00.000Z");
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

	// Regression: a GLOBAL Codex store is full of foreign-repo rollouts, and the
	// reader breaks out of each as soon as its cwd doesn't match. `readline`'s
	// close() does NOT close the underlying read stream, so without an explicit
	// destroy each foreign file leaks its file descriptor — across a multi-repo
	// sync that exhausts the fd limit and deadlocks. Repeated collects must not
	// grow the process's open-fd count. Skipped where `/dev/fd` isn't readable.
	test("does not leak file descriptors across repeated collects", async () => {
		let openFdCount: () => number;
		try {
			const { readdirSync } = await import("node:fs");
			readdirSync("/dev/fd");
			openFdCount = () => readdirSync("/dev/fd").length;
		} catch {
			return; // no /dev/fd on this platform — nothing to assert
		}
		// Warm up (module init / lazy fd allocation) before sampling.
		await collectFixtureEvents();
		const before = openFdCount();
		for (let i = 0; i < 25; i++) {
			await collectFixtureEvents();
		}
		const after = openFdCount();
		// A leak would add ~one fd per foreign rollout per pass (25+); allow a
		// small slack for unrelated fd churn.
		expect(after - before).toBeLessThan(10);
	});

	// The privacy guard for the whole collector: none of the raw strings planted
	// in the fixture rollout may survive into the event stream (CLAUDE.md
	// invariant #1 — raw transcript/command/output text never leaves the parser).
	test("serialized output never contains rollout text", async () => {
		const serialized = JSON.stringify(await collectFixtureEvents());
		const plantedRawStrings = [
			"PLANTED_USER_PROMPT",
			"PLANTED_ENV_CONTEXT",
			"PLANTED_REASONING",
			"PLANTED_SHELL_CMD",
			"PLANTED_EXEC_OUTPUT",
			"PLANTED_PATCH_BODY",
			"PLANTED_PATCH_RESULT",
			"PLANTED_PLAN_EXPLANATION",
			"PLANTED_PLAN_STEP",
			"PLANTED_BUILD_CMD",
			"PLANTED_BUILD_ERROR",
			"PLANTED_AGENT_MESSAGE",
			"PLANTED_DRIFT_PROMPT",
			"PLANTED_FUTURE",
			"pytest -q", // exec command text
			"*** Begin Patch", // apply_patch body
			"/tmp/fixture-repo", // the cwd is read for filtering, never emitted
		];
		for (const raw of plantedRawStrings) {
			expect(serialized).not.toContain(raw);
		}
	});
});
