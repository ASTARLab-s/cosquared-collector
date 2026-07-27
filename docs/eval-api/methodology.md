# Evaluation API v1 — methodology

The API calls the same deterministic, clock-free `scoreProfile()` engine used
by the personal product. The published source of truth for weights, thresholds,
confidence rules, and evidence caps is
[`packages/collector/src/scoring/weights.ts`](../../packages/collector/src/scoring/weights.ts).
The API adds coverage reporting, event-ID evidence back-mapping,
self-reported-event exclusion, and the short-window guard below.

Every dimension returns a score or honest `null`, applicability, confidence,
sample sizes, structured numerator/denominator evidence, and submitted-event
references. It never returns a composite rank, Builder Type, coaching prose, or
advice.

## `ai_collaboration_v1` — methodology 1.0.0

- `ai_collaboration`: the published top-level hierarchy over the four
  components below, not a cross-domain overall score.
- `task_framing`: plan artifacts, plan commands, and structural first-prompt
  features. The 40-word proxy is chat-UI-dependent and gameable.
- `tool_workflow_judgment`: balanced edit/read/search/execute behavior, workflow
  leverage, and repo context/automation artifacts. Missing `repo.snapshot`
  coverage is surfaced.
- `verification_calibration`: validation after accepted changes and sessions
  combining accepted changes with test runs.
- `cognitive_engagement`: question and explanation-seeking rates. Construct
  validity is provisional; this is the profile's weakest proxy.

## `software_delivery_v1` — methodology 0.1.0-experimental

- `testing_discipline`: in-session tests, repo test-file ratio, and commits
  touching tests. Missing components are renormalized, never replaced by zero.
- `shipping_momentum`: cadence, completion arcs, and churn health. The published
  cadence window is 14 days; the API imposes a 7-day observed-span floor.
  Shorter batches abstain with `window_too_short`. Timed missions should expect
  this abstention.

## Confidence, coverage, and abstention

Denominator zero means `none`, thin evidence means `low`, and sufficient
evidence means `normal`. The abstention reasons are `no_applicable_events`,
`missing_source`, and `window_too_short`.

`self_reported` events are excluded rather than down-weighted; the run reports
the count. Other provenance classes are reported but do not change scores
because no validated coefficient exists.

## Standing limitation

Every result carries `methodology_not_validated_for_consequential_decisions`.
These are developmental signals, not validated hiring, firing, promotion,
admissions, or compensation instruments. The limitation remains until a
pre-registered program establishes construct validity, calibration, inter-rater
agreement, source bias behavior, and gaming resistance.
