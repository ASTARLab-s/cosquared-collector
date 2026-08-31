import type { SessionEvent } from "@cosquared/schema";
import { hashPrompt } from "../heuristics/conversation-dedupe";
import {
	countWords,
	describesOrderedSteps,
	detectTestRun,
	isExplanationRequest,
	isQuestion,
	referencesPlanArtifact,
} from "../heuristics/text-features";
import {
	categorizeCodexToolCall,
	extractShellCommand,
	functionCallOutputIsError,
	isCodexPlanTool,
} from "./heuristics";
import {
	CustomToolCallOutputPayloadSchema,
	CustomToolCallPayloadSchema,
	EventMsgPayloadSchema,
	FunctionCallOutputPayloadSchema,
	FunctionCallPayloadSchema,
	ResponseMessagePayloadSchema,
	type RolloutLine,
	SessionMetaPayloadSchema,
} from "./rollout-line";

/**
 * Pure mapping from a parsed Codex rollout to the normalized `SessionEvent[]`
 * stream — no filesystem, no network, fully unit-testable. Structurally mirrors
 * the Claude Code mapper: two passes (pass 1 indexes outputs and activity, pass
 * 2 emits events using the index for the `followedByValidation`/`resolved`
 * lookahead fields). Codex has no subagent/sidechain concept, so that handling
 * is dropped.
 *
 * Tool arguments and outputs (raw shell commands, patch bodies, exec stdout)
 * are read TRANSIENTLY here, reduced to structural features, and dropped — no
 * emitted event carries any of them (CLAUDE.md invariant #1).
 */

const SOURCE = "codex-cli" as const;

/** Which message stream supplies user prompts for this session. */
type PromptSource = "event_msg" | "response_item";

interface PairedResult {
	isError: boolean;
	timestamp: string;
	lineIndex: number;
}

interface CodexIndex {
	resultByCallId: Map<string, PairedResult>;
	toolCallLineIndexes: number[];
	executeLineIndexes: number[];
	userTurnLineIndexes: number[];
	nonErrorResultLineIndexes: number[];
}

/** A normalized tool-call line (function_call or custom_tool_call). */
interface CodexToolCall {
	name: string;
	callId: string | undefined;
	/** The shell command for execute tools, for test-run detection; else null. */
	command: string | null;
}

/** A normalized tool-output line (function_call_output or its custom variant). */
interface CodexToolOutput {
	callId: string | undefined;
	output: unknown;
}

function asToolCall(line: RolloutLine): CodexToolCall | null {
	if (line.type !== "response_item") {
		return null;
	}
	const fn = FunctionCallPayloadSchema.safeParse(line.payload);
	if (fn.success) {
		return {
			name: fn.data.name,
			callId: fn.data.call_id,
			command: fn.data.arguments
				? extractShellCommand(fn.data.arguments)
				: null,
		};
	}
	const custom = CustomToolCallPayloadSchema.safeParse(line.payload);
	if (custom.success) {
		return {
			name: custom.data.name,
			callId: custom.data.call_id,
			command: null,
		};
	}
	return null;
}

function asToolOutput(line: RolloutLine): CodexToolOutput | null {
	if (line.type !== "response_item") {
		return null;
	}
	const fn = FunctionCallOutputPayloadSchema.safeParse(line.payload);
	if (fn.success) {
		return { callId: fn.data.call_id, output: fn.data.output };
	}
	const custom = CustomToolCallOutputPayloadSchema.safeParse(line.payload);
	if (custom.success) {
		return { callId: custom.data.call_id, output: custom.data.output };
	}
	return null;
}

