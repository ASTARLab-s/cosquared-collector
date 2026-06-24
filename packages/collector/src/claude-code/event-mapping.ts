import type { SessionEvent } from "@cosquared/schema";
import {
	categorizeToolName,
	classifyCommand,
	countWords,
	detectTestRun,
	isCommandInvocation,
	isExplanationRequest,
	isHumanPrompt,
	isPlanArtifactWrite,
	isQuestion,
	isRejectionResult,
	promptText,
	referencesPlanArtifact,
	toolResultText,
} from "./heuristics";
import {
	type AssistantLine,
	type ToolUseBlock,
	ToolUseBlockSchema,
	type TranscriptLine,
	type UserLine,
} from "./transcript-line";

/**
 * Pure mapping from an ordered, parsed transcript to the normalized
 * `SessionEvent[]` stream — no filesystem, no network, fully unit-testable.
 *
 * Transcript text (prompts, commands, file paths, result output) is read
 * transiently inside this module, reduced to structural features, and
 * dropped. No emitted event carries any of it (CLAUDE.md invariant #1);
 * the collector re-validates every batch against the strict schema as a
 * runtime proof.
 */

/** The paired outcome of a tool call, indexed by `tool_use_id`. */
interface PairedResult {
	isError: boolean;
	isRejection: boolean;
	timestamp: string;
	lineIndex: number;
}

/**
 * Lookup index built in pass 1, so pass 2 can derive lookahead fields
 * (`followedByValidation`, `resolved`, `passed`) from the whole session.
 */
interface SessionIndex {
	resultByToolUseId: Map<string, PairedResult>;
	/** Line indexes of non-sidechain tool_use blocks (any category). */
	toolUseLineIndexes: number[];
	/** Line indexes of non-sidechain execute-category tool_use blocks. */
	executeLineIndexes: number[];
	/**
	 * Line indexes of the user's own turns — typed prompts and command
	 * invocations (non-sidechain, non-meta, text content, not tool results).
	 * These bound `followedByValidation`: a change is judged against the
	 * verification that happens before the user's NEXT instruction.
	 */
	userTurnLineIndexes: number[];
	/** Line indexes of non-sidechain non-error tool results. */
	nonErrorResultLineIndexes: number[];
}

function extractToolUseBlocks(line: AssistantLine): ToolUseBlock[] {
	const blocks: ToolUseBlock[] = [];
	for (const block of line.message.content) {
		if (block.type === "tool_use") {
			const parsed = ToolUseBlockSchema.safeParse(block);
			if (parsed.success) {
				blocks.push(parsed.data);
			}
		}
	}
	return blocks;
}

/**
 * Pass 1: index tool results and tool activity across the session.
 *
 * Pairing (`resultByToolUseId`) is built over ALL lines including
 * sidechains, so a tool call whose result happens to land on a sidechain
 * line still resolves. The activity indexes used for lookahead fields
 * cover non-sidechain lines only: subagent activity is agent behavior,
 * not the user's verification behavior.
 */
function buildSessionIndex(lines: TranscriptLine[]): SessionIndex {
	const index: SessionIndex = {
		resultByToolUseId: new Map(),
		toolUseLineIndexes: [],
		executeLineIndexes: [],
		userTurnLineIndexes: [],
		nonErrorResultLineIndexes: [],
	};
	lines.forEach((line, lineIndex) => {
		const isSidechain = line.isSidechain === true;
		if (line.type === "user") {
			const content = line.message.content;
			const isMetaOrSidechain = line.isMeta === true || isSidechain;
			if (typeof content === "string") {
				// A string user line is a human turn (typed prompt or command).
				if (!isMetaOrSidechain) {
					index.userTurnLineIndexes.push(lineIndex);
				}
				return;
			}
			// A text block with no tool_result is also a human turn.
			if (
				!isMetaOrSidechain &&
				content.some((block) => block.type === "text") &&
				!content.some((block) => block.type === "tool_result")
			) {
				index.userTurnLineIndexes.push(lineIndex);
			}
			for (const block of content) {
				if (block.type !== "tool_result") {
					continue;
				}
				const text = toolResultText(block);
				const toolUseId = (block as { tool_use_id?: unknown }).tool_use_id;
				if (typeof toolUseId !== "string") {
					continue;
				}
				const isError = (block as { is_error?: unknown }).is_error === true;
				index.resultByToolUseId.set(toolUseId, {
					isError,
					isRejection: isError && isRejectionResult(text),
					timestamp: line.timestamp,
					lineIndex,
				});
				if (!isError && !isSidechain) {
					index.nonErrorResultLineIndexes.push(lineIndex);
				}
			}
			return;
		}
		if (isSidechain) {
			return;
		}
		for (const block of extractToolUseBlocks(line)) {
			index.toolUseLineIndexes.push(lineIndex);
			if (categorizeToolName(block.name) === "execute") {
				index.executeLineIndexes.push(lineIndex);
			}
		}
	});
	return index;
}

