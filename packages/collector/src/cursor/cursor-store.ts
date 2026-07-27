import { z } from "zod";
import type { SqliteReader } from "./sqlite-reader";

/**
 * Pure readers over Cursor's SQLite chat store, turning rows into typed loose
 * records. LOOSE IN, STRICT OUT — same design as the Claude/Codex collectors:
 * model only the fields we read; unknown fields pass through; any parse failure
 * yields null/[] so a corrupt row costs that row, not the session.
 *
 * Verified against a real `state.vscdb`: chat history lives in the
 * `cursorDiskKV` table of `globalStorage/state.vscdb` under keys
 * `composerData:<id>` (a conversation's metadata + ordered bubble headers) and
 * `bubbleId:<composerId>:<bubbleId>` (one message/tool-call). Each workspace's
 * `state.vscdb` lists its conversation ids in the `ItemTable` row
 * `composer.composerData`.
 *
 * PRIVACY: bubble `text`/`params`/`result` carry raw prompt and command/output
 * text. These records are read TRANSIENTLY by the event mapper, reduced to
 * structural features, and dropped — nothing here is emitted.
 */

/** One header in a composer's ordered conversation: `type` 1 = user, 2 =
 * assistant. */
const RawHeaderSchema = z.looseObject({
	bubbleId: z.string(),
	type: z.number(),
});
export type RawHeader = z.infer<typeof RawHeaderSchema>;

/** A conversation's metadata + the ordered list of its bubble headers. */
export const RawComposerSchema = z.looseObject({
	composerId: z.string().optional(),
	name: z.string().nullish(),
	createdAt: z.number().optional(),
	lastUpdatedAt: z.number().optional(),
	isAgentic: z.boolean().optional(),
	fullConversationHeadersOnly: z.array(RawHeaderSchema).optional(),
});
export type RawComposer = z.infer<typeof RawComposerSchema>;

/** A Cursor tool invocation recorded on an assistant bubble. `params`/`result`
 * are JSON strings (or objects across versions) carrying raw command/output
 * text — read transiently only. */
export const RawToolFormerDataSchema = z.looseObject({
	name: z.string().optional(),
	params: z.unknown().optional(),
	result: z.unknown().optional(),
	status: z.string().optional(),
	userDecision: z.string().optional(),
});
export type RawToolFormerData = z.infer<typeof RawToolFormerDataSchema>;

/** One message bubble: a user prompt (`type` 1) or an assistant turn / tool
 * call (`type` 2). */
export const RawBubbleSchema = z.looseObject({
	type: z.number(),
	text: z.string().optional(),
	toolFormerData: RawToolFormerDataSchema.optional(),
});
export type RawBubble = z.infer<typeof RawBubbleSchema>;

/** The workspace's list of conversation ids. Newer Cursor uses `allComposers`;
 * older/un-migrated workspaces only have `selectedComposerIds`. */
const WorkspaceComposerDataSchema = z.looseObject({
	allComposers: z.array(z.looseObject({ composerId: z.string() })).optional(),
	selectedComposerIds: z.array(z.string()).optional(),
});

/** Decodes a single-`value`-column row into parsed JSON, or undefined. The
 * SQLite adapter already decodes BLOBs to strings; we still coerce defensively
 * so either a string or an already-parsed object works. */
function parseValueRow(rows: Array<{ value?: unknown }>): unknown {
	const value = rows[0]?.value;
	if (typeof value === "string") {
		try {
			return JSON.parse(value);
		} catch {
			return undefined;
		}
	}
	if (value instanceof Uint8Array) {
		try {
			return JSON.parse(new TextDecoder().decode(value));
		} catch {
			return undefined;
		}
	}
	if (typeof value === "object" && value !== null) {
		return value;
	}
	return undefined;
}

/**
 * Reads the conversation ids belonging to one workspace from its
 * `state.vscdb`. Prefers the migrated `allComposers` list, falling back to
 * `selectedComposerIds`. SQL uses parameter binding (no interpolation).
 */
export function readWorkspaceComposerIds(reader: SqliteReader): string[] {
	const rows = reader.all<{ value?: unknown }>(
		"SELECT value FROM ItemTable WHERE key = ?",
		"composer.composerData",
	);
	const parsed = WorkspaceComposerDataSchema.safeParse(parseValueRow(rows));
	if (!parsed.success) {
		return [];
	}
	const ids =
		parsed.data.allComposers?.map((composer) => composer.composerId) ??
		parsed.data.selectedComposerIds ??
		[];
	return [...new Set(ids)];
}

/** Reads one conversation's metadata + ordered bubble headers from the global
 * store, or null if absent/corrupt. */
export function readComposerMeta(
	reader: SqliteReader,
	composerId: string,
): RawComposer | null {
	const rows = reader.all<{ value?: unknown }>(
		"SELECT value FROM cursorDiskKV WHERE key = ?",
		`composerData:${composerId}`,
	);
	const parsed = RawComposerSchema.safeParse(parseValueRow(rows));
	return parsed.success ? parsed.data : null;
}

/** Reads one bubble (message or tool call) from the global store, or null. */
export function readBubble(
	reader: SqliteReader,
	composerId: string,
	bubbleId: string,
): RawBubble | null {
	const rows = reader.all<{ value?: unknown }>(
		"SELECT value FROM cursorDiskKV WHERE key = ?",
		`bubbleId:${composerId}:${bubbleId}`,
	);
	const parsed = RawBubbleSchema.safeParse(parseValueRow(rows));
	return parsed.success ? parsed.data : null;
}
