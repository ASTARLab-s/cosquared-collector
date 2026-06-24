export {
	ClaudeCodeCollector,
	encodeProjectDirName,
} from "./claude-code/claude-code-collector";
export type { Collector, CollectorOptions } from "./collector";
export type { DiscoveredRepo } from "./discovery/discover";
export { discoverRepositories } from "./discovery/discover";
export type { ChurnTotals } from "./git/churn-reduction";
export { CHURN_WINDOW_DAYS } from "./git/churn-reduction";
export { GitCollector } from "./git/git-collector";
export { buildAnalysisPayload } from "./payload/build-payload";
export type {
	RedactionFinding,
	RedactionResult,
	RedactTextOptions,
} from "./redaction/redact";
export { redactText, ruleMatches } from "./redaction/redact";
export type { RedactedText } from "./redaction/redacted-text";
export type { RedactionRule } from "./redaction/rules";
export { REDACTION_RULES } from "./redaction/rules";
export type { BuilderTypeInputs } from "./scoring/builder-type";
export { classifyBuilderType } from "./scoring/builder-type";
export { scaleLinear, weightedMean } from "./scoring/scale";
export { scoreProfile } from "./scoring/score-profile";
export type { SegmentedEvents, SessionView } from "./scoring/sessions";
export { segmentSessions } from "./scoring/sessions";
export type {
	BuilderProfile,
	BuilderType,
	Confidence,
	EvidenceKind,
	EvidenceRef,
	EvidenceStatistic,
	ScoredSignal,
	ScoreResult,
	SignalId,
} from "./scoring/types";
// Published methodology: every weight, threshold, and confidence rule.
export * from "./scoring/weights";
