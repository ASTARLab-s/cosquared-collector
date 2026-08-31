import { describe, expect, test } from "vitest";
import { SessionEventSchema } from "./session-event";

/**
 * Named fixtures, table-driven — the pattern all future scoring tests
 * follow (CLAUDE.md test standards). Fixtures double as documentation of
 * what each event type looks like on the wire.
 */

const TIMESTAMP = "2026-06-11T09:30:00Z";

const validFixtures: Record<string, unknown> = {
	sessionStartFromClaudeCode: {
		sessionId: "sess-001",
		source: "claude-code",
		timestamp: TIMESTAMP,
		type: "session_start",
		toolVersion: "2.1.0",
	},
	sessionEndWithUnknownDuration: {
		sessionId: "sess-001",
		source: "claude-code",
		timestamp: TIMESTAMP,
		type: "session_end",
		durationMinutes: null,
	},
	wellFramedPromptReferencingPlan: {
		sessionId: "sess-001",
		source: "claude-code",
		timestamp: TIMESTAMP,
		type: "user_prompt",
		wordCount: 142,
		isQuestion: false,
		referencesPlanArtifact: true,
		describesOrderedSteps: false,
	},
	fileEditToolCall: {
		sessionId: "sess-001",
		source: "cursor",
		timestamp: TIMESTAMP,
		type: "tool_call",
		toolName: "edit_file",
		category: "file_edit",
	},
	passingVitestRun: {
		sessionId: "sess-001",
		source: "claude-code",
		timestamp: TIMESTAMP,
		type: "test_run",
		passed: true,
		framework: "vitest",
	},
	unresolvedError: {
		sessionId: "sess-002",
		source: "codex-cli",
		timestamp: TIMESTAMP,
		type: "error_encountered",
		resolved: false,
	},
	acceptedChangeWithoutValidation: {
		sessionId: "sess-001",
		source: "cursor",
		timestamp: TIMESTAMP,
		type: "change_accepted",
		followedByValidation: false,
	},
	rejectedChangeAfterInspection: {
		sessionId: "sess-001",
		source: "cursor",
		timestamp: TIMESTAMP,
		type: "change_rejected",
		followedByValidation: true,
	},
	explanationRequest: {
		sessionId: "sess-001",
		source: "claude-code",
		timestamp: TIMESTAMP,
		type: "explanation_request",
	},
	planDocCreated: {
		sessionId: "sess-001",
		source: "claude-code",
		timestamp: TIMESTAMP,
		type: "plan_artifact_created",
		artifactKind: "plan_doc",
	},
	repoScopeCommitWithNullSessionId: {
		sessionId: null,
		source: "git",
		timestamp: TIMESTAMP,
		type: "commit",
		filesChanged: 3,
		insertions: 120,
		deletions: 45,
		touchedTestFiles: true,
	},
	repoSnapshotAtHead: {
		sessionId: null,
		source: "git",
		timestamp: TIMESTAMP,
		type: "repo_snapshot",
		trackedFileCount: 412,
		testFileCount: 87,
		docFileCount: 9,
		contextFileCount: 1,
		automationFileCount: 3,
	},
	churnSnapshotAtHead: {
		sessionId: null,
		source: "git",
		timestamp: TIMESTAMP,
		type: "churn_snapshot",
		windowDays: 14,
		linesAdded: 480,
		linesChurned: 96,
	},
	payloadFreeCommandInvocation: {
		sessionId: "sess-001",
		source: "claude-code",
		timestamp: TIMESTAMP,
		type: "command_invoked",
		category: "plan",
	},
	contextCommandInvocation: {
		sessionId: "sess-001",
		source: "claude-code",
		timestamp: TIMESTAMP,
		type: "command_invoked",
		category: "context",
	},
	delegateCategoryToolCall: {
		sessionId: "sess-001",
		source: "claude-code",
		timestamp: TIMESTAMP,
		type: "tool_call",
		toolName: "Skill",
		category: "delegate",
	},
};

