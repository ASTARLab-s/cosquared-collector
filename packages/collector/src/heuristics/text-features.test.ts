import { describe, expect, test } from "vitest";
import {
	countWords,
	detectTestRun,
	isExplanationRequest,
	isPlanArtifactWrite,
	isQuestion,
	isRejectionResult,
	referencesPlanArtifact,
} from "./text-features";

/**
 * Table-driven fixtures, one table per published rule. These fixtures ARE
 * the public methodology documentation: each entry pins exactly what the
 * rule does and does not match. Behavior is shared verbatim across every
 * collector (Claude Code, Codex CLI, Cursor) — these are the single source.
 */

describe("countWords", () => {
	const fixtures: Record<string, { text: string; expected: number }> = {
		simpleSentence: { text: "fix the failing test", expected: 4 },
		extraWhitespaceCollapses: { text: "  a   b\n c  ", expected: 3 },
		emptyString: { text: "", expected: 0 },
		whitespaceOnly: { text: "   \n\t ", expected: 0 },
	};

	test.each(Object.entries(fixtures))("%s", (_name, { text, expected }) => {
		expect(countWords(text)).toBe(expected);
	});
});

describe("isQuestion", () => {
	const fixtures: Record<string, { text: string; expected: boolean }> = {
		plainStatement: { text: "refactor the auth module", expected: false },
		trailingQuestionMark: { text: "does this handle nulls?", expected: true },
		midTextQuestionMark: {
			text: "is this right? please double check",
			expected: true,
		},
	};

	test.each(Object.entries(fixtures))("%s", (_name, { text, expected }) => {
		expect(isQuestion(text)).toBe(expected);
	});
});

describe("referencesPlanArtifact", () => {
	const fixtures: Record<string, { text: string; expected: boolean }> = {
		namedPlanFile: { text: "follow the plan in PLAN.md", expected: true },
		planningVerb: { text: "planning to refactor next", expected: true },
		plansPathSegment: {
			text: "see .agents/plans/collector for details",
			expected: true,
		},
		specMention: { text: "update the spec first", expected: true },
		todoMention: { text: "add it to the TODO list", expected: true },
		wordBoundaryGuard: {
			text: "let's deplane and grab lunch",
			expected: false,
		},
		unrelatedText: { text: "fix the login redirect", expected: false },
	};

	test.each(Object.entries(fixtures))("%s", (_name, { text, expected }) => {
		expect(referencesPlanArtifact(text)).toBe(expected);
	});
});

describe("isExplanationRequest", () => {
	const fixtures: Record<string, { text: string; expected: boolean }> = {
		explainKeyword: { text: "explain this regex", expected: true },
		whyQuestion: { text: "why does the build fail on CI?", expected: true },
		howDoesQuestion: {
			text: "how does the scheduler pick jobs?",
			expected: true,
		},
		whatIsQuestion: { text: "what is a sidechain line?", expected: true },
		walkMeThrough: {
			text: "walk me through the redaction flow",
			expected: true,
		},
		helpMeUnderstand: {
			text: "help me understand this stack trace",
			expected: true,
		},
		plainChangeRequest: { text: "rename the variable", expected: false },
		howManyIsNotExplanation: {
			text: "how many tests are left",
			expected: false,
		},
	};

	test.each(Object.entries(fixtures))("%s", (_name, { text, expected }) => {
		expect(isExplanationRequest(text)).toBe(expected);
	});
});

describe("detectTestRun", () => {
	const fixtures: Record<string, { command: string; expected: string | null }> =
		{
			pnpmTestScript: { command: "pnpm test", expected: "npm-script" },
			npmRunTestScript: { command: "npm run test", expected: "npm-script" },
			yarnTestScript: { command: "yarn test -u", expected: "npm-script" },
			vitestViaRunner: {
				command: "pnpm vitest run --project x",
				expected: "vitest",
			},
			jestViaNpx: { command: "npx jest --ci", expected: "jest" },
			cargoTest: { command: "cargo test", expected: "cargo" },
			goTest: { command: "go test ./...", expected: "go" },
			bunTest: { command: "bun test", expected: "bun" },
			pytestWithFilter: { command: "pytest -k foo", expected: "pytest" },
			rspecRun: { command: "bundle exec rspec spec/", expected: "rspec" },
			buildScriptIsNotATestRun: { command: "npm run build", expected: null },
			// Regression guard: a naive /test/ substring match would flag this.
			echoTestIsNotATestRun: { command: 'echo "test"', expected: null },
			typecheckIsNotATestRun: { command: "pnpm typecheck", expected: null },
		};

	test.each(Object.entries(fixtures))("%s", (_name, { command, expected }) => {
		const result = detectTestRun(command);
		expect(result?.framework ?? null).toBe(expected);
	});
});

describe("isPlanArtifactWrite", () => {
	const fixtures: Record<
		string,
		{ filePath: string; expected: string | null }
	> = {
		fileInPlansDirIsPlanDoc: {
			filePath: ".agents/plans/feature.md",
			expected: "plan_doc",
		},
		planMarkdownBasenameIsPlanDoc: {
			filePath: "docs/plan-q3.md",
			expected: "plan_doc",
		},
		specMarkdownIsSpec: { filePath: "docs/SPEC.md", expected: "spec" },
		todoTextFileIsTodo: { filePath: "TODO.txt", expected: "todo" },
		extensionlessTodoIsTodo: { filePath: "notes/TODO", expected: "todo" },
		// Doc-file guard: spec/todo basenames on source files never match.
		todoComponentSourceFileIsNot: {
			filePath: "src/todo-list.component.ts",
			expected: null,
		},
		specSourceFileIsNot: { filePath: "src/spec-runner.ts", expected: null },
		ordinarySourceFileIsNot: { filePath: "src/index.ts", expected: null },
	};

	test.each(Object.entries(fixtures))("%s", (_name, { filePath, expected }) => {
		const result = isPlanArtifactWrite(filePath);
		expect(result?.artifactKind ?? null).toBe(expected);
	});
});

describe("isRejectionResult", () => {
	const fixtures: Record<string, { text: string; expected: boolean }> = {
		doesntWantToProceed: {
			text: "The user doesn't want to proceed with this tool use.",
			expected: true,
		},
		userRejectedCaseInsensitive: {
			text: "Error: User rejected the proposed edit",
			expected: true,
		},
		genuineErrorIsNotARejection: {
			text: "error TS2345: argument of type 'string' is not assignable",
			expected: false,
		},
	};

	test.each(Object.entries(fixtures))("%s", (_name, { text, expected }) => {
		expect(isRejectionResult(text)).toBe(expected);
	});
});
