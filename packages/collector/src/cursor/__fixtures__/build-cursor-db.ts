import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openWritable } from "./sqlite-write";

/**
 * Builds a REAL Cursor `state.vscdb` fixture store under `userDir` from inline,
 * readable JSON rows — so the golden tests exercise the exact SQLite read path
 * users hit, while the fixture content stays auditable source (not an opaque
 * binary). TEST-ONLY (Node).
 *
 * Layout mirrors a real Cursor profile:
 *   workspaceStorage/<hash>/workspace.json   → { folder: "file://…" }
 *   workspaceStorage/<hash>/state.vscdb      → ItemTable composer.composerData
 *   globalStorage/state.vscdb                → cursorDiskKV composerData:/bubbleId:
 *
 * Raw strings are PLANTED in every text/params/result field; the collector's
 * privacy guard asserts none survive serialization.
 */

export const FIXTURE_REPO_PATH = "/tmp/fixture-repo";
export const COMPOSER_ID = "11111111-1111-4111-8111-111111111111";
export const FOREIGN_COMPOSER_ID = "22222222-2222-4222-8222-222222222222";
export const CREATED_AT = Date.parse("2026-06-10T10:00:00.000Z");
export const LAST_UPDATED_AT = CREATED_AT + 5 * 60_000;

/** Every raw string planted in the fixture — none may survive serialization. */
export const CURSOR_PLANTED_STRINGS = [
	"CURSOR_PLANTED_PROMPT",
	"CURSOR_PLANTED_PYTEST_RESULT",
	"CURSOR_PLANTED_EDIT_PARAMS",
	"CURSOR_PLANTED_BUILD_CMD",
	"CURSOR_PLANTED_BUILD_ERROR",
	"CURSOR_PLANTED_PLAN",
	"CURSOR_FOREIGN_PROMPT",
	"pytest -q", // command text
	"file:///tmp/fixture-repo", // workspace folder URI
];

interface Row {
	key: string;
	value: string;
}

/** The main conversation's bubbles, keyed b0…b7 (header order). */
function mainBubbles(): Record<string, unknown> {
	return {
		b0: {
			type: 1,
			text: "Implement the plan in plans/feature.md and explain why? CURSOR_PLANTED_PROMPT",
		},
		b1: {
			type: 2,
			toolFormerData: {
				name: "run_terminal_cmd",
				params: '{"command":"pytest -q","is_background":false}',
				result: '{"output":"CURSOR_PLANTED_PYTEST_RESULT"}',
				status: "completed",
			},
		},
		b2: {
			type: 2,
			toolFormerData: {
				name: "edit_file_v2",
				params:
					'{"target_file":"src/app.ts","instructions":"CURSOR_PLANTED_EDIT_PARAMS"}',
				status: "completed",
				userDecision: "accepted",
			},
		},
		b3: {
			type: 2,
			toolFormerData: {
				name: "run_terminal_cmd",
				params: '{"command":"pnpm test"}',
				status: "completed",
			},
		},
		b4: {
			type: 2,
			toolFormerData: {
				name: "search_replace",
				userDecision: "rejected",
				result: '{"rejected":true}',
			},
		},
		b5: {
			type: 2,
			toolFormerData: {
				name: "create_plan",
				params: '{"plan":"CURSOR_PLANTED_PLAN"}',
				status: "completed",
			},
		},
		b6: {
			type: 2,
			toolFormerData: {
				name: "run_terminal_cmd",
				params: '{"command":"npm run build CURSOR_PLANTED_BUILD_CMD"}',
				result: '{"error":"CURSOR_PLANTED_BUILD_ERROR"}',
				status: "error",
			},
		},
		b7: {
			type: 2,
			toolFormerData: {
				name: "edit_file_v2",
				status: "completed",
				userDecision: "accepted",
			},
		},
	};
}

function composerMetaRow(
	composerId: string,
	bubbleIds: Array<{ bubbleId: string; type: number }>,
): Row {
	return {
		key: `composerData:${composerId}`,
		value: JSON.stringify({
			composerId,
			createdAt: CREATED_AT,
			lastUpdatedAt: LAST_UPDATED_AT,
			isAgentic: true,
			fullConversationHeadersOnly: bubbleIds,
		}),
	};
}

function writeVscdb(path: string, table: string, rows: Row[]): void {
	const db = openWritable(path);
	db.exec(`CREATE TABLE ${table} (key TEXT PRIMARY KEY, value BLOB)`);
	for (const row of rows) {
		db.run(
			`INSERT INTO ${table} (key, value) VALUES (?, ?)`,
			row.key,
			row.value,
		);
	}
	db.close();
}

/** Builds the full fixture store under `userDir`. */
export function buildCursorFixture(userDir: string): void {
	// Matching workspace → the repo under analysis.
	const workspaceA = join(userDir, "workspaceStorage", "hashA");
	mkdirSync(workspaceA, { recursive: true });
	writeFileSync(
		join(workspaceA, "workspace.json"),
		JSON.stringify({ folder: "file:///tmp/fixture-repo" }),
	);
	writeVscdb(join(workspaceA, "state.vscdb"), "ItemTable", [
		{
			key: "composer.composerData",
			value: JSON.stringify({ allComposers: [{ composerId: COMPOSER_ID }] }),
		},
	]);

	// Foreign workspace → a different repo; its composer must never be read.
	const workspaceB = join(userDir, "workspaceStorage", "hashB");
	mkdirSync(workspaceB, { recursive: true });
	writeFileSync(
		join(workspaceB, "workspace.json"),
		JSON.stringify({ folder: "file:///tmp/other-repo" }),
	);
	writeVscdb(join(workspaceB, "state.vscdb"), "ItemTable", [
		{
			key: "composer.composerData",
			value: JSON.stringify({
				selectedComposerIds: [FOREIGN_COMPOSER_ID],
			}),
		},
	]);

	// Global store: both conversations' metadata + bubbles.
	const bubbles = mainBubbles();
	const headers = Object.keys(bubbles).map((bubbleId) => ({
		bubbleId,
		type: (bubbles[bubbleId] as { type: number }).type,
	}));
	const globalRows: Row[] = [composerMetaRow(COMPOSER_ID, headers)];
	for (const [bubbleId, body] of Object.entries(bubbles)) {
		globalRows.push({
			key: `bubbleId:${COMPOSER_ID}:${bubbleId}`,
			value: JSON.stringify(body),
		});
	}
	globalRows.push(
		composerMetaRow(FOREIGN_COMPOSER_ID, [{ bubbleId: "bf", type: 1 }]),
		{
			key: `bubbleId:${FOREIGN_COMPOSER_ID}:bf`,
			value: JSON.stringify({ type: 1, text: "CURSOR_FOREIGN_PROMPT" }),
		},
	);

	const globalDir = join(userDir, "globalStorage");
	mkdirSync(globalDir, { recursive: true });
	writeVscdb(join(globalDir, "state.vscdb"), "cursorDiskKV", globalRows);
}
