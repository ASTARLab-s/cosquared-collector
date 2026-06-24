# Privacy

This is the plain-language version of how this tool handles your data. It
reflects the data-handling contract in the PRD (§9) and the privacy controls
in §7.7. If anything here ever drifts from what the code does, the code is the
bug — the public collector package is open source precisely so you can check.

> **Current build status (Phase 1).** Today this is a **local-only analyzer**.
> It reads your AI coding sessions and git history on your machine, scores them
> locally, and prints a Builder Profile in your terminal. **Nothing is
> transmitted anywhere — there is no cloud, no account, and no upload in this
> build.** Everything below about "what each mode transmits" describes the
> *contract for when cloud sync ships in a later phase*, written down now so the
> design can be audited before any data ever moves.

---

## 1. Privacy by construction

The core privacy guarantee is not a promise to scrub your data carefully — it
is that **the sensitive data never enters the pipeline in the first place.**

When a collector reads a transcript or a repo, it converts everything into a
normalized event stream that has **no free-text fields**. Each event is a set of
structural facts — counts, booleans, categories, durations — computed at parse
time:

- *"a prompt was sent; it was 42 words; it referenced a plan; it was a question"*
- *"a change was accepted; a test run followed it"*
- *"a commit touched 3 files, +120/−15 lines, and touched a test file"*

The prompt text, the code, the diff, the commit message, the file paths — none
of it is ever stored in the event. There is no field for it to live in, so there
is nothing raw to leak, even by accident. The event schema is *strict*: an
unexpected field is rejected at validation, so a collector bug that tried to
smuggle raw text in would fail loudly instead of silently shipping it.

Redaction (below) exists as **defense in depth** for the few free-text surfaces
that fall outside this schema. It is never the backstop the privacy story rests
on — because redaction is probabilistic, and a probabilistic guard is the wrong
foundation for a privacy-first product.

## 2. What never leaves your machine

In **any** mode, these are never transmitted:

- raw source code and file contents
- API keys, credentials, tokens, and secrets
- environment variable values
- full file paths (only structural counts/ratios, never the paths themselves)
- raw transcripts of your AI coding sessions

## 3. What each mode transmits

You choose a privacy mode at `cosq init`; you can change it anytime by editing
`~/.cosquared/config.toml`, and a per-repo `.cosquared.toml` can override it for a
single repository (e.g. keep a work repo `local-only` while side projects sync).

| Mode | What it would transmit (once cloud sync exists) |
|------|--------------------------------------------------|
| **Local-only** | **Nothing.** Analysis runs entirely offline; no data leaves the machine, ever. |
| **Metadata** *(default)* | Event counts, score inputs, deterministic redacted summaries, and repo-shape signals (e.g. `has_tests: true`, `test_file_ratio: 0.12`), plus language/framework labels, plus your Builder Profile (your Builder Type, score breakdown, and the evidence behind each number). Never raw code or transcripts. |
| **Rich** | **Designed but deferred — not built at launch.** It *would* transmit redacted transcript excerpts with a mandatory `cosq inspect` review before each upload — but only if it is ever built. See [experiments/E1-summaries-vs-excerpts.md](experiments/E1-summaries-vs-excerpts.md). |

**One temporal detail, disclosed plainly:** the evidence behind each score
cites the **date** of an example session ("tests ran in 4 of 11 sessions —
e.g. Jun 17"). That is a calendar date only — never a wall-clock time, and
never a session identifier. It is the single piece of timing information that
leaves your machine, kept deliberately coarse (PRD §9 data minimization) so a
citation can point you at the right day without revealing when you work.

`init` only offers **Local-only** and **Metadata** — and that is what ships.
Rich is **not built at launch.** It earns a build only if early users find
summaries too thin to coach well *and* Experiment E1 then shows redacted
excerpts measurably beat structured summaries. Until that happens (and it may
never), the product ships two modes and the claim *"raw transcript text never
leaves your machine — in any mode."* We defer the build, not just the test:
Rich is the only mode that would put verbatim text on the wire, so it is the
only one carrying leaked-secret risk — and redaction (§4) can't be the
backstop.

## 4. The redaction pipeline (and why it is not the guarantee)

For the free-text surfaces that exist outside the structured schema (today: none
in the upload path; later: crash reports if you opt in, and Rich-mode excerpts
if Rich ships), a redaction engine removes secrets before the text is ever
serialized toward a network buffer. It uses detection rules derived from
[gitleaks](https://github.com/gitleaks/gitleaks), and it is validated against a
secrets corpus whose test suite is **release-blocking** — a release cannot ship
if that suite is red.

But redaction is **defense in depth, not the privacy guarantee.** Redaction is
probabilistic: secret-detection tooling misses a meaningful fraction of secrets
in evaluations, and a single leaked credential is a brand-ending event for a
privacy-first product. That is exactly why the primary mechanism is the
no-free-text schema in §1 — there is nothing to redact in the structured path
because there is nothing raw there to begin with. Redaction guards the edges;
it does not hold up the roof.

## 5. Inspect, deletion, and the AI provider

- **Inspect before upload.** Before any first-time upload (when cloud sync
  ships), `cosq inspect` shows you the *exact* bytes that would be sent —
  byte-identical to what an upload would transmit — so you can verify it before
  trusting it.
- **Deletion is honest about backups.** `cosq delete --all` deletes your live
  rows within 24 hours. Database backup snapshots that contain already-deleted
  data expire within 30 days and are never restored except for disaster
  recovery. Both halves are stated plainly here and, verbatim, in the deletion
  receipt the command prints — a server-generated `{ receipt_id, deleted_at }`
  that is your proof the account is gone — because a privacy-first product that
  quietly keeps deleted data in backups is one audit away from a scandal. (The
  receipt itself is ephemeral: nothing tied to the deleted account is retained
  to "verify" it later — the real proof is that re-auth fails and the dashboard
  404s.) `cosq delete --local` clears only this machine's token + config and
  sends nothing.
- **The AI provider.** The coaching narrative on your Builder Profile — the
  short "coach's read" of your scores — is the one place an AI model is involved,
  and it sees **only your already-redacted structured profile**: the same
  counts, ratios, enums, and dates the dashboard itself renders (e.g. *"tests ran
  in 4 of 11 sessions"*, your Builder Type, the recommended focus). It is sent to
  Anthropic's Claude API to be turned into plain-language coaching prose. **The
  AI provider never sees your code, your prompts, your transcripts, or your file
  paths — there is no path for that raw data to reach it** (§1, §2). The model
  may only restate the numbers it is given; it is constrained never to invent a
  fact, a trend, or a comparison (PRD §7.6). The Anthropic calls run under a
  **zero-retention, no-training** posture — an account/workspace-level
  configuration and documented commitment (not a per-request code flag): your
  data is not retained by the provider and is not used to train models. The
  generated narrative is stored on your analysis row and is **visible only to
  you** — row-level security scopes it to your account, exactly like every other
  field (PRD §2.3). ("Does the AI provider see my data?" is a top user question,
  so it is answered here directly.)

## 6. No default-on telemetry

Error reporting and usage analytics are **opt-in and off by default.** You are
asked once, at `cosq init`; if you decline (the default), nothing diagnostic is
ever collected. If you opt in, crash reports and analytics events pass through
the same redaction pipeline as everything else before they are sent. There is no
hidden, default-on crash reporter — that anti-pattern is precisely what this
product is built to avoid.

---

*The product is **CoSquared** (CLI command `cosq`).*
