# pileup roadmap

Living document. Edited honestly — gaps are gaps, not opportunities.

## Status

v0.1.0 plus an unreleased correctness pass and `pileup fleet`. **Six commands**,
seven collectors, zero dependencies, **25 tests green**. Audits
itself clean. **P0 and P1 are closed**; what remains is one P2 row, one blocked
research item, and the test-coverage and CI gaps recorded in Triage.

**A new standing risk, added 2026-07-30.** The correctness pass above existed
because the harness moved and pileup did not: three shipped claims had quietly
become false and one was producing a wrong number rather than a stale one.
Deferred tool loading invalidated the premise of the `mcp` collector, Opus 5's 1M
default made every share-of-window figure overstate by five times, and one
tokenizer across every harness row guaranteed at least one wrong row. None of
this was caught by a test, because all the tests asserted pileup's own logic and
none asserted anything about the world it models. That is now a permanent P1
item — see **Track the harness** below — not a one-off cleanup.

Shipped history is in [CHANGELOG.md](CHANGELOG.md); this file is forward-looking only.

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
| **Audit the discovery root against a skill pool** | a skill-pool manager's promotion ledger states that promotion is "judgment-driven for now (no automated gate)". Measured: it governs **5** entries while **18** distinct skills sit across the discovery roots costing ~2.1k tok/turn. 13 are untracked by the ledger meant to govern them. | `pileup skill` | ~3h | **T3** — `pileup skill --ledger <promotions.json>`; PASS iff it lists each discovery-root skill with its always-on cost and flags entries absent from the ledger. | ✅ **done 2026-07-27** |

## P1 — Make the claims true

| Item | What it closes | Surface | Effort | Benchmark | Status |
|---|---|---|---|---|---|
| **Flag skills that never fire** | A skill in the discovery root that no local transcript has ever invoked is pure always-on rent. [ctxlint]'s `skill-orphaned` is static-only — it cannot know what actually fired. This is the exact evidence such a ledger asks for: *"once an A/B row shows a skill measurably moving an output, add it here."* **Measured: 8 of 18 have never fired across 360 transcripts, costing 742 tok/turn — and 3 of those 8 are in the ledger.** | `pileup skill` | ~2h | **T3** — PASS iff a skill absent from every scanned transcript is listed with its per-turn cost, a known-invoked one is not, and no claim is made when zero transcripts were scanned. | ✅ **done 2026-07-27** |
| **Detect colliding skill descriptions** | Two skills whose descriptions overlap cause misrouting *and* pay always-on twice. Measured on this machine: two design skills at 29% shared vocabulary and two docs skills at 23%. External work puts description wording at ~20× impact on activation odds. | `pileup skill` | ~2h | **T3** — PASS iff both known pairs are reported and no pair below the threshold is. | ✅ **done 2026-07-27** |
| **Parse Codex session transcripts** | [lib/adapter.mjs](lib/adapter.mjs) advertised Codex support while `session` read only `~/.claude/projects`, so every session finding silently reported nothing for a Codex user. Parsing lives in [lib/transcript.mjs](lib/transcript.mjs) now, one reader per harness, normalising to one shape. **Validated on 259 local rollouts.** | `pileup session` on a Codex repo | ~4h | **T3** — run `pileup session` in a repo with `~/.codex/sessions` history; PASS iff turns and prefix are non-zero and cache hit stays ≤100% (Codex counts cached tokens as a subset of the prompt, not a sibling). | ✅ **done 2026-07-27** |

## P1 — Keep the claims true as the harness moves

| Item | What it closes | Surface | Effort | Benchmark | Status |
|---|---|---|---|---|---|
| **Track the harness** (partly closed) | The July 2026 pass found three false claims and one wrong number, none caught by a test. Every hard-coded fact about a harness — the model→window table in [lib/model.mjs](lib/model.mjs), the 2% skill budget in [lib/budget.mjs](lib/budget.mjs), the tokenizer ratios in [lib/token.mjs](lib/token.mjs), the `ENABLE_TOOL_SEARCH` key in [lib/toolsearch.mjs](lib/toolsearch.mjs) — is a claim about somebody else's release notes and rots silently. | all of them | ~2h | **T3** — every such constant carries a dated source comment, and one place lists them for review. PASS iff `grep` finds no undated harness fact in `lib/`. | 🟡 **half done 2026-07-30** — [test/harness-fact.mjs](test/harness-fact.mjs) enforces citation + registration in `npm test`, and [docs/harness-fact.md](docs/harness-fact.md) is the register. Still open: nothing asserts a fact is *true*, only that it is dated. |
| **A dated provenance comment on every borrowed number** | The tokenizer ratios and the 85%/88.1% deferral figures come from third-party writeups, not from local runs. They are cited in prose but not dated in code, so a future reader cannot tell a measured constant from a borrowed one. | [lib/token.mjs](lib/token.mjs), [lib/collector/mcp.mjs](lib/collector/mcp.mjs) | ~30m | **T3** — PASS iff each borrowed constant names its source and the date it was read. | ✅ **done 2026-07-30** — enforced, not just written. |
| **Verify deferred loading instead of trusting the declaration** | Went from nice-to-have to urgent: pileup had the default backwards and produced a HIGH finding telling the user to enable something already on. Solved from the other side — `mcp-defer-confirmed` confirms from **measured** per-server contrast rather than a before/after, so it needs no setting change to observe, and it catches the runtime host conditions a file scan cannot. **Measured 8 of 8 servers free across 34 repos.** | `pileup mcp-cost` | ~3h | **T3** — PASS iff a machine whose servers measure inside the noise floor reports confirmation, and one whose servers measurably cost tokens does NOT. Both asserted. | ✅ **done 2026-07-30** |