/**
 * Prose openers Codex's own harness writes into a `role: "user"` message.
 *
 * Unlike the `<...>` wrappers these carry no structural marker whatsoever —
 * the rollout envelope of an injected approval-review task is byte-identical
 * in shape to a typed prompt (same `response_item` / `message` / `role: user`,
 * same `internal_chat_message_metadata_passthrough`), so the text is the only
 * available discriminator. Matched anchored at the start, case-sensitively,
 * because that is how the harness emits them.
 *
 * KNOWN LIMITATION: these are English-locale literals and will drift when
 * Codex rewords its harness copy. That is the same drift exposure the
 * collector's golden fixtures exist to catch loudly — a missed prefix
 * silently re-inflates prompt-derived signals, which is exactly the bug this
 * list fixes, so treat a golden-test failure here as a signal to re-inventory
 * rather than to re-baseline.
 */
const INJECTED_PROMPT_PREFIXES = [
	// Codex's approval/review mode hands the model another agent's transcript
	// to assess. Two variants: the initial assessment and the continuation.
	"The following is the Codex agent history",
];

/**
 * A non-empty, non-injected prompt is one whose text is present, does not
 * begin with `<` (Codex wraps `<environment_context>`/`<user_instructions>`
 * as user content), and does not open with one of
 * {@link INJECTED_PROMPT_PREFIXES}.
 *
 * Why the prose list exists (calibration 2026-08-27): an on-disk inventory of
 * 338 rollouts found 648 of 3941 counted prompts (16.4%) were approval-review
 * scaffolding the `<` rule could not see — 50% of the prompts on one repo and
 * 40% on another. Because that text is machine-authored prose full of
 * questions and explanatory phrasing, every prompt-derived signal read it as
 * the developer: Cognitive Engagement counted its question marks, and the
 * uploaded `prompt_count` counted its turns. Harness text is not user
 * behavior, so it is not evidence of any user behavior.
 */
function cleanPromptText(text: string): string | null {
	const trimmed = text.trim();
	if (trimmed.length === 0 || isInjectedCodexPrompt(trimmed)) {
		return null;
	}
	return text;
}

/**
 * Whether Codex's harness — not the developer — authored this `role: "user"`
 * text. Exported so anything that reads the same rollouts applies the SAME
 * rule: a second implementation would silently disagree with the collector
 * about what counts as a human prompt.
 */
export function isInjectedCodexPrompt(text: string): boolean {
	const trimmed = text.trim();
	if (trimmed.startsWith("<")) {
		return true;
	}
	return INJECTED_PROMPT_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
}

/** Clean user-prompt text from an `event_msg user_message` line, or null. */
function eventMsgUserText(line: RolloutLine): string | null {
	if (line.type !== "event_msg") {
		return null;
	}
	const event = EventMsgPayloadSchema.safeParse(line.payload);
	if (
		!event.success ||
		event.data.type !== "user_message" ||
		typeof event.data.message !== "string"
	) {
		return null;
	}
	return cleanPromptText(event.data.message);
}

/** Clean user-prompt text from a `response_item message role:"user"` line. */
function responseUserText(line: RolloutLine): string | null {
	if (line.type !== "response_item") {
		return null;
	}
	const message = ResponseMessagePayloadSchema.safeParse(line.payload);
	if (!message.success || message.data.role !== "user") {
		return null;
	}
	const text = message.data.content
		.map((block) => block.text ?? "")
		.filter(Boolean)
		.join("\n");
	return cleanPromptText(text);
}

/**
 * Picks the prompt source. Codex records each typed prompt BOTH as an
 * `event_msg user_message` (clean) and as a `response_item message` (sometimes
 * wrapped in injected context). Preferring `event_msg` when ANY exists avoids
 * double-counting; sessions from older Codex versions with no `event_msg`
 * fall back to the filtered `response_item` user messages.
 */
function determinePromptSource(lines: RolloutLine[]): PromptSource {
	return lines.some((line) => eventMsgUserText(line) !== null)
		? "event_msg"
		: "response_item";
}

function userPromptText(
	line: RolloutLine,
	source: PromptSource,
): string | null {
	return source === "event_msg"
		? eventMsgUserText(line)
		: responseUserText(line);
}

function findSessionMeta(lines: RolloutLine[]) {
	for (const line of lines) {
		if (line.type === "session_meta") {
			const meta = SessionMetaPayloadSchema.safeParse(line.payload);
			if (meta.success) {
				return meta.data;
			}
		}
	}
	return null;
}

