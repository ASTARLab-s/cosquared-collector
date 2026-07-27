# Evaluation API v1 — getting started

The Evaluation API converts a strict batch of privacy-safe workflow events into
deterministic, versioned dimension results. It never accepts client-supplied
scores, code, prompts, transcripts, paths, or other free text.

## Create a project and test key

Sign in to the CoSquared dashboard, open **API**, create an organization, and
mint a test key. Keys begin with `csq_test_` or `csq_live_`; plaintext is shown
once and only its SHA-256 hash is stored. Test and live runs are segregated.

Live keys are manually enabled during the design-partner phase after accepting
the data covenant: participant notice, disclosed evaluation purpose,
pseudonymous subjects, and subject deletion support.

Set the preview API host once for the examples below:

```bash
export COSQUARED_EVAL_BASE_URL=https://cosquared.astar.inc
```

## Inspect normalization

`inspect` is test-mode-only and persists nothing. It calls the same adapter as
a real evaluation, so its mapping is authoritative.

```bash
curl -sS -X POST "$COSQUARED_EVAL_BASE_URL/eval/v1/inspect" \
  -H "Authorization: Bearer $COSQUARED_EVAL_KEY" \
  -H "content-type: application/json" \
  -d @evaluation.json | jq .
```

## Create an evaluation

```bash
curl -sS -X POST "$COSQUARED_EVAL_BASE_URL/eval/v1/evaluations" \
  -H "Authorization: Bearer $COSQUARED_EVAL_KEY" \
  -H "Idempotency-Key: mission-42-final" \
  -H "content-type: application/json" \
  -d @evaluation.json | jq .
```

A minimal request:

```json
{
  "subject": "sub_a91f",
  "external_session_id": "mission_42",
  "window": {
    "start": "2026-07-10T13:00:00Z",
    "end": "2026-07-10T16:00:00Z"
  },
  "profiles": ["ai_collaboration_v1", "software_delivery_v1"],
  "events": [{
    "id": "evt_test_1",
    "type": "validation.test_run",
    "occurred_at": "2026-07-10T14:03:22Z",
    "subject": "sub_a91f",
    "session_id": "mission_42_s1",
    "source": "external",
    "provenance": "server_observed",
    "passed": true,
    "framework": "vitest"
  }]
}
```

Every event subject must equal the request subject. Repo-family events require
`"session_id": null`. The optional declared window is advisory in v1: events
outside it are accepted, while scoring uses actual event timestamps.

Requests are capped at 5,000 events and 1 MiB. Duplicate event IDs are
deduplicated deterministically; the first occurrence wins. `self_reported`
events remain in coverage but are excluded from scoring.

## Retrieve results

```bash
curl -sS "$COSQUARED_EVAL_BASE_URL/eval/v1/evaluations/EVALUATION_ID" \
  -H "Authorization: Bearer $COSQUARED_EVAL_KEY" | jq .

curl -sS "$COSQUARED_EVAL_BASE_URL/eval/v1/evaluations?subject=sub_a91f&limit=25" \
  -H "Authorization: Bearer $COSQUARED_EVAL_KEY" | jq .
```

An `Idempotency-Key` replay returns the original resource with `200`; the first
creation returns `201`. Results pin event-schema, evaluator, and per-profile
methodology versions.

Failures use RFC 9457 `application/problem+json` with `type`, `title`, `status`,
typed extensions such as `issues`, and an `X-Request-Id`. See
[error types](errors.md). Public discovery endpoints are `GET /eval/v1/schema`
and `GET /eval/v1/profiles`.
