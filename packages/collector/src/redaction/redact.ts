import { shannonEntropy } from "./entropy";
import { brandRedacted, type RedactedText } from "./redacted-text";
import { REDACTION_RULES, type RedactionRule } from "./rules";

/**
 * The redaction engine — the ONLY producer of `RedactedText`.
 *
 * PRIVACY CONTRACT for this module (CLAUDE.md invariant #1): any free-text
 * string headed for an upload buffer or crash report MUST pass through
 * `redactText()` first; consumers enforce this by typing their fields as
 * `RedactedText`, which nothing else can produce. Redaction is defense in
 * depth (PRD §16 Q3) — the schema's no-free-text design is the primary
 * privacy mechanism; this engine guards the surfaces outside it.
 *
 * The engine is pure and deterministic: no clock, no randomness, no I/O —
 * byte-identical output for byte-identical input. The `inspect`/upload
 * byte-parity guarantee (CLAUDE.md code patterns) depends on this.
 */

export interface RedactionFinding {
	ruleId: string;
	/**
	 * Occurrences redacted. NEVER the matched text — a finding that echoed
	 * the secret would itself be the leak this module exists to prevent.
	 */
	count: number;
}

export interface RedactionResult {
	text: RedactedText;
	findings: RedactionFinding[];
}

export interface RedactTextOptions {
	/**
	 * User-supplied additions (future: config.toml custom regexes, PRD §9).
	 * Applied AFTER the built-in rules.
	 */
	additionalRules?: ReadonlyArray<RedactionRule>;
}

/**
 * Placeholders already spliced in by an earlier rule (or a previous call —
 * idempotency). A candidate containing one is never re-redacted, so the most
 * specific rule's id survives in the output and findings stay zero on a
 * second pass.
 */
const PLACEHOLDER_PATTERN = /\[REDACTED:[a-z0-9-]+\]/;

/**
 * The engine matches via `matchAll` on a derived regex (original flags plus
 * `d` for group indices, plus `g` defensively for caller-supplied rules) —
 * never `.test()`/`.exec()` on the shared rule literal, whose `lastIndex`
 * would leak state across calls.
 */
function enginePattern(rule: RedactionRule): RegExp {
	let flags = rule.pattern.flags;
	if (!flags.includes("d")) {
		flags += "d";
	}
	if (!flags.includes("g")) {
		flags += "g";
	}
	return new RegExp(rule.pattern.source, flags);
}

/**
 * Extracts the candidate secret span of one match: the `secretGroup` span
 * when the rule scopes one (so surrounding context like `api_key = ` is
 * preserved), the whole match otherwise. Returns null when the group did
 * not participate in the match.
 */
function candidateSpan(
	match: RegExpExecArray,
	rule: RedactionRule,
): { start: number; end: number; value: string } | null {
	if (rule.secretGroup === undefined) {
		return {
			start: match.index,
			end: match.index + match[0].length,
			value: match[0],
		};
	}
	const value = match[rule.secretGroup];
	const span = match.indices?.[rule.secretGroup];
	if (value === undefined || span === undefined) {
		return null;
	}
	return { start: span[0], end: span[1], value };
}

function applyRule(
	text: string,
	rule: RedactionRule,
): { text: string; count: number } {
	const pattern = enginePattern(rule);
	let output = "";
	let cursor = 0;
	let count = 0;
	for (const match of text.matchAll(pattern)) {
		const candidate = candidateSpan(match, rule);
		if (candidate === null || candidate.value.length === 0) {
			continue;
		}
		if (PLACEHOLDER_PATTERN.test(candidate.value)) {
			continue;
		}
		if (
			rule.minEntropy !== undefined &&
			shannonEntropy(candidate.value) < rule.minEntropy
		) {
			continue;
		}
		// Splice via index slices, not a replacer-string rebuild, so
		// surrounding text (including astral/emoji characters) is copied
		// verbatim and never reinterpreted.
		output += text.slice(cursor, candidate.start);
		output += `[REDACTED:${rule.id}]`;
		cursor = candidate.end;
		count += 1;
	}
	output += text.slice(cursor);
	return { text: output, count };
}

/**
 * Whether a single rule fires on the input under full engine semantics
 * (secret group participation, placeholder guard, entropy gate) — exported
 * as published methodology so per-rule tests exercise exactly what ships,
 * not bare `pattern.test()`.
 */
export function ruleMatches(rule: RedactionRule, input: string): boolean {
	return applyRule(input, rule).count > 0;
}

/**
 * Redacts all rule matches from `input`, in rule-table order, replacing each
 * with `[REDACTED:<rule-id>]` (or splicing the placeholder over the rule's
 * `secretGroup` only, preserving surrounding context).
 *
 * Each rule runs against the output of the previous one. Placeholders are
 * never re-redacted, which makes the function idempotent: redacting already-
 * redacted text changes nothing and reports no findings.
 *
 * Findings are aggregated per rule id in rule-table order and carry rule id
 * and count ONLY — never matched text or offsets.
 */
export function redactText(
	input: string,
	options?: RedactTextOptions,
): RedactionResult {
	const rules = options?.additionalRules
		? [...REDACTION_RULES, ...options.additionalRules]
		: REDACTION_RULES;
	let text = input;
	const findings: RedactionFinding[] = [];
	for (const rule of rules) {
		const applied = applyRule(text, rule);
		text = applied.text;
		if (applied.count > 0) {
			findings.push({ ruleId: rule.id, count: applied.count });
		}
	}
	return { text: brandRedacted(text), findings };
}
