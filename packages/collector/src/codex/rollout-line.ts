import { z } from "zod";

/**
 * Loose Zod schemas for the raw Codex CLI rollout lines we read
 * (`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`, one JSON object per line).
 *
 * LOOSE IN, STRICT OUT — the same privacy + compatibility design as the Claude
 * Code collector. These schemas are `looseObject`: unknown fields pass through
 * unread, so newer Codex versions adding fields never break parsing (Codex's
 * `session_meta` shape and tool names have already drifted across versions —
 * PRD §14 Risk #4). The events we EMIT go through `@cosquared/schema`'s strict
 * schemas, so nothing beyond the declared structural features — and never raw
 * prompt/command/diff text — can leave the collector.
 *
 * Verified against real on-disk rollouts (cli_version 0.108 → 0.142): every
 * line is `{ timestamp, type, payload }`; `type` is one of `session_meta`,
 * `response_item`, `event_msg`, `turn_context`; a `response_item` is further
 * discriminated by `payload.type` (`message`, `function_call`,
 * `function_call_output`, `custom_tool_call`, `custom_tool_call_output`,
 * `reasoning`, …). Only the fields we read are modeled.
 */

/**
 * The line envelope. `timestamp` is an ISO-8601 instant on every line;
 * `payload.type` discriminates `response_item`/`event_msg` variants.
 */
export const RolloutLineSchema = z.looseObject({
	timestamp: z.iso.datetime(),
	type: z.string(),
	payload: z.looseObject({ type: z.string().optional() }),
});
export type RolloutLine = z.infer<typeof RolloutLineSchema>;

/**
 * `session_meta.payload`: session identity + the working directory the session
 * ran in. `id` is present in every version; `session_id` was added later — read
 * both. `cwd` is how the collector filters a global sessions store down to one
 * repo. All optional so an older/newer meta shape still parses.
 */
export const SessionMetaPayloadSchema = z.looseObject({
	id: z.string().optional(),
	session_id: z.string().optional(),
	cwd: z.string().optional(),
	cli_version: z.string().optional(),
	timestamp: z.string().optional(),
});
export type SessionMetaPayload = z.infer<typeof SessionMetaPayloadSchema>;

/**
 * A `response_item` `message`: a user or assistant turn. `content` is an array
 * of blocks (`input_text`, `output_text`, `input_image`); only `text` is read,
 * transiently. Codex emits the user's typed prompt BOTH here and as an
 * `event_msg user_message`; the mapper de-duplicates (see event-mapping).
 */
export const ResponseMessagePayloadSchema = z.looseObject({
	type: z.literal("message"),
	role: z.string(),
	content: z.array(
		z.looseObject({ type: z.string().optional(), text: z.string().optional() }),
	),
});
export type ResponseMessagePayload = z.infer<
	typeof ResponseMessagePayloadSchema
>;

/**
 * A `response_item` `function_call`: a tool invocation. `arguments` is a JSON
 * STRING carrying raw shell commands / paths — read transiently for feature
 * extraction only, never emitted. `call_id` pairs it with its output.
 */
export const FunctionCallPayloadSchema = z.looseObject({
	type: z.literal("function_call"),
	name: z.string(),
	arguments: z.string().optional(),
	call_id: z.string().optional(),
});
export type FunctionCallPayload = z.infer<typeof FunctionCallPayloadSchema>;

/**
 * A `response_item` `function_call_output`. `output` is a JSON string OR object
 * across versions (e.g. exec output text "Process exited with code N", or a
 * structured `{ output, metadata: { exit_code } }`) — read transiently to
 * decide pass/fail. Paired to its call by `call_id`.
 */
export const FunctionCallOutputPayloadSchema = z.looseObject({
	type: z.literal("function_call_output"),
	call_id: z.string().optional(),
	output: z.unknown(),
});
export type FunctionCallOutputPayload = z.infer<
	typeof FunctionCallOutputPayloadSchema
>;

/**
 * A `response_item` `custom_tool_call`: how Codex emits `apply_patch` (and
 * other freeform tools). `input` carries the raw patch text — transient only.
 * Pairs with a `custom_tool_call_output` by `call_id`.
 */
export const CustomToolCallPayloadSchema = z.looseObject({
	type: z.literal("custom_tool_call"),
	name: z.string(),
	input: z.string().optional(),
	call_id: z.string().optional(),
	status: z.string().optional(),
});
export type CustomToolCallPayload = z.infer<typeof CustomToolCallPayloadSchema>;

/** A `response_item` `custom_tool_call_output` (e.g. the apply_patch result). */
export const CustomToolCallOutputPayloadSchema = z.looseObject({
	type: z.literal("custom_tool_call_output"),
	call_id: z.string().optional(),
	output: z.unknown(),
});
export type CustomToolCallOutputPayload = z.infer<
	typeof CustomToolCallOutputPayloadSchema
>;

/**
 * An `event_msg` whose `payload.type` is `user_message` / `agent_message`.
 * `message` is the turn text — the CLEAN user prompt (no injected
 * `<environment_context>` wrapper, unlike the `response_item message` copy).
 */
export const EventMsgPayloadSchema = z.looseObject({
	type: z.string(),
	message: z.string().optional(),
});
export type EventMsgPayload = z.infer<typeof EventMsgPayloadSchema>;

/**
 * Parses one raw JSONL line into a typed rollout line, or null.
 *
 * Only the envelope (`timestamp`/`type`/`payload`) is validated here; callers
 * re-parse `payload` with the specific schema for its `type`/`payload.type`,
 * skipping unknown shapes. Every failure path returns null, never throws — one
 * malformed line must not kill analysis of the session (PRD §14 Risk #4).
 */
export function parseRolloutLine(raw: string): RolloutLine | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}
	if (typeof parsed !== "object" || parsed === null) {
		return null;
	}
	const result = RolloutLineSchema.safeParse(parsed);
	return result.success ? result.data : null;
}
