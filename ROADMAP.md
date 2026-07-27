# pileup roadmap

Living document. Edited honestly — gaps are gaps, not opportunities.

## Status

v0.1.0. Seven collectors, zero dependencies, 11 tests green. Audits itself clean.

Discovery for this roadmap found **seven mature sibling tools already in this
space** ([ctxlint], [context-viewer], [context-analyzer], [claude-crusts],
[claude-context-optimizer], [claude-token-guard], [AgentLinter]). pileup is not
novel as a category, and two of those siblings are ahead of it on their own half:

- **[ctxlint]** — zero-dep JS, `npx`, 16 clients, ~81 rules. Strictly ahead of
  pileup on *static correctness*: broken paths, commands that don't exist in
  `package.json`, stale references, cross-file contradictions, hardcoded secrets.
- **[context-viewer]** — Python + real `tiktoken`, parses Claude **and Codex**
  transcripts, dollar cost with caching math, compaction timeline, and an
  itemized framework-overhead audit.

What pileup actually has that neither does: it runs **both halves and reports
the gap between them** as a finding, and it ranks by **cost × frequency** rather
than by rule count. The roadmap below defends that position and stops trying to
win the halves outright.

[ctxlint]: https://github.com/YawLabs/ctxlint
[context-viewer]: https://github.com/auditt98/context-viewer
[context-analyzer]: https://github.com/manavgup/context-analyzer
[claude-crusts]: https://github.com/Abinesh-L/claude-crusts
[claude-context-optimizer]: https://github.com/egorfedorov/claude-context-optimizer
[claude-token-guard]: https://github.com/kaviadigdarshan/claude-token-guard
[AgentLinter]: https://agentlinter.com/

---

## P0 — Close before any new feature

| Item | What it closes | Surface | Effort | Benchmark | Status |
|---|---|---|---|---|---|
| **Soften the tokenizer accuracy claim** | [lib/token.mjs](lib/token.mjs) said the estimator was "measured against Claude and GPT tokenizers … within roughly 10%". It was not. [README.md](README.md) repeated it. Shipping an unverified accuracy claim in a measurement tool is the one bug that discredits every other number. | the comment and README section themselves | ~15m | **T3** — `grep -n "Measured against" lib/token.mjs README.md`; PASS iff every accuracy claim is either backed by a committed calibration run or stated as unverified. | ✅ **done 2026-07-27** |
| **Attribute the prefix gap to individual MCP servers** | `prefix-gap` is pileup's highest-severity finding (218k tokens on the reference repo) and it was **unactionable** — it named a number, not a server. Solved by contrast across every repo on the machine rather than by regression: **measured 5 servers costing +270k/turn, and correctly refused to price the 4 that sit inside the noise floor.** | `pileup mcp-cost` | ~4h | **T3** — run against a machine with ≥4 repos whose `.mcp.json` sets differ; PASS iff it prints a token estimate with a sample count, prices a set it cannot decompose as a *set*, and refuses servers appearing in fewer than 2 repos. | ✅ **done 2026-07-27** |
| **Audit the discovery root against a skill pool** | piper's [data/promotions.json](../piper/data/promotions.json) says promotion is "judgment-driven for now (no automated gate)". Measured: it governs **5** entries while **18** distinct skills sit across the discovery roots costing ~2.1k tok/turn. 13 are untracked by the ledger meant to govern them. | `pileup skill` | ~3h | **T3** — `pileup skill --ledger ../piper/data/promotions.json`; PASS iff it lists each discovery-root skill with its always-on cost and flags entries absent from the ledger. | ✅ **done 2026-07-27** |

## P1 — Make the claims true

