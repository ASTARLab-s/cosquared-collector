# Privacy

This is the plain-language version of how this tool handles your data. It
reflects the data-handling contract in the PRD (§9) and the privacy controls
in §7.7. If anything here ever drifts from what the code does, the code is the
bug — the public collector package is open source precisely so you can check.

> **Current build status (soft launch).** Cloud sync is live: you can sign in
> (`cosq login`, or inline during `cosq analyze`), upload a metadata-only Builder
> Profile, and — if you opt in — have it refresh automatically each day (§7).
> **Local-only mode still transmits nothing**, and raw source, transcripts, and
> secrets never leave your machine in *any* mode (§2). Everything below is the
> data-handling contract you can audit against the open-source collector.

---

## 1. Privacy by construction

The core privacy guarantee is not a promise to scrub your data carefully — it
is that **the sensitive data never enters the pipeline in the first place.**

The tool reads the local session stores of **Claude Code**
(`~/.claude/projects/`), **Codex CLI** (`~/.codex/sessions/`), and **Cursor**
(`~/Library/Application Support/Cursor/` on macOS) — all **read-only** and
**metadata-only**, under the same guarantees below. Cursor's history lives in a
SQLite database, which is opened read-only and never modified.

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
| **Metadata** *(default)* | Event counts, structural score inputs, repo-shape signals (e.g. `has_tests: true`, `test_file_ratio: 0.12`), and your Builder Profile (Builder Type, score breakdown, confidence, and structured evidence with date-only citations). It sends no summaries, language list, or framework labels — and never raw code or transcripts. |
| **Rich** | **Designed but deferred — not built at launch.** It *would* transmit redacted transcript excerpts with a mandatory `cosq inspect` review before each upload — but only if it is ever built. See [experiments/E1-summaries-vs-excerpts.md](experiments/E1-summaries-vs-excerpts.md). |

