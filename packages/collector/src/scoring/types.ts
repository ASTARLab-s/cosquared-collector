import type { SessionSource } from "@cosquared/schema";

/**
 * Output types of the scoring engine — the Builder Profile and everything
 * inside it.
 *
 * EVIDENCE IS STRUCTURED, NEVER PROSE (PRD §7.6): the collector package
 * produces only ids, counts, rates, and timestamps. Phrasing lives in the
 * CLI, which keeps this public package's output upload-safe by
 * construction and the open/closed boundary clean (PRD §6) — no coaching
 * language can drift into the open-source half.
 *
 * WIRE MIRROR — KEEP IN SYNC: `SignalId`, `BuilderType`, `Confidence`, and
 * `EvidenceKind` are mirrored as zod enums in `@cosquared/schema`
 * `analysis-payload.ts` (the upload `profile` contract). When a value is
 * added/renamed here, update that mirror too — the schema's `satisfies`
 * guards and the dashboard's exhaustive phrase tables will fail loudly if
 * the two drift, but the source-of-truth ordering lives here.
 */

/**
 * The six leaf dimensions ranked for strengths/weaknesses/focus: the four
 * AI Collaboration sub-signals plus the two other top-level scores.
 * AI Collaboration itself is an aggregate of the first four — ranking it
 * alongside them would double-count (PRD §16 Q1: no composite score).
 */
export type SignalId =
	| "task_framing"
	| "tool_workflow_judgment"
	| "verification_calibration"
	| "cognitive_engagement"
	| "testing_discipline"
	| "shipping_momentum";

/**
 * Honest-confidence label (PRD §7.6): `none` = no applicable data (the
 * value is null, never a fake number), `low` = thin evidence (below the
 * published session/commit minimum in `weights.ts`), `normal` otherwise.
 */
export type Confidence = "none" | "low" | "normal";

/**
 * Every contributing statistic kind the engine can emit — a closed union
 * so the CLI's phrase table is exhaustiveness-checked: a new statistic
 * without phrasing fails typecheck instead of rendering garbage.
 */
export type EvidenceKind =
	| "framed_sessions"
	| "balanced_sessions"
	| "workflow_leverage_sessions"
	| "repo_context_artifacts"
	| "validation_after_accept"
	| "sessions_with_accept_and_test_run"
	| "engagement_depth"
	| "repo_test_file_ratio"
	| "sessions_with_test_run"
	| "commits_touching_tests"
	| "commit_cadence_days"
	| "sessions_ending_in_commit"
	| "recent_churn_ratio";

/**
 * A checkable artifact reference (PRD §7.6: every citation points to the
 * user's own verifiable artifacts). `sessionId` is null for repo-scope
 * citations (commits, snapshots).
 */
export interface EvidenceRef {
	sessionId: string | null;
	source: SessionSource;
	/** ISO timestamp of the cited event. */
	timestamp: string;
}

/**
 * One contributing statistic — structured, never prose. The CLI maps
 * `kind` to phrasing ("tests ran in {numerator} of {denominator}
 * sessions"); numerator/denominator expose the raw rate so users can
 * falsify the claim against their own history (PRD §7.6); `refs` cite up
 * to MAX_EVIDENCE_REFS example artifacts.
 */
export interface EvidenceStatistic {
	kind: EvidenceKind;
	numerator: number;
	denominator: number;
	refs: EvidenceRef[];
}

export interface ScoredSignal {
	id: SignalId;
	/** 0–100 (unrounded), or null when no applicable events exist. */
	value: number | null;
	confidence: Confidence;
	evidence: EvidenceStatistic[];
}

export interface ScoreResult {
	/** 0–100 rounded to integer; null = no data, never a fake number. */
	value: number | null;
	confidence: Confidence;
	/**
	 * Every contributing component with its weight — the breakdown IS the
	 * computation (PRD §7.6 explanation fidelity by construction).
	 */
	components: Array<{ signal: ScoredSignal; weight: number }>;
}

/** Builder Type classifications (PRD §7.2 — rule-based, published criteria). */
export type BuilderType =
	| "rapid_prototyper"
	| "methodical_architect"
	| "ai_delegator"
	| "careful_validator"
	| "explorer";

export interface BuilderProfile {
	/** SCHEMA_VERSION of the event stream this profile was computed from. */
	schemaVersion: string;
	window: {
		firstEventAt: string | null;
		lastEventAt: string | null;
		eventCount: number;
		sessionCount: number;
		commitCount: number;
	};
	/** Null when there is not enough data to classify (PRD §7.6 honesty). */
	builderType: BuilderType | null;
	/** Components are the four sub-signals (PRD §7.3 hierarchy). */
	aiCollaboration: ScoreResult;
	testingDiscipline: ScoreResult;
	shippingMomentum: ScoreResult;
	/** Up to 3 leaf signals with value ≥ 60, strongest first (PRD §7.2). */
	strengths: SignalId[];
	/** Up to 3 leaf signals with value < 60, weakest first (PRD §7.2). */
	weaknesses: SignalId[];
	/** The single lowest-valued leaf signal — exactly one (PRD §7.2). */
	recommendedFocus: SignalId | null;
}
