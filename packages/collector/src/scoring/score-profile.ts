import { SCHEMA_VERSION, type SessionEvent } from "@cosquared/schema";
import { classifyBuilderType } from "./builder-type";
import { aiCollaboration } from "./scores/ai-collaboration";
import { shippingMomentum } from "./scores/shipping-momentum";
import { testingDiscipline } from "./scores/testing-discipline";
import { segmentSessions } from "./sessions";
import { cognitiveEngagement } from "./signals/cognitive-engagement";
import { taskFraming } from "./signals/task-framing";
import {
	isLeverageSession,
	toolWorkflowJudgment,
} from "./signals/tool-workflow-judgment";
import { verificationCalibration } from "./signals/verification-calibration";
import type { BuilderProfile, SignalId } from "./types";

/**
 * The scoring engine's single entry point: normalized events in, one
 * Builder Profile out.
 *
 * The engine is pure and deterministic: no clock (`Date.now()` is
 * FORBIDDEN — "now" is always the stream's max timestamp), no randomness,
 * no I/O — byte-identical output for byte-identical input. The
 * inspect/upload byte-parity guarantee (CLAUDE.md code patterns) depends
 * on this, and it is what lets a user re-run scoring on old data and get
 * the same profile forever.
 *
 * Every number carries structured evidence and an honest confidence label
 * (PRD §7.6); all prose phrasing lives in the CLI, outside this public
 * package (PRD §6 open/closed boundary).
 */
export function scoreProfile(events: SessionEvent[]): BuilderProfile {
	const { sessions, repoEvents, referenceTime } = segmentSessions(events);

	const subSignals = {
		taskFraming: taskFraming(sessions),
		toolWorkflowJudgment: toolWorkflowJudgment(sessions, repoEvents),
		verificationCalibration: verificationCalibration(sessions),
		cognitiveEngagement: cognitiveEngagement(sessions),
	};
	const aiCollaborationScore = aiCollaboration(subSignals);
	const testingDisciplineScore = testingDiscipline(sessions, repoEvents);
	const shippingMomentumScore = shippingMomentum(
		sessions,
		repoEvents,
		referenceTime,
	);

	const builderType = classifyBuilderType({
		...subSignals,
		testingDiscipline: testingDisciplineScore,
		shippingMomentum: shippingMomentumScore,
		leverageSessionRate:
			sessions.length === 0
				? null
				: sessions.filter(isLeverageSession).length / sessions.length,
		acceptedSessionRate:
			sessions.length === 0
				? null
				: sessions.filter((session) =>
						session.events.some((event) => event.type === "change_accepted"),
					).length / sessions.length,
	});

	// The six leaf dimensions ranked for strengths/weaknesses/focus.
	// AI Collaboration is deliberately absent: it aggregates the first
	// four, so ranking it would double-count, and only leaves are
	// actionable as a focus (PRD §7.2 "exactly one primary recommendation").
	const leafSignals: Array<{ id: SignalId; value: number | null }> = [
		{ id: "task_framing", value: subSignals.taskFraming.value },
		{
			id: "tool_workflow_judgment",
			value: subSignals.toolWorkflowJudgment.value,
		},
		{
			id: "verification_calibration",
			value: subSignals.verificationCalibration.value,
		},
		{ id: "cognitive_engagement", value: subSignals.cognitiveEngagement.value },
		{ id: "testing_discipline", value: testingDisciplineScore.value },
		{ id: "shipping_momentum", value: shippingMomentumScore.value },
	];
	const withData = leafSignals.filter(
		(signal): signal is { id: SignalId; value: number } =>
			signal.value !== null,
	);
	// Stable sorts: ties keep the fixed leaf order above (determinism).
	const strengths = withData
		.filter((signal) => signal.value >= 60)
		.sort((a, b) => b.value - a.value)
		.slice(0, 3)
		.map((signal) => signal.id);
	const ascending = withData.slice().sort((a, b) => a.value - b.value);
	const weaknesses = ascending
		.filter((signal) => signal.value < 60)
		.slice(0, 3)
		.map((signal) => signal.id);

	let firstEventAt: string | null = null;
	let firstMillis = Number.POSITIVE_INFINITY;
	for (const event of events) {
		const millis = Date.parse(event.timestamp);
		if (millis < firstMillis) {
			firstMillis = millis;
			firstEventAt = event.timestamp;
		}
	}

	return {
		schemaVersion: SCHEMA_VERSION,
		window: {
			firstEventAt,
			lastEventAt: referenceTime,
			eventCount: events.length,
			sessionCount: sessions.length,
			commitCount: repoEvents.filter((event) => event.type === "commit").length,
		},
		builderType,
		aiCollaboration: aiCollaborationScore,
		testingDiscipline: testingDisciplineScore,
		shippingMomentum: shippingMomentumScore,
		strengths,
		weaknesses,
		recommendedFocus: ascending[0]?.id ?? null,
	};
}
