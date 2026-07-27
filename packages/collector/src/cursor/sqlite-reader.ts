/**
 * Runtime-detecting, READ-ONLY SQLite adapter — the single quarantine point
 * for SQLite imports in the Cursor collector.
 *
 * Cursor stores its chat history in a SQLite database (`state.vscdb`). We read
 * it with zero added dependencies by using whichever SQLite module the host
 * runtime ships in its standard library:
 *   - Node / vitest → `node:sqlite` (`DatabaseSync`), unflagged since Node 22.
 *   - The shipped binary runs under Bun → `bun:sqlite` (`Database`).
 * Bun does NOT implement `node:sqlite` (oven-sh/bun#27092), and Node does not
 * implement `bun:sqlite`, so the correct module is chosen at runtime and
 * imported dynamically — a static import of either would break the other host.
 * Keeping both imports here means the rest of the collector is pure and
 * runtime-agnostic (PRD §8: the public package adds no runtime dependency).
 *
 * Every failure (SQLite unavailable, file missing/locked, import error)
 * degrades to `null` — never a throw — mirroring the git collector's
 * "open, read, degrade" discipline (`git-collector.ts`).
 */

/** Minimal read-only SQLite surface the Cursor collector needs. */
export interface SqliteReader {
	/** Run a SELECT and return every row as a plain object. */
	all<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T[];
	/** Release the underlying database handle. */
	close(): void;
}

/**
 * Opens `path` read-only, or resolves to `null` if SQLite is unavailable or
 * the file cannot be opened (graceful degradation — never throws). Async
 * because the runtime-specific module is imported lazily.
 */
export type OpenSqlite = (path: string) => Promise<SqliteReader | null>;

/** The two host SQLite surfaces we adapt, typed minimally and locally so this
 * package depends on neither `@types/node`'s `node:sqlite` typings nor
 * `bun-types` — they are resolved at runtime, not compile time. */
interface NodeDatabaseSync {
	prepare(sql: string): { all(...params: unknown[]): unknown[] };
	close(): void;
}
interface BunDatabase {
	query(sql: string): { all(...params: unknown[]): unknown[] };
	close(): void;
}

/**
 * True when running under Bun (the compiled-binary production path), which
 * selects `bun:sqlite` over `node:sqlite`. Exported for the runtime-selection
 * unit test — Bun does not implement `node:sqlite` (oven-sh/bun#27092), so
 * getting this branch right is what makes the shipped binary read Cursor data.
 */
export function isBun(): boolean {
	return (
		typeof (globalThis as { Bun?: unknown }).Bun !== "undefined" ||
		typeof (process as { versions?: { bun?: string } }).versions?.bun ===
			"string"
	);
}

/**
 * Dynamic import via a string-typed specifier so the bundler/type-checker does
 * not statically resolve `bun:sqlite` under Node (or vice versa). Returns the
 * module namespace as `unknown`; callers narrow to the minimal surface above.
 */
async function importRuntimeModule(specifier: string): Promise<unknown> {
	return import(specifier);
}

/**
 * Some SQLite drivers return BLOB columns as `Uint8Array`/`Buffer`. Cursor's
 * `value` column holds UTF-8 JSON; decode any binary cell to a string and
 * return a plain object so downstream `JSON.parse` works under both runtimes.
 */
function normalizeRow(row: unknown): Record<string, unknown> {
	if (typeof row !== "object" || row === null) {
		return {};
	}
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(row)) {
		out[key] =
			value instanceof Uint8Array ? new TextDecoder().decode(value) : value;
	}
	return out;
}

function nodeReader(db: NodeDatabaseSync): SqliteReader {
	return {
		all<T>(sql: string, ...params: unknown[]): T[] {
			return db
				.prepare(sql)
				.all(...params)
				.map(normalizeRow) as T[];
		},
		close() {
			db.close();
		},
	};
}

function bunReader(db: BunDatabase): SqliteReader {
	return {
		all<T>(sql: string, ...params: unknown[]): T[] {
			return db
				.query(sql)
				.all(...params)
				.map(normalizeRow) as T[];
		},
		close() {
			db.close();
		},
	};
}

/**
 * Default {@link OpenSqlite}: picks `bun:sqlite` under Bun and `node:sqlite`
 * under Node, opens `path` read-only, and adapts it to {@link SqliteReader}.
 * Any unavailability or open failure resolves to `null`.
 */
export const openSqlite: OpenSqlite = async (path) => {
	try {
		let reader: SqliteReader;
		if (isBun()) {
			// bun:sqlite spells the open flag `readonly` (lowercase).
			const mod = (await importRuntimeModule("bun:sqlite")) as {
				Database: new (
					path: string,
					options: { readonly: boolean },
				) => BunDatabase;
			};
			reader = bunReader(new mod.Database(path, { readonly: true }));
		} else {
			// node:sqlite spells it `readOnly` (capital O) — a lowercase key is
			// silently ignored and the DB opens read-write, creating a missing
			// file. Getting this exact key right is what makes "missing store →
			// degrade" hold instead of fabricating an empty database.
			const mod = (await importRuntimeModule("node:sqlite")) as {
				DatabaseSync: new (
					path: string,
					options: { readOnly: boolean },
				) => NodeDatabaseSync;
			};
			reader = nodeReader(new mod.DatabaseSync(path, { readOnly: true }));
		}
		// node:sqlite opens the file lazily, so a missing/corrupt DB would not
		// surface at construction. Probe the schema table now to force the open;
		// a failure here degrades to null (graceful — never throws).
		reader.all("SELECT 1 FROM sqlite_master LIMIT 1");
		return reader;
	} catch {
		// SQLite unavailable (old Node, missing module) or the file can't be
		// opened — the Cursor collector treats this as "no Cursor data here".
		return null;
	}
};