/** Pass 1: index tool outputs (by call_id) and tool/user activity for the
 * lookahead fields. Mirrors the Claude mapper's `buildSessionIndex`. */
function buildCodexIndex(
	lines: RolloutLine[],
	source: PromptSource,
): CodexIndex {
	const index: CodexIndex = {
		resultByCallId: new Map(),
		toolCallLineIndexes: [],
		executeLineIndexes: [],
		userTurnLineIndexes: [],
		nonErrorResultLineIndexes: [],
	};
	lines.forEach((line, lineIndex) => {
		if (userPromptText(line, source) !== null) {
			index.userTurnLineIndexes.push(lineIndex);
			return;
		}
		const call = asToolCall(line);
		if (call !== null) {
			index.toolCallLineIndexes.push(lineIndex);
			if (categorizeCodexToolCall(call.name, call.command) === "execute") {
				index.executeLineIndexes.push(lineIndex);
			}
			return;
		}
		const output = asToolOutput(line);
		if (output !== null) {
			const isError = functionCallOutputIsError(output.output);
			if (output.callId !== undefined) {
				index.resultByCallId.set(output.callId, {
					isError,
					timestamp: line.timestamp,
					lineIndex,
				});
			}
			if (!isError) {
				index.nonErrorResultLineIndexes.push(lineIndex);
			}
		}
	});
	return index;
}

function existsAfter(sortedLineIndexes: number[], lineIndex: number): boolean {
	return sortedLineIndexes.some((candidate) => candidate > lineIndex);
}

/**
 * `followedByValidation` for `change_accepted`: was this edit verified before
 * the user's next instruction? Identical rule to the Claude mapper (PRD §7.3) —
 * `true` if an execute-category tool call falls between this edit and the next
 * user turn, `false` if later tool activity exists but no execution, `null` if
 * the edit was the session's final tool activity.
 */
function followedByValidation(
	index: CodexIndex,
	lineIndex: number,
): boolean | null {
	const nextTurnLineIndex =
		index.userTurnLineIndexes.find((candidate) => candidate > lineIndex) ??
		Number.POSITIVE_INFINITY;
	const verifiedBeforeNextTurn = index.executeLineIndexes.some(
		(candidate) => candidate > lineIndex && candidate < nextTurnLineIndex,
	);
	if (verifiedBeforeNextTurn) {
		return true;
	}
	if (existsAfter(index.toolCallLineIndexes, lineIndex)) {
		return false;
	}
	return null;
}

function deriveToolCallEvents(
	line: RolloutLine,
	lineIndex: number,
	sessionId: string,
	index: CodexIndex,
): SessionEvent[] {
	const call = asToolCall(line);
	if (call === null) {
		return [];
	}
	const events: SessionEvent[] = [];
	const category = categorizeCodexToolCall(call.name, call.command);
	events.push({
		sessionId,
		source: SOURCE,
		timestamp: line.timestamp,
		type: "tool_call",
		toolName: call.name,
		category,
	});
	const paired =
		call.callId !== undefined
			? index.resultByCallId.get(call.callId)
			: undefined;
	if (call.command !== null) {
		const testRun = detectTestRun(call.command);
		if (testRun !== null) {
			events.push({
				sessionId,
				source: SOURCE,
				timestamp: line.timestamp,
				type: "test_run",
				framework: testRun.framework,
				// No paired output means the session ended mid-call.
				passed: paired ? !paired.isError : null,
			});
		}
	}
	if (isCodexPlanTool(call.name)) {
		events.push({
			sessionId,
			source: SOURCE,
			timestamp: line.timestamp,
			type: "plan_artifact_created",
			artifactKind: "plan_doc",
		});
	}
	// A file edit (apply_patch) that produced a non-error output WAS applied —
	// the acceptance act. Codex's rollout has no per-edit rejection signal, so
	// only change_accepted is derived; an errored edit is covered by the
	// error_encountered event on its output line.
	if (category === "file_edit" && paired !== undefined && !paired.isError) {
		events.push({
			sessionId,
			source: SOURCE,
			timestamp: paired.timestamp,
			type: "change_accepted",
			followedByValidation: followedByValidation(index, lineIndex),
		});
	}
	return events;
}