describe("SessionEventSchema v1", () => {
	test.each(
		Object.entries(validFixtures),
	)("parses valid fixture: %s", (_name, fixture) => {
		const result = SessionEventSchema.safeParse(fixture);
		expect(result.success, JSON.stringify(result.error, null, 2)).toBe(true);
	});

	test("rejects an unknown event type", () => {
		const result = SessionEventSchema.safeParse({
			sessionId: "sess-001",
			source: "claude-code",
			timestamp: TIMESTAMP,
			type: "keystroke_logged",
		});
		expect(result.success).toBe(false);
	});

	// The privacy guard: strict schemas REJECT unexpected fields rather than
	// stripping them, so a collector that smuggles raw text fails loudly
	// (CLAUDE.md invariant #1 — no free-text fields in the event stream).
	const rawTextSmugglingAttempts: Record<string, unknown> = {
		promptWithRawText: {
			...(validFixtures.wellFramedPromptReferencingPlan as object),
			text: "please refactor my auth module containing SECRET_KEY=...",
		},
		toolCallWithFileContent: {
			...(validFixtures.fileEditToolCall as object),
			content: "function leak() { return process.env.DB_PASSWORD; }",
		},
		commitWithMessage: {
			...(validFixtures.repoScopeCommitWithNullSessionId as object),
			message: "fix: hardcode prod credentials",
		},
		snapshotWithFilePaths: {
			...(validFixtures.repoSnapshotAtHead as object),
			filePaths: ["src/auth/secret-keys.ts"],
		},
		commandInvocationWithName: {
			...(validFixtures.payloadFreeCommandInvocation as object),
			commandName: "/deploy-prod-with-secrets",
		},
		churnSnapshotWithPaths: {
			...(validFixtures.churnSnapshotAtHead as object),
			churnedPaths: ["src/auth/secret-keys.ts"],
		},
	};

	test.each(
		Object.entries(rawTextSmugglingAttempts),
	)("rejects raw-text smuggling: %s", (_name, fixture) => {
		expect(SessionEventSchema.safeParse(fixture).success).toBe(false);
	});

	test("rejects a non-ISO timestamp", () => {
		const result = SessionEventSchema.safeParse({
			...(validFixtures.sessionStartFromClaudeCode as object),
			timestamp: "June 11th 2026, 9:30am",
		});
		expect(result.success).toBe(false);
	});

	test("rejects negative churn counts", () => {
		const result = SessionEventSchema.safeParse({
			...(validFixtures.churnSnapshotAtHead as object),
			linesChurned: -1,
		});
		expect(result.success).toBe(false);
	});

	test("rejects an unknown command_invoked category", () => {
		const result = SessionEventSchema.safeParse({
			...(validFixtures.payloadFreeCommandInvocation as object),
			category: "verification",
		});
		expect(result.success).toBe(false);
	});

	test("rejects a command_invoked missing its category", () => {
		const { category: _dropped, ...withoutCategory } =
			validFixtures.payloadFreeCommandInvocation as Record<string, unknown>;
		expect(SessionEventSchema.safeParse(withoutCategory).success).toBe(false);
	});

	// Strict objects make the v1.2.0 snapshot fields REQUIRED: a collector
	// still emitting the 1.1.0 shape fails loudly instead of silently
	// producing snapshots the scoring engine would misread.
	test("rejects a repo_snapshot missing the context/automation counts", () => {
		const {
			contextFileCount: _droppedContext,
			automationFileCount: _droppedAutomation,
			...legacySnapshot
		} = validFixtures.repoSnapshotAtHead as Record<string, unknown>;
		expect(SessionEventSchema.safeParse(legacySnapshot).success).toBe(false);
	});

	test("accepts sessionId null only as an explicit value, not a missing field", () => {
		const { sessionId: _dropped, ...withoutSessionId } =
			validFixtures.repoScopeCommitWithNullSessionId as Record<string, unknown>;
		expect(SessionEventSchema.safeParse(withoutSessionId).success).toBe(false);
	});
});
