# cosquared-collector

The public, auditable half of [**CoSquared**](https://cosquared.ai) — a
privacy-first AI engineering coach (a "fitness tracker for engineering skill").
CoSquared analyzes *how* you work — your AI coding sessions and git/repo
metadata — to score and coach your engineering, **without ever reading or
storing your source code**.

This repository contains everything that touches your data **before** it leaves
your machine: the collectors, the redaction pipeline, the telemetry schema, and
the complete scoring methodology. It is published under Apache-2.0 so you don't
have to take our word for any of it.

## Why this repo exists

For a tool that asks to look at how you code, "trust us, it's private" is not
good enough. So the privacy claims are **verifiable, not promised** — the part
of the product that reads your data and decides what (if anything) is uploaded
is open source, and its readability *is* the trust strategy. You can read it,
run it, and confirm for yourself:

- exactly what is computed from your sessions and repos,
- exactly what would be uploaded — and that raw code, file contents, secrets,
  and raw transcripts never are.

## What's in here

| Package | Purpose |
|---------|---------|
| `packages/collector` | Collectors (Claude Code, Codex CLI, and Cursor — read-only, metadata-only), the redaction pipeline, and the full scoring methodology — signal definitions, criteria, thresholds, and weights (`src/scoring/weights.ts`). |
| `packages/schema` | The versioned telemetry schema: the normalized `SessionEvent` types every collector emits, and `AnalysisPayload` — the exact, name/path-free shape that would be uploaded. |
| `packages/eval-schema` | The strict, no-free-text external Evaluation API envelope, request contract, result types, and canonical digest serialization. |

## What is deliberately NOT here

The product's private half lives in a separate, closed repository: the coaching
engine and its prompts, the recommendation library, the benchmark/goal-outcome
data, the skill graph, the dashboard, and billing. `packages/collector` depends
on **no** private package — the open/closed line is drawn along the data
boundary, so nothing you need in order to audit what leaves your machine is
hidden.

The scoring methodology is public **on purpose**: it runs on your machine (so it
is extractable from the binary regardless), and a published, inspectable
methodology is exactly the transparency the product is built on — not a black box.

## Privacy guarantees you can check in the code

- **Redaction runs before serialization.** There is no code path where
  unredacted data reaches the upload buffer (`packages/collector/src/redaction`).
- **Never transmitted:** raw source code, file contents, API keys/credentials,
  env values, raw file paths, and raw transcripts.
- **The upload contract is typed and strict.** `AnalysisPayload` in
  `packages/schema` is counts, ratios, booleans, enums, opaque hashes, and dates
  — by construction it has no field that can carry a name, a path, a prompt, or
  source. Unknown keys are rejected, not silently stripped.
- **Scoring is deterministic and clock-free** — byte-identical output for
  byte-identical input — so what an auditor computes is what the product computes.

## Verify it yourself

```sh
pnpm install
pnpm test        # full suite, incl. the redaction secrets-corpus gate
pnpm lint
pnpm typecheck
```

The redaction release gate — a seeded corpus of **fake-but-format-valid**
secrets that must be caught at 100% with zero survivals, plus a benign corpus
that must produce zero false positives:

```sh
pnpm vitest run --project @cosquared/collector -t "secrets corpus"
```

Good places to start reading: the redaction rule table
(`packages/collector/src/redaction/rules.ts`), the scoring weights and
thresholds (`packages/collector/src/scoring/weights.ts`), and the upload
contract (`packages/schema/src/analysis-payload.ts`).

## About this mirror

This repository is **generated from the private monorepo as an explicit
allowlist** — only the packages and docs above are ever copied in, so a private
file cannot leak here by construction (the mirror also fails loudly if any
copied file imports a private package). It is a source-only mirror for auditing;
the CLI itself ships as signed, compiled binaries.

## Privacy policy

See [`docs/privacy.md`](docs/privacy.md) for the plain-language data policy and
the data-handling contract the redaction pipeline enforces. The pre-registered
methodology experiment is in
[`docs/experiments/E1-summaries-vs-excerpts.md`](docs/experiments/E1-summaries-vs-excerpts.md).

## License

Apache-2.0. See [`LICENSE`](LICENSE).
