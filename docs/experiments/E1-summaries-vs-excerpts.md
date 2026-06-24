# Experiment E1 — Structured summaries vs. redacted excerpts

**Pre-registration.** This document fixes the hypothesis, protocol, sample
target, and decision rule for Experiment E1 *before any rating is collected*, so
the launch decision cannot be quietly re-litigated afterward by whoever
preferred the other outcome. Source of truth: PRD §16 Q3 (and §7.7).

## Status

- **State:** Pre-registered and **locked** on 2026-06-17, before the first
  rating.
- **Deferred to post-launch.** This experiment is *not* run in Phase 1. It runs
  only if early users signal that structured summaries are too thin to coach
  well (PRD §13, §16 Q3). Running it requires building the excerpt pipeline, so
  "run E1" and "start building Rich mode" are the same commitment — which is why
  we defer the build, not just the test. Until then the product ships two modes
  (Local-only, Metadata) and Rich is not built. This doc stays the locked
  protocol for if/when E1 runs.
- **Amendments:** append-only below. Once ratings begin, the hypothesis,
  pipelines, rating instrument, sample target, and decision gate are frozen; any
  change is recorded as a dated amendment with its rationale, never an in-place
  edit.
- **Implementation:** **out of scope for this document.** The two coaching
  pipelines, the `coaching_eval` store, the rating flow, and the dashboard are a
  separate, later plan. This file is the protocol only.

## Background

Three findings make structured summaries the *presumptive* default, so excerpts
must earn their existence rather than being assumed necessary:

1. Structured extraction used as preprocessing tends to **improve** LLM output
   quality, not degrade it — clean behavioral arcs beat making the model wade
   through raw text.
2. Redaction pipelines are **probabilistically leaky** (evaluations show roughly
   ~50% recall on secrets), and a single leaked credential is a brand-ending
   event for a privacy-first product — so redaction can never be the privacy
   backstop.
3. Structured summaries are safe **by construction**: no verbatim text in the
   payload means there is nothing to leak.

## Hypothesis

> Coaching generated from deterministic structured summaries achieves **≥90% of
> the blind-rated quality** of coaching generated from redacted transcript
> excerpts.

(Pre-registered before any data collection.)

## Pipelines

Each analysis generates coaching through **both** pipelines, with the coaching
prompt held identical between them — the *only* difference is the input:

- **Pipeline A — structured-summary input:** the deterministic, rule-based
  structured summary (the Metadata-mode representation).
- **Pipeline B — redacted-excerpt input:** redacted transcript excerpts.

## Rating

Each rater compares the **pair** for one analysis:

- **Blind:** pipeline labels are hidden.
- **Paired and order-randomized:** A/B presentation order is randomized per pair
  so order can't bias the result.
- **Three 1–5 scales:**
  - **Accuracy** — "this correctly describes what I did."
  - **Specificity** — "cites real evidence, not horoscope."
  - **Actionability** — "I know what to do next."

## Sample target

At least **30 paired ratings**, from at least **15 raters**, spanning at least
**3 builder types**, before the gate is evaluated.

## Tracking

Results live in a single `coaching_eval` table with one row per paired rating:

| Column | Meaning |
|--------|---------|
| `rater_id` | who provided the rating |
| `session_id` | the analyzed session the pair came from |
| `pipeline_variant` | which pipeline a given side was (A: summary, B: excerpt) |
| `accuracy` | 1–5 |
| `specificity` | 1–5 |
| `actionability` | 1–5 |
| `comment` | free-text |
| `created_at` | timestamp |

A standing dashboard view shows the **running quality ratio per dimension**
(summary score ÷ excerpt score) alongside the current sample count, so progress
toward the gate is visible without re-running an analysis.

## Decision gate (binary — evaluated when E1 runs)

Evaluated once the sample target is met. Because Rich is not built by default,
the burden is on excerpts to justify being built:

- **Ratio ≥ 0.90 on all three dimensions → do not build Rich.** Summaries win;
  keep the two privacy modes (Local-only, Metadata) and the claim: *"raw
  transcript text never leaves your machine — in any mode."*
- **Ratio < 0.90 on any dimension → build Rich** as an opt-in mode with
  **mandatory per-upload review**, scoped only to the coaching tasks where
  excerpts measurably won (the per-dimension data identifies exactly which).

## Amendments log

*(append-only; empty at pre-registration)*
