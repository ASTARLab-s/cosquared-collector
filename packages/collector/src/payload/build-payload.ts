import {
	type AnalysisPayload,
	AnalysisPayloadSchema,
	SCHEMA_VERSION,
	type SessionEvent,
} from "@cosquared/schema";
import { scoreProfile } from "../scoring/score-profile";
import type { SessionView } from "../scoring/sessions";
import { segmentSessions } from "../scoring/sessions";
import type {
	BuilderProfile,
	Confidence,
	EvidenceStatistic,
	ScoreResult,
	SignalId,
} from "../scoring/types";

/**
 * Builds the {@link AnalysisPayload} — the exact, name/path-free shape the CLI
 * uploads — from a normalized v1 `SessionEvent[]`. This is the bridge between
 * the public scoring engine and the public upload contract; it lives in the
 * collector (open) because the upload shape must be auditable. No
 * coaching/recommendation logic belongs here (PRD §6 open/closed boundary).
 *
 * PURE AND DETERMINISTIC (the inspect == upload guarantee): like the scoring
 * engine, this reads no clock — every window ("last 30 days", "last 14 days")
 * is measured against `referenceTime` (the stream's max event timestamp),
 * never `Date.now()`. Same events in → byte-identical payload out, forever.
 * Every division is guarded → `null` (honest "no data", never a fake 0).
 *
 * PRIVACY: built only from v1 events, which carry no names/paths/free text, so
 * the payload cannot either. The result is re-validated against the strict
 * schema before returning (mirroring `git-collector.ts`'s runtime proof) — a
 * field that should not exist fails loudly here, not silently on the wire.
 */
export function buildAnalysisPayload(
	events: SessionEvent[],
	meta: { cliVersion: string; platform: string; repoIdHash: string },
): AnalysisPayload {
	const { sessions, repoEvents, referenceTime } = segmentSessions(events);
	const profile = scoreProfile(events);

	const payload: AnalysisPayload = {
		schema_version: SCHEMA_VERSION,
		client: { cli_version: meta.cliVersion, platform: meta.platform },
		repo: buildRepo(repoEvents, referenceTime, meta.repoIdHash),
		sessions: sessions.map(buildSession),
		local_scores: {
			ai_collaboration: profile.aiCollaboration.value,
			ai_collaboration_subsignals: {
				task_framing: subsignal(profile.aiCollaboration, "task_framing"),
				tool_workflow_judgment: subsignal(
					profile.aiCollaboration,
					"tool_workflow_judgment",
				),
				verification_calibration: subsignal(
					profile.aiCollaboration,
					"verification_calibration",
				),
				cognitive_engagement: subsignal(
					profile.aiCollaboration,
					"cognitive_engagement",
				),
			},
			testing: profile.testingDiscipline.value,
			shipping: profile.shippingMomentum.value,
		},
		profile: buildProfile(profile),
	};

	// Runtime enforcement of the contract: the built payload MUST satisfy the
	// strict schema before it can be serialized/uploaded.
	return AnalysisPayloadSchema.parse(payload);
}

/** The confidence of one AI Collaboration sub-signal, by id (`none` if absent). */
function subsignalConfidence(
	aiCollaboration: ScoreResult,
	id: SignalId,
): Confidence {
	const component = aiCollaboration.components.find(
		(entry) => entry.signal.id === id,
	);
	return component?.signal.confidence ?? "none";
}

/**
 * Coarsen an evidence statistic to the wire shape: copy the structured
 * counts and map each ref to DATE granularity — `session_date` is the
 * citation's date only (`timestamp.slice(0, 10)`), and `sessionId` is
 * dropped entirely (PRD §9 minimization). Deterministic: the date derives
 * from the event's timestamp string, never the wall clock.
 */
function wireEvidence(
	statistics: EvidenceStatistic[],
): AnalysisPayload["profile"]["evidence"]["task_framing"] {
	return statistics.map((statistic) => ({
		kind: statistic.kind,
		numerator: statistic.numerator,
		denominator: statistic.denominator,
		refs: statistic.refs.map((ref) => ({
			source: ref.source,
			session_date: ref.timestamp.slice(0, 10),
		})),
	}));
}

/**
 * Maps the in-memory {@link BuilderProfile} onto the wire `profile` contract:
 * builder type, recommended focus, ranked strengths/weaknesses, per-score and
 * per-subsignal confidence, and per-leaf-signal evidence (coarsened to date
 * granularity). All values are outputs of the PUBLIC rule-based engine — no
 * phrasing or recommendation prose is introduced here (PRD §6 open/closed).
 * Nulls pass straight through (no fabricated classification on thin data).
 */
function buildProfile(profile: BuilderProfile): AnalysisPayload["profile"] {
	const { aiCollaboration } = profile;

	// One statistics list per leaf signal, mirroring terminal-report's
	// evidenceBySignal: the four AI sub-signals carry their own id; the two
	// top-level scores collect across their components under a single id.
	const aiEvidence = new Map<SignalId, EvidenceStatistic[]>();
	for (const { signal } of aiCollaboration.components) {
		aiEvidence.set(signal.id, [
			...(aiEvidence.get(signal.id) ?? []),
			...signal.evidence,
		]);
	}
	const collect = (result: ScoreResult): EvidenceStatistic[] =>
		result.components.flatMap(({ signal }) => signal.evidence);

	return {
		builder_type: profile.builderType,
		recommended_focus: profile.recommendedFocus,
		strengths: profile.strengths,
		weaknesses: profile.weaknesses,
		confidence: {
			ai_collaboration: aiCollaboration.confidence,
			testing: profile.testingDiscipline.confidence,
			shipping: profile.shippingMomentum.confidence,
			subsignals: {
				task_framing: subsignalConfidence(aiCollaboration, "task_framing"),
				tool_workflow_judgment: subsignalConfidence(
					aiCollaboration,
					"tool_workflow_judgment",
				),
				verification_calibration: subsignalConfidence(
					aiCollaboration,
					"verification_calibration",
				),
				cognitive_engagement: subsignalConfidence(
					aiCollaboration,
					"cognitive_engagement",
				),
			},
		},
		evidence: {
			task_framing: wireEvidence(aiEvidence.get("task_framing") ?? []),
			tool_workflow_judgment: wireEvidence(
				aiEvidence.get("tool_workflow_judgment") ?? [],
			),
			verification_calibration: wireEvidence(
				aiEvidence.get("verification_calibration") ?? [],
			),
			cognitive_engagement: wireEvidence(
				aiEvidence.get("cognitive_engagement") ?? [],
			),
			testing_discipline: wireEvidence(collect(profile.testingDiscipline)),
			shipping_momentum: wireEvidence(collect(profile.shippingMomentum)),
		},
	};
}

