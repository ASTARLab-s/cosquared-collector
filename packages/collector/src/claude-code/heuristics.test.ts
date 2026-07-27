import { describe, expect, test } from "vitest";
import {
	categorizeToolName,
	classifyCommand,
	isCommandInvocation,
	isHumanPrompt,
	promptText,
} from "./heuristics";
import { UserLineSchema } from "./transcript-line";

/**
 * Table-driven fixtures, one table per published rule. These fixtures ARE
 * the public methodology documentation: each entry pins exactly what the
 * rule does and does not match. The tool-agnostic text rules now live in
 * `../heuristics/text-features.test.ts`; this file covers the
 * Claude-Code-line-shaped rules only.
 */

function userLine(content: unknown, extra: Record<string, unknown> = {}) {
	return UserLineSchema.parse({
		type: "user",
		sessionId: "00000000-0000-4000-8000-00000000000a",
		timestamp: "2026-06-10T10:00:00.000Z",
		message: { content },
		...extra,
	});
}

describe("isHumanPrompt", () => {
	const fixtures: Record<string, { line: unknown; expected: boolean }> = {
		typedPromptIsHuman: {
			line: userLine("refactor the parser"),
			expected: true,
		},
		slashCommandMachineryIsNotHuman: {
			line: userLine("<command-message>execute</command-message>"),
			expected: false,
		},
		localCommandOutputIsNotHuman: {
			line: userLine("<local-command-stdout>ok</local-command-stdout>"),
			expected: false,
		},
		metaLineIsNotHuman: {
			line: userLine("Caveat: injected by the harness", { isMeta: true }),
			expected: false,
		},
		sidechainLineIsNotHuman: {
			line: userLine("subagent traffic", { isSidechain: true }),
			expected: false,
		},
		toolResultArrayIsNotHuman: {
			line: userLine([
				{ type: "tool_result", tool_use_id: "toolu_01", content: "ok" },
			]),
			expected: false,
		},
		textBlockWithAttachmentIsHuman: {
			line: userLine([
				{ type: "text", text: "what does this stack trace mean" },
			]),
			expected: true,
		},
	};

	test.each(Object.entries(fixtures))("%s", (_name, { line, expected }) => {
		expect(isHumanPrompt(UserLineSchema.parse(line))).toBe(expected);
	});
});

describe("isCommandInvocation", () => {
	const fixtures: Record<string, { line: unknown; expected: boolean }> = {
		commandMessageLineIsInvocation: {
			line: userLine("<command-message>execute</command-message>"),
			expected: true,
		},
		commandNameLineIsInvocation: {
			line: userLine("<command-name>/plan-feature</command-name>"),
			expected: true,
		},
		localCommandStdoutIsNot: {
			line: userLine("<local-command-stdout>ok</local-command-stdout>"),
			expected: false,
		},
		sidechainCommandIsNot: {
			line: userLine("<command-message>execute</command-message>", {
				isSidechain: true,
			}),
			expected: false,
		},
		plainPromptIsNot: {
			line: userLine("refactor the parser"),
			expected: false,
		},
	};

	test.each(Object.entries(fixtures))("%s", (_name, { line, expected }) => {
		expect(isCommandInvocation(UserLineSchema.parse(line))).toBe(expected);
	});
});

describe("classifyCommand", () => {
	const cmd = (name: string) =>
		userLine(
			`<command-message>x</command-message>\n<command-name>${name}</command-name>`,
		);
	const fixtures: Record<string, { line: unknown; expected: string }> = {
		executeIsPlan: { line: cmd("/execute"), expected: "plan" },
		planFeatureIsPlan: { line: cmd("/plan-feature"), expected: "plan" },
		createPrdIsPlan: { line: cmd("/create-prd"), expected: "plan" },
		primeIsContext: { line: cmd("/prime"), expected: "context" },
		initIsContext: { line: cmd("/init"), expected: "context" },
		clearIsOther: { line: cmd("/clear"), expected: "other" },
		modelIsOther: { line: cmd("/model"), expected: "other" },
		nameMatchedCaseInsensitively: { line: cmd("/Execute"), expected: "plan" },
		// A custom command's name is never inspected beyond the allowlist.
		unknownCustomCommandIsOther: {
			line: cmd("/deploy-prod-secrets"),
			expected: "other",
		},
		missingNameTagIsOther: {
			line: userLine("<command-message>execute</command-message>"),
			expected: "other",
		},
	};

	test.each(Object.entries(fixtures))("%s", (_name, { line, expected }) => {
		expect(classifyCommand(UserLineSchema.parse(line))).toBe(expected);
	});
});

describe("promptText", () => {
	test("returns string content verbatim", () => {
		expect(promptText(userLine("fix the bug"))).toBe("fix the bug");
	});

	test("concatenates text blocks and ignores other block types", () => {
		const line = userLine([
			{ type: "text", text: "first part" },
			{ type: "image", source: {} },
			{ type: "text", text: "second part" },
		]);
		expect(promptText(line)).toBe("first part\nsecond part");
	});
});

describe("categorizeToolName", () => {
	const fixtures: Record<string, { name: string; expected: string }> = {
		editIsFileEdit: { name: "Edit", expected: "file_edit" },
		writeIsFileEdit: { name: "Write", expected: "file_edit" },
		multiEditIsFileEdit: { name: "MultiEdit", expected: "file_edit" },
		notebookEditIsFileEdit: { name: "NotebookEdit", expected: "file_edit" },
		readIsFileRead: { name: "Read", expected: "file_read" },
		bashIsExecute: { name: "Bash", expected: "execute" },
		grepIsSearch: { name: "Grep", expected: "search" },
		webSearchIsSearch: { name: "WebSearch", expected: "search" },
		unknownFutureToolIsOtherNotAnError: {
			name: "QuantumDebugger",
			expected: "other",
		},
		skillIsDelegate: { name: "Skill", expected: "delegate" },
		taskIsDelegate: { name: "Task", expected: "delegate" },
		agentIsDelegate: { name: "Agent", expected: "delegate" },
	};

	test.each(Object.entries(fixtures))("%s", (_name, { name, expected }) => {
		expect(categorizeToolName(name)).toBe(expected);
	});
});
