# Changelog

Notable changes to pileup. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versions follow [semver](https://semver.org/spec/v2.0.0.html).

Current state — what pileup is and how to run it — lives in [README.md](README.md).
Planned work lives in [ROADMAP.md](ROADMAP.md). This file is history only.

## [0.2.1] — 2026-08-19

### Fixed

- **`--json` was truncated at exactly 65,536 bytes whenever anything read it.**
  Every command ended in `process.exit(0)` immediately after `process.stdout.write`.
  On a TTY that write is synchronous and nothing was ever wrong; on a pipe it is
  not, and exiting discarded whatever had not drained — so `pileup fleet --json |
  jq`, or any program spawning pileup, received a fragment of JSON that could not
  parse. The whole-machine reports are the ones large enough to hit it, which is to
  say the ones most likely to be consumed by another tool. Dispatch returns now and
  node exits once stdout drains. [test/pileup.test.mjs](test/pileup.test.mjs) runs
  the CLI as a subprocess against a fixture deliberately larger than the buffer;
  it is the only test here that spawns the binary, because it is the only bug that
  cannot be reproduced in-process.

## [0.2.0] — 2026-08-19

Two halves. The first is a correctness pass forced by changes to Claude Code in
July 2026 — three of pileup's shipped claims had stopped being true, and one was
producing a wrong number rather than a stale one. The second is `pileup fleet`.

### Fixed

- **MCP tool schemas are no longer unconditionally always-on.** Deferred tool
  loading (`ENABLE_TOOL_SEARCH`; Anthropic's Tool Search Tool with
  `defer_loading`) moves them out of the prefix and loads them on demand —
  reportedly ~85% fewer tool-definition tokens, and *better* tool selection at
  scale (published evals: Opus 4.5 from 79.5% to 88.1% correct choice). The `mcp`
  collector asserted the old behaviour as fact. It now detects the setting
  ([lib/toolsearch.mjs](lib/toolsearch.mjs)) and grades two different worlds,
  dropping to `info` when deferral is declared rather than grading a cost it has
  reason to believe is not paid. It reports the *declaration* and says outright
  that it cannot confirm the setting took effect.
- **`pileup mcp-cost` was confounded by that setting.** It prices servers by
  contrasting repos, and repos on opposite sides of deferred loading are not
  comparable samples — the contrast would attribute a setting to a server. It now
  prices inside one cohort, names the repos it set aside and why, and separately
  prices the *setting* by cross-cohort contrast (`mcp-defer-measured`), labelled
  coarse because the cohorts also differ in declared servers.
- **The 200k context window default was five times wrong.** Claude Opus 5 became
  Claude Code's default Opus model with a 1M window, so every share-of-window
  figure computed against 200k overstated severity. [lib/model.mjs](lib/model.mjs)
  now resolves the window — `--window`, then a harness-reported window, then the
  model observed in a transcript, then the default — and the report labels which
  of the four it used. Only the first two are measured.
- **One tokenizer was used for every harness row**, so a Codex row and a Claude
  Code row reported identical token counts for identical files and at least one
  was wrong by up to ~20%. Per-family ratios now apply (tiktoken 0.91, Anthropic
  1.0, SentencePiece 1.13, derived from published cross-tokenizer comparisons —
  *not* a local calibration, which is still the blocked P3 item). The report names
  the tokenizer per row, because a reader who does not know the rows differ by
  vendor will read the difference as a bug.
- **`pileup --only <collector>` silently reported an empty repo.** `audit` passed
  its whole option object to `resolveHarness`, whose own `only` meant *harness
  ids* — so a collector name matched no harness and every harness was filtered
  out. The adapter's option is now `harness`.

### Added

- **`pileup fleet [dir...]`** — every git repo under a directory (or `--repo a,b`),
  with one row per *document* rather than per repo, ranked by
  `paid = tokens per turn × turns measured in the repos it is injected into`.
  This is the ranking a single-repo audit cannot produce: a user-global skill
  bills in every repo on the machine, which looks like a 200-token line item
  forty separate times and never once like the number it is. Turns are measured
  from transcripts; per-turn size is estimated; `paid` applies each document's
  *current* size to every measured turn, and the report says all three.
  - Collapses one document installed into several discovery roots into one row,
    and adds turns once per repo rather than once per installed copy — otherwise
    an installer's choices multiply the frequency half of the ranking.
  - Counts slash-command invocations as well as `Skill` calls, so "never fired"
    covers scripts and commands, not only skills.
### Fixed: deferred tool loading defaults to ON, and pileup said otherwise

The worst bug of the batch, found while about to act on pileup's own advice. The
`mcp` collector treated an unset `ENABLE_TOOL_SEARCH` as *off* and produced a
**HIGH** finding — "deferred tool loading is off, so 10 servers' schemas ride
every turn" — telling the user to enable something already running, and grading a
token cost nobody was paying.

The correction is not from a blog post. [lib/toolsearch.mjs](lib/toolsearch.mjs)
now mirrors the mode resolver decompiled out of the shipped Claude Code binary
(2.1.220): `auto:0` on, `auto:100` off, `auto`/`auto:N` on, truthy on, falsey off,
and **unset → on**. Three independent lines of evidence agree: that resolver, a
session receiving MCP tools as deferred names rather than schemas, and
`mcp-cost` measuring **8 of 8 declared servers at no cost above noise across 34
repos**.

- `mcp-deferred` (info) now covers the deferring case and states whether it is
  declared or defaulted. `mcp-defer-disabled` fires only when something actually
  switched it off — the one case that deserves a severity.
- Added `mcp-defer-confirmed`: confirmation from *measurement* rather than from the
  setting. Declared servers whose measured contrast sits inside the noise floor
  cannot have loaded schemas, and this is the only check that also catches the two
  runtime conditions no file scan can see — a non-first-party `ANTHROPIC_BASE_URL`
  and Vertex AI, which rejects the beta header. It refuses to confirm when
  measurement refutes it, which is tested.
- `mcp-server-count` survives either way, on a narrower claim: past roughly 30–50
  tools, selection degrades however schemas are loaded. That is an accuracy cost,
  not a token one.

### Added: a check that harness facts cannot rot silently

`npm test` now also runs [test/harness-fact.mjs](test/harness-fact.mjs), which
fails when a file hard-codes a fact about someone else's software without a dated
`SOURCE:` comment and a row in [docs/harness-fact.md](docs/harness-fact.md) — the
register of every such fact, what it claims, and how to re-verify it. It caught two
uncited files on its first run.

It proves facts are *documented*, not that they are *true*; the latter needs a live
harness and stays open in the roadmap. Also added `.github/workflows/test.yml`,
which runs the suite on Node 20/22/24, smoke-tests every command, and fails if
pileup ever grows a dependency.

### Fixed in `pileup fleet` before release, by running it against 101 real repos

Every one of these produced a plausible-looking wrong number. None was caught by
a fixture, which is the argument for testing a measurement tool against real data
before believing it.

- **The fleet total summed across harnesses.** A repo with both a `CLAUDE.md` and
  an `AGENTS.md` contributed two documents — correctly, they are two files — but
  adding their cost describes a session nobody has, since only one harness runs at
  a time. On the reference machine those two files were **97% identical** at 116k
  and 102k tokens per turn, so the fleet total was overstated by ~100k per turn in
  one repo alone (3,147M → 1.8B once corrected). This is the rule the single-repo
  audit already followed and the fleet had quietly broken.
- **Command names carried their file extension**, so a command with no `name:`
  frontmatter was recorded as `tna-slack-check.md`. Invocation counting matches
  that name against what transcripts record, and a transcript says
  `/tna-slack-check` — so the name could never match and an actively-used command
  (11 invocations) was reported as **never fired**. Now stripped in
  [lib/collector/definition.mjs](lib/collector/definition.mjs), which fixes the
  name everywhere, not only in fleet.
- **A repo-local skill in two discovery roots counted twice.** Only user-scoped
  documents were deduped by name; a repo holding the same skill in
  `.claude/skills/` and `.agents/skills/` reported it as two documents. Memory
  files are deliberately unaffected — their name *is* the filename, so `CLAUDE.md`
  and `AGENTS.md` remain the two distinct documents they are.
- **Turn counts were silently capped at 20 sessions per repo**, the single-repo
  default, which undercounted one repo's turns by more than half (6,938 against
  14,354) and every `paid` weighted by it with them. `fleet` now reads 200 sessions
  per repo by default and reports `fleet-turn-floor` naming any repo still capped,
  so a floor is never presented as a total.
