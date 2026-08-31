import { describe, expect, test } from "vitest";
import {
	commandInvoked,
	planArtifact,
	prompt,
	toolCall,
} from "../__fixtures__/builders";
import { segmentSessions } from "../sessions";
import { taskFraming } from "./task-framing";

/**
 * Fixtures ARE the published Task Framing methodology: each entry pins
 * which session shapes count as "framed" and which do not.
 */

const T0 = "2026-06-10T10:00:00.000Z";
const T1 = "2026-06-10T10:01:00.000Z";
const T2 = "2026-06-10T10:02:00.000Z";

describe("signals: taskFraming", () => {
	test("plannedSessionViaArtifactBeforeFirstEdit counts as framed", () => {
		const { sessions } = segmentSessions([
			prompt("s1", T0),
			planArtifact("s1", T1),
			toolCall("s1", T2, "file_edit"),
		]);
		const signal = taskFraming(sessions);
		expect(signal.value).toBe(100); // 1/1 framed, full at 0.8
		expect(signal.evidence[0]).toMatchObject({
			kind: "framed_sessions",
			numerator: 1,
			denominator: 1,
		});
		// The citation is the plan artifact — the checkable framing act.
		expect(signal.evidence[0].refs).toEqual([
			{ sessionId: "s1", source: "claude-code", timestamp: T1 },
		]);
	});

	test("firstPromptDescribingOrderedStepsCountsAsFramed", () => {
		// Structuring the work IN the prompt is planning even with no plan
		// file: "First … Then …" states the sequence before any generation.
		const { sessions } = segmentSessions([
			prompt("s1", T0, { describesOrderedSteps: true }),
			toolCall("s1", T1, "file_edit"),
		]);
		const signal = taskFraming(sessions);
		expect(signal.value).toBe(100);
		expect(signal.evidence[0]).toMatchObject({
			kind: "framed_sessions",
			numerator: 1,
			denominator: 1,
		});
		// The citation is the prompt itself — the checkable framing act.
		expect(signal.evidence[0].refs).toEqual([
			{ sessionId: "s1", source: "claude-code", timestamp: T0 },
		]);
	});

	test("orderedStepsOnlyCountOnTheFirstPrompt", () => {
		// Framing happens up front; sequencing a later turn is mid-flight
		// course correction, not framing (same scoping as plan references).
		const { sessions } = segmentSessions([
			prompt("s1", T0),
			toolCall("s1", T1, "file_edit"),
			prompt("s1", T2, { describesOrderedSteps: true }),
		]);
		const signal = taskFraming(sessions);
		expect(signal.value).toBe(0);
		expect(signal.evidence[0]).toMatchObject({ numerator: 0, denominator: 1 });
	});

	test("artifactCreatedAfterFirstEditIsNotFraming", () => {
		const { sessions } = segmentSessions([
			prompt("s1", T0),
			toolCall("s1", T1, "file_edit"),
			planArtifact("s1", T2),
		]);
		expect(taskFraming(sessions).value).toBe(0);
	});

	test("firstPromptReferencingAPlanCountsAsFramed", () => {
		const { sessions } = segmentSessions([
			prompt("s1", T0, { referencesPlanArtifact: true }),
		]);
		expect(taskFraming(sessions).value).toBe(100);
	});

	test("promptLengthAloneDoesNotFrame", () => {
		// 2026-08-25 calibration: full credit for long prompts saturated
		// prompt-heavy repos; half credit re-saturated two of six repos.
		// Length is not structure — a 200-word first prompt without a plan
		// reference earns nothing.
		const { sessions } = segmentSessions([
			prompt("s1", T0, { wordCount: 200 }),
		]);
		expect(taskFraming(sessions).value).toBe(0);
	});

	test("onlyTheFirstPromptFramesTheSession", () => {
		// A plan reference in a second prompt does not retroactively frame.
		const { sessions } = segmentSessions([
			prompt("s1", T0, { wordCount: 5 }),
			prompt("s1", T1, { referencesPlanArtifact: true }),
		]);
		expect(taskFraming(sessions).value).toBe(0);
	});

	test("sessionsWithoutHumanPromptsAreExcludedFromTheDenominator", () => {
		const { sessions } = segmentSessions([
			toolCall("s1", T0, "file_edit"),
			prompt("s2", T1, { referencesPlanArtifact: true }),
		]);
		const signal = taskFraming(sessions);
		expect(signal.evidence[0].denominator).toBe(1);
		expect(signal.value).toBe(100);
	});

	test("planCommandDrivenSessionIsFramed even with a terse typed prompt", () => {
		// The /execute <plan> case: short prompt ("continue"), but a plan
		// command drives the session → framed, cited by the command event.
		const { sessions } = segmentSessions([
			commandInvoked("s1", T0, "plan"),
			prompt("s1", T1, { wordCount: 1 }),
			toolCall("s1", T2, "file_edit"),
		]);
		const signal = taskFraming(sessions);
		expect(signal.value).toBe(100);
		expect(signal.evidence[0].refs).toEqual([
			{ sessionId: "s1", source: "claude-code", timestamp: T0 },
		]);
	});

	test("planCommandWithoutTypedPromptStillCountsAndFrames", () => {
		// A /execute-only session (no typed prompt) is applicable AND framed,
		// not excluded as it was before this rule.
		const { sessions } = segmentSessions([
			commandInvoked("s1", T0, "plan"),
			toolCall("s1", T1, "file_edit"),
		]);
		const signal = taskFraming(sessions);
		expect(signal.evidence[0]).toMatchObject({ numerator: 1, denominator: 1 });
		expect(signal.value).toBe(100);
	});

	test("contextCommandAloneIsNotFramedAndNotApplicable", () => {
		// /prime is context engineering, not task framing — it feeds Tool &
		// Workflow Judgment. A context-only session is excluded entirely.
		const { sessions } = segmentSessions([
			commandInvoked("s1", T0, "context"),
			toolCall("s1", T1, "file_edit"),
		]);
		const signal = taskFraming(sessions);
		expect(signal.value).toBeNull();
		expect(signal.confidence).toBe("none");
	});

	test("contextCommandWithShortPromptIsApplicableButUnframed", () => {
		const { sessions } = segmentSessions([
			commandInvoked("s1", T0, "context"),
			prompt("s1", T1, { wordCount: 5 }),
		]);
		const signal = taskFraming(sessions);
		expect(signal.evidence[0]).toMatchObject({ numerator: 0, denominator: 1 });
	});

	test("machineryCommandAloneIsNotApplicable", () => {
		// /model, /clear → category "other": not a framing opportunity.
		const { sessions } = segmentSessions([commandInvoked("s1", T0, "other")]);
		expect(taskFraming(sessions).value).toBeNull();
	});

	test("zeroApplicableSessionsYieldsNullValueNoneConfidence", () => {
		const signal = taskFraming([]);
		expect(signal.value).toBeNull();
		expect(signal.confidence).toBe("none");
	});

	test("fourSessionsYieldsLowConfidence", () => {
		const { sessions } = segmentSessions(
			["s1", "s2", "s3", "s4"].map((id) => prompt(id, T0)),
		);
		expect(taskFraming(sessions).confidence).toBe("low");
	});

	test("fiveSessionsYieldsNormalConfidence", () => {
		const { sessions } = segmentSessions(
			["s1", "s2", "s3", "s4", "s5"].map((id) => prompt(id, T0)),
		);
		expect(taskFraming(sessions).confidence).toBe("normal");
	});

	test("rateScalesLinearlyToTheFullAtThreshold", () => {
		// 2 of 5 framed = 0.4 rate; full at 0.8 → 50.
		const { sessions } = segmentSessions([
			prompt("s1", T0, { referencesPlanArtifact: true }),
			prompt("s2", T0, { referencesPlanArtifact: true }),
			prompt("s3", T0),
			prompt("s4", T0),
			prompt("s5", T0),
		]);
		expect(taskFraming(sessions).value).toBe(50);
	});
});
