import type {
	EvalEventProvenance,
	EvalEventSource,
	EvaluationEvent,
} from "./event";
import type { ProfileKey } from "./request";

export type EvalConfidence = "none" | "low" | "normal";
export type EvalEvidenceKind =
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

export type EvalAbstentionReason =
	| "no_applicable_events"
	| "missing_source"
	| "window_too_short";

export interface EvalDimensionResult {
	key: string;
	score: number | null;
	applicability: "applicable" | "abstained";
	abstention_reason?: EvalAbstentionReason;
	confidence: EvalConfidence;
	sample_size: Record<string, number>;
	evidence: Array<{
		kind: EvalEvidenceKind;
		numerator: number;
		denominator: number;
		event_refs: string[];
	}>;
	limitations: string[];
}

export interface EvalProfileResult {
	profile: ProfileKey;
	methodology_version: string;
	dimensions: EvalDimensionResult[];
	recommended_focus_key?: string;
}

export interface EvalSourceCoverage {
	sources_seen: EvalEventSource[];
	event_types_seen: EvaluationEvent["type"][];
	provenance_mix: Partial<Record<EvalEventProvenance, number>>;
}

export interface EvalRunRecord {
	input_digest: string;
	event_schema_version: string;
	evaluator_version: string;
	events: { accepted: number; duplicates: number };
	source_coverage: EvalSourceCoverage;
	results: EvalProfileResult[];
	limitations: string[];
}

export interface EvalRunResponse extends EvalRunRecord {
	id: string;
	status: "completed";
}

function orderEvent(event: EvaluationEvent): Record<string, unknown> {
	const base = {
		id: event.id,
		type: event.type,
		occurred_at: event.occurred_at,
		subject: event.subject,
		session_id: event.session_id,
		source: event.source,
		provenance: event.provenance,
	};
	switch (event.type) {
		case "session.started":
			return { ...base, tool_version: event.tool_version };
		case "session.completed":
			return { ...base, duration_minutes: event.duration_minutes };
		case "ai.prompted":
			return {
				...base,
				word_count: event.word_count,
				is_question: event.is_question,
				references_plan_artifact: event.references_plan_artifact,
			};
		case "ai.change_accepted":
		case "ai.change_rejected":
			return {
				...base,
				followed_by_validation: event.followed_by_validation,
			};
		case "ai.explanation_requested":
			return base;
		case "ai.tool_invoked":
		case "ai.command_invoked":
			return { ...base, category: event.category };
		case "plan.artifact_created":
			return { ...base, artifact_kind: event.artifact_kind };
		case "validation.test_run":
			return { ...base, passed: event.passed, framework: event.framework };
		case "error.encountered":
			return { ...base, resolved: event.resolved };
		case "vcs.commit":
			return {
				...base,
				files_changed: event.files_changed,
				insertions: event.insertions,
				deletions: event.deletions,
				touched_test_files: event.touched_test_files,
			};
		case "repo.snapshot":
			return {
				...base,
				tracked_file_count: event.tracked_file_count,
				test_file_count: event.test_file_count,
				doc_file_count: event.doc_file_count,
				context_file_count: event.context_file_count,
				automation_file_count: event.automation_file_count,
			};
		case "repo.churn_snapshot":
			return {
				...base,
				window_days: event.window_days,
				lines_added: event.lines_added,
				lines_churned: event.lines_churned,
			};
	}
}

/** Canonical digest input: sorted by timestamp/id and rebuilt in fixed key order. */
export function serializeEventsCanonical(events: EvaluationEvent[]): string {
	const sorted = [...events].sort(
		(a, b) =>
			a.occurred_at.localeCompare(b.occurred_at) || a.id.localeCompare(b.id),
	);
	return JSON.stringify(sorted.map(orderEvent));
}
