import { z } from "zod";

/**
 * SessionEvent schema v1 — the normalized event stream every collector
 * (Claude Code, Cursor, Codex CLI, git) converts its raw data into before
 * any scoring runs (CLAUDE.md "Event normalization" pattern).
 *
 * PRIVACY BY CONSTRUCTION (CLAUDE.md invariant #1): v1 has NO free-text
 * fields. Collectors compute structural features (counts, booleans,
 * categories) at parse time; raw prompt/code text never enters the
 * normalized stream, so it can never reach an upload buffer. Every event
 * object is strict — unexpected fields are REJECTED, not silently stripped,
 * so a collector bug that smuggles raw text fails loudly at validation.
 */

/** Tools a collector can read. Each Collector implementation declares one. */
export const SessionSourceSchema = z.enum([
	"claude-code",
	"cursor",
	"codex-cli",
	"git",
	/**
	 * Events observed by an external platform's own infrastructure (CI sandbox
	 * runs, server-observed pushes) submitted via the Evaluation API — never
	 * emitted by the CLI collectors.
	 */
	"external",
]);
export type SessionSource = z.infer<typeof SessionSourceSchema>;

/**
 * Fields shared by every event.
 * `sessionId` is null for repo-scope events (e.g. `commit` from the git
 * collector) that don't belong to a single AI session.
 */
const envelope = {
	sessionId: z.string().nullable(),
	source: SessionSourceSchema,
	timestamp: z.iso.datetime(),
};

/**
 * Marks the beginning of an AI coding session. Used for session
 * segmentation only; feeds no score directly (PRD §7.3).
 */
export const SessionStartEventSchema = z.strictObject({
	...envelope,
	type: z.literal("session_start"),
	toolVersion: z.string().nullable(),
});

/**
 * Marks the end of an AI coding session. `durationMinutes` feeds Shipping
 * Momentum's session-completion arcs (PRD §7.3): whether sessions tend to
 * reach a shipped/validated end state.
 */
export const SessionEndEventSchema = z.strictObject({
	...envelope,
	type: z.literal("session_end"),
	durationMinutes: z.number().nullable(),
});

/**
 * A prompt the user sent to the AI tool, reduced to structural features at
 * parse time — the prompt text itself is never stored. `wordCount` and
 * `referencesPlanArtifact` feed the Task Framing sub-signal; `isQuestion`
 * feeds Cognitive Engagement (PRD §7.3, AI Collaboration sub-signals).
 */
export const UserPromptEventSchema = z.strictObject({
	...envelope,
	type: z.literal("user_prompt"),
	wordCount: z.number().int().nonnegative(),
	isQuestion: z.boolean(),
	referencesPlanArtifact: z.boolean(),
});

/**
 * A tool invocation by the AI agent (file edit, command run, search…).
 * The category distribution across a session feeds the Tool & Workflow
 * Judgment sub-signal (PRD §7.3): e.g. edit-heavy sessions with no
 * execute/search activity suggest unverified generation. `delegate` marks
 * skill/subagent delegation (Skill, Task, Agent) — the agent-vs-manual
 * task fit signal (PRD §7.3) feeding workflow leverage.
 */
export const ToolCallEventSchema = z.strictObject({
	...envelope,
	type: z.literal("tool_call"),
	toolName: z.string(),
	category: z.enum([
		"file_edit",
		"file_read",
		"execute",
		"search",
		"delegate",
		"other",
	]),
});

/**
 * A test-suite execution observed in the session. Feeds Testing Discipline
 * directly and Verification & Calibration (PRD §7.3): test runs adjacent to
 * accepted changes are the strongest verification signal we have.
 */
export const TestRunEventSchema = z.strictObject({
	...envelope,
	type: z.literal("test_run"),
	passed: z.boolean().nullable(),
	framework: z.string().nullable(),
});

/**
 * An error surfaced during the session (failed command, runtime error…).
 * `resolved` marks whether a later event indicates recovery; resolution
 * arcs feed error-handling analysis (PRD §7.3).
 */
export const ErrorEncounteredEventSchema = z.strictObject({
	...envelope,
	type: z.literal("error_encountered"),
	resolved: z.boolean().nullable(),
});

/**
 * The user accepted an AI-proposed change. `followedByValidation` (a test
 * run, execution, or review pass occurring after the accept) feeds
 * Verification & Calibration. NOTE: raw accept counts are a deliberately
 * DEMOTED signal (PRD §7.3 demotion note) — high acceptance alone says
 * nothing about quality; only the validation that follows does.
 */
export const ChangeAcceptedEventSchema = z.strictObject({
	...envelope,
	type: z.literal("change_accepted"),
	followedByValidation: z.boolean().nullable(),
});

/**
 * The user rejected an AI-proposed change. Paired with `change_accepted`
 * for Verification & Calibration (PRD §7.3); rejection after inspection is
 * evidence of calibration, so it carries the same validation field.
 */
export const ChangeRejectedEventSchema = z.strictObject({
	...envelope,
	type: z.literal("change_rejected"),
	followedByValidation: z.boolean().nullable(),
});

