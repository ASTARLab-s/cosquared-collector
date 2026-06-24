import type { Confidence, SignalId } from "./types";

/**
 * Every weight and threshold in the scoring methodology, in one place.
 *
 * These doc comments are user-facing published methodology (PRD §7.6):
 * each constant states what it tunes and the PRD/research grounding behind
 * it. The numeric values are v1 placeholders with a defensible rationale,
 * not validated calibration — they are centralized here precisely so
 * Phase 1 design-partner feedback can retune them in one file.
 */

/**
 * AI Collaboration sub-signal weights (must sum to 1). Verification &
 * Calibration carries the strictly largest weight — PRD §7.3: the METR RCT
 * (devs 19% slower while believing 20% faster) makes verification the
 * field's best-documented blind spot, so it is "weighted heaviest".
 */
export const AI_COLLABORATION_WEIGHTS: Record<
	Extract<
		SignalId,
		| "task_framing"
		| "tool_workflow_judgment"
		| "verification_calibration"
		| "cognitive_engagement"
	>,
	number
> = {
	verification_calibration: 0.4,
	task_framing: 0.2,
	tool_workflow_judgment: 0.2,
	cognitive_engagement: 0.2,
};

/**
 * Task Framing: framed-session rate scaling — 80% of sessions framed
 * scores 100. Grounding: UChicago planning study (experienced devs plan
 * before generating); the 2026 consensus workflow is spec → plan →
 * implement → verify (PRD §7.3).
 */
export const TASK_FRAMING_FULL_AT_RATE = 0.8;

/**
 * A first prompt of ≥ this many words counts as framing the task even
 * without a plan artifact — a coarse published proxy for supplying context
 * and intent up front (PRD §7.3 prompt specificity).
 */
export const FRAMED_PROMPT_MIN_WORD_COUNT = 40;

/**
 * Tool & Workflow Judgment component weights (sum to 1): session structure
 * (edit AND execute AND read/search — plan→build→verify vs. freeform) 0.5,
 * workflow leverage (skills/commands/subagents — agent-vs-manual task fit)
 * 0.2, context-engineering artifacts in the repo 0.3. Grounding: DORA 2025
 * (context/docs quality strongly predicts AI effectiveness) and the 2026
 * five-layer power-user stack (rules, MCP, skills, hooks, subagents).
 */
export const TWJ_BALANCED_WEIGHT = 0.5;
export const TWJ_LEVERAGE_WEIGHT = 0.2;
export const TWJ_CONTEXT_WEIGHT = 0.3;

/** Balanced-session rate scaling: 80% of edit-sessions balanced → 100. */
export const TWJ_BALANCED_FULL_AT_RATE = 0.8;

/** Leverage-session rate scaling: skills/commands/subagents in 50% of sessions → 100. */
export const TWJ_LEVERAGE_FULL_AT_RATE = 0.5;

/**
 * Context-artifact presence points (sum to 100): agent-context files
 * (CLAUDE.md-class) matter most, authored automation
 * (.claude/skills|commands|agents) next, documentation presence last
 * (PRD §7.3 "context-engineering artifacts present").
 */
export const CONTEXT_FILE_POINTS = 50;
export const AUTOMATION_FILE_POINTS = 30;
export const DOC_FILE_POINTS = 20;

/**
 * Verification & Calibration component weights (sum to 1): the
 * validation-after-accept rate is the primary signal (METR RCT, PRD §7.3);
 * tests specifically following accepts is the stronger but sparser cousin.
 */
export const VC_VALIDATION_RATE_WEIGHT = 0.6;
export const VC_TEST_AFTER_ACCEPT_WEIGHT = 0.4;

/** Both VC rates scale 0 → 0.75: validating 3 of 4 accepts scores 100. */
export const VC_FULL_AT_RATE = 0.75;

/**
 * Cognitive Engagement: engagement acts (questions + explanation requests)
 * per session at which a session is considered fully engaged. The score is
 * the mean of per-session min(acts, this) / this — so depth counts (a
 * session with one question scores half, two or more scores full) and a
 * single chatty session can't max the whole signal. Deliberately NOT a
 * binary presence rate, which saturated at 100. Grounding: Anthropic
 * skill-formation study (engaged interaction patterns preserved skill
 * while passive use lowered comprehension 17%, PRD §7.3).
 */
