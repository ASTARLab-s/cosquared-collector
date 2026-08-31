import { describe, expect, test } from "vitest";
import {
	dropResumedDuplicates,
	hashPrompt,
	MIN_DEDUPE_PROMPTS,
	sharedPromptPrefix,
} from "./conversation-dedupe";

/**
 * These fixtures ARE the published methodology for conversation identity
 * (PRD §7.6): each case pins exactly which re-recordings collapse into one
 * conversation and which stay separate sessions.
 */

/** A recording named for readability; letters stand in for prompt hashes. */
function recording(name: string, prompts: string) {
	return { name, fingerprint: [...prompts] };
}

const keptNames = (
	candidates: Array<{ name: string; fingerprint: string[] }>,
) =>
	dropResumedDuplicates(candidates)
		.map((candidate) => candidate.name)
		.sort();

describe("sharedPromptPrefix", () => {
	test("counts the leading run two conversations have in common", () => {
		expect(sharedPromptPrefix([..."abcd"], [..."abxy"])).toBe(2);
	});

	test("is zero when the conversations diverge immediately", () => {
		expect(sharedPromptPrefix([..."abc"], [..."xbc"])).toBe(0);
	});

	test("is the shorter length when one conversation is a prefix of the other", () => {
		expect(sharedPromptPrefix([..."ab"], [..."abcd"])).toBe(2);
	});
});

describe("dropResumedDuplicates", () => {
	test("drops a resume that replays a conversation and adds nothing", () => {
		// The strict-prefix case: Codex re-records the whole history, stops.
		expect(
			keptNames([recording("full", "abcde"), recording("replay", "abc")]),
		).toEqual(["full"]);
	});

	test("drops a fork that replays a conversation and adds a single turn", () => {
		// Claude Code forks on interrupt: shared opening, one new turn. The
		// strict-prefix rule could not see this (calibration 2026-08-31).
		expect(
			keptNames([recording("full", "abcdef"), recording("fork", "abcX")]),
		).toEqual(["full"]);
	});

	test("KEEPS a fork that took the conversation somewhere new", () => {
		// Two substantial branches are two sessions: dropping one would
		// delete work that was really done.
		expect(
			keptNames([recording("main", "abcdef"), recording("branch", "abcXY")]),
		).toEqual(["branch", "main"]);
	});

	test("keeps conversations that merely start alike but diverge at once", () => {
		expect(
			keptNames([recording("one", "aXYZ"), recording("two", "aPQR")]),
		).toEqual(["one", "two"]);
	});

	test(`never dedupes a conversation shorter than ${MIN_DEDUPE_PROMPTS} prompts`, () => {
		// A single generic opener ("continue") recurs across unrelated
		// sessions; merging those would delete real work.
		expect(
			keptNames([recording("long", "abcde"), recording("opener", "a")]),
		).toEqual(["long", "opener"]);
	});

	test("keeps a recording with no authored prompts at all", () => {
		expect(keptNames([recording("silent", "")])).toEqual(["silent"]);
	});

	test("keeps the longest recording regardless of input order", () => {
		const short = recording("short", "abc");
		const long = recording("long", "abcde");
		expect(keptNames([short, long])).toEqual(["long"]);
		expect(keptNames([long, short])).toEqual(["long"]);
	});

	test("keeps the first of two identical recordings, not both", () => {
		expect(
			keptNames([recording("first", "abcd"), recording("second", "abcd")]),
		).toEqual(["first"]);
	});
});

describe("hashPrompt", () => {
	test("makes two recordings of the same prompt compare equal", () => {
		expect(hashPrompt("explain the retry logic")).toBe(
			hashPrompt("explain the retry logic"),
		);
	});

	test("separates prompts that differ only after a shared opening", () => {
		// Real case (calibration 2026-08-31): two "Question 2 …" prompts
		// shared their first 200 characters and diverged later. Identity must
		// read the WHOLE prompt or a fork looks like a replay.
		const shared = "Question 2. ".repeat(20);
		expect(hashPrompt(`${shared}compute average power`)).not.toBe(
			hashPrompt(`${shared}compute peak power`),
		);
	});
});
