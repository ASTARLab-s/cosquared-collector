import type { SessionEvent } from "@cosquared/schema";
import { cappedRefs, evidenceRef } from "../evidence";
import { scaleLinear, weightedMean } from "../scale";
import type { SessionView } from "../sessions";
import type { ScoredSignal } from "../types";
import {
	AUTOMATION_FILE_POINTS,
	CONTEXT_FILE_POINTS,
	DOC_FILE_POINTS,
	LOW_CONFIDENCE_MIN_SESSIONS,
	TWJ_BALANCED_FULL_AT_RATE,
	TWJ_BALANCED_WEIGHT,
	TWJ_CONTEXT_WEIGHT,
	TWJ_LEVERAGE_FULL_AT_RATE,
	TWJ_LEVERAGE_WEIGHT,
} from "../weights";

/**
 * Whether a session shows workflow leverage: at least one delegation to a
 * skill/subagent (`delegate`-category tool call) or one skill/command
 * invocation. The agent-vs-manual task fit signal (PRD §7.3) — published
 * here so the Builder Type classifier reuses the exact same rule.
 */
export function isLeverageSession(session: SessionView): boolean {
	return session.events.some(
		(event) =>
			event.type === "command_invoked" ||
			(event.type === "tool_call" && event.category === "delegate"),
	);
}

function hasToolCategory(
	session: SessionView,
	categories: ReadonlyArray<string>,
): boolean {
	return session.events.some(
		(event) =>
			event.type === "tool_call" && categories.includes(event.category),
	);
}

function latestRepoSnapshot(repoEvents: SessionEvent[]) {
	// repoEvents arrive timestamp-sorted; the last snapshot is the latest.
	for (let index = repoEvents.length - 1; index >= 0; index -= 1) {
		const event = repoEvents[index];
		if (event.type === "repo_snapshot") {
			return event;
		}
	}
	return null;
}

/**
 * Tool & Workflow Judgment — right tool, right structure, right context.
 *
 * Rule: 0.5 × balanced-session rate (scaled 0 → 0.8) + 0.2 × leverage-
 * session rate (scaled 0 → 0.5) + 0.3 × context-artifact presence points.
 * *Balanced* = a session with ≥1 file edit AND ≥1 execution AND ≥1
 * read/search — the plan→build→verify shape vs. freeform generation
 * (denominator: sessions with ≥1 edit). *Leverage* = skills, commands, or
 * subagent delegation present ({@link isLeverageSession}). Context points
 * (latest repo snapshot): agent-context file present = 50, authored
 * automation present = 30, documentation present = 20.
 * Signals read: `tool_call` categories, `command_invoked`,
 * `repo_snapshot` counts.
 * Grounding: PRD §7.3 TWJ row — DORA 2025 (context/docs quality strongly
 * predicts AI effectiveness); the 2026 five-layer power-user stack.
 *
 * Pure and deterministic: no clock, no randomness, no I/O.
 */
export function toolWorkflowJudgment(
	sessions: SessionView[],
	repoEvents: SessionEvent[],
): ScoredSignal {
	const sessionsWithEdit = sessions.filter((session) =>
		hasToolCategory(session, ["file_edit"]),
	);
	const balancedSessions = sessionsWithEdit.filter(
		(session) =>
			hasToolCategory(session, ["execute"]) &&
			hasToolCategory(session, ["search", "file_read"]),
	);
	const leverageSessions = sessions.filter(isLeverageSession);
	const snapshot = latestRepoSnapshot(repoEvents);

	const balancedRate =
		sessionsWithEdit.length === 0
			? null
			: scaleLinear(
					balancedSessions.length / sessionsWithEdit.length,
					0,
					TWJ_BALANCED_FULL_AT_RATE,
				);
	const leverageRate =
		sessions.length === 0
			? null
			: scaleLinear(
					leverageSessions.length / sessions.length,
					0,
					TWJ_LEVERAGE_FULL_AT_RATE,
				);
	const contextPoints =
		snapshot === null
			? null
			: (snapshot.contextFileCount >= 1 ? CONTEXT_FILE_POINTS : 0) +
				(snapshot.automationFileCount >= 1 ? AUTOMATION_FILE_POINTS : 0) +
				(snapshot.docFileCount >= 1 ? DOC_FILE_POINTS : 0);

	const value = weightedMean([
		{ value: balancedRate, weight: TWJ_BALANCED_WEIGHT },
		{ value: leverageRate, weight: TWJ_LEVERAGE_WEIGHT },
		{ value: contextPoints, weight: TWJ_CONTEXT_WEIGHT },
	]);

	// A leverage-absent stream scores the component 0, never null — the
	// gap is the signal. Null is reserved for "no sessions at all".
	return {
		id: "tool_workflow_judgment",
		value,
		confidence:
			value === null
				? "none"
				: sessions.length < LOW_CONFIDENCE_MIN_SESSIONS
					? "low"
					: "normal",
		evidence: [
			{
				kind: "balanced_sessions",
				numerator: balancedSessions.length,
				denominator: sessionsWithEdit.length,
				refs: cappedRefs(balancedSessions.map((session) => session.events[0])),
			},
			{
				kind: "workflow_leverage_sessions",
				numerator: leverageSessions.length,
				denominator: sessions.length,
				refs: cappedRefs(
					leverageSessions.map(
						(session) =>
							session.events.find(
								(event) =>
									event.type === "command_invoked" ||
									(event.type === "tool_call" && event.category === "delegate"),
							) ?? session.events[0],
					),
				),
			},
			{
				// Presence triple: context file, automation file, doc file.
				kind: "repo_context_artifacts",
				numerator:
					snapshot === null
						? 0
						: Number(snapshot.contextFileCount >= 1) +
							Number(snapshot.automationFileCount >= 1) +
							Number(snapshot.docFileCount >= 1),
				denominator: 3,
				refs: snapshot === null ? [] : [evidenceRef(snapshot)],
			},
		],
	};
}
