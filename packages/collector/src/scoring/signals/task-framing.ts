import type { SessionEvent } from "@cosquared/schema";
import { cappedRefs } from "../evidence";
import { scaleLinear } from "../scale";
import type { SessionView } from "../sessions";
import type { ScoredSignal } from "../types";
import {
	confidenceForDenominator,
	TASK_FRAMING_FULL_AT_RATE,
} from "../weights";

/**
 * Task Framing — does the user structure work before generating code?
 *
 * Applicable sessions (denominator): those with ≥1 human prompt OR ≥1
 * plan-category `command_invoked`. Pure-machinery sessions (only `/model`,
 * `/clear`…) and context-only sessions are excluded — they aren't
 * judgeable framing opportunities.
 *
 * A session is *framed* if any of:
 *  - it is driven by a plan-execution command (a `command_invoked` with
 *    `category === "plan"`, e.g. `/execute <plan>` or `/plan-feature`) —
 *    working from or producing an explicit plan, even when the typed
 *    prompt is a terse "continue";
 *  - a `plan_artifact_created` precedes its first file edit;
 *  - its first prompt references a plan artifact, or lays the work out as
 *    explicit ordered steps (a numbered list, or "first … then").
 *
 * Prompt LENGTH deliberately does not frame. Full credit for ≥40-word
 * first prompts saturated prompt-heavy repos (model 100 vs. a human read
 * of 30); a 2026-08-25 follow-up that gave length half credit re-saturated
 * two of six calibration repos and overshot others. Length is not
 * structure.
 *
 * ORDERING, however, is structure. Recognizing only explicit plan
 * ARTIFACTS proved too narrow: on the 2026-08-28 calibration run it pinned
 * three of seven repos at exactly 0 while a qualitative read of the same
 * sessions saw 40-68, because a prompt like "First, explain how scheduled
 * tasks work. Then interview me…" plans the work without naming a plan
 * file. `describesOrderedSteps` requires two distinct sequencing cues or a
 * numbered list, so an incidental "first" is still not framing.
 *
 * `context` commands (e.g. `/prime`) deliberately do NOT frame here — they
 * are context engineering and feed Tool & Workflow Judgment instead, so
 * the two signals stay distinct (no double-counting). Issuing a plan
 * command counts as framing even on a session that then does little work:
 * the intent to work from a plan IS the framing act, and we keep the rule
 * a clean deterministic boolean rather than adding a fuzzy "did enough
 * happen?" threshold.
 *
 * Signals read: `command_invoked` (category), `plan_artifact_created`,
 * `tool_call` (file_edit), `user_prompt` (referencesPlanArtifact).
 * Grounding: PRD §7.3 Task Framing row — UChicago planning study
 * (experienced devs plan before generating); the 2026 consensus workflow
 * is spec → plan → implement → verify.
 *
 * Pure and deterministic: no clock, no randomness, no I/O.
 */
export function taskFraming(sessions: SessionView[]): ScoredSignal {
	const qualifyingEvents: SessionEvent[] = [];
	let applicableSessions = 0;

	for (const session of sessions) {
		const firstPrompt = session.events.find(
			(event) => event.type === "user_prompt",
		);
		const planCommand = session.events.find(
			(event) => event.type === "command_invoked" && event.category === "plan",
		);
		if (firstPrompt === undefined && planCommand === undefined) {
			continue;
		}
		applicableSessions += 1;

		const firstPlanIndex = session.events.findIndex(
			(event) => event.type === "plan_artifact_created",
		);
		const firstEditIndex = session.events.findIndex(
			(event) => event.type === "tool_call" && event.category === "file_edit",
		);
		const plannedBeforeEditing =
			firstPlanIndex !== -1 &&
			(firstEditIndex === -1 || firstPlanIndex < firstEditIndex);

		if (planCommand !== undefined) {
			qualifyingEvents.push(planCommand);
		} else if (plannedBeforeEditing) {
			qualifyingEvents.push(session.events[firstPlanIndex]);
		} else if (
			firstPrompt !== undefined &&
			firstPrompt.type === "user_prompt" &&
			(firstPrompt.referencesPlanArtifact || firstPrompt.describesOrderedSteps)
		) {
			qualifyingEvents.push(firstPrompt);
		}
	}

	const framedSessions = qualifyingEvents.length;
	return {
		id: "task_framing",
		value:
			applicableSessions === 0
				? null
				: scaleLinear(
						framedSessions / applicableSessions,
						0,
						TASK_FRAMING_FULL_AT_RATE,
					),
		confidence: confidenceForDenominator(applicableSessions),
		evidence: [
			{
				kind: "framed_sessions",
				numerator: framedSessions,
				denominator: applicableSessions,
				refs: cappedRefs(qualifyingEvents),
			},
		],
	};
}