function existsAfter(sortedLineIndexes: number[], lineIndex: number): boolean {
	return sortedLineIndexes.some((candidate) => candidate > lineIndex);
}

/**
 * Lookahead for `change_accepted` / `change_rejected`: was this change
 * verified before the user gave their next instruction?
 *
 * `true` if an execute-category tool call (which includes every test run)
 * happens after this change but before the user's *next turn* (their next
 * typed prompt or command). `false` if tool activity follows but no
 * execution lands before that next turn — the user moved on without
 * checking. `null` if the change was the session's final tool activity,
 * too close to the end to judge.
 *
 * The "before the next instruction" bound is deliberate (PRD §7.3
 * Verification & Calibration — the field's documented blind spot). It
 * credits a batch-then-verify workflow (several edits, then run the suite,
 * all under one instruction) while preventing a single late test from
 * retroactively validating changes made under earlier, separate
 * instructions — the session-length inflation we're removing. It is
 * instruction-adjacent, not per-keystroke and not session-coarse.
 */
function followedByValidation(
	index: SessionIndex,
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
	if (existsAfter(index.toolUseLineIndexes, lineIndex)) {
		return false;
	}
	return null;
}

/** `session_start` from the first line; segmentation only (PRD §7.3). */
function deriveSessionStart(firstLine: TranscriptLine): SessionEvent {
	return {
		sessionId: firstLine.sessionId,
		source: "claude-code",
		timestamp: firstLine.timestamp,
		type: "session_start",
		toolVersion: firstLine.version ?? null,
	};
}

/**
 * `session_end` from the last line. `durationMinutes` is whole minutes
 * between the first and last line timestamps (feeds Shipping Momentum's
 * session arcs, PRD §7.3); `null` if either timestamp fails to parse.
 */
function deriveSessionEnd(
	firstLine: TranscriptLine,
	lastLine: TranscriptLine,
): SessionEvent {
	const startMs = Date.parse(firstLine.timestamp);
	const endMs = Date.parse(lastLine.timestamp);
	const durationMinutes =
		Number.isNaN(startMs) || Number.isNaN(endMs)
			? null
			: Math.round((endMs - startMs) / 60_000);
	return {
		sessionId: lastLine.sessionId,
		source: "claude-code",
		timestamp: lastLine.timestamp,
		type: "session_end",
		durationMinutes,
	};
}

/**
 * Events from one user line: `user_prompt` (+ `explanation_request`) for
 * human prompts, payload-free `command_invoked` for skill/slash-command
 * invocations, `error_encountered` for genuine error results.
 *
 * A command expansion is NOT a `user_prompt` — its machine-generated body
 * is not authored prompt text (its word count would poison Task Framing);
 * only the invocation itself is recorded, name never captured.
 *
 * The prompt text is reduced to features here and discarded. `resolved` on
 * errors is a deterministic approximation: `true` iff any later non-error
 * tool result exists in the session — a proxy for a recovery arc, not
 * proof the same error was fixed (scoring weights it accordingly).
 */
function deriveUserLineEvents(
	line: UserLine,
	lineIndex: number,
	index: SessionIndex,
): SessionEvent[] {
	const events: SessionEvent[] = [];
	if (isHumanPrompt(line)) {
		const text = promptText(line);
		events.push({
			sessionId: line.sessionId,
			source: "claude-code",
			timestamp: line.timestamp,
			type: "user_prompt",
			wordCount: countWords(text),
			isQuestion: isQuestion(text),
			referencesPlanArtifact: referencesPlanArtifact(text),
		});
		if (isExplanationRequest(text)) {
			events.push({
				sessionId: line.sessionId,
				source: "claude-code",
				timestamp: line.timestamp,
				type: "explanation_request",
			});
		}
	} else if (isCommandInvocation(line)) {
		events.push({
			sessionId: line.sessionId,
			source: "claude-code",
			timestamp: line.timestamp,
			type: "command_invoked",
			category: classifyCommand(line),
		});
	}
	const content = line.message.content;
	if (typeof content === "string") {
		return events;
	}
	for (const block of content) {
		if (block.type !== "tool_result") {
			continue;
		}
		const isError = (block as { is_error?: unknown }).is_error === true;
		if (!isError || isRejectionResult(toolResultText(block))) {
			continue;
		}
		events.push({
			sessionId: line.sessionId,
			source: "claude-code",
			timestamp: line.timestamp,
			type: "error_encountered",
			resolved: existsAfter(index.nonErrorResultLineIndexes, lineIndex),
		});
	}
	return events;
}

