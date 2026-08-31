import type { SessionEvent } from "@cosquared/schema";

/**
 * Builders for hand-written `SessionEvent[]` scoring fixtures. Defaults
 * are the *neutral* case for every signal; tests override exactly the
 * fields their rule reads, so each fixture documents what the rule keys
 * on.
 */

type EventOfType<T extends SessionEvent["type"]> = Extract<
	SessionEvent,
	{ type: T }
>;

function envelope(sessionId: string | null, timestamp: string) {
	return {
		sessionId,
		source: (sessionId === null
			? "git"
			: "claude-code") as SessionEvent["source"],
		timestamp,
	};
}

export function sessionStart(
	sessionId: string,
	timestamp: string,
): SessionEvent {
	return {
		...envelope(sessionId, timestamp),
		type: "session_start",
		toolVersion: "2.1.170",
	};
}

export function sessionEnd(
	sessionId: string,
	timestamp: string,
	durationMinutes: number | null = null,
): SessionEvent {
	return {
		...envelope(sessionId, timestamp),
		type: "session_end",
		durationMinutes,
	};
}

export function prompt(
	sessionId: string,
	timestamp: string,
	overrides: Partial<EventOfType<"user_prompt">> = {},
): SessionEvent {
	return {
		...envelope(sessionId, timestamp),
		type: "user_prompt",
		wordCount: 8,
		isQuestion: false,
		referencesPlanArtifact: false,
		describesOrderedSteps: false,
		...overrides,
	};
}

export function toolCall(
	sessionId: string,
	timestamp: string,
	category: EventOfType<"tool_call">["category"],
	toolName = "FixtureTool",
): SessionEvent {
	return {
		...envelope(sessionId, timestamp),
		type: "tool_call",
		toolName,
		category,
	};
}

export function testRun(sessionId: string, timestamp: string): SessionEvent {
	return {
		...envelope(sessionId, timestamp),
		type: "test_run",
		passed: true,
		framework: "vitest",
	};
}

export function changeAccepted(
	sessionId: string,
	timestamp: string,
	followedByValidation: boolean | null,
): SessionEvent {
	return {
		...envelope(sessionId, timestamp),
		type: "change_accepted",
		followedByValidation,
	};
}

export function changeRejected(
	sessionId: string,
	timestamp: string,
	followedByValidation: boolean | null,
): SessionEvent {
	return {
		...envelope(sessionId, timestamp),
		type: "change_rejected",
		followedByValidation,
	};
}

export function explanationRequest(
	sessionId: string,
	timestamp: string,
): SessionEvent {
	return { ...envelope(sessionId, timestamp), type: "explanation_request" };
}

export function commandInvoked(
	sessionId: string,
	timestamp: string,
	category: EventOfType<"command_invoked">["category"] = "other",
): SessionEvent {
	return {
		...envelope(sessionId, timestamp),
		type: "command_invoked",
		category,
	};
}

export function planArtifact(
	sessionId: string,
	timestamp: string,
): SessionEvent {
	return {
		...envelope(sessionId, timestamp),
		type: "plan_artifact_created",
		artifactKind: "plan_doc",
	};
}

export function commit(
	timestamp: string,
	overrides: Partial<EventOfType<"commit">> = {},
): SessionEvent {
	return {
		...envelope(null, timestamp),
		type: "commit",
		filesChanged: 1,
		insertions: 10,
		deletions: 0,
		touchedTestFiles: false,
		...overrides,
	};
}

export function repoSnapshot(
	timestamp: string,
	overrides: Partial<EventOfType<"repo_snapshot">> = {},
): SessionEvent {
	return {
		...envelope(null, timestamp),
		type: "repo_snapshot",
		trackedFileCount: 100,
		testFileCount: 0,
		docFileCount: 0,
		contextFileCount: 0,
		automationFileCount: 0,
		...overrides,
	};
}

export function churnSnapshot(
	timestamp: string,
	overrides: Partial<EventOfType<"churn_snapshot">> = {},
): SessionEvent {
	return {
		...envelope(null, timestamp),
		type: "churn_snapshot",
		windowDays: 14,
		linesAdded: 100,
		linesChurned: 10,
		...overrides,
	};
}