**One temporal detail, disclosed plainly:** the evidence behind each score
cites the **date** of an example session ("tests ran in 4 of 11 sessions —
e.g. Jun 17"). That is a calendar date only — never a wall-clock time, and
never a session identifier. It is the single piece of timing information that
leaves your machine, kept deliberately coarse (PRD §9 data minimization) so a
citation can point you at the right day without revealing when you work.

**Repo labels (a small, disclosed name-only relaxation).** So your dashboard can
list your repos by name instead of opaque hashes, a cloud sync also sends each
repo's **name** — the git `owner/repo` slug when there is an `origin` remote,
otherwise the repo's folder name. That is *all* it sends: never the full path,
never code, never secrets or env values, and the name is run through the same
redaction pipeline (§4) as defense in depth. It is a **separate** write from your
analysis, so `cosq inspect` still shows the exact analysis bytes unchanged. This
is bounded on every side:

- It is **never** sent for a **Local-only** repo (those transmit nothing, ever).
- You can **rename or remove** any label from the dashboard at any time; a name
  you set by hand is never overwritten by a later automatic sync.
- You can turn it off entirely with `upload_repo_label = false` in
  `~/.cosquared/config.toml` — your repos then show up under a label-free handle
  like `repo-9f3a`.

We chose to send the name by default because a readable dashboard is worth far
more than silent hash-matching, and a repo's name is low-sensitivity. The hard
guarantees above it — code, secrets, env values, full paths, raw transcripts
never leaving your machine — are unchanged and absolute.

**Work type (a single, closed-enum label).** To tailor your agent/workflow
recommendations, CoSquared infers a **work type** — one of a fixed set
(*AI-native builder*, *student*, *backend*, *founder*) — from **local** repo
signals **on your machine** (file extensions, dependency manifests, whether you
use AI tooling). Only the resulting **category label** is transmitted — never
the languages, frameworks, or files it looked at. This adds **no new data class**
beyond that one label (the same posture as repo labels above). It is fully under
your control: pin it with `--work-type`, set `work_type` in
`~/.cosquared/config.toml`, or pick it on the dashboard — and a value you set by
hand is never overwritten by a later automatic guess. The recommendation
artifacts themselves are curated, human-reviewed templates authored by
CoSquared; nothing about your code is sent to produce them.

**Marketplace install records (a closed-enum label, like work type).** When you
install a marketplace item with `cosq add <slug>` while signed in, the CLI
records **which catalog item** you applied to **which repo**: the item's slug —
a **closed enum published by the server** (the same list you can browse at
`/marketplace`; the CLI cannot send an arbitrary string that the server would
store, unknown slugs are rejected) — the repo's opaque id hash, the catalog
version, and a timestamp. That is the whole record: no path, no code, no file
contents, no free text from your machine. It exists so your own coaching report
can tell you honestly whether the thing you installed changed how you work.
Bounded on every side, same as repo labels:

- **Anonymous browsing, copying, and installing send nothing.** The catalog
  routes are public and unauthenticated; `cosq add` works signed out and then
  records nothing.
- It is **never** sent for a **Local-only** repo.
- It rides a **separate** write, never the analysis payload — `cosq inspect`
  byte-parity is untouched.
- A failure to record never blocks the install — the files are already yours.
- Install records are deleted with everything else by `cosq delete --all`
  (`DELETE /v1/me`), and are visible only to you (row-level security).

`init` only offers **Local-only** and **Metadata** — and that is what ships.
Rich is **not built at launch.** It earns a build only if early users find
summaries too thin to coach well *and* Experiment E1 then shows redacted
excerpts measurably beat structured summaries. Until that happens (and it may
never), the product ships two modes and the claim *"raw transcript text never
leaves your machine — in any mode."* We defer the build, not just the test:
Rich is the only mode that would put verbatim text on the wire, so it is the
only one carrying leaked-secret risk — and redaction (§4) can't be the
backstop.

### The platform Evaluation API is a separate surface

The Evaluation API is not the personal coaching upload path above. It is a
platform-facing processor service: a platform sends pseudonymous subject IDs
and a closed catalog of workflow observations, and receives deterministic
dimension results. The event envelope is no-free-text by construction — no
field accepts code, prompts, transcripts, paths, commit messages, names, or
email addresses. Unknown fields and identifiers outside the published opaque
ID charset are rejected.

For this surface, the integrating platform is the data controller and
CoSquared is its processor. Before live-mode access, the platform must accept
the platform data covenant: inform participants that workflow telemetry is
being evaluated, disclose evaluation as the purpose, use pseudonymous IDs, and
honor subject access/deletion requests. Test and live API data are segregated.
The Evaluation API runs the published deterministic scorer only; no LLM sees
these events or results.

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

## 7. Continuous tracking (background sync)

A profile is only useful if it stays current, so the tool can refresh it for you
once a day. This is **opt-in**: you are asked once during onboarding (*"Track my
sessions automatically each day?"*), and nothing is scheduled unless you say yes.

- **What it transmits.** A background run of `cosq sync` sends the **exact same
  metadata-only payload** as `cosq analyze`, governed by the **same privacy
  mode** (global and per-repo). A `local-only` repo is **never** uploaded by
  sync. Run `cosq inspect` anytime to see the precise bytes — sync uploads
  nothing `inspect` doesn't show.
- **It only re-uploads real changes.** A per-repo watermark (the newest session
  timestamp already synced, stored in `~/.cosquared/sync-state.json`) means a
  repo with no new AI sessions uploads nothing. Re-running sync after a quiet day
  sends zero data and creates no new server row.
- **It is quiet and background-safe.** Sync never signs you in interactively and
  never prompts. With no stored token, or while paused, it does nothing and exits
  cleanly — it cannot nag you or block.
- **See it / pause it.** `cosq status` shows whether tracking is on, paused,
  signed in, your privacy mode, and the last sync. `cosq pause` stops all syncing
  immediately (the scheduled job stays installed but does nothing); `cosq resume`
  turns it back on.
- **Remove it completely.** `cosq delete --scheduler` uninstalls the OS timer and
  clears the local sync state. `cosq delete --local` and `cosq delete --all` also
  remove the timer + sync state as part of de-provisioning.

The schedule is a normal user-level OS job — a **launchd LaunchAgent** on macOS
(`~/Library/LaunchAgents`) or a **systemd user timer** on Linux
(`~/.config/systemd/user`) — running only as your user, never as root. On Linux,
a `--user` timer only runs while you have an active login session unless
*lingering* is enabled; the installer prints the one command to enable it
(`loginctl enable-linger <you>`) rather than running it silently, since it needs
privileges and is a surprising side effect to apply without asking.

## 8. Weekly report emails

Once you have analyses building up, the product can email you a short **weekly
report** — a coaching read of how your three scores moved week over week.

- **It is generated server-side from data you already uploaded.** The report is
  computed entirely from the **metadata-only Builder Profiles already on your
  account** (the same counts, ratios, enums, and dates `cosq inspect` shows).
  Nothing new leaves your machine to produce it: the week-over-week deltas are
  computed deterministically on the server, and the AI model that writes the
  prose sees **only those computed numbers** — never your code, prompts,
  transcripts, or paths (§1, §5). The model may only restate the numbers it is
  given; it is constrained never to invent a trend, a comparison, or a number
  (PRD §7.6).
- **What the email contains.** Your own scores and their changes for the period,
  a couple of sentences of coaching prose derived from them, and links back to
  your dashboard and trends. It contains only your own data and is sent only to
  you.
- **It is owner-visible only.** The stored report is scoped to your account by
  row-level security, exactly like every other field (PRD §2.3) — no one else,
  including admins, can see your individual report.
- **Unsubscribe is one click.** Every report carries a visible unsubscribe link
  (and a `List-Unsubscribe` header). Following it stops all future weekly emails
  immediately; it needs no login — the link itself is the authorization. Deleting
  your account (`cosq delete --all`) also removes your reports and preferences via
  the same cascade as the rest of your data (§5).

## 9. Renamed or moved projects (local-only recovery)

Your AI tools file session history under the folder path a repo lived at when
the session ran. Rename or move a project and the pre-move sessions get stranded
under the old path — a "phantom" repo that would otherwise score as empty while
the real repo loses that history. To fix this, you can add a **`[[project_alias]]`**
block to `~/.cosquared/config.toml` linking the old path(s) to the repo's current
path (or let `cosq attach` write it for you):

```toml
[[project_alias]]
canonical = "/home/you/dev/myapp-v2"   # the repo's current path
merge = ["/home/you/dev/myapp"]         # old path(s) to fold in
```

This map is **local-only config** — it is **never transmitted** and adds **no
new data class**. It only changes *which local session buckets are analyzed
together*: the merged analysis uploads under the canonical repo's existing id,
and the only name ever sent is still the canonical repo's label (§3, the same
`upload_repo_label` behavior). It is hand-editable and fully **reversible** —
delete the block to undo, with no server-side state to unwind, since the cloud
already keys on the canonical id. Every guarantee in §2 (code, secrets, env
values, full paths, raw transcripts never leaving your machine) is unchanged.

## 10. Bug reports you choose to send

Everything above describes data the tool collects *about your work*. This
section is different: it covers the one place where **you type free text and ask
us to read it** — the **Report a bug** form in the signed-in web app.

- **It is manual, never background.** Nothing is captured unless you open the
  form, write a report, and press Send. This is not telemetry, and it is not
  related to the opt-in error reporting in §6.
- **What is sent.** The fields you fill in (a one-line summary, what happened,
  optional steps, expected behavior, and an optional "browser and OS" note you
  type yourself), the closed set of choices you pick (area, type, impact,
  frequency), **which app page you started from** — as one value from a fixed
  list like `dashboard` or `trends`, never a URL — and **the email address you
  signed in with**, so we can reply. Every text field is length-bounded.
- **What is not sent.** No scores, no Builder Profile, no repo names or ids, no
  analysis ids, no code, no transcripts, no browser fingerprint, and no
  User-Agent. The "browser and OS" field exists precisely so that context is
  something you choose to give, in your own words.
- **Your text is redacted first.** Before your report is stored anywhere, it
  passes through the **same open-source redaction engine** described in §4:
  anything shaped like a secret, an API key, a credential in a URL, an email
  address, or an absolute path under your home directory is replaced with a
  `[REDACTED:…]` placeholder. The confirmation tells you how many values were
  removed. **Please still don't paste code, prompts, transcripts, or
  credentials** — redaction is defence in depth, not a licence to paste secrets.
- **Where it goes.** The redacted report and your sign-in email are filed in
  **CoSquared's private Notion workspace**, which is where we triage bugs. A
  **minimal notification** goes to the team through Resend (our email provider):
  it carries only the report's short id, the redacted one-line summary, the
  category labels, the redaction count, and a link to the Notion page — not the
  body of your report, and not your email address.
- **We keep a private copy to make delivery reliable.** Your report is saved to
  our database first, so that if Notion or email is temporarily unavailable your
  report is not lost and you are never asked to write it again. That copy is
  readable only by CoSquared's servers — not by other users, and not through the
  public API.
- **Deleting your account deletes it.** Bug reports are removed with everything
  else by the same cascade described in §5. Because the Notion copy lives
  outside our database and cannot be cascaded, deleting your account
  **immediately queues that page to be moved to Notion's Trash**, and cancels
  any delivery still in progress.
- **Retention, stated honestly.** Once a report has been marked Fixed, Closed,
  or Won't fix, it stays in the active tracker for **90 continuous days** and is
  then moved to Notion's Trash and removed from our database. Reopening a report
  restarts that clock. **The Notion API cannot permanently delete a page** — it
  can only move it to Trash — so final destruction depends on Notion's own trash
  handling and on the workspace owner emptying it. We would rather say that than
  promise a guarantee the API does not give us.

Every guarantee in §2 is unchanged by this feature: your code, your secrets,
your env values, your full paths, and your raw transcripts still never leave
your machine. A bug report contains what you typed, and nothing else.

---

*The product is **CoSquared** (CLI command `cosq`).*
