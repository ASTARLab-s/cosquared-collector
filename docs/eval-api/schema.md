# Evaluation API v1 — event schema

Evaluation requests use a strict, versioned event envelope. The canonical
machine-readable schema is generated from the same Zod definitions that validate
requests, so integrations should discover it from the API rather than copying a
static schema document.

```bash
export COSQUARED_EVAL_BASE_URL=https://cosquared.astar.inc
curl -sS "$COSQUARED_EVAL_BASE_URL/eval/v1/schema" | jq .
```

The response includes `event_schema_version` and a JSON Schema document in
`schema`. Unknown properties are rejected.

## Common envelope

Every event supplies an `id`, `type`, `occurred_at`, pseudonymous `subject`,
`session_id`, `source`, and `provenance`. The request-level subject and each
event subject must match. Repo-family events use a `null` session ID.

Free-text prompts, transcripts, source code, file paths, command text, and
client-supplied scores are not accepted.

## Event families

The v1 schema covers session lifecycle, privacy-safe AI interaction counters,
tool and command categories, plan artifacts, validation outcomes, structured
errors, commits, and aggregate repository snapshots. Each event type adds only
the bounded fields needed by the deterministic evaluator.

Use `POST /eval/v1/inspect` with a test key to validate and normalize a complete
evaluation request without persisting it. See the [getting started guide](getting-started.md)
for the request envelope and an end-to-end example.
