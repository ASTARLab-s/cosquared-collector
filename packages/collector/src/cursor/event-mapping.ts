import type { SessionEvent } from "@cosquared/schema";
import {
	countWords,
	describesOrderedSteps,
	detectTestRun,
	isExplanationRequest,
	isQuestion,
	referencesPlanArtifact,
} from "../heuristics/text-features";
import type { RawBubble, RawComposer } from "./cursor-store";
import {
	categorizeCursorTool,
	extractCursorCommand,
	isCursorPlanTool,
	toolErrored,
	toolWasRejected,
} from "./heuristics";

/**
 * Pure mapping from one Cursor conversation (a composer + its ordered bubbles)
 * to the normalized `SessionEvent[]` stream — no filesystem, no SQLite, fully
 * unit-testable.
 *
 * Bubble text, tool params, and tool results are read TRANSIENTLY here, reduced
 * to structural features, and dropped (CLAUDE.md invariant #1).
 *
 * TIMESTAMPS: Cursor records no reliable per-bubble wall-clock time — bubbles
 * usually carry no `timingInfo`, and where present its `clientStartTime` is a
 * performance counter, not an epoch. So every in-session event is stamped with
 * the composer's `createdAt` and `session_end` with `lastUpdatedAt`. With one
 * timestamp per session, `segmentSessions`' stable sort preserves the bubble
 * (header) order deterministically — no wall-clock dependence, byte-stable.
 */

const SOURCE = "cursor" as const;

const USER_BUBBLE = 1;
const ASSISTANT_BUBBLE = 2;

interface CursorIndex {
	/** Header indexes of user-prompt bubbles (bound `followedByValidation`). */
	userBubbleIndexes: number[];
	/** Header indexes of any tool-call bubble. */
	toolBubbleIndexes: number[];
	/** Header indexes of execute-category tool bubbles. */
	executeBubbleIndexes: number[];
	/** Header indexes of non-errored tool bubbles (for `resolved` lookahead). */
	nonErrorToolBubbleIndexes: number[];
}

function isoFromMs(ms: number): string {
	return new Date(ms).toISOString();
}

/** The tool name on an assistant bubble, or null if it isn't a tool call. */
function bubbleToolName(bubble: RawBubble): string | null {
	if (bubble.type !== ASSISTANT_BUBBLE) {
		return null;
	}
	const name = bubble.toolFormerData?.name;
	return typeof name === "string" && name.length > 0 ? name : null;
}

/** Clean user-prompt text from a user bubble, or null (empty, or harness-
 * injected `<…>` context). */
function userBubbleText(bubble: RawBubble): string | null {
	if (bubble.type !== USER_BUBBLE || typeof bubble.text !== "string") {
		return null;
	}
	const trimmed = bubble.text.trim();
	if (trimmed.length === 0 || trimmed.startsWith("<")) {
		return null;
	}
	return bubble.text;
}

function buildCursorIndex(bubbles: RawBubble[]): CursorIndex {
	const index: CursorIndex = {
		userBubbleIndexes: [],
		toolBubbleIndexes: [],
		executeBubbleIndexes: [],
		nonErrorToolBubbleIndexes: [],
	};
	bubbles.forEach((bubble, bubbleIndex) => {
		if (userBubbleText(bubble) !== null) {
			index.userBubbleIndexes.push(bubbleIndex);
			return;
		}
		const name = bubbleToolName(bubble);
		if (name === null || bubble.toolFormerData === undefined) {
			return;
		}
		index.toolBubbleIndexes.push(bubbleIndex);
		if (categorizeCursorTool(name) === "execute") {
			index.executeBubbleIndexes.push(bubbleIndex);
		}
		if (!toolErrored(bubble.toolFormerData)) {
			index.nonErrorToolBubbleIndexes.push(bubbleIndex);
		}
	});
	return index;
}

function existsAfter(sortedIndexes: number[], bubbleIndex: number): boolean {
	return sortedIndexes.some((candidate) => candidate > bubbleIndex);
}

/**
 * `followedByValidation` for a change: was it verified before the user's next
 * instruction? Identical rule to the Claude/Codex mappers (PRD §7.3) — `true`
 * if an execute-category tool call falls between this change and the next user
 * bubble, `false` if later tool activity exists but no execution, `null` if the
 * change was the conversation's final tool activity.
 */
