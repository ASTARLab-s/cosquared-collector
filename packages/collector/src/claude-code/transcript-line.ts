import { z } from "zod";

/**
 * Loose Zod schemas for the raw Claude Code transcript lines we read
 * (`~/.claude/projects/<encoded-repo>/*.jsonl`, one JSON object per line).
 *
 * LOOSE IN, STRICT OUT — the collector's core privacy + compatibility
 * design. These schemas are `looseObject`: unknown fields pass through
 * unread, so new Claude Code versions adding fields never break parsing
 * (PRD §14 Risk #4). The events we EMIT go through `@cosquared/schema`'s
 * strict schemas, so nothing beyond the declared structural features —
 * and never raw text — can leave the collector.
 *
 * Only the fields we actually read are modeled here. Every modeled field
 * is audit surface for the public repo; resist adding ones we don't use.
 */

/**
 * Envelope fields shared by `user` and `assistant` lines. `isSidechain`
 * marks subagent traffic (agent behavior, not user behavior); `isMeta`
 * marks harness-injected lines that the human never typed.
 */
const envelopeFields = {
	sessionId: z.string(),
	timestamp: z.iso.datetime(),
	isSidechain: z.boolean().optional(),
	isMeta: z.boolean().optional(),
	version: z.string().optional(),
};

/**
 * A content block whose `type` we have not yet inspected. Blocks are
 * discriminated manually by `type` and re-parsed with the specific block
 * schema below; blocks of unknown shape are skipped, never an error.
 */
const RawBlockSchema = z.looseObject({
	type: z.string().optional(),
});
export type RawBlock = z.infer<typeof RawBlockSchema>;

/**
 * An assistant `tool_use` block. `input.command` (Bash) and
 * `input.file_path` (Write/Edit) are read TRANSIENTLY for feature
 * extraction (test-run detection, plan-artifact detection) and are never
 * emitted into events.
 */
export const ToolUseBlockSchema = z.looseObject({
	type: z.literal("tool_use"),
	id: z.string(),
	name: z.string(),
	input: z.looseObject({
		command: z.string().optional(),
		file_path: z.string().optional(),
	}),
});
export type ToolUseBlock = z.infer<typeof ToolUseBlockSchema>;

/**
 * A user-line `tool_result` block: the outcome of a prior assistant tool
 * call, matched by `tool_use_id`. `content` text is read transiently only
 * to distinguish a user rejection from a genuine error.
 */
export const ToolResultBlockSchema = z.looseObject({
	type: z.literal("tool_result"),
	tool_use_id: z.string(),
	is_error: z.boolean().optional(),
	content: z
		.union([
			z.string(),
			z.array(z.looseObject({ type: z.string(), text: z.string().optional() })),
		])
		.optional(),
});
export type ToolResultBlock = z.infer<typeof ToolResultBlockSchema>;

/**
 * A `text` block on a user line (typed prompt accompanied by attachments).
 */
export const TextBlockSchema = z.looseObject({
	type: z.literal("text"),
	text: z.string(),
});
export type TextBlock = z.infer<typeof TextBlockSchema>;

/**
 * A `type: "user"` line: either a typed prompt (string content) or an
 * array of blocks (tool results, text-with-attachments).
 */
export const UserLineSchema = z.looseObject({
	...envelopeFields,
	type: z.literal("user"),
	message: z.looseObject({
		content: z.union([z.string(), z.array(RawBlockSchema)]),
	}),
});
export type UserLine = z.infer<typeof UserLineSchema>;

/**
 * A `type: "assistant"` line: an array of blocks (`text`, `thinking`,
 * `tool_use`). Only `tool_use` blocks are read.
 */
export const AssistantLineSchema = z.looseObject({
	...envelopeFields,
	type: z.literal("assistant"),
	message: z.looseObject({
		content: z.array(RawBlockSchema),
	}),
});
export type AssistantLine = z.infer<typeof AssistantLineSchema>;

export type TranscriptLine = UserLine | AssistantLine;

/**
 * Parses one raw JSONL line into a typed transcript line, or null.
 *
 * Only `user` and `assistant` lines are read; every other top-level
 * `type` (`system`, `file-history-snapshot`, `ai-title`, future unknowns…)
 * returns null without further parsing — forward compatible by default.
 *
 * Every failure path returns null, never throws: one malformed line must
 * not kill analysis of a whole session store (PRD §14 Risk #4 graceful
 * degradation).
 */
export function parseTranscriptLine(raw: string): TranscriptLine | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}
	if (typeof parsed !== "object" || parsed === null) {
		return null;
	}
	const lineType = (parsed as { type?: unknown }).type;
	if (lineType === "user") {
		const result = UserLineSchema.safeParse(parsed);
		return result.success ? result.data : null;
	}
	if (lineType === "assistant") {
		const result = AssistantLineSchema.safeParse(parsed);
		return result.success ? result.data : null;
	}
	return null;
}
