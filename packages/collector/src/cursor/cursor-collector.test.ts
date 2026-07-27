import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { SessionEvent } from "@cosquared/schema";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
	buildCursorFixture,
	CURSOR_PLANTED_STRINGS,
	FIXTURE_REPO_PATH,
} from "./__fixtures__/build-cursor-db";
import { CursorCollector, readWorkspaceFolder } from "./cursor-collector";

/**
 * Golden-file tests against a real `state.vscdb` built from inline JSON rows
 * (see build-cursor-db.ts). The golden file IS the public contract for how
 * Cursor's SQLite chat store maps to events; format drift breaks it loudly
 * (CLAUDE.md collector test standard; PRD §14 Risk #4).
 */

let userDir: string;

beforeAll(() => {
	userDir = mkdtempSync(`${tmpdir()}/cosq-cursor-`);
	buildCursorFixture(userDir);
});

afterAll(() => {
	rmSync(userDir, { recursive: true, force: true });
});

function fixtureCollector(): CursorCollector {
	return new CursorCollector({ userDir });
}

async function collectFixtureEvents(since?: Date): Promise<SessionEvent[]> {
	return fixtureCollector().collect({ repoPath: FIXTURE_REPO_PATH, since });
}

const goldenPath = fileURLToPath(
	new URL("./__fixtures__/expected-conversation.json", import.meta.url),
);

describe("CursorCollector", () => {
	test("detect is true when the global store exists and SQLite can open it", async () => {
		await expect(fixtureCollector().detect()).resolves.toBe(true);
	});

	test("detect is false when the store is absent", async () => {
		const collector = new CursorCollector({ userDir: "/nonexistent/cursor" });
		await expect(collector.detect()).resolves.toBe(false);
	});

	test("detect is false when SQLite is unavailable (adapter returns null)", async () => {
		const collector = new CursorCollector({
			userDir,
			openSqlite: async () => null,
		});
		await expect(collector.detect()).resolves.toBe(false);
	});

	test("collects the conversation into the golden event stream", async () => {
		const events = await collectFixtureEvents();
		const golden = JSON.parse(
			readFileSync(goldenPath, "utf8"),
		) as SessionEvent[];
		expect(events).toEqual(golden);
	});

	test("excludes conversations from a workspace whose folder is a different repo", async () => {
		const events = await collectFixtureEvents();
		// The foreign workspace's composer must never be read.
		expect(
			events.some(
				(event) => event.sessionId === "22222222-2222-4222-8222-222222222222",
			),
		).toBe(false);
	});

	test("returns empty for a repo with no matching workspace", async () => {
		const events = await fixtureCollector().collect({
			repoPath: "/tmp/never-opened-in-cursor",
		});
		expect(events).toEqual([]);
	});

	test("returns empty when SQLite is unavailable", async () => {
		const collector = new CursorCollector({
			userDir,
			openSqlite: async () => null,
		});
		const events = await collector.collect({ repoPath: FIXTURE_REPO_PATH });
		expect(events).toEqual([]);
	});

	test("since skips conversations last updated at or before the cutoff", async () => {
		// The conversation's lastUpdatedAt is 2026-06-10T10:05:00Z; a later cutoff
		// drops it entirely (fast-path skip).
		const events = await collectFixtureEvents(
			new Date("2026-06-10T11:00:00.000Z"),
		);
		expect(events).toEqual([]);
	});

	test("output is byte-stable JSON", async () => {
		const first = JSON.stringify(await collectFixtureEvents());
		const second = JSON.stringify(await collectFixtureEvents());
		expect(first).toBe(second);
	});

	// The privacy guard for the whole collector: none of the raw strings planted
	// in the fixture bubbles may survive into the event stream (CLAUDE.md
	// invariant #1 — raw prompt/command/output text never leaves the parser).
	test("serialized output never contains bubble text", async () => {
		const serialized = JSON.stringify(await collectFixtureEvents());
		for (const raw of CURSOR_PLANTED_STRINGS) {
			expect(serialized).not.toContain(raw);
		}
	});
});

describe("readWorkspaceFolder — only single-folder project dirs become repos", () => {
	let dir: string;

	beforeAll(() => {
		dir = mkdtempSync(`${tmpdir()}/cosq-cursor-ws-`);
	});

	afterAll(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	function writeWorkspaceJson(name: string, contents: unknown): string {
		const path = join(dir, `${name}.json`);
		writeFileSync(path, JSON.stringify(contents), "utf8");
		return path;
	}

	test("resolves a single-folder window's `folder` to its project path", async () => {
		const project = join(dir, "my-project");
		const path = writeWorkspaceJson("single", {
			folder: pathToFileURL(project).href,
		});
		expect(await readWorkspaceFolder(path)).toBe(project);
	});

	test("skips a multi-root window (`workspace` .code-workspace file) — no junk repo", async () => {
		const cfg = join(dir, "team.code-workspace");
		const path = writeWorkspaceJson("multi", {
			workspace: pathToFileURL(cfg).href,
		});
		expect(await readWorkspaceFolder(path)).toBeNull();
	});

	test("skips Cursor's internal generated `workspace.json` config file", async () => {
		const internal = join(dir, "Workspaces", "1770152463377", "workspace.json");
		const path = writeWorkspaceJson("internal", {
			workspace: pathToFileURL(internal).href,
		});
		expect(await readWorkspaceFolder(path)).toBeNull();
	});

	test("defensively rejects a `folder` that resolves to a config file", async () => {
		const cfg = join(dir, "stray", "workspace.json");
		const path = writeWorkspaceJson("stray", {
			folder: pathToFileURL(cfg).href,
		});
		expect(await readWorkspaceFolder(path)).toBeNull();
	});
});
