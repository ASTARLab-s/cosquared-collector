import { describe, expect, test } from "vitest";
import {
	type AnalysisPayload,
	AnalysisPayloadSchema,
	serializeAnalysisPayload,
} from "./analysis-payload";

/**
 * The upload contract's tests double as documentation of the wire shape and
 * its two guarantees: strict validation (no smuggled fields) and a canonical,
 * byte-stable serialization (the inspect == upload anchor).
 */

const validPayload: AnalysisPayload = {
	schema_version: "1.4.0",
	client: { cli_version: "0.1.0", platform: "darwin" },
	repo: {
		id_hash: "sha256:deadbeef",
		has_tests: true,
		test_file_ratio: 0.2,
		commit_count_30d: 12,
		churn_ratio_14d: 0.1,
		context_artifact_count: 2,
		doc_file_count: 5,
	},
	sessions: [
		{
			source: "claude-code",
			duration_minutes: 10,
			prompt_count: 3,
			tests_run_count: 1,
			errors_encountered: 0,
			explanation_request_count: 1,
			plan_artifact_present: true,
			validation_after_accept_rate: 1,
			question_prompt_rate: 0.5,
		},
	],
	local_scores: {
		ai_collaboration: 72,
		ai_collaboration_subsignals: {
			task_framing: 40,
			tool_workflow_judgment: 65.5,
			verification_calibration: 88,
			cognitive_engagement: 50,
		},
		testing: 61,
		shipping: null,
	},
	profile: {
		builder_type: "careful_validator",
		recommended_focus: "task_framing",
		strengths: ["verification_calibration", "tool_workflow_judgment"],
		weaknesses: ["task_framing", "cognitive_engagement"],
		confidence: {
			ai_collaboration: "low",
			testing: "normal",
			shipping: "none",
			subsignals: {
				task_framing: "low",
				tool_workflow_judgment: "normal",
				verification_calibration: "normal",
				cognitive_engagement: "low",
			},
		},
		evidence: {
			task_framing: [
				{
					kind: "framed_sessions",
					numerator: 1,
					denominator: 3,
					refs: [{ source: "claude-code", session_date: "2026-06-17" }],
				},
			],
			tool_workflow_judgment: [
				{
					kind: "workflow_leverage_sessions",
					numerator: 2,
					denominator: 3,
					refs: [],
				},
			],
			verification_calibration: [
				{
					kind: "validation_after_accept",
					numerator: 3,
					denominator: 3,
					refs: [{ source: "claude-code", session_date: "2026-06-17" }],
				},
			],
			cognitive_engagement: [
				{ kind: "engagement_depth", numerator: 1, denominator: 4, refs: [] },
			],
			testing_discipline: [
				{
					kind: "repo_test_file_ratio",
					numerator: 2,
					denominator: 10,
					refs: [{ source: "git", session_date: "2026-06-17" }],
				},
			],
			shipping_momentum: [],
		},
	},
};

describe("AnalysisPayloadSchema", () => {
	test("accepts a fully-populated valid payload", () => {
		const result = AnalysisPayloadSchema.safeParse(validPayload);
		expect(result.success, JSON.stringify(result.error, null, 2)).toBe(true);
	});

	test("accepts null scores and null rates (honest 'no data')", () => {
		const empty: AnalysisPayload = {
			...validPayload,
			repo: { ...validPayload.repo, churn_ratio_14d: null },
			sessions: [
				{
					...validPayload.sessions[0],
					validation_after_accept_rate: null,
					question_prompt_rate: null,
				},
			],
			local_scores: {
				ai_collaboration: null,
				ai_collaboration_subsignals: {
					task_framing: null,
					tool_workflow_judgment: null,
					verification_calibration: null,
					cognitive_engagement: null,
				},
				testing: null,
				shipping: null,
			},
		};
		expect(AnalysisPayloadSchema.safeParse(empty).success).toBe(true);
	});

	test("accepts an empty sessions array", () => {
		expect(
			AnalysisPayloadSchema.safeParse({ ...validPayload, sessions: [] })
				.success,
		).toBe(true);
	});

	// The privacy guard: strict objects REJECT unexpected keys rather than
	// stripping them, so a builder bug that smuggles a name/path fails loudly.
	test("rejects an unknown top-level key", () => {
		expect(
			AnalysisPayloadSchema.safeParse({
				...validPayload,
				raw_transcript: "please refactor my secret module",
			}).success,
		).toBe(false);
	});

	test("rejects a name/path smuggled into repo", () => {
		expect(
			AnalysisPayloadSchema.safeParse({
				...validPayload,
				repo: { ...validPayload.repo, repo_path: "/Users/me/secret-project" },
			}).success,
		).toBe(false);
	});

	test("rejects a smuggled field inside a session", () => {
		expect(
			AnalysisPayloadSchema.safeParse({
				...validPayload,
				sessions: [
					{ ...validPayload.sessions[0], prompt_text: "the raw prompt" },
				],
			}).success,
		).toBe(false);
	});

	test("rejects an unknown session source", () => {
		expect(
			AnalysisPayloadSchema.safeParse({
				...validPayload,
				sessions: [{ ...validPayload.sessions[0], source: "windsurf" }],
			}).success,
		).toBe(false);
	});

	test("rejects a fractional commit_count_30d", () => {
		expect(
			AnalysisPayloadSchema.safeParse({
				...validPayload,
				repo: { ...validPayload.repo, commit_count_30d: 1.5 },
			}).success,
		).toBe(false);
	});

	// The same privacy guard applies to the new profile section: a smuggled
	// prose field (e.g. an LLM-written justification) must fail loudly.
	test("rejects an unknown key smuggled into profile", () => {
		expect(
			AnalysisPayloadSchema.safeParse({
				...validPayload,
				profile: {
					...validPayload.profile,
					coaching_prose: "You should frame your tasks better.",
				},
			}).success,
		).toBe(false);
	});

	test("rejects a wall-clock time smuggled into an evidence ref", () => {
		expect(
			AnalysisPayloadSchema.safeParse({
				...validPayload,
				profile: {
					...validPayload.profile,
					evidence: {
						...validPayload.profile.evidence,
						task_framing: [
							{
								kind: "framed_sessions",
								numerator: 1,
								denominator: 3,
								refs: [
									{
										source: "claude-code",
										session_date: "2026-06-17",
										session_id: "s1",
									},
								],
							},
						],
					},
				},
			}).success,
		).toBe(false);
	});

	test("rejects an unknown builder_type", () => {
		expect(
			AnalysisPayloadSchema.safeParse({
				...validPayload,
				profile: { ...validPayload.profile, builder_type: "ninja_coder" },
			}).success,
		).toBe(false);
	});

	test("accepts a null builder_type / recommended_focus (honest cold start)", () => {
		expect(
			AnalysisPayloadSchema.safeParse({
				...validPayload,
				profile: {
					...validPayload.profile,
					builder_type: null,
					recommended_focus: null,
				},
			}).success,
		).toBe(true);
	});
});