export const CE_SESSION_FULL_COUNT = 2;

/**
 * Testing Discipline component weights (sum to 1): in-session test runs
 * are the strongest behavioral signal (0.4); repo test-file ratio (0.3)
 * and tests-touched-in-commits (0.3) are the structural counterparts
 * (PRD §7.3 Testing Discipline row).
 */
export const TD_REPO_RATIO_WEIGHT = 0.3;
export const TD_SESSION_RATE_WEIGHT = 0.4;
export const TD_COMMIT_RATE_WEIGHT = 0.3;

/** Repo test-file ratio scaling: 1 test file per 5 tracked files → 100. */
export const TD_REPO_RATIO_FULL_AT = 0.2;
/** Session test-run rate scaling: tests in 60% of sessions → 100. */
export const TD_SESSION_RATE_FULL_AT = 0.6;
/** Commit test-touch rate scaling: tests touched in 50% of commits → 100. */
export const TD_COMMIT_RATE_FULL_AT = 0.5;

/**
 * Shipping Momentum component weights (sum to 1): commit cadence 0.4,
 * session completion arcs 0.3, churn health 0.3 (PRD §7.3 Shipping
 * Momentum row).
 */
export const SM_CADENCE_WEIGHT = 0.4;
export const SM_COMPLETION_WEIGHT = 0.3;
export const SM_CHURN_WEIGHT = 0.3;

/** Cadence window: distinct commit days are counted over this many days. */
export const SM_CADENCE_WINDOW_DAYS = 14;
/** Cadence scaling: committing on half the window's days → 100. */
export const SM_CADENCE_FULL_AT_RATE = 0.5;
/** Completion scaling: 70% of sessions ending in a commit → 100. */
export const SM_COMPLETION_FULL_AT_RATE = 0.7;

/**
 * Churn-health scaling: churn ratio (linesChurned/linesAdded) ≤ 10% is
 * healthy (scores 100); ≥ 50% scores 0. Grounding: GitClear — AI-era churn
 * roughly doubled vs. pre-AI baseline; high commits + high churn ≠
 * shipping (PRD §7.3).
 */
export const SM_CHURN_RATIO_ZERO_AT = 0.1;
export const SM_CHURN_RATIO_FULL_AT = 0.5;

/**
 * A commit within this many minutes after a session's last event still
 * completes the session's arc — the user often commits just after the AI
 * session ends. HONESTY (PRD §7.6): this is timestamp correlation, not
 * attribution — a nearby commit is evidence of an arc completing, not
 * proof the commit contains that session's work.
 */
export const COMMIT_LINKAGE_GRACE_MINUTES = 60;

/**
 * Honest-confidence threshold (PRD §7.6 "only 3 sessions this period —
 * low confidence"): below this many sessions (or commits, for commit-based
 * signals) a signal is labeled `low` instead of presented with false
 * precision.
 */
export const LOW_CONFIDENCE_MIN_SESSIONS = 5;

/** Cap on cited example artifacts per evidence statistic (PRD §7.6). */
export const MAX_EVIDENCE_REFS = 5;

/**
 * Published confidence rule: a denominator of 0 means no applicable data
 * (`none` — the value is null); below the published minimum is `low`;
 * otherwise `normal`.
 */
export function confidenceForDenominator(denominator: number): Confidence {
	if (denominator === 0) {
		return "none";
	}
	return denominator < LOW_CONFIDENCE_MIN_SESSIONS ? "low" : "normal";
}

/**
 * A ScoreResult's confidence is the WEAKEST of its non-none components
 * (`none` components contribute no data — weightedMean renormalizes around
 * them); all-none means the score itself has no data.
 */
export function weakestConfidence(confidences: Confidence[]): Confidence {
	const withData = confidences.filter((confidence) => confidence !== "none");
	if (withData.length === 0) {
		return "none";
	}
	return withData.includes("low") ? "low" : "normal";
}
