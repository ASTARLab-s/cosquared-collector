import { describe, expect, test } from "vitest";
import {
	commit,
	prompt,
	repoSnapshot,
	testRun,
	toolCall,
} from "../__fixtures__/builders";
import { segmentSessions } from "../sessions";
import { testingDiscipline } from "./testing-discipline";

const T0 = "2026-06-10T10:00:00.000Z";
const T1 = "2026-06-10T10:01:00.000Z";
const T2 = "2026-06-10T10:02:00.000Z";

describe("scores: testingDiscipline", () => {
	test("fullMarksAcrossAllThreeComponents", () => {
		const { sessions, repoEvents } = segmentSessions([
			prompt("s1", T0),
			toolCall("s1", T1, "file_edit"),
			testRun("s1", T2),
			commit(T0, { touchedTestFiles: true }),
			commit(T1, { touchedTestFiles: true }),
			// 25 test files / 100 tracked = 0.25 ≥ 0.2 full-at.
			repoSnapshot(T1, { testFileCount: 25 }),
		]);
		expect(testingDiscipline(sessions, repoEvents).value).toBe(100);
	});

	test("noGitDataRenormalizesOntoTheSessionComponent", () => {
		// Claude-Code-only stream: repo ratio and commit rate are null;
		// tests in 1 of 1 coding sessions (rate 1 ≥ 0.6) carries the score.
		const { sessions, repoEvents } = segmentSessions([
			prompt("s1", T0),
			toolCall("s1", T1, "file_edit"),
			testRun("s1", T2),
		]);
		const result = testingDiscipline(sessions, repoEvents);
		expect(result.value).toBe(100);
		expect(result.components[0].signal.value).toBeNull();
		expect(result.components[2].signal.value).toBeNull();
	});

	test("nonCodingSessionsAreExcludedFromTheTestRateDenominator", () => {
		// One coding session that tested + one read-only session (no edits):
		// the rate is 1/1, not 1/2 — the /model-style session never had code
		// to test and must not drag the score down.
		const { sessions, repoEvents } = segmentSessions([
			prompt("s1", T0),
			toolCall("s1", T1, "file_edit"),
			testRun("s1", T2),
			prompt("s2", T0),
			toolCall("s2", T1, "file_read"),
		]);
		const result = testingDiscipline(sessions, repoEvents);
		expect(result.components[1].signal.evidence[0]).toMatchObject({
			kind: "sessions_with_test_run",
			numerator: 1,
			denominator: 1,
		});
	});

	test("zeroTrackedFilesGuardsTheRatioToNullNotNaN", () => {
		const { sessions, repoEvents } = segmentSessions([
			repoSnapshot(T0, { trackedFileCount: 0, testFileCount: 0 }),
		]);
		const result = testingDiscipline(sessions, repoEvents);
		expect(result.components[0].signal.value).toBeNull();
		expect(result.value).toBeNull();
	});

	test("sessionTestRateScalesAtThePublishedThreshold", () => {
		// Tests in 3 of 10 coding sessions = 0.3 rate; full at 0.6 → 50.
		const events = Array.from({ length: 10 }, (_unused, index) => [
			prompt(`s${index}`, T0),
			toolCall(`s${index}`, T1, "file_edit"),
			...(index < 3 ? [testRun(`s${index}`, T2)] : []),
		]).flat();
		const { sessions, repoEvents } = segmentSessions(events);
		const result = testingDiscipline(sessions, repoEvents);
		expect(result.components[1].signal.value).toBe(50);
		expect(result.value).toBe(50);
	});

	test("commitTestRateReadsTouchedTestFiles", () => {
		// 1 of 4 commits touches tests = 0.25; full at 0.5 → 50. The
		// session component is null (no sessions), repo component null.
		const { sessions, repoEvents } = segmentSessions([
			commit(T0, { touchedTestFiles: true }),
			commit(T0),
			commit(T1),
			commit(T1),
		]);
		const result = testingDiscipline(sessions, repoEvents);
		expect(result.components[2].signal.value).toBe(50);
		expect(result.value).toBe(50);
		expect(result.components[2].signal.evidence[0]).toMatchObject({
			kind: "commits_touching_tests",
			numerator: 1,
			denominator: 4,
		});
	});

	test("fourCommitsYieldLowConfidence", () => {
		const { sessions, repoEvents } = segmentSessions([
			commit(T0),
			commit(T0),
			commit(T1),
			commit(T1),
		]);
		expect(testingDiscipline(sessions, repoEvents).confidence).toBe("low");
	});

	test("emptyStreamYieldsNullScoreNoneConfidence", () => {
		const result = testingDiscipline([], []);
		expect(result.value).toBeNull();
		expect(result.confidence).toBe("none");
	});
});
