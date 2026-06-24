import { weightedMean } from "../scale";
import type { ScoredSignal, ScoreResult } from "../types";
import { AI_COLLABORATION_WEIGHTS, weakestConfidence } from "../weights";

/**
 * AI Collaboration — the weighted mean of its four named sub-signals
 * (PRD §7.3 hierarchy: three top-level scores, not seven; the sub-signals
 * are user-facing but never top-level scores themselves).
 *
 * Rule: weightedMean over Task Framing (0.2), Tool & Workflow Judgment
 * (0.2), Verification & Calibration (0.4 — weighted heaviest, METR RCT),
 * and Cognitive Engagement (0.2), with weights renormalized over the
 * sub-signals that have data. Confidence is the weakest of the non-none
 * sub-signals (PRD §7.6 honest confidence).
 *
 * Pure and deterministic: no clock, no randomness, no I/O.
 */
export function aiCollaboration(subSignals: {
	taskFraming: ScoredSignal;
	toolWorkflowJudgment: ScoredSignal;
	verificationCalibration: ScoredSignal;
	cognitiveEngagement: ScoredSignal;
}): ScoreResult {
	const components = [
		{
			signal: subSignals.taskFraming,
			weight: AI_COLLABORATION_WEIGHTS.task_framing,
		},
		{
			signal: subSignals.toolWorkflowJudgment,
			weight: AI_COLLABORATION_WEIGHTS.tool_workflow_judgment,
		},
		{
			signal: subSignals.verificationCalibration,
			weight: AI_COLLABORATION_WEIGHTS.verification_calibration,
		},
		{
			signal: subSignals.cognitiveEngagement,
			weight: AI_COLLABORATION_WEIGHTS.cognitive_engagement,
		},
	];
	const mean = weightedMean(
		components.map(({ signal, weight }) => ({ value: signal.value, weight })),
	);
	return {
		value: mean === null ? null : Math.round(mean),
		confidence: weakestConfidence(
			components.map(({ signal }) => signal.confidence),
		),
		components,
	};
}
