import { z } from "zod";

/**
 * Opaque platform identifiers. The closed charset prevents identifiers from
 * carrying prose, paths, email addresses, or other personal data.
 */
export const EvalOpaqueIdSchema = z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/);

export const EvalEventSourceSchema = z.enum([
	"claude-code",
	"cursor",
	"codex-cli",
	"git",
	"external",
]);

export const EvalEventProvenanceSchema = z.enum([
	"server_observed",
	"provider_observed",
	"client_observed",
	"self_reported",
]);

const sessionEnvelope = {
	id: EvalOpaqueIdSchema,
	occurred_at: z.iso.datetime(),
	subject: EvalOpaqueIdSchema,
	session_id: EvalOpaqueIdSchema,
	source: EvalEventSourceSchema,
	provenance: EvalEventProvenanceSchema,
};

const repoEnvelope = {
	...sessionEnvelope,
	session_id: z.null(),
};

/** Session boundary used for segmentation; no scorer reads it directly. */
export const EvalEventSessionStartedSchema = z.strictObject({
	...sessionEnvelope,
	type: z.literal("session.started"),
	tool_version: z
		.string()
		.regex(/^[A-Za-z0-9_.+-]{1,64}$/)
		.nullable(),
});

/** Session completion observed for Shipping Momentum completion arcs. */
export const EvalEventSessionCompletedSchema = z.strictObject({
	...sessionEnvelope,
	type: z.literal("session.completed"),
	duration_minutes: z.number().nonnegative().nullable(),
});

/** Structural prompt features used by Task Framing and Cognitive Engagement. */
export const EvalEventAiPromptedSchema = z.strictObject({
	...sessionEnvelope,
	type: z.literal("ai.prompted"),
	word_count: z.number().int().nonnegative(),
	is_question: z.boolean(),
	references_plan_artifact: z.boolean(),
});

/** An accepted AI change used by Verification & Calibration. */
export const EvalEventAiChangeAcceptedSchema = z.strictObject({
	...sessionEnvelope,
	type: z.literal("ai.change_accepted"),
	followed_by_validation: z.boolean().nullable(),
});

/** A rejected AI change used by Verification & Calibration. */
export const EvalEventAiChangeRejectedSchema = z.strictObject({
	...sessionEnvelope,
	type: z.literal("ai.change_rejected"),
	followed_by_validation: z.boolean().nullable(),
});

/** Explanation-seeking behavior used by Cognitive Engagement. */
export const EvalEventAiExplanationRequestedSchema = z.strictObject({
	...sessionEnvelope,
	type: z.literal("ai.explanation_requested"),
});

/** Closed tool category used by Tool & Workflow Judgment; names are excluded. */
export const EvalEventAiToolInvokedSchema = z.strictObject({
	...sessionEnvelope,
	type: z.literal("ai.tool_invoked"),
	category: z.enum([
		"file_edit",
		"file_read",
		"execute",
		"search",
		"delegate",
		"other",
	]),
});

/** Closed automation category used by Task Framing and workflow leverage. */
export const EvalEventAiCommandInvokedSchema = z.strictObject({
	...sessionEnvelope,
	type: z.literal("ai.command_invoked"),
	category: z.enum(["plan", "context", "other"]),
});

/** Planning artifact observation used by Task Framing. */
export const EvalEventPlanArtifactCreatedSchema = z.strictObject({
	...sessionEnvelope,
	type: z.literal("plan.artifact_created"),
	artifact_kind: z.enum(["plan_doc", "spec", "todo"]),
});

/** Closed test framework taxonomy; test outcomes feed verification and testing. */
export const EvalTestFrameworkSchema = z.enum([
	"vitest",
	"jest",
	"pytest",
	"unittest",
	"rspec",
	"cargo-test",
	"go-test",
	"node-test",
	"other",
]);

export const EvalEventValidationTestRunSchema = z.strictObject({
	...sessionEnvelope,
	type: z.literal("validation.test_run"),
	passed: z.boolean().nullable(),
	framework: EvalTestFrameworkSchema.nullable(),
});

/** Error-resolution arc observation used by the evaluator's session context. */
export const EvalEventErrorEncounteredSchema = z.strictObject({
	...sessionEnvelope,
	type: z.literal("error.encountered"),
	resolved: z.boolean().nullable(),
});

/** Repo-scope commit shape used by Testing Discipline and Shipping Momentum. */
export const EvalEventVcsCommitSchema = z.strictObject({
	...repoEnvelope,
	type: z.literal("vcs.commit"),
	files_changed: z.number().int().nonnegative(),
	insertions: z.number().int().nonnegative(),
	deletions: z.number().int().nonnegative(),
	touched_test_files: z.boolean(),
});

/** Repo-scope structural counts used by testing and context-artifact signals. */
export const EvalEventRepoSnapshotSchema = z.strictObject({
	...repoEnvelope,
	type: z.literal("repo.snapshot"),
	tracked_file_count: z.number().int().nonnegative(),
	test_file_count: z.number().int().nonnegative(),
	doc_file_count: z.number().int().nonnegative(),
	context_file_count: z.number().int().nonnegative(),
	automation_file_count: z.number().int().nonnegative(),
});

/** Repo-scope churn window used only by Shipping Momentum. */
export const EvalEventRepoChurnSnapshotSchema = z.strictObject({
	...repoEnvelope,
	type: z.literal("repo.churn_snapshot"),
	window_days: z.number().int().positive(),
	lines_added: z.number().int().nonnegative(),
	lines_churned: z.number().int().nonnegative(),
});

/**
 * Closed v1 event catalog. No event type ships without a scorer that reads its
 * normalized SessionEvent counterpart; every object rejects unknown fields.
 */
export const EvaluationEventSchema = z.discriminatedUnion("type", [
	EvalEventSessionStartedSchema,
	EvalEventSessionCompletedSchema,
	EvalEventAiPromptedSchema,
	EvalEventAiChangeAcceptedSchema,
	EvalEventAiChangeRejectedSchema,
	EvalEventAiExplanationRequestedSchema,
	EvalEventAiToolInvokedSchema,
	EvalEventAiCommandInvokedSchema,
	EvalEventPlanArtifactCreatedSchema,
	EvalEventValidationTestRunSchema,
	EvalEventErrorEncounteredSchema,
	EvalEventVcsCommitSchema,
	EvalEventRepoSnapshotSchema,
	EvalEventRepoChurnSnapshotSchema,
]);

export type EvaluationEvent = z.infer<typeof EvaluationEventSchema>;
export type EvalEventSource = z.infer<typeof EvalEventSourceSchema>;
export type EvalEventProvenance = z.infer<typeof EvalEventProvenanceSchema>;