const DAY_MILLIS = 86_400_000;
const COMMIT_WINDOW_DAYS = 30;

/** Latest event of a given type in the timestamp-sorted repo-scope stream. */
function latestOfType<T extends SessionEvent["type"]>(
	repoEvents: SessionEvent[],
	type: T,
): Extract<SessionEvent, { type: T }> | null {
	for (let index = repoEvents.length - 1; index >= 0; index -= 1) {
		const event = repoEvents[index];
		if (event.type === type) {
			return event as Extract<SessionEvent, { type: T }>;
		}
	}
	return null;
}

/**
 * Repo facts from the latest snapshots plus the commit stream. Absent git
 * data degrades to honest defaults (no tests, 0 commits, null churn), never a
 * throw. `context_artifact_count` sums agent-context and authored-automation
 * files (the TWJ context-engineering component); docs are counted separately.
 */
function buildRepo(
	repoEvents: SessionEvent[],
	referenceTime: string | null,
	repoIdHash: string,
): AnalysisPayload["repo"] {
	const snapshot = latestOfType(repoEvents, "repo_snapshot");
	const churn = latestOfType(repoEvents, "churn_snapshot");

	const testFileRatio =
		snapshot !== null && snapshot.trackedFileCount > 0
			? snapshot.testFileCount / snapshot.trackedFileCount
			: 0;

	let commitCount30d = 0;
	if (referenceTime !== null) {
		const referenceMillis = Date.parse(referenceTime);
		const windowStartMillis = referenceMillis - COMMIT_WINDOW_DAYS * DAY_MILLIS;
		for (const event of repoEvents) {
			if (event.type !== "commit") {
				continue;
			}
			const millis = Date.parse(event.timestamp);
			if (millis > windowStartMillis && millis <= referenceMillis) {
				commitCount30d += 1;
			}
		}
	}

	return {
		id_hash: repoIdHash,
		has_tests: snapshot !== null && snapshot.testFileCount > 0,
		test_file_ratio: testFileRatio,
		commit_count_30d: commitCount30d,
		churn_ratio_14d:
			churn !== null && churn.linesAdded > 0
				? churn.linesChurned / churn.linesAdded
				: null,
		context_artifact_count:
			snapshot === null
				? 0
				: snapshot.contextFileCount + snapshot.automationFileCount,
		doc_file_count: snapshot?.docFileCount ?? 0,
	};
}

/**
 * Per-session structural features. `plan_artifact_present` mirrors the Task
 * Framing rule (an explicit plan was created OR a prompt referenced one OR a
 * `plan`-category command ran). Rates guard division by zero → null.
 */
function buildSession(
	session: SessionView,
): AnalysisPayload["sessions"][number] {
	let promptCount = 0;
	let questionPromptCount = 0;
	let testsRunCount = 0;
	let errorsEncountered = 0;
	let explanationRequestCount = 0;
	let acceptCount = 0;
	let validatedAcceptCount = 0;
	let planArtifactPresent = false;
	let durationMinutes: number | null = null;

	for (const event of session.events) {
		switch (event.type) {
			case "user_prompt":
				promptCount += 1;
				if (event.isQuestion) {
					questionPromptCount += 1;
				}
				if (event.referencesPlanArtifact) {
					planArtifactPresent = true;
				}
				break;
			case "test_run":
				testsRunCount += 1;
				break;
			case "error_encountered":
				errorsEncountered += 1;
				break;
			case "explanation_request":
				explanationRequestCount += 1;
				break;
			case "change_accepted":
				acceptCount += 1;
				if (event.followedByValidation === true) {
					validatedAcceptCount += 1;
				}
				break;
			case "plan_artifact_created":
				planArtifactPresent = true;
				break;
			case "command_invoked":
				if (event.category === "plan") {
					planArtifactPresent = true;
				}
				break;
			case "session_end":
				durationMinutes = event.durationMinutes;
				break;
		}
	}

	return {
		// Sessions are single-tool today; the source of the first event labels it.
		source: session.events[0].source,
		duration_minutes: durationMinutes,
		prompt_count: promptCount,
		tests_run_count: testsRunCount,
		errors_encountered: errorsEncountered,
		explanation_request_count: explanationRequestCount,
		plan_artifact_present: planArtifactPresent,
		validation_after_accept_rate:
			acceptCount === 0 ? null : validatedAcceptCount / acceptCount,
		question_prompt_rate:
			promptCount === 0 ? null : questionPromptCount / promptCount,
	};
}

/** The unrounded value of one AI Collaboration sub-signal, by id. */
function subsignal(aiCollaboration: ScoreResult, id: SignalId): number | null {
	const component = aiCollaboration.components.find(
		(entry) => entry.signal.id === id,
	);
	return component?.signal.value ?? null;
}