describe("serializeAnalysisPayload", () => {
	test("is compact JSON (no whitespace between tokens)", () => {
		const wire = serializeAnalysisPayload(validPayload);
		expect(wire).not.toContain("\n");
		expect(wire).not.toContain(": ");
		expect(JSON.parse(wire)).toEqual(validPayload);
	});

	test("is byte-stable across repeated calls (determinism)", () => {
		expect(serializeAnalysisPayload(validPayload)).toBe(
			serializeAnalysisPayload(validPayload),
		);
	});

	test("is independent of the input object's key insertion order", () => {
		// Re-assemble the same payload with keys in a deliberately different
		// order; the canonical serialization must produce identical bytes.
		const shuffled: AnalysisPayload = {
			profile: validPayload.profile,
			local_scores: validPayload.local_scores,
			sessions: validPayload.sessions,
			repo: {
				doc_file_count: validPayload.repo.doc_file_count,
				context_artifact_count: validPayload.repo.context_artifact_count,
				churn_ratio_14d: validPayload.repo.churn_ratio_14d,
				commit_count_30d: validPayload.repo.commit_count_30d,
				test_file_ratio: validPayload.repo.test_file_ratio,
				has_tests: validPayload.repo.has_tests,
				id_hash: validPayload.repo.id_hash,
			},
			client: {
				platform: validPayload.client.platform,
				cli_version: validPayload.client.cli_version,
			},
			schema_version: validPayload.schema_version,
		};
		expect(serializeAnalysisPayload(shuffled)).toBe(
			serializeAnalysisPayload(validPayload),
		);
	});

	test("places schema_version first in the canonical form", () => {
		expect(
			serializeAnalysisPayload(validPayload).startsWith('{"schema_version":'),
		).toBe(true);
	});

	test("emits profile last, after local_scores, in fixed key order", () => {
		const wire = serializeAnalysisPayload(validPayload);
		// profile sits after local_scores...
		expect(wire.indexOf('"profile":')).toBeGreaterThan(
			wire.indexOf('"local_scores":'),
		);
		// ...and its keys follow the declared order regardless of input order.
		const profileKeyOrder = [
			'"builder_type":',
			'"recommended_focus":',
			'"strengths":',
			'"weaknesses":',
			'"confidence":',
			'"evidence":',
		].map((key) => wire.indexOf(key));
		const sorted = [...profileKeyOrder].sort((a, b) => a - b);
		expect(profileKeyOrder).toEqual(sorted);
	});

	test("round-trips the profile section deep-equal through serialize", () => {
		const wire = serializeAnalysisPayload(validPayload);
		expect(JSON.parse(wire).profile).toEqual(validPayload.profile);
	});

	test("serializes profile byte-identically regardless of input key order", () => {
		// Re-assemble the profile (and a nested evidence statistic) with keys in a
		// deliberately different order; canonical bytes must be identical.
		const reordered: AnalysisPayload = {
			...validPayload,
			profile: {
				evidence: {
					shipping_momentum: validPayload.profile.evidence.shipping_momentum,
					testing_discipline:
						validPayload.profile.evidence.testing_discipline.map((stat) => ({
							refs: stat.refs.map((ref) => ({
								session_date: ref.session_date,
								source: ref.source,
							})),
							denominator: stat.denominator,
							numerator: stat.numerator,
							kind: stat.kind,
						})),
					cognitive_engagement:
						validPayload.profile.evidence.cognitive_engagement,
					verification_calibration:
						validPayload.profile.evidence.verification_calibration,
					tool_workflow_judgment:
						validPayload.profile.evidence.tool_workflow_judgment,
					task_framing: validPayload.profile.evidence.task_framing,
				},
				confidence: validPayload.profile.confidence,
				weaknesses: validPayload.profile.weaknesses,
				strengths: validPayload.profile.strengths,
				recommended_focus: validPayload.profile.recommended_focus,
				builder_type: validPayload.profile.builder_type,
			},
		};
		expect(serializeAnalysisPayload(reordered)).toBe(
			serializeAnalysisPayload(validPayload),
		);
	});
});
