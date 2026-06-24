import { z } from "zod";
import { SessionSourceSchema } from "./session-event";

/**
 * AnalysisPayload — the upload contract: the exact, name/path-free shape the
 * CLI serializes and `POST`s to `/v1/analyses`, and the shape the server
 * validates with this same schema. It is PUBLIC (mirrored to the open-source
 * repo and exposed via `GET /v1/schema`): the whole point is that a
 * privacy-skeptical developer can read this file and see precisely what would
 * leave their machine (CLAUDE.md "the public repo's readability IS the trust
 * strategy").
 *
 * PRIVACY BY CONSTRUCTION (CLAUDE.md invariant #1): every field is a count, a
 * rate, a boolean, a score, or an opaque hash. There is no field that can
 * carry a file name, a path, a prompt, a commit message, or source — by
 * construction, because the payload is derived ONLY from v1 `SessionEvent`s,
 * which already stripped all of that at parse time. Strict objects REJECT
 * unknown keys (not strip them), so a builder bug that smuggles an extra field
 * fails loudly at `parse`.
 *
 * DELIBERATE SUBSET OF PRD §10's illustration (privacy + honesty, PRD §7.6):
 * the PRD's example payload shows `languages`, `context_artifacts_present:
 * ["CLAUDE.md"]`, `checkpoint_review_count`, and `summary_redacted`. NONE of
 * those are included here:
 *   - `languages` and named `context_artifacts_present` would leak names —
 *     v1 events carry only counts, never names, so we emit counts/booleans.
 *   - `checkpoint_review_count` has no v1 source — inventing it would be a
 *     fake number, which the honesty invariant forbids.
 *   - `summary_redacted` (deterministic transcript summaries) is its own
 *     future feature; Rich-mode excerpts remain deferred (PRD §7.7, §16 Q3).
 * Numeric scores are `number | null` — null means "no applicable data",
 * never a fake 0 (PRD §7.6 honest confidence).
 *
 * THE `profile` SECTION (schema 1.4.0+): the structured Builder Profile the
 * dashboard renders — `builder_type`, `recommended_focus`, ranked
 * strengths/weaknesses, per-score + per-subsignal confidence, and per-leaf
 * evidence. Every field is an enum, a count, a ratio, or a DATE — there is no
 * prose and no name/path, exactly like the rest of the payload. It carries
 * nothing the PUBLIC rule-based scoring engine doesn't already compute and
 * the published methodology doesn't already disclose; the consumer (CLI
 * terminal report, web dashboard) supplies all phrasing (PRD §6 open/closed).
 * Evidence refs are coarsened to DATE granularity (`session_date`, no time,
 * no `sessionId`) by deliberate minimization (PRD §9) — coarsening later is
 * impossible, so we start coarse.
 */

/**
 * The CLI build that produced the payload. `cli_version` and `platform` are
 * the only client-identifying fields, both non-sensitive (a semver string and
 * `process.platform`, e.g. "darwin").
 */
export const PayloadClientSchema = z.strictObject({
	cli_version: z.string(),
	platform: z.string(),
});

/**
 * Repo-shape facts derived from the latest `repo_snapshot` / `churn_snapshot`
 * and the commit stream — counts and ratios only.
 *
 * - `id_hash`: opaque, stable repo identifier (`sha256:…` of the normalized
 *   remote URL, or the absolute path as a fallback). NEVER the raw path/URL —
 *   it only has to be stable across re-analyses of the same repo.
 * - `has_tests` / `test_file_ratio`: test-file presence and ratio
 *   (testFileCount / trackedFileCount), feeding Testing Discipline (PRD §7.3).
 * - `commit_count_30d`: commits in the 30 days ending at the stream's
 *   reference time (the max event timestamp — never the wall clock).
 * - `churn_ratio_14d`: linesChurned / linesAdded over the trailing 14-day
 *   churn window (PRD §7.3 Shipping Momentum); null when linesAdded is 0.
 * - `context_artifact_count`: agent-context files (e.g. CLAUDE.md/.cursorrules)
 *   PLUS authored automation (`.claude/skills|commands|agents/`) — the
 *   context-engineering-artifacts component of Tool & Workflow Judgment
 *   (PRD §7.3). A COUNT, not the names the PRD illustration listed.
 * - `doc_file_count`: documentation files, kept separate from the count above.
 */
