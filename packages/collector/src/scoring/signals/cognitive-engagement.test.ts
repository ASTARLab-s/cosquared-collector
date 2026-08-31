import { describe, expect, test } from "vitest";
import { explanationRequest, prompt, toolCall } from "../__fixtures__/builders";
import { segmentSessions } from "../sessions";
import { cognitiveEngagement } from "./cognitive-engagement";

/**
 * CE scores WEIGHTED engagement depth, not mere presence. Per session:
 * min(2·explanation requests + 1·question prompts, 4) / 4; the signal is the
 * mean × 100. Explanation requests weigh double — they are the direct
 * comprehension-seeking act; `?` prompts are a coarser proxy (2026-08-25
 * calibration: an unweighted 2-act cap saturated at 100 on question-mark
 * counts a human read scored 40–45). Fixtures pin the weights, the
 * per-session cap, and the no-saturation goal.
 */

const T0 = "2026-06-10T10:00:00.000Z";
const T1 = "2026-06-10T10:01:00.000Z";
const T2 = "2026-06-10T10:02:00.000Z";

describe("signals: cognitiveEngagement", () => {
	test("oneExplanationRequestNearlyFillsASingleTurnSession", () => {
		const { sessions } = segmentSessions([
			prompt("s1", T0),
			explanationRequest("s1", T1),
		]);
		const signal = cognitiveEngagement(sessions);
		// One prompt can carry at most an explanation request AND a question,
		// so this session's ceiling is 3, not 4: 2 of 3 → 67. Scoring it out
		// of 4 would penalise the session for being short rather than for
		// being disengaged. Evidence reconstructs the value.
		expect(signal.value).toBeCloseTo(66.67, 1);
		expect(signal.evidence[0]).toMatchObject({
			kind: "engagement_depth",
			numerator: 2,
			denominator: 3,
		});
	});

	test("oneQuestionPromptScoresASingleTurnSessionOneThird", () => {
		const { sessions } = segmentSessions([
			prompt("s1", T0, { isQuestion: true }),
			toolCall("s1", T1, "file_edit"),
		]);
		const signal = cognitiveEngagement(sessions);
		// A bare `?` prompt is the weaker act: 1 point of this session's
		// achievable 3 → 33.
		expect(signal.value).toBeCloseTo(33.33, 1);
		expect(signal.evidence[0]).toMatchObject({ numerator: 1, denominator: 3 });
	});

	test("twoExplanationRequestsScoreASessionFullyEngaged", () => {
		const { sessions } = segmentSessions([
			prompt("s1", T0),
			explanationRequest("s1", T1),
			explanationRequest("s1", T2),
		]);
		expect(cognitiveEngagement(sessions).value).toBe(100);
	});

	test("questionsAloneNeedFourToFullyEngageASession", () => {
		// The calibration failure mode: interview-style `?` prompts maxing the
		// signal cheaply. Two questions now score half, not full.
		const { sessions } = segmentSessions([
			prompt("s1", T0, { isQuestion: true }),
			prompt("s1", T1, { isQuestion: true }),
		]);
		expect(cognitiveEngagement(sessions).value).toBe(50);
	});

	test("chattySingleSessionCannotMaxTheSignalAcrossSessions", () => {
		// 25 questions in one session are capped at 4 points; a second silent
		// session drags the mean down — one loud session never pins the score.
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
		// session1 caps at 4 of 4; session2 is a single turn that earned
		// nothing, ceiling 3 → 4 of 7 → 57, not 100. One loud session still
		// never pins the score.
		expect(cognitiveEngagement(sessions).value).toBeCloseTo(57.14, 1);
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
		// One applicable session, a single prompt, so its ceiling is 3.
		expect(cognitiveEngagement(sessions).evidence[0].denominator).toBe(3);
	});

	test("zeroApplicableSessionsYieldsNullValueNoneConfidence", () => {
		const { sessions } = segmentSessions([toolCall("s1", T0, "execute")]);
		const signal = cognitiveEngagement(sessions);
		expect(signal.value).toBeNull();
		expect(signal.confidence).toBe("none");
	});

	test("everySessionFullyEngagedScoresOneHundred", () => {
		// Even a perfect score is earned by depth: two explanation-grade acts
		// (here: explanation + explanation) per session across five sessions.
		const events = ["s1", "s2", "s3", "s4", "s5"].flatMap((id) => [
			prompt(id, T0),
			explanationRequest(id, T1),
			explanationRequest(id, T2),
		]);
		const { sessions } = segmentSessions(events);
		const signal = cognitiveEngagement(sessions);
		expect(signal.value).toBe(100);
		expect(signal.confidence).toBe("normal");
	});

	test("partialDepthAcrossManySessionsScalesProportionally", () => {
		// 8 of 20 single-turn sessions ask one question each: 8 points of an
		// achievable 20 × 3 = 60 → 13.3.
		const events = Array.from({ length: 20 }, (_unused, index) => [
			prompt(`s${index}`, T0, { isQuestion: index < 8 }),
			toolCall(`s${index}`, T2, "file_edit"),
		]).flat();
		const { sessions } = segmentSessions(events);
		expect(cognitiveEngagement(sessions).value).toBeCloseTo(13.33, 1);
	});
});