/**
 * The user asked the AI to explain code, a decision, or an error rather
 * than to produce changes. Feeds Cognitive Engagement (PRD §7.3):
 * explanation-seeking distinguishes comprehension-oriented use from pure
 * generation.
 */
export const ExplanationRequestEventSchema = z.strictObject({
	...envelope,
	type: z.literal("explanation_request"),
});

/**
 * The user invoked a skill, slash command, or other authored automation.
 * Payload-free BY DESIGN: the custom skill/command NAME is a user-authored
 * identifier and is never stored. `category` is a structural classification
 * the collector derives at parse time from a published allowlist (the name
 * is read transiently to classify it, then dropped, exactly like
 * `user_prompt.referencesPlanArtifact` reads prompt text). `plan` =
 * working from / producing an explicit plan (feeds Task Framing, PRD §7.3);
 * `context` = context-engineering (feeds Tool & Workflow Judgment); `other`
 * = machinery and any unrecognized command. The invocation itself also
 * feeds TWJ's workflow-leverage component (PRD §7.3 agent-vs-manual fit).
 */
export const CommandInvokedEventSchema = z.strictObject({
	...envelope,
	type: z.literal("command_invoked"),
	category: z.enum(["plan", "context", "other"]),
});

/**
 * A planning artifact (plan doc, spec, TODO list) was created during the
 * session. Feeds Task Framing (PRD §7.3): working from explicit plans is
 * the core upstream signal of well-framed tasks.
 */
export const PlanArtifactCreatedEventSchema = z.strictObject({
	...envelope,
	type: z.literal("plan_artifact_created"),
	artifactKind: z.enum(["plan_doc", "spec", "todo"]),
});

/**
 * A git commit (repo-scope: `sessionId` is null when emitted by the git
 * collector). Size/shape stats feed Shipping Momentum; `touchedTestFiles`
 * feeds Testing Discipline (PRD §7.3). Only structural stats — never
 * messages, diffs, or file paths.
 */
export const CommitEventSchema = z.strictObject({
	...envelope,
	type: z.literal("commit"),
	filesChanged: z.number().int().nonnegative(),
	insertions: z.number().int().nonnegative(),
	deletions: z.number().int().nonnegative(),
	touchedTestFiles: z.boolean(),
});

/**
 * Repo-shape counts as of the repo's HEAD commit (repo-scope: `sessionId`
 * is null; timestamp is HEAD's committer date so output is deterministic).
 * `testFileCount`/`trackedFileCount` feed Testing Discipline's test-file
 * presence/ratio; `docFileCount` feeds context-quality signals (PRD §7.3,
 * §4 repo-shape signals). `contextFileCount` (agent-context files such as
 * CLAUDE.md / .cursorrules) and `automationFileCount` (authored automation
 * under `.claude/skills|commands|agents/`) feed Tool & Workflow Judgment's
 * context-engineering-artifacts component (PRD §7.3). Counts only — never
 * file names or paths.
 */
export const RepoSnapshotEventSchema = z.strictObject({
	...envelope,
	type: z.literal("repo_snapshot"),
	trackedFileCount: z.number().int().nonnegative(),
	testFileCount: z.number().int().nonnegative(),
	docFileCount: z.number().int().nonnegative(),
	contextFileCount: z.number().int().nonnegative(),
	automationFileCount: z.number().int().nonnegative(),
});

/**
 * Aggregate code-churn counts over a trailing window ending at HEAD
 * (repo-scope: `sessionId` is null; timestamp is HEAD's committer date, so
 * output is deterministic). `linesChurned` approximates lines deleted
 * within `windowDays` of being added (GitClear churn — PRD §7.3 Shipping
 * Momentum: AI-era churn roughly doubled; high commits + high churn ≠
 * shipping). Counts only — never paths, hashes, or messages.
 */
export const ChurnSnapshotEventSchema = z.strictObject({
	...envelope,
	type: z.literal("churn_snapshot"),
	windowDays: z.number().int().positive(),
	linesAdded: z.number().int().nonnegative(),
	linesChurned: z.number().int().nonnegative(),
});

/**
 * The discriminated union of all v1 event types. Collectors emit
 * `SessionEvent[]`; scoring consumes it. New integrations add a collector,
 * never a parallel schema.
 */
export const SessionEventSchema = z.discriminatedUnion("type", [
	SessionStartEventSchema,
	SessionEndEventSchema,
	UserPromptEventSchema,
	ToolCallEventSchema,
	TestRunEventSchema,
	ErrorEncounteredEventSchema,
	ChangeAcceptedEventSchema,
	ChangeRejectedEventSchema,
	ExplanationRequestEventSchema,
	CommandInvokedEventSchema,
	PlanArtifactCreatedEventSchema,
	CommitEventSchema,
	RepoSnapshotEventSchema,
	ChurnSnapshotEventSchema,
]);

export type SessionEvent = z.infer<typeof SessionEventSchema>;