export const PayloadRepoSchema = z.strictObject({
	id_hash: z.string(),
	has_tests: z.boolean(),
	test_file_ratio: z.number(),
	commit_count_30d: z.number().int().nonnegative(),
	churn_ratio_14d: z.number().nullable(),
	context_artifact_count: z.number().int().nonnegative(),
	doc_file_count: z.number().int().nonnegative(),
});

/**
 * One AI coding session reduced to structural per-session features (counts,
 * rates, booleans). All derived from v1 events; no free text. Rates are
 * `number | null` — null when the denominator is 0 (no accepts → no
 * validation rate; no prompts → no question rate), never a fake 0.
 */
export const PayloadSessionSchema = z.strictObject({
	source: SessionSourceSchema,
	duration_minutes: z.number().nullable(),
	prompt_count: z.number().int().nonnegative(),
	tests_run_count: z.number().int().nonnegative(),
	errors_encountered: z.number().int().nonnegative(),
	explanation_request_count: z.number().int().nonnegative(),
	plan_artifact_present: z.boolean(),
	validation_after_accept_rate: z.number().nullable(),
	question_prompt_rate: z.number().nullable(),
});

/**
 * The four named AI Collaboration sub-signals (PRD §7.3 hierarchy). Each is
 * `number | null` (0–100, unrounded). They are user-facing but never a
 * top-level score themselves (PRD §16 Q1: no composite score).
 */
export const PayloadSubsignalsSchema = z.strictObject({
	task_framing: z.number().nullable(),
	tool_workflow_judgment: z.number().nullable(),
	verification_calibration: z.number().nullable(),
	cognitive_engagement: z.number().nullable(),
});

/**
 * The locally-computed Builder Profile scores (PRD §7.2): the three top-level
 * scores plus the four AI Collaboration sub-signals. Computed entirely on the
 * user's machine by the rule-based engine; the server stores them as given.
 * All `number | null` — null is honest "no data", never a fake number.
 */
export const PayloadLocalScoresSchema = z.strictObject({
	ai_collaboration: z.number().nullable(),
	ai_collaboration_subsignals: PayloadSubsignalsSchema,
	testing: z.number().nullable(),
	shipping: z.number().nullable(),
});

/**
 * The six leaf signal ids ranked for strengths/weaknesses/focus (PRD §7.2).
 * KEEP IN SYNC with `SignalId` in `@cosquared/collector` `scoring/types.ts` — the
 * wire mirror of that union (string literals, never new spellings).
 */
export const SignalIdSchema = z.enum([
	"task_framing",
	"tool_workflow_judgment",
	"verification_calibration",
	"cognitive_engagement",
	"testing_discipline",
	"shipping_momentum",
]);
export type SignalId = z.infer<typeof SignalIdSchema>;

/**
 * Builder Type classifications (PRD §7.2 — rule-based, published criteria).
 * KEEP IN SYNC with `BuilderType` in `@cosquared/collector` `scoring/types.ts`.
 */
export const BuilderTypeSchema = z.enum([
	"rapid_prototyper",
	"methodical_architect",
	"ai_delegator",
	"careful_validator",
	"explorer",
]);
export type BuilderType = z.infer<typeof BuilderTypeSchema>;

/**
 * Honest-confidence label (PRD §7.6): `none` = no applicable data (value is
 * null), `low` = thin evidence (below the published session minimum), `normal`.
 * KEEP IN SYNC with `Confidence` in `@cosquared/collector` `scoring/types.ts`.
 */
export const ConfidenceSchema = z.enum(["none", "low", "normal"]);
export type Confidence = z.infer<typeof ConfidenceSchema>;

/**
 * Every contributing statistic kind the engine can emit — a closed union so
 * each consumer's phrase table is exhaustiveness-checked (a new kind without
 * phrasing fails typecheck). KEEP IN SYNC with `EvidenceKind` in
 * `@cosquared/collector` `scoring/types.ts`.
 */
