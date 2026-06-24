import { describe, expect, test } from "vitest";
import {
	isAutomationConfigPath,
	isContextFilePath,
	isDocFilePath,
	isTestFilePath,
} from "./heuristics";

/**
 * Table-driven fixtures, one table per published rule. These fixtures ARE
 * the public methodology documentation: each entry pins exactly what the
 * rule does and does not match.
 */

describe("isTestFilePath", () => {
	const fixtures: Record<string, { path: string; expected: boolean }> = {
		dotTestBasename: { path: "src/foo.test.ts", expected: true },
		dotSpecBasename: { path: "src/foo.spec.tsx", expected: true },
		goUnderscoreTestSuffix: { path: "pkg/handler_test.go", expected: true },
		pythonTestPrefixInTestsDir: {
			path: "tests/test_api.py",
			expected: true,
		},
		dunderTestsSegment: { path: "app/__tests__/x.js", expected: true },
		rubySpecSegment: { path: "spec/models/user_spec.rb", expected: true },
		renamedTestFileNumstatPath: {
			path: "src/{old => new}/file.test.ts",
			expected: true,
		},
		contestIsNotATestSegment: { path: "src/contest.ts", expected: false },
		latestIsNotATestSegment: {
			path: "src/latest/index.ts",
			expected: false,
		},
		attestationIsNotATestSegment: {
			path: "attestation/verify.go",
			expected: false,
		},
		protestIsNotATestBasename: { path: "protest_log.md", expected: false },
	};

	test.each(Object.entries(fixtures))("%s", (_name, { path, expected }) => {
		expect(isTestFilePath(path)).toBe(expected);
	});
});

describe("isDocFilePath", () => {
	const fixtures: Record<string, { path: string; expected: boolean }> = {
		readmeMarkdown: { path: "README.md", expected: true },
		extensionlessReadme: { path: "readme", expected: true },
		docsSegment: { path: "docs/guide.md", expected: true },
		nestedDocsSegment: { path: "packages/cli/docs/usage.md", expected: true },
		strayMarkdownIsNotDocs: { path: ".agents/plans/x.md", expected: false },
		docstringBasenameIsNotDocs: { path: "src/docstring.py", expected: false },
		changelogIsNotDocs: { path: "CHANGELOG.md", expected: false },
	};

	test.each(Object.entries(fixtures))("%s", (_name, { path, expected }) => {
		expect(isDocFilePath(path)).toBe(expected);
	});
});

describe("isContextFilePath", () => {
	const fixtures: Record<string, { path: string; expected: boolean }> = {
		rootClaudeMd: { path: "CLAUDE.md", expected: true },
		nestedClaudeMdCaseInsensitive: {
			path: "packages/cli/claude.md",
			expected: true,
		},
		agentsMd: { path: "AGENTS.md", expected: true },
		cursorrules: { path: ".cursorrules", expected: true },
		geminiMd: { path: "GEMINI.md", expected: true },
		copilotInstructions: {
			path: ".github/copilot-instructions.md",
			expected: true,
		},
		reclaudeIsNotContext: { path: "reclaude.md", expected: false },
		claudeMdBackupIsNotContext: { path: "CLAUDE.md.bak", expected: false },
		ordinaryMarkdownIsNotContext: { path: "notes/ideas.md", expected: false },
	};

	test.each(Object.entries(fixtures))("%s", (_name, { path, expected }) => {
		expect(isContextFilePath(path)).toBe(expected);
	});
});

describe("isAutomationConfigPath", () => {
	const fixtures: Record<string, { path: string; expected: boolean }> = {
		claudeSkillsFile: { path: ".claude/skills/review.md", expected: true },
		claudeCommandsFile: { path: ".claude/commands/deploy.md", expected: true },
		claudeAgentsFile: { path: ".claude/agents/tester.md", expected: true },
		nestedClaudeSkills: {
			path: "packages/cli/.claude/skills/run/SKILL.md",
			expected: true,
		},
		claudeBackupDirIsNotAutomation: {
			path: "src/.claude-backup/skills/x.md",
			expected: false,
		},
		claudeSettingsIsNotAutomation: {
			path: ".claude/settings.json",
			expected: false,
		},
		skillsDirOutsideClaudeIsNotAutomation: {
			path: "skills/juggling.md",
			expected: false,
		},
		fileNamedSkillsInClaudeDirIsNotAutomation: {
			path: ".claude/skills",
			expected: false,
		},
	};

	test.each(Object.entries(fixtures))("%s", (_name, { path, expected }) => {
		expect(isAutomationConfigPath(path)).toBe(expected);
	});
});
