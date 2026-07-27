import { describe, expect, test } from "vitest";
import { type ChurnTotals, reduceChurnLines } from "./churn-reduction";
import { buildCommitIdentity } from "./identity";

/**
 * Table-driven fixtures pinning the published churn rule (PRD §7.3
 * Shipping Momentum). These fixtures ARE the public methodology
 * documentation: each entry shows exactly which add→delete arcs count as
 * churn and which do not.
 *
 * Fixture lines mirror real `git log --format=%x1e%cI%x1f%ae%x1f%an --numstat`
 * output: NEWEST commit first, `\x1e<date>\x1f<email>\x1f<name>` headers, blank
 * separator lines.
 */

const USER_EMAIL = "fixture@example.com";
const USER_NAME = "Fixture User";
const OTHER_EMAIL = "someone-else@example.com";
const REFERENCE_TIME = "2026-06-14T00:00:00.000Z";

/** The user identity for these fixtures. The USER_EMAIL commits below match by
 * EMAIL, so headers default to a non-user name — proving email attribution and
 * keeping the OTHER_EMAIL commits excluded by both email and name. */
const USER = buildCommitIdentity({ emails: [USER_EMAIL], names: [USER_NAME] });
const NON_USER_NAME = "Someone Else";

function header(dateIso: string, email: string, name = NON_USER_NAME): string {
	return `\x1e${dateIso}\x1f${email}\x1f${name}`;
}

function numstat(
	insertions: number | "-",
	deletions: number | "-",
	path: string,
): string {
	return `${insertions}\t${deletions}\t${path}`;
}

