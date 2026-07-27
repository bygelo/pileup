# Changelog

Notable changes to pileup. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versions follow [semver](https://semver.org/spec/v2.0.0.html).

Current state — what pileup is and how to run it — lives in [README.md](README.md).
Planned work lives in [ROADMAP.md](ROADMAP.md). This file is history only.

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
  description vocabularies. Built to supply the evidence piper's `promotions.json`
  says it lacks: *"Promotion is judgment-driven for now (no automated gate)."*
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

[0.1.0]: https://github.com/bygelo/pileup/releases/tag/v0.1.0
