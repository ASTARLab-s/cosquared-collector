import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { openWritable } from "./__fixtures__/sqlite-write";
import { isBun, openSqlite } from "./sqlite-reader";

/**
 * Round-trips the read-only adapter against a real temp SQLite file, and pins
 * the runtime-selection logic — the Bun branch is the PRODUCTION path (the
 * shipped binary runs under Bun, which lacks `node:sqlite`).
 */

let dir: string;
let dbPath: string;

beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), "cosq-sqlite-"));
	dbPath = join(dir, "state.vscdb");
	const writer = openWritable(dbPath);
	writer.exec("CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value BLOB)");
	writer.run("INSERT INTO ItemTable (key, value) VALUES (?, ?)", "a", "alpha");
	writer.run("INSERT INTO ItemTable (key, value) VALUES (?, ?)", "b", "beta");
	writer.close();
});

afterAll(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("openSqlite", () => {
	test("reads rows back from a real SQLite file", async () => {
		const reader = await openSqlite(dbPath);
		expect(reader).not.toBeNull();
		const rows = reader?.all<{ key: string; value: string }>(
			"SELECT key, value FROM ItemTable ORDER BY key",
		);
		reader?.close();
		expect(rows).toEqual([
			{ key: "a", value: "alpha" },
			{ key: "b", value: "beta" },
		]);
	});

	test("supports parameterized queries", async () => {
		const reader = await openSqlite(dbPath);
		const rows = reader?.all<{ value: string }>(
			"SELECT value FROM ItemTable WHERE key = ?",
			"b",
		);
		reader?.close();
		expect(rows).toEqual([{ value: "beta" }]);
	});

	test("returns null for a path that cannot be opened", async () => {
		const reader = await openSqlite(join(dir, "does-not-exist.vscdb"));
		expect(reader).toBeNull();
	});
});

describe("isBun (runtime selection)", () => {
	test("is false under Node (so the node:sqlite branch is taken)", () => {
		expect(isBun()).toBe(false);
	});

	test("is true when process.versions.bun is present", () => {
		const versions = process.versions as { bun?: string };
		const original = versions.bun;
		try {
			versions.bun = "1.3.14";
			expect(isBun()).toBe(true);
		} finally {
			if (original === undefined) {
				delete versions.bun;
			} else {
				versions.bun = original;
			}
		}
	});
});