export const EvidenceKindSchema = z.enum([
	"framed_sessions",
	"balanced_sessions",
	"workflow_leverage_sessions",
	"repo_context_artifacts",
	"validation_after_accept",
	"sessions_with_accept_and_test_run",
	"engagement_depth",
	"repo_test_file_ratio",
	"sessions_with_test_run",
	"commits_touching_tests",
	"commit_cadence_days",
	"sessions_ending_in_commit",
	"recent_churn_ratio",
]);
export type EvidenceKind = z.infer<typeof EvidenceKindSchema>;

/**
 * A checkable artifact citation, MINIMIZED for the wire (PRD §9): only the
 * source tool and the session's DATE — no time component, no `sessionId`. The
 * collector's `EvidenceRef` carries both; `buildAnalysisPayload` coarsens
 * `timestamp` → `session_date` (`timestamp.slice(0, 10)`) and drops the id.
 * The dashboard cites "Jun 17", never "3:14 am". Coarsening after upload is
 * impossible, so the wire is coarse by construction.
 */
export const PayloadEvidenceRefSchema = z.strictObject({
	source: SessionSourceSchema,
	session_date: z.string(),
});

/**
 * One contributing statistic, structured (never prose): `kind` maps to a
 * phrase template on the consumer side; numerator/denominator expose the raw
 * rate so a user can falsify the claim against their own history (PRD §7.6);
 * `refs` cite example artifacts at date granularity.
 */
export const PayloadEvidenceStatisticSchema = z.strictObject({
	kind: EvidenceKindSchema,
	numerator: z.number().int().nonnegative(),
	denominator: z.number().int().nonnegative(),
	refs: z.array(PayloadEvidenceRefSchema),
});

/** Per-score and per-subsignal honest-confidence labels (PRD §7.6). */
export const PayloadProfileConfidenceSchema = z.strictObject({
	ai_collaboration: ConfidenceSchema,
	testing: ConfidenceSchema,
	shipping: ConfidenceSchema,
	subsignals: z.strictObject({
		task_framing: ConfidenceSchema,
		tool_workflow_judgment: ConfidenceSchema,
		verification_calibration: ConfidenceSchema,
		cognitive_engagement: ConfidenceSchema,
	}),
});

/** Per-leaf-signal evidence — the statistics behind each of the six signals. */
export const PayloadProfileEvidenceSchema = z.strictObject({
	task_framing: z.array(PayloadEvidenceStatisticSchema),
	tool_workflow_judgment: z.array(PayloadEvidenceStatisticSchema),
	verification_calibration: z.array(PayloadEvidenceStatisticSchema),
	cognitive_engagement: z.array(PayloadEvidenceStatisticSchema),
	testing_discipline: z.array(PayloadEvidenceStatisticSchema),
	shipping_momentum: z.array(PayloadEvidenceStatisticSchema),
});

/**
 * The structured Builder Profile the dashboard renders (PRD §7.2, §7.6). All
 * outputs of the PUBLIC rule-based engine; no prose lives here. `builder_type`
 * and `recommended_focus` are nullable — null is honest "not enough data yet",
 * never a fabricated classification.
 */
export const PayloadProfileSchema = z.strictObject({
	builder_type: BuilderTypeSchema.nullable(),
	recommended_focus: SignalIdSchema.nullable(),
	strengths: z.array(SignalIdSchema),
	weaknesses: z.array(SignalIdSchema),
	confidence: PayloadProfileConfidenceSchema,
	evidence: PayloadProfileEvidenceSchema,
});

export type PayloadEvidenceRef = z.infer<typeof PayloadEvidenceRefSchema>;
export type PayloadEvidenceStatistic = z.infer<
	typeof PayloadEvidenceStatisticSchema
>;
export type PayloadProfile = z.infer<typeof PayloadProfileSchema>;

/** The full upload contract. Strict at every level. */
export const AnalysisPayloadSchema = z.strictObject({
	schema_version: z.string(),
	client: PayloadClientSchema,
	repo: PayloadRepoSchema,
	sessions: z.array(PayloadSessionSchema),
	local_scores: PayloadLocalScoresSchema,
	profile: PayloadProfileSchema,
});

export type AnalysisPayload = z.infer<typeof AnalysisPayloadSchema>;