/**
 * Maps an ordered Codex rollout (file order) to the normalized event stream.
 *
 * `fallbackSessionId` (the rollout filename's UUID) labels the session when no
 * `session_meta` line carries an id. Empty input maps to an empty stream (no
 * synthetic start/end).
 */
/**
 * The ordered identity of the human side of a conversation: a stable hash
 * per authored prompt, in order.
 *
 * Read TRANSIENTLY like every other text feature in this module — the
 * hashes are used only to decide which rollout FILES to keep and are never
 * attached to an event or serialized (CLAUDE.md invariant #1).
 *
 * Prompt text rather than timestamps, because Codex re-stamps a replayed
 * history with the RESUME time: the same two prompts were found on disk at
 * 20:51:32, 20:53:33 and 20:53:36 across three recordings of one
 * conversation, so a timestamp-based identity matches nothing (0 of 47
 * files), while prompt content matches 34 of 47.
 */
export function conversationFingerprint(lines: RolloutLine[]): string[] {
	const source = determinePromptSource(lines);
	const prompts: string[] = [];
	for (const line of lines) {
		const text = userPromptText(line, source);
		if (text !== null) {
			prompts.push(hashPrompt(text.trim()));
		}
	}
	return prompts;
}

export function mapRolloutToEvents(
	lines: RolloutLine[],
	fallbackSessionId: string,
): SessionEvent[] {
	const firstLine = lines[0];
	if (firstLine === undefined) {
		return [];
	}
	const lastLine = lines[lines.length - 1];
	const meta = findSessionMeta(lines);
	const sessionId = meta?.id ?? meta?.session_id ?? fallbackSessionId;
	const toolVersion = meta?.cli_version ?? null;
	const source = determinePromptSource(lines);
	const index = buildCodexIndex(lines, source);

	const startMs = Date.parse(firstLine.timestamp);
	const endMs = Date.parse(lastLine.timestamp);
	const durationMinutes =
		Number.isNaN(startMs) || Number.isNaN(endMs)
			? null
			: Math.round((endMs - startMs) / 60_000);

	const events: SessionEvent[] = [
		{
			sessionId,
			source: SOURCE,
			timestamp: firstLine.timestamp,
			type: "session_start",
			toolVersion,
		},
	];

	lines.forEach((line, lineIndex) => {
		const promptText = userPromptText(line, source);
		if (promptText !== null) {
			events.push({
				sessionId,
				source: SOURCE,
				timestamp: line.timestamp,
				type: "user_prompt",
				wordCount: countWords(promptText),
				isQuestion: isQuestion(promptText),
				referencesPlanArtifact: referencesPlanArtifact(promptText),
				describesOrderedSteps: describesOrderedSteps(promptText),
			});
			if (isExplanationRequest(promptText)) {
				events.push({
					sessionId,
					source: SOURCE,
					timestamp: line.timestamp,
					type: "explanation_request",
				});
			}
			return;
		}
		const toolEvents = deriveToolCallEvents(line, lineIndex, sessionId, index);
		if (toolEvents.length > 0) {
			events.push(...toolEvents);
			return;
		}
		const output = asToolOutput(line);
		if (output !== null && functionCallOutputIsError(output.output)) {
			events.push({
				sessionId,
				source: SOURCE,
				timestamp: line.timestamp,
				type: "error_encountered",
				resolved: existsAfter(index.nonErrorResultLineIndexes, lineIndex),
			});
		}
	});

	events.push({
		sessionId,
		source: SOURCE,
		timestamp: lastLine.timestamp,
		type: "session_end",
		durationMinutes,
	});
	return events;
}