const fixtures: Record<string, { lines: string[]; expected: ChurnTotals }> = {
	addThenDeleteWithinWindowChurns: {
		// 10 lines added Jun 2, 4 deleted Jun 10 (8 days later) → 4 churned.
		lines: [
			header("2026-06-10T00:00:00Z", USER_EMAIL),
			numstat(0, 4, "src/a.ts"),
			"",
			header("2026-06-02T00:00:00Z", USER_EMAIL),
			numstat(10, 0, "src/a.ts"),
		],
		expected: { windowDays: 14, linesAdded: 10, linesChurned: 4 },
	},
	deleteOutsideWindowDoesNotChurn: {
		// Added May 20, deleted Jun 10 (21 days later) → no churn. The old
		// addition also falls outside the linesAdded window ending Jun 14.
		lines: [
			header("2026-06-10T00:00:00Z", USER_EMAIL),
			numstat(0, 5, "src/a.ts"),
			"",
			header("2026-05-20T00:00:00Z", USER_EMAIL),
			numstat(8, 0, "src/a.ts"),
		],
		expected: { windowDays: 14, linesAdded: 0, linesChurned: 0 },
	},
	otherAuthorsExcluded: {
		// Another author's additions never seed FIFOs, and their deletions
		// never match the user's additions (personal scope, published rule).
		lines: [
			header("2026-06-12T00:00:00Z", OTHER_EMAIL),
			numstat(0, 6, "src/a.ts"),
			"",
			header("2026-06-10T00:00:00Z", USER_EMAIL),
			numstat(0, 3, "src/b.ts"),
			"",
			header("2026-06-08T00:00:00Z", OTHER_EMAIL),
			numstat(20, 0, "src/b.ts"),
			"",
			header("2026-06-06T00:00:00Z", USER_EMAIL),
			numstat(7, 0, "src/a.ts"),
		],
		expected: { windowDays: 14, linesAdded: 7, linesChurned: 0 },
	},
	binaryNumstatCountsZero: {
		lines: [
			header("2026-06-10T00:00:00Z", USER_EMAIL),
			numstat("-", "-", "assets/logo.png"),
			numstat(3, 0, "src/a.ts"),
		],
		expected: { windowDays: 14, linesAdded: 3, linesChurned: 0 },
	},
	deletionsCappedByPriorAdditions: {
		// 12 deletions but only 5 lines were added in-window on that path:
		// churn is capped at the matched remainder, never the raw deletions.
		lines: [
			header("2026-06-10T00:00:00Z", USER_EMAIL),
			numstat(0, 12, "src/a.ts"),
			"",
			header("2026-06-05T00:00:00Z", USER_EMAIL),
			numstat(5, 0, "src/a.ts"),
		],
		expected: { windowDays: 14, linesAdded: 5, linesChurned: 5 },
	},
	differentPathsNeverMatch: {
		lines: [
			header("2026-06-10T00:00:00Z", USER_EMAIL),
			numstat(0, 4, "src/b.ts"),
			"",
			header("2026-06-05T00:00:00Z", USER_EMAIL),
			numstat(9, 0, "src/a.ts"),
		],
		expected: { windowDays: 14, linesAdded: 9, linesChurned: 0 },
	},
	rewriteInOneCommitChurnsOldLinesNotItsOwn: {
		// +2/-2 on one path deletes PRIOR lines; its own additions are only
		// available to LATER deletions.
		lines: [
			header("2026-06-10T00:00:00Z", USER_EMAIL),
			numstat(2, 2, "src/a.ts"),
			"",
			header("2026-06-05T00:00:00Z", USER_EMAIL),
			numstat(2, 0, "src/a.ts"),
		],
		expected: { windowDays: 14, linesAdded: 4, linesChurned: 2 },
	},
	oldAdditionSeedsChurnButNotLinesAdded: {
		// Added Jun 1 (13 days before the Jun 14 reference — in the added
		// window), deleted Jun 9 (8 days after the add — churns). Added
		// May 28 (17 days before reference — NOT in the added window), but
		// its delete on Jun 9 is only 12 days later, so it still churns.
		lines: [
			header("2026-06-09T00:00:00Z", USER_EMAIL),
			numstat(0, 3, "src/old.ts"),
			numstat(0, 2, "src/new.ts"),
			"",
			header("2026-06-01T00:00:00Z", USER_EMAIL),
			numstat(2, 0, "src/new.ts"),
			"",
			header("2026-05-28T00:00:00Z", USER_EMAIL),
			numstat(3, 0, "src/old.ts"),
		],
		expected: { windowDays: 14, linesAdded: 2, linesChurned: 5 },
	},
	emptyLogYieldsZeroTotals: {
		lines: [],
		expected: { windowDays: 14, linesAdded: 0, linesChurned: 0 },
	},
	malformedLinesAreSkippedNotFatal: {
		lines: [
			"not a header and not numstat",
			header("2026-06-10T00:00:00Z", USER_EMAIL),
			"garbage\tline",
			numstat(4, 0, "src/a.ts"),
		],
		expected: { windowDays: 14, linesAdded: 4, linesChurned: 0 },
	},
};

describe("reduceChurnLines (churn methodology)", () => {
	test.each(Object.entries(fixtures))("%s", async (_name, {
		lines,
		expected,
	}) => {
		const totals = await reduceChurnLines(lines, {
			windowDays: 14,
			identity: USER,
			referenceTime: REFERENCE_TIME,
		});
		expect(totals).toEqual(expected);
	});

	test("matches the user email case-insensitively", async () => {
		const totals = await reduceChurnLines(
			[
				header("2026-06-10T00:00:00Z", "Fixture@Example.COM"),
				numstat(5, 0, "src/a.ts"),
			],
			{ windowDays: 14, identity: USER, referenceTime: REFERENCE_TIME },
		);
		expect(totals.linesAdded).toBe(5);
	});

	test("attributes a commit by NAME when the email differs (secondary email)", async () => {
		const totals = await reduceChurnLines(
			[
				header("2026-06-10T00:00:00Z", "personal@gmail.com", USER_NAME),
				numstat(5, 0, "src/a.ts"),
			],
			{ windowDays: 14, identity: USER, referenceTime: REFERENCE_TIME },
		);
		expect(totals.linesAdded).toBe(5);
	});
});
