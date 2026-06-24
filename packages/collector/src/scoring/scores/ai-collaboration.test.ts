import { describe, expect, test } from "vitest";
import type { ScoredSignal, SignalId } from "../types";
import { aiCollaboration } from "./ai-collaboration";

function signal(
	id: SignalId,
	value: number | null,
	confidence: ScoredSignal["confidence"] = value === null ? "none" : "normal",
): ScoredSignal {
	return { id, value, confidence, evidence: [] };
}

function subSignals(values: {
	tf: number | null;
	twj: number | null;
	vc: number | null;
	ce: number | null;
}) {
	return {
		taskFraming: signal("task_framing", values.tf),
		toolWorkflowJudgment: signal("tool_workflow_judgment", values.twj),
		verificationCalibration: signal("verification_calibration", values.vc),
		cognitiveEngagement: signal("cognitive_engagement", values.ce),
	};
}

describe("scores: aiCollaboration", () => {
	test("blends the four sub-signals with VC weighted heaviest", () => {
		// 0.2×50 + 0.2×50 + 0.4×100 + 0.2×50 = 70.
		const result = aiCollaboration(
			subSignals({ tf: 50, twj: 50, vc: 100, ce: 50 }),
		);
		expect(result.value).toBe(70);
		expect(result.components).toHaveLength(4);
		expect(
			result.components.map(({ signal: s, weight }) => [s.id, weight]),
		).toContainEqual(["verification_calibration", 0.4]);
	});

	test("renormalizes weights over sub-signals that have data", () => {
		// VC null: (0.2×60 + 0.2×60 + 0.2×60) / 0.6 = 60.
		const result = aiCollaboration(
			subSignals({ tf: 60, twj: 60, vc: null, ce: 60 }),
		);
		expect(result.value).toBe(60);
	});

	test("all-null sub-signals yield a null score, never a fake number", () => {
		const result = aiCollaboration(
			subSignals({ tf: null, twj: null, vc: null, ce: null }),
		);
		expect(result.value).toBeNull();
		expect(result.confidence).toBe("none");
	});

	test("confidence is the weakest non-none sub-signal confidence", () => {
		const result = aiCollaboration({
			taskFraming: signal("task_framing", 80, "low"),
			toolWorkflowJudgment: signal("tool_workflow_judgment", 80, "normal"),
			verificationCalibration: signal("verification_calibration", null, "none"),
			cognitiveEngagement: signal("cognitive_engagement", 80, "normal"),
		});
		expect(result.confidence).toBe("low");
	});

	test("rounds to an integer only at the score level", () => {
		// 0.2×33 + 0.2×33 + 0.4×33 + 0.2×34 = 33.2 → 33.
		const result = aiCollaboration(
			subSignals({ tf: 33, twj: 33, vc: 33, ce: 34 }),
		);
		expect(result.value).toBe(33);
		expect(Number.isInteger(result.value)).toBe(true);
	});
});
