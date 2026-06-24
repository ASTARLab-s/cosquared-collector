import { describe, expect, test } from "vitest";
import {
	commandInvoked,
	prompt,
	repoSnapshot,
	toolCall,
} from "../__fixtures__/builders";
import { segmentSessions } from "../sessions";
import { toolWorkflowJudgment } from "./tool-workflow-judgment";

const T0 = "2026-06-10T10:00:00.000Z";
const T1 = "2026-06-10T10:01:00.000Z";
const T2 = "2026-06-10T10:02:00.000Z";

function balancedSessionEvents(sessionId: string) {
	return [
		toolCall(sessionId, T0, "file_edit"),
		toolCall(sessionId, T1, "execute"),
		toolCall(sessionId, T2, "search"),
	];
}

describe("signals: toolWorkflowJudgment", () => {
	test("balancedSessionHasEditExecuteAndReadOrSearch", () => {
		const { sessions, repoEvents } = segmentSessions(
			balancedSessionEvents("s1"),
		);
		const signal = toolWorkflowJudgment(sessions, repoEvents);
		expect(signal.evidence[0]).toMatchObject({
			kind: "balanced_sessions",
			numerator: 1,
			denominator: 1,
		});
	});

	test("editOnlySessionIsNotBalanced", () => {
		const { sessions, repoEvents } = segmentSessions([
			toolCall("s1", T0, "file_edit"),
			toolCall("s1", T1, "file_edit"),
		]);
		const signal = toolWorkflowJudgment(sessions, repoEvents);
		expect(signal.evidence[0]).toMatchObject({ numerator: 0, denominator: 1 });
	});

	test("fileReadSatisfiesTheReadOrSearchLeg", () => {
		const { sessions, repoEvents } = segmentSessions([
			toolCall("s1", T0, "file_edit"),
			toolCall("s1", T1, "execute"),
			toolCall("s1", T2, "file_read"),
		]);
		expect(
			toolWorkflowJudgment(sessions, repoEvents).evidence[0].numerator,
		).toBe(1);
	});

	test("delegateToolCallCountsAsLeverage", () => {
		const { sessions, repoEvents } = segmentSessions([
			prompt("s1", T0),
			toolCall("s1", T1, "delegate", "Skill"),
		]);
		const signal = toolWorkflowJudgment(sessions, repoEvents);
		expect(signal.evidence[1]).toMatchObject({
			kind: "workflow_leverage_sessions",
			numerator: 1,
			denominator: 1,
		});
		// The citation is the delegation act itself.
		expect(signal.evidence[1].refs).toEqual([
			{ sessionId: "s1", source: "claude-code", timestamp: T1 },
		]);
	});

	test("commandInvokedCountsAsLeverage", () => {
		const { sessions, repoEvents } = segmentSessions([
			commandInvoked("s1", T0),
			prompt("s2", T0),
		]);
		const signal = toolWorkflowJudgment(sessions, repoEvents);
		expect(signal.evidence[1]).toMatchObject({ numerator: 1, denominator: 2 });
	});

	test("leverageAbsentScoresZeroComponentNotNull", () => {
		// No skills/commands/subagents in any session: the leverage gap IS
		// the signal — it must drag the value down, not vanish from it.
		const withLeverage = segmentSessions([
			...balancedSessionEvents("s1"),
			commandInvoked("s1", T0),
		]);
		const withoutLeverage = segmentSessions(balancedSessionEvents("s1"));
		const leveraged = toolWorkflowJudgment(
			withLeverage.sessions,
			withLeverage.repoEvents,
		);
		const unleveraged = toolWorkflowJudgment(
			withoutLeverage.sessions,
			withoutLeverage.repoEvents,
		);
		expect(unleveraged.value).not.toBeNull();
		expect(unleveraged.value as number).toBeLessThan(leveraged.value as number);
	});

	test("contextArtifactPresenceScoresThePublishedPoints", () => {
		// Sessionless stream with all three artifact classes present:
		// 50 + 30 + 20 points, carried by the context component alone.
		const { sessions, repoEvents } = segmentSessions([
			repoSnapshot(T0, {
				contextFileCount: 1,
				automationFileCount: 2,
				docFileCount: 3,
			}),
		]);
		const signal = toolWorkflowJudgment(sessions, repoEvents);
		expect(signal.value).toBe(100);
		expect(signal.evidence[2]).toMatchObject({
			kind: "repo_context_artifacts",
			numerator: 3,
			denominator: 3,
		});
	});

	test("missingSnapshotMakesTheContextComponentNullNotZero", () => {
		const { sessions, repoEvents } = segmentSessions(
			balancedSessionEvents("s1"),
		);
		const signal = toolWorkflowJudgment(sessions, repoEvents);
		// balanced 100 (w 0.5) + leverage 0 (w 0.2), context redistributed:
		// 100 × 0.5 / 0.7 ≈ 71.43 — NOT dragged to 50 by a missing repo.
		expect(signal.value).toBeCloseTo(500 / 7, 5);
	});

	test("emptyStreamYieldsNullValueNoneConfidence", () => {
		const signal = toolWorkflowJudgment([], []);
		expect(signal.value).toBeNull();
		expect(signal.confidence).toBe("none");
	});

	test("fourSessionsYieldsLowConfidence", () => {
		const { sessions, repoEvents } = segmentSessions(
			["s1", "s2", "s3", "s4"].flatMap((id) => balancedSessionEvents(id)),
		);
		expect(toolWorkflowJudgment(sessions, repoEvents).confidence).toBe("low");
	});
});