function followedByValidation(
	index: CursorIndex,
	bubbleIndex: number,
): boolean | null {
	const nextUserBubble =
		index.userBubbleIndexes.find((candidate) => candidate > bubbleIndex) ??
		Number.POSITIVE_INFINITY;
	const verifiedBeforeNextTurn = index.executeBubbleIndexes.some(
		(candidate) => candidate > bubbleIndex && candidate < nextUserBubble,
	);
	if (verifiedBeforeNextTurn) {
		return true;
	}
	if (existsAfter(index.toolBubbleIndexes, bubbleIndex)) {
		return false;
	}
	return null;
}

function deriveToolBubbleEvents(
	bubble: RawBubble,
	bubbleIndex: number,
	sessionId: string,
	timestamp: string,
	index: CursorIndex,
): SessionEvent[] {
	const name = bubbleToolName(bubble);
	const toolFormerData = bubble.toolFormerData;
	if (name === null || toolFormerData === undefined) {
		return [];
	}
	const events: SessionEvent[] = [];
	const category = categorizeCursorTool(name);
	events.push({
		sessionId,
		source: SOURCE,
		timestamp,
		type: "tool_call",
		toolName: name,
		category,
	});
	if (category === "execute") {
		const command = extractCursorCommand(toolFormerData);
		const testRun = command !== null ? detectTestRun(command) : null;
		if (testRun !== null) {
			events.push({
				sessionId,
				source: SOURCE,
				timestamp,
				type: "test_run",
				framework: testRun.framework,
				passed: toolErrored(toolFormerData)
					? false
					: toolFormerData.status === "completed"
						? true
						: null,
			});
		}
	}
	if (isCursorPlanTool(name)) {
		events.push({
			sessionId,
			source: SOURCE,
			timestamp,
			type: "plan_artifact_created",
			artifactKind: "plan_doc",
		});
	}
	if (category === "file_edit") {
		if (toolWasRejected(toolFormerData)) {
			events.push({
				sessionId,
				source: SOURCE,
				timestamp,
				type: "change_rejected",
				followedByValidation: followedByValidation(index, bubbleIndex),
			});
		} else if (!toolErrored(toolFormerData)) {
			events.push({
				sessionId,
				source: SOURCE,
				timestamp,
				type: "change_accepted",
				followedByValidation: followedByValidation(index, bubbleIndex),
			});
		}
	}
	if (toolErrored(toolFormerData)) {
		events.push({
			sessionId,
			source: SOURCE,
			timestamp,
			type: "error_encountered",
			resolved: existsAfter(index.nonErrorToolBubbleIndexes, bubbleIndex),
		});
	}
	return events;
}

/**
 * Maps one Cursor conversation to the normalized event stream. `bubbles` must
 * be in header order (the composer's `fullConversationHeadersOnly` order).
 * Returns an empty stream if the composer has no usable `createdAt` timestamp.
 */
export function mapCursorConversationToEvents(
	sessionId: string,
	composer: RawComposer,
	bubbles: RawBubble[],
): SessionEvent[] {
	const createdAt = composer.createdAt;
	if (typeof createdAt !== "number" || Number.isNaN(createdAt)) {
		return [];
	}
	const lastUpdatedAt =
		typeof composer.lastUpdatedAt === "number"
			? composer.lastUpdatedAt
			: createdAt;
	const timestamp = isoFromMs(createdAt);
	const index = buildCursorIndex(bubbles);

	const events: SessionEvent[] = [
		{
			sessionId,
			source: SOURCE,
			timestamp,
			type: "session_start",
			toolVersion: null,
		},
	];

	bubbles.forEach((bubble, bubbleIndex) => {
		const promptText = userBubbleText(bubble);
		if (promptText !== null) {
			events.push({
				sessionId,
				source: SOURCE,
				timestamp,
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
					timestamp,
					type: "explanation_request",
				});
			}
			return;
		}
		events.push(
			...deriveToolBubbleEvents(
				bubble,
				bubbleIndex,
				sessionId,
				timestamp,
				index,
			),
		);
	});

	events.push({
		sessionId,
		source: SOURCE,
		timestamp: isoFromMs(lastUpdatedAt),
		type: "session_end",
		durationMinutes: Math.round((lastUpdatedAt - createdAt) / 60_000),
	});
	return events;
}