| Item | What it closes | Surface | Effort | Benchmark | Status |
|---|---|---|---|---|---|
| **Flag skills that never fire** | A skill in the discovery root that no local transcript has ever invoked is pure always-on rent. [ctxlint]'s `skill-orphaned` is static-only — it cannot know what actually fired. This is the exact evidence piper's ledger asks for: *"once an A/B row shows a skill measurably moving an output, add it here."* **Measured: 8 of 18 have never fired across 360 transcripts, costing 742 tok/turn — and 3 of those 8 are in the ledger.** | `pileup skill` | ~2h | **T3** — PASS iff a skill absent from every scanned transcript is listed with its per-turn cost, a known-invoked one is not, and no claim is made when zero transcripts were scanned. | ✅ **done 2026-07-27** |
| **Detect colliding skill descriptions** | Two skills whose descriptions overlap cause misrouting *and* pay always-on twice. Measured on this machine: `akonga-agentko-design` ↔ `study-design` at 29% shared vocabulary, `orsem-sync-docs` ↔ `orsem-contribute` at 23%. External work puts description wording at ~20× impact on activation odds. | `pileup skill` | ~2h | **T3** — PASS iff both known pairs are reported and no pair below the threshold is. | ✅ **done 2026-07-27** |
| **Parse Codex session transcripts** | [lib/adapter.mjs](lib/adapter.mjs) advertises Codex support, but [lib/collector/session.mjs](lib/collector/session.mjs) `transcriptDir()` reads only `~/.claude/projects`. Every session-derived finding silently reports nothing for a Codex user. [context-viewer] parses `~/.codex/sessions` already, so the format is tractable. | `pileup session` on a Codex repo | ~4h | **T3** — run `pileup session` in a repo with `~/.codex/sessions` history; PASS iff turns and prefix are non-zero, or it prints an explicit unsupported-format note. Currently prints nothing at all. | 🔴 open |

## P2 — Coverage

| Item | What it closes | Surface | Effort | Benchmark | Status |
|---|---|---|---|---|---|
| **Report compaction as a cost event** | [lib/collector/session.mjs](lib/collector/session.mjs) ignores compaction entirely. Each compact rewrites the whole prefix at cache-write price (1.25×), and `/compact` discipline is one of the most-repeated community recommendations. | `pileup session` | ~3h | **T3** — PASS iff a session with ≥2 compactions reports the count and the cache-write tokens attributable to them. Currently reports neither. | 🔴 open |
| **Markdown report output** | Findings are terminal or raw JSON only. A repo that wants this in a PR comment or a doc has to write the formatter. `data` payloads were built for diffing runs ([lib/finding.mjs](lib/finding.mjs)) but nothing consumes them. | `pileup --format md` | ~2h | **T3** — `pileup --format md > out.md`; PASS iff the file renders as valid markdown with one section per surface. Currently fails — flag unrecognized. | 🔴 open |

## P3 — Research

| Item | What it closes | Surface | Effort | Benchmark | Status |
|---|---|---|---|---|---|
| **Calibrate the estimator against ground truth** | The honest version of the P0 claim-softening. Needs authoritative token counts pileup cannot currently obtain. See Triage. | `npm run calibrate` | unknown | **T2** — live procedure: count a committed corpus via the Anthropic `count_tokens` endpoint, compare to `estimateToken`, PASS iff median absolute error ≤ 12%. Not runnable without an API key. | 🔵 blocked |

---

## What we explicitly are NOT going to do

Full reasons in [docs/roadmap-rejected.md](docs/roadmap-rejected.md).

| Rejected | Reason |
|---|---|
| Dashboard, TUI, live file-watching, SSE | Adds a server and a UI to a report-only CLI. Fails the deletion test — [context-analyzer] and [context-viewer] already do this well. |
| Dollar-cost calculation | Needs a per-model price table that rots the moment pricing changes. pileup uses relative ratios deliberately; they survive repricing. |
| Auto-fix and pasteable fix commands | Report-only is a deliberate constraint, not a missing feature. pileup points at other people's repos. |
| Reimplementing [ctxlint]'s correctness rules | Different axis: ctxlint asks "is this context file *true*", pileup asks "what does it *cost*". Recommend it in the README; do not absorb it. |
| Bundling a real tokenizer | Breaks the zero-dependency distribution story, which is the reason `npx pileup` works with no install. |
| MCP schema trimming or proxying | That is a runtime component. pileup is an auditor and does not sit in the request path. |

## Triage

| Item | What is blocking |
|---|---|
| Tokenizer ground-truth calibration | Needs an Anthropic API key for `count_tokens`, or a corpus with authoritative counts committed once. Decide which. |
| Whether pileup becomes a piper pipeline stage or stays standalone | Product decision. Standalone keeps the open-source story clean; a stage gets promotion-gating for free. Not resolvable from the code. |
| Whether the 30% prose-share constant in [lib/collector/output.mjs](lib/collector/output.mjs) holds | Taken from published terseness-skill measurements, not from these transcripts. Measurable by classifying output blocks as prose vs code, but that needs a classifier pileup does not have. |
