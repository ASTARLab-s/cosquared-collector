import type { SessionEvent } from "@cosquared/schema";
import {
	countWords,
	detectTestRun,
	isExplanationRequest,
	isQuestion,
	referencesPlanArtifact,
} from "../heuristics/text-features";
import {
	categorizeCodexTool,
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

/** A non-empty, non-injected prompt is one whose text is present and does not
 * begin with `<` (Codex wraps `<environment_context>`/`<user_instructions>` as
 * user content; those are harness context, not authored prompts). */
function cleanPromptText(text: string): string | null {
	const trimmed = text.trim();
	if (trimmed.length === 0 || trimmed.startsWith("<")) {
		return null;
	}
	return text;
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
			if (categorizeCodexTool(call.name) === "execute") {
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
	const category = categorizeCodexTool(call.name);
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