- **`formatToken` had no billion tier**, so a fleet total printed as `3147M`.
- **`pileup skill` undercounted firing, and falsely called a used skill unused.**
  Found by comparing its numbers against `fleet`'s on the same machine: 51 against
  81 for the same skill. A definition fires through two channels — a `Skill` tool
  call and a `/name` slash command — and `skill` counted only the first, so a skill
  invoked as `/parcel` was reported as **never fired** by the one command whose
  entire job is saying which skills are unused. The counter now lives in
  [lib/invocation.mjs](lib/invocation.mjs) and is shared, because it went wrong
  precisely by existing in two copies that drifted.
- Added `fleet-twin-memory`: a repo carrying parallel instruction files for two
  harnesses, reported for the *opposite* of the obvious reason — it is **not**
  double cost, and two large adjacent rows for one repo invite exactly that
  misreading. What the pair does cost is drift: edit one and the other harness
  keeps running the old rules.

- **Skill descriptions are graded against the harness character budget**, which
  Claude Code sizes at 2% of the context window — 4,000 characters at 200k,
  20,000 at 1M. Over that ceiling it stops being a cost question: descriptions are
  dropped or truncated and which skill loses is not the user's choice.

## [0.1.0] — 2026-07-27

Initial cut. Built in one session, from an empty directory.

### Added

- **`pileup audit`** — ranks a repo's context surface by cost × frequency across four
  surfaces: `always-on` (memory files, skill descriptions, MCP schemas), `cache`
  (prefix churn), `on-read` (docs an agent could open whole), `on-invoke` (skill
  bodies). The ordering lives in the sort, so a small per-turn cost outranks a
  larger one that may never be paid.