/**
 * Events from one assistant line: a `tool_call` per tool_use block, plus
 * derived `test_run`, `plan_artifact_created`, and `change_accepted` /
 * `change_rejected` events.
 *
 * change_accepted semantics for Claude Code: there is no per-suggestion
 * accept UI — under the permission model, a file edit that was applied
 * (paired result exists, no error, no rejection) IS the acceptance act.
 * Raw accept counts are a demoted signal (PRD §7.3 demotion note);
 * `followedByValidation` is the signal that matters.
 */
function deriveAssistantLineEvents(
	line: AssistantLine,
	lineIndex: number,
	index: SessionIndex,
): SessionEvent[] {
	const events: SessionEvent[] = [];
	for (const block of extractToolUseBlocks(line)) {
		const category = categorizeToolName(block.name);
		events.push({
			sessionId: line.sessionId,
			source: "claude-code",
			timestamp: line.timestamp,
			type: "tool_call",
			toolName: block.name,
			category,
		});
		const paired = index.resultByToolUseId.get(block.id);
		if (block.name === "Bash" && block.input.command !== undefined) {
			const testRun = detectTestRun(block.input.command);
			if (testRun !== null) {
				events.push({
					sessionId: line.sessionId,
					source: "claude-code",
					timestamp: line.timestamp,
					type: "test_run",
					framework: testRun.framework,
					// No paired result means the session ended mid-call.
					passed: paired ? !paired.isError : null,
				});
			}
		}
		if (block.name === "ExitPlanMode") {
			events.push({
				sessionId: line.sessionId,
				source: "claude-code",
				timestamp: line.timestamp,
				type: "plan_artifact_created",
				artifactKind: "plan_doc",
			});
		} else if (block.name === "Write" && block.input.file_path !== undefined) {
			const artifact = isPlanArtifactWrite(block.input.file_path);
			if (artifact !== null) {
				events.push({
					sessionId: line.sessionId,
					source: "claude-code",
					timestamp: line.timestamp,
					type: "plan_artifact_created",
					artifactKind: artifact.artifactKind,
				});
			}
		}
		if (category === "file_edit" && paired !== undefined) {
			if (paired.isRejection) {
				events.push({
					sessionId: line.sessionId,
					source: "claude-code",
					timestamp: paired.timestamp,
					type: "change_rejected",
					followedByValidation: followedByValidation(index, lineIndex),
				});
			} else if (!paired.isError) {
				events.push({
					sessionId: line.sessionId,
					source: "claude-code",
					timestamp: paired.timestamp,
					type: "change_accepted",
					followedByValidation: followedByValidation(index, lineIndex),
				});
			}
			// A failed (is_error, non-rejection) edit applied nothing: no
			// change event; the error_encountered event covers it.
		}
	}
	return events;
}

/**
 * Maps an ordered transcript (file order) to the normalized event stream.
 *
 * Two passes: pass 1 indexes tool results and activity, pass 2 emits
 * events using the index for lookahead fields. Sidechain (subagent) lines
 * emit nothing — their results only serve pairing. Empty input maps to
 * an empty stream (no synthetic start/end). Session start/end bracket the
 * full transcript, sidechain lines included.
 */
export function mapTranscriptToEvents(lines: TranscriptLine[]): SessionEvent[] {
	const firstLine = lines[0];
	if (firstLine === undefined) {
		return [];
	}
	const index = buildSessionIndex(lines);
	const events: SessionEvent[] = [deriveSessionStart(firstLine)];
	lines.forEach((line, lineIndex) => {
		if (line.isSidechain === true) {
			return;
		}
		if (line.type === "user") {
			events.push(...deriveUserLineEvents(line, lineIndex, index));
		} else {
			events.push(...deriveAssistantLineEvents(line, lineIndex, index));
		}
	});
	events.push(deriveSessionEnd(firstLine, lines[lines.length - 1]));
	return events;
}