/**
 * The canonical wire form: a compact JSON string with keys in a FIXED order,
 * independent of how the input object was constructed.
 *
 * This is the byte-parity anchor (PRD line 428, CLAUDE.md code patterns):
 * `cosq inspect` prints exactly this string and the uploader sends exactly
 * this string for the same events, so "what I show you" is provably "what I
 * upload". JSON.stringify preserves key insertion order, so re-building the
 * object here with explicit ordering makes the bytes deterministic even if a
 * caller's payload object happened to be assembled key-by-key in a different
 * order. Compact (no spaces) so the bytes are minimal and stable.
 */
export function serializeAnalysisPayload(payload: AnalysisPayload): string {
	// Rebuild each evidence statistic (and its refs) key-by-key so the bytes are
	// order-independent of how the producer assembled the object.
	const orderEvidence = (
		statistics: AnalysisPayload["profile"]["evidence"]["task_framing"],
	) =>
		statistics.map((statistic) => ({
			kind: statistic.kind,
			numerator: statistic.numerator,
			denominator: statistic.denominator,
			refs: statistic.refs.map((ref) => ({
				source: ref.source,
				session_date: ref.session_date,
			})),
		}));
	const { profile } = payload;
	const ordered = {
		schema_version: payload.schema_version,
		client: {
			cli_version: payload.client.cli_version,
			platform: payload.client.platform,
		},
		repo: {
			id_hash: payload.repo.id_hash,
			has_tests: payload.repo.has_tests,
			test_file_ratio: payload.repo.test_file_ratio,
			commit_count_30d: payload.repo.commit_count_30d,
			churn_ratio_14d: payload.repo.churn_ratio_14d,
			context_artifact_count: payload.repo.context_artifact_count,
			doc_file_count: payload.repo.doc_file_count,
		},
		sessions: payload.sessions.map((session) => ({
			source: session.source,
			duration_minutes: session.duration_minutes,
			prompt_count: session.prompt_count,
			tests_run_count: session.tests_run_count,
			errors_encountered: session.errors_encountered,
			explanation_request_count: session.explanation_request_count,
			plan_artifact_present: session.plan_artifact_present,
			validation_after_accept_rate: session.validation_after_accept_rate,
			question_prompt_rate: session.question_prompt_rate,
		})),
		local_scores: {
			ai_collaboration: payload.local_scores.ai_collaboration,
			ai_collaboration_subsignals: {
				task_framing:
					payload.local_scores.ai_collaboration_subsignals.task_framing,
				tool_workflow_judgment:
					payload.local_scores.ai_collaboration_subsignals
						.tool_workflow_judgment,
				verification_calibration:
					payload.local_scores.ai_collaboration_subsignals
						.verification_calibration,
				cognitive_engagement:
					payload.local_scores.ai_collaboration_subsignals.cognitive_engagement,
			},
			testing: payload.local_scores.testing,
			shipping: payload.local_scores.shipping,
		},
		profile: {
			builder_type: profile.builder_type,
			recommended_focus: profile.recommended_focus,
			strengths: [...profile.strengths],
			weaknesses: [...profile.weaknesses],
			confidence: {
				ai_collaboration: profile.confidence.ai_collaboration,
				testing: profile.confidence.testing,
				shipping: profile.confidence.shipping,
				subsignals: {
					task_framing: profile.confidence.subsignals.task_framing,
					tool_workflow_judgment:
						profile.confidence.subsignals.tool_workflow_judgment,
					verification_calibration:
						profile.confidence.subsignals.verification_calibration,
					cognitive_engagement:
						profile.confidence.subsignals.cognitive_engagement,
				},
			},
			evidence: {
				task_framing: orderEvidence(profile.evidence.task_framing),
				tool_workflow_judgment: orderEvidence(
					profile.evidence.tool_workflow_judgment,
				),
				verification_calibration: orderEvidence(
					profile.evidence.verification_calibration,
				),
				cognitive_engagement: orderEvidence(
					profile.evidence.cognitive_engagement,
				),
				testing_discipline: orderEvidence(profile.evidence.testing_discipline),
				shipping_momentum: orderEvidence(profile.evidence.shipping_momentum),
			},
		},
	};
	return JSON.stringify(ordered);
}