- **Seven collectors**, each failing independently so a partial audit still reports:
  `memory`, `definition`, `mcp`, `prefix`, `doc`, `session`, `output`.
- **Harness adapter table** ([lib/adapter.mjs](lib/adapter.mjs)) covering Claude Code,
  Codex, Cursor, GitHub Copilot, Gemini CLI, Windsurf and Aider. Adding a harness is
  one row; nothing downstream knows a harness name.
- **`pileup session`** — measured token spend from local transcripts, including the
  always-on prefix taken from the smallest billed turn of each session.
- **`pileup skill`** — per-skill always-on cost, invocation counts read from real
  `Skill` tool calls, entries missing from a promotion ledger, and colliding
  description vocabularies. Built to supply the evidence a skill-pool
  promotion ledger says it lacks: *"Promotion is judgment-driven for now (no
  automated gate)."*
- **`pileup mcp-cost`** — prices MCP servers by contrast across every repo on the
  machine, since tool schemas are invisible to a file scan.
- **`pileup surface`** — every surface found, ungraded, as JSON.
- **`output` collector** — prices the terseness-skill trade (caveman and relatives)
  against measured sessions rather than repeating a published claim.
- **Codex transcript parsing**, which brought three findings Claude transcripts
  cannot support: the real `model_context_window`, compaction counts, and
  `rate_limits.primary.used_percent` — the provider's own count of subscription
  spend.
- **`skill/SKILL.md`** wrapper so any harness can invoke pileup.
- **17 tests** over generated fixtures; no fixture is committed.

### Changed

- Always-on cost is reported **per harness, never summed**. Only one harness runs at
  a time, and summing would describe a session nobody has. `pileup skill` applies the
  same rule across discovery roots.
- Read-trap detection uses `git ls-files` when the repo is under git, so `.gitignore`
  is respected without reimplementing it. Auditing 34 MB of untracked exports was the
  original symptom.
- Findings are capped and rolled up (top 12 read traps, top 8 descriptions) — an
  unbounded report is its own kind of bloat. The first run against a real repo emitted
  568 findings.
- Description thresholds relaxed to 400/700/1200 characters after the first pass
  flagged 49 healthy descriptions.
- Transcript parsing extracted to [lib/transcript.mjs](lib/transcript.mjs), one reader
  per harness normalising to one shape, so grading never learns a harness name.

### Fixed

- `mkFinding` rejected the `info` severity, which ranks 0 and failed a truthiness
  check. The `output` collector's findings were being silently swallowed by the
  collector error handler.
- Claude and Codex disagree about "input tokens" and the mistake is silent: Claude's
  `input` / `cache_read` / `cache_creation` are disjoint, while Codex's `input_tokens`
  is the whole prompt with `cached_input_tokens` a *subset* of it. Both readers now
  emit the disjoint form; adding Codex's the Claude way reported a cache hit rate
  above 100%.
- Codex logs each compaction twice — once as a `compacted` record, once as a
  `context_compacted` event. Counted once; the count was inflated 52 → 104.
- `pileup skill` descended into `.disabled/` and `.system/`, reporting 29 skills as
  billing every turn when those directories are precisely how a harness is told to
  ignore them.
- The always-on prefix was taken from the first billed turn, which is wrong for
  resumed or compacted sessions that start mid-conversation. It now uses the smallest
  billed turn.
- Column alignment broke wherever an ANSI-tinted string was padded; padding now
  happens before tinting.
- A harness counted as "in use" on the strength of user-global files alone, so a
  stray `~/.gemini` was audited against unrelated repos. Detection now requires the
  repo to say so, with a machine-wide fallback only when no harness is detected.

### Documentation

- [ROADMAP.md](ROADMAP.md) — discovery found **seven mature sibling tools** already in
  this space, two of them ahead of pileup on their own half. The roadmap narrows
  pileup's claim to what it uniquely does: run both halves and report the gap between
  them.
- [docs/roadmap-rejected.md](docs/roadmap-rejected.md) — six rejected candidates with
  verbatim reasons, so future sweeps stay idempotent.
- Corrected an unverified accuracy claim: [lib/token.mjs](lib/token.mjs) and the README
  stated the estimator had been "measured against Claude and GPT tokenizers … within
  roughly 10%". It had not been. Both now state the actual evidence and label it
  uncalibrated.

### Known gaps

- The token estimator is **not calibrated**. See the P3 item in
  [ROADMAP.md](ROADMAP.md).
- Finding-level test coverage is **19 of 32** (59%). Uncovered IDs are listed in the
  roadmap's Triage section.
- No CI.
- Cursor, Copilot, Gemini, Windsurf and Aider adapter rows are **unexercised** — the
  paths are declared but no test or real run has confirmed them.

[0.2.1]: https://github.com/bygelo/pileup/releases/tag/v0.2.1
[0.2.0]: https://github.com/bygelo/pileup/releases/tag/v0.2.0
[0.1.0]: https://github.com/bygelo/pileup/releases/tag/v0.1.0