## P2 — Coverage

| Item | What it closes | Surface | Effort | Benchmark | Status |
|---|---|---|---|---|---|
| **Report compaction as a cost event** | Session parsing ignored compaction entirely. Each compact discards the cached prefix and rebuilds it at cache-write price, and `/compact` discipline is one of the most-repeated community recommendations. **Measured: 52 compactions across 20 sessions in one repo, ~21k rewritten each.** | `pileup session` | ~3h | **T3** — PASS iff a session with ≥2 compactions reports the count and the tokens attributable to them, counting a Codex compaction once despite it being logged twice. | ✅ **done 2026-07-27** |
| **Surface measured subscription quota** | Not in the original sweep — found while reading the Codex format. Codex transcripts carry `rate_limits.primary.used_percent`, the provider's own count of how much of the plan window is spent. That is ground truth for the subscription half of pileup's premise, and no estimate can substitute for it. **Measured 100% of a 1-week pro window on this machine.** | `pileup session` | ~1h | **T3** — PASS iff a repo with Codex transcripts reports the used percentage, its window length and the plan, and Claude-only repos report nothing rather than guessing. | ✅ **done 2026-07-27** |
| **Use the reported context window** | Also found mid-build. Codex records `model_context_window`, so pileup no longer has to assume 200k when the transcript states otherwise. | `pileup session` | ~30m | **T3** — PASS iff a mismatch between the assumed and reported window is reported with the exact `--window` value to re-run with. | ✅ **done 2026-07-27** |
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

## Test-coverage gaps

Measured 2026-07-30 by cross-checking every `mkFinding` id in `lib/` against the ids
asserted in `test/`: **28 of 45 covered (62%)**, against 19 of 32 (59%) on 2026-07-27.
Not a line-coverage number — for this codebase the meaningful unit is "does a finding
have a test that proves it fires".

Every finding added in the July 2026 pass ships with a test that asserts it by id
(`mcp-deferred`, `mcp-defer-available`, `mcp-cost-defer-confound`,
`mcp-defer-measured`, `skill-budget-fill`, `fleet-top-cost`, `fleet-unfired-rent`,
`fleet-no-frequency`) — which is why the ratio moved despite eleven new ids.

The uncovered ids, and why each is unproven:

| Uncovered finding | Why it has no test |
|---|---|
| `session-measured-prefix`, `session-low-cache-hit`, `session-model-switch`, `session-heavy-tool-result`, `session-compaction` | Session findings were validated against real local transcripts, never against a fixture. They are the most-cited numbers in the report and the least defended. **Highest-value gap.** |
| `prefix-gap` | Needs a fixture pairing a static surface with transcripts, which no fixture builds yet. |
| `definition-description-total`, `definition-fat-body`, `definition-no-description` | The bloated fixture triggers `definition-fat-description` only. |
| `doc-total-exposure`, `doc-more-trap` | Both are rollups that need more oversized files than the fixture creates. |
| `prefix-volatile-memory` | Requires a fixture repo with real git history. |
| `skill-pool-ratio` | Informational; fires whenever a pool exists. |
| `window-assumed` | Needs a fixture whose transcripts name a model with no known window — easy, just not built. |
| `fleet-skewed-repo`, `fleet-truncated` | The fleet fixture is three small repos, so neither the 2× skew threshold nor the `--limit` truncation path is reached. |

Closing this is a **T3** item: PASS iff every `mkFinding` id in `lib/` appears in a test
assertion, checkable with the same cross-check that produced this table. Worth doing as
one batch rather than a roadmap row per finding.

## Triage

| Item | What is blocking |
|---|---|
| ~~No CI~~ | ✅ Closed 2026-07-30. [.github/workflows/test.yml](.github/workflows/test.yml) runs the suite on Node 20/22/24, smoke-tests every command, and fails if pileup grows a dependency. |
| Five adapter rows are unexercised | Cursor, Copilot, Gemini, Windsurf and Aider paths are declared in [lib/adapter.mjs](lib/adapter.mjs) but no test or real run has confirmed them. Needs either fixtures per harness or an honest downgrade of the claim in the README. |
| Tokenizer ground-truth calibration | Needs an Anthropic API key for `count_tokens`, or a corpus with authoritative counts committed once. Decide which. |
| Whether pileup becomes a piper pipeline stage or stays standalone | Product decision. Standalone keeps the open-source story clean; a stage gets promotion-gating for free. Not resolvable from the code. |
| Whether the 30% prose-share constant in [lib/collector/output.mjs](lib/collector/output.mjs) holds | Taken from published terseness-skill measurements, not from these transcripts. Measurable by classifying output blocks as prose vs code, but that needs a classifier pileup does not have. |
