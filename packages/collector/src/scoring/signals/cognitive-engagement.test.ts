import { describe, expect, test } from "vitest";
import { explanationRequest, prompt, toolCall } from "../__fixtures__/builders";
import { segmentSessions } from "../sessions";
import { cognitiveEngagement } from "./cognitive-engagement";

/**
 * CE scores engagement DEPTH, not mere presence. Per session:
 * min(questions + explanation requests, 2) / 2; the signal is the mean × 100.
 * Fixtures pin that depth, the per-session cap, and the no-saturation goal.
 */

const T0 = "2026-06-10T10:00:00.000Z";
const T1 = "2026-06-10T10:01:00.000Z";
const T2 = "2026-06-10T10:02:00.000Z";

describe("signals: cognitiveEngagement", () => {
	test("oneEngagementActScoresASessionHalfEngaged", () => {
		const { sessions } = segmentSessions([
			prompt("s1", T0),
			explanationRequest("s1", T1),
		]);
		const signal = cognitiveEngagement(sessions);
		// 1 act, capped at 2 → 0.5 → 50. Evidence reconstructs the value.
		expect(signal.value).toBe(50);
		expect(signal.evidence[0]).toMatchObject({
			kind: "engagement_depth",
			numerator: 1,
			denominator: 2,
		});
	});

	test("twoActsScoreASessionFullyEngaged", () => {
		const { sessions } = segmentSessions([
			prompt("s1", T0, { isQuestion: true }),
			explanationRequest("s1", T1),
		]);
		expect(cognitiveEngagement(sessions).value).toBe(100);
	});

	test("chattySingleSessionCannotMaxTheSignalAcrossSessions", () => {
		// 25 questions in one session is capped at 2; a second silent session
		// drags the mean down — one loud session no longer pins the score.
		const loud = Array.from({ length: 25 }, (_unused, index) =>
			prompt("s1", `2026-06-10T10:${String(index).padStart(2, "0")}:00.000Z`, {
				isQuestion: true,
			}),
		);
		const { sessions } = segmentSessions([
			...loud,
			prompt("s2", T0),
			toolCall("s2", T1, "file_edit"),
		]);
		// session1 → 1.0 (capped), session2 → 0 → mean 0.5 → 50, not 100.
		expect(cognitiveEngagement(sessions).value).toBe(50);
	});

	test("pureGenerationSessionScoresZero", () => {
		const { sessions } = segmentSessions([
			prompt("s1", T0),
			toolCall("s1", T1, "file_edit"),
		]);
		expect(cognitiveEngagement(sessions).value).toBe(0);
	});

	test("sessionsWithoutHumanPromptsAreExcludedFromTheDenominator", () => {
		const { sessions } = segmentSessions([
			toolCall("s1", T0, "execute"),
			prompt("s2", T0, { isQuestion: true }),
		]);
		// One applicable session × cap 2 = denominator 2.
		expect(cognitiveEngagement(sessions).evidence[0].denominator).toBe(2);
	});

	test("zeroApplicableSessionsYieldsNullValueNoneConfidence", () => {
		const { sessions } = segmentSessions([toolCall("s1", T0, "execute")]);
		const signal = cognitiveEngagement(sessions);
		expect(signal.value).toBeNull();
		expect(signal.confidence).toBe("none");
	});

	test("everySessionFullyEngagedScoresOneHundred", () => {
		// Even a perfect score is earned by depth, not a low presence rate.
		const events = ["s1", "s2", "s3", "s4", "s5"].flatMap((id) => [
			prompt(id, T0, { isQuestion: true }),
			explanationRequest(id, T1),
		]);
		const { sessions } = segmentSessions(events);
		const signal = cognitiveEngagement(sessions);
		expect(signal.value).toBe(100);
		expect(signal.confidence).toBe("normal");
	});

	test("partialDepthAcrossManySessionsScalesProportionally", () => {
		// 7 of 20 sessions ask one question each (1 act, 0.5 capped);
		// mean = (7 × 0.5) / 20 = 0.175 → 17.5.
		const events = Array.from({ length: 20 }, (_unused, index) => [
			prompt(`s${index}`, T0, { isQuestion: index < 7 }),
			toolCall(`s${index}`, T2, "file_edit"),
		]).flat();
		const { sessions } = segmentSessions(events);
		expect(cognitiveEngagement(sessions).value).toBe(17.5);
	});
});
