import { DatabaseSync } from "node:sqlite";

/**
 * TEST-ONLY writable SQLite helper.
 *
 * Production code is strictly read-only (see `sqlite-reader.ts`). Fixtures,
 * however, build a REAL `state.vscdb` so the Cursor golden tests exercise the
 * exact SQLite read path users hit — not a mock. This runs under Node only
 * (vitest); the shipped binary's `bun:sqlite` path is covered separately by
 * the Bun smoke test (plan Task 17).
 */
export interface SqliteWriter {
	/** Execute DDL (CREATE TABLE …). */
	exec(sql: string): void;
	/** Execute a parameterized INSERT/UPDATE. */
	run(sql: string, ...params: unknown[]): void;
	close(): void;
}

/** Open (creating if needed) a writable SQLite file for fixture construction. */
export function openWritable(path: string): SqliteWriter {
	const db = new DatabaseSync(path);
	return {
		exec(sql) {
			db.exec(sql);
		},
		run(sql, ...params) {
			db.prepare(sql).run(...(params as never[]));
		},
		close() {
			db.close();
		},
	};
}
