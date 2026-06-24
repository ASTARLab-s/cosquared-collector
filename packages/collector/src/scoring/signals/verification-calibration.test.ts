import { describe, expect, test } from "vitest";
import {
	changeAccepted,
	changeRejected,
	testRun,
} from "../__fixtures__/builders";
import { segmentSessions } from "../sessions";
import { verificationCalibration } from "./verification-calibration";

const T0 = "2026-06-10T10:00:00.000Z";
const T1 = "2026-06-10T10:01:00.000Z";
const T2 = "2026-06-10T10:02:00.000Z";

describe("signals: verificationCalibration", () => {
	test("flags low verification when accepted changes lack test runs", () => {
		// Accepts never followed by validation, no test runs at all.
		const { sessions } = segmentSessions([
			changeAccepted("s1", T0, false),
			changeAccepted("s1", T1, false),
		]);
		const signal = verificationCalibration(sessions);
		expect(signal.value).toBe(0);
		expect(signal.evidence[0]).toMatchObject({
			kind: "validation_after_accept",
			numerator: 0,
			denominator: 2,
		});
		expect(signal.evidence[1]).toMatchObject({
			kind: "sessions_with_accept_and_test_run",
			numerator: 0,
			denominator: 1,
		});
	});

	test("fullyValidatedAcceptsWithTestsScoreFull", () => {
		const { sessions } = segmentSessions([
			changeAccepted("s1", T0, true),
			testRun("s1", T1),
		]);
		// Both rates are 1.0, full at 0.75 → 100.
		expect(verificationCalibration(sessions).value).toBe(100);
	});

	test("nullValidationOutcomesExcludedFromRate", () => {
		// One validated accept + one too-close-to-session-end accept (null):
		// the rate is 1/1, not 1/2 — null means "couldn't judge".
		const { sessions } = segmentSessions([
			changeAccepted("s1", T0, true),
			testRun("s1", T1),
			changeAccepted("s1", T2, null),
		]);
		const signal = verificationCalibration(sessions);
		expect(signal.evidence[0]).toMatchObject({ numerator: 1, denominator: 1 });
		expect(signal.value).toBe(100);
	});

	test("allNullOutcomesYieldNullValidationComponentNotZero", () => {
		// Every change was the session's final activity: nothing is judgeable.
		// The test-after-accept component still has data (no test runs), so
		// the blend renormalizes onto it alone.
		const { sessions } = segmentSessions([changeAccepted("s1", T0, null)]);
		const signal = verificationCalibration(sessions);
		expect(signal.evidence[0].denominator).toBe(0);
		expect(signal.value).toBe(0); // accept+test rate 0/1, sole component
	});

	test("rejectionsAfterInspectionCountTowardCalibration", () => {
		// A rejected change followed by validation is calibration evidence,
		// even with no accepts anywhere.
		const { sessions } = segmentSessions([changeRejected("s1", T0, true)]);
		const signal = verificationCalibration(sessions);
		expect(signal.evidence[0]).toMatchObject({ numerator: 1, denominator: 1 });
		expect(signal.value).toBe(100); // accept-based component null, renormalized
	});

	test("zeroChangeEventsYieldsNullValueNoneConfidence", () => {
		const { sessions } = segmentSessions([testRun("s1", T0)]);
		const signal = verificationCalibration(sessions);
		expect(signal.value).toBeNull();
		expect(signal.confidence).toBe("none");
	});

	test("fourSessionsWithChangesYieldsLowConfidence", () => {
		const { sessions } = segmentSessions(
			["s1", "s2", "s3", "s4"].map((id) => changeAccepted(id, T0, true)),
		);
		expect(verificationCalibration(sessions).confidence).toBe("low");
	});

	test("publishedBlendWeightsValidationHeavier", () => {
		// Validation rate 1.0 (→100), accept+test rate 0 (→0):
		// 0.6 × 100 + 0.4 × 0 = 60.
		const { sessions } = segmentSessions([
			changeAccepted("s1", T0, true),
			changeAccepted("s2", T0, true),
		]);
		expect(verificationCalibration(sessions).value).toBe(60);
	});
});
