# Rejected roadmap candidates

Idempotency anchor. Read this before any `/roadmap` run so a killed idea is not
re-surfaced. One line of verbatim reason per entry; append, never delete.

## 2026-07-27 — first sweep (caveman-adjacent tooling + piper interop)

Discovered 14 candidates across project signals, seven sibling GitHub repos, and
two web passes. Six rejected.

**Dashboard / TUI / live file-watching / SSE updates**
Sourced from `manavgup/context-analyzer`, `auditt98/context-viewer`,
`Abinesh-L/claude-crusts`. Rejected: fails the deletion test — it adds a server
process and a UI layer to a tool whose entire distribution story is
`npx pileup` printing to stdout. Two siblings already do this well; competing
with them costs the thing that makes pileup easy to adopt.

**Dollar-cost calculation**
Sourced from `context-viewer` (per-model pricing incl. caching math) and
`egorfedorov/claude-context-optimizer` (ROI reports, budget alerts). Rejected:
requires a maintained per-model price table, which is stale the day pricing
changes and silently wrong afterwards. `lib/budget.mjs` uses relative price
*ratios* instead, which hold across model tiers and across repricing, and which
work identically for subscription quota where dollars do not apply.

**Auto-fix / pasteable fix commands**
Sourced from `claude-crusts` ("pasteable fix commands", "auto-inject for
self-healing context") and `kaviadigdarshan/claude-token-guard` ("auto-fixes").
Rejected: report-only is a deliberate constraint chosen at the start of the
project, not an unbuilt feature. A tool aimed at other people's repos should not
edit them, and deciding what a `CLAUDE.md` is *for* is not a call a linter gets
to make.

**Reimplementing ctxlint's correctness rules**
Sourced from `YawLabs/ctxlint` — ~81 rules across `paths`, `commands`,
`staleness`, `contradictions`, `content-secrets`, `mcp-security`. Rejected as
scope, not as value: ctxlint asks "is this context file *true*"; pileup asks
"what does this context *cost*". Both are worth having and they compose. The
right move is to recommend ctxlint in the README, not to grow an 81-rule
correctness engine inside a cost auditor. Two of its *cost*-adjacent rules
(`skill-trigger-collision`, `skill-orphaned`) were **not** rejected — they are
P1 items, because pileup can ground them in measured transcript data where a
static linter cannot.

**Bundling a real tokenizer (tiktoken or equivalent)**
Sourced from `context-viewer`, which uses `tiktoken` with `cl100k_base` and
explicitly rejects "chars/4 estimates". Rejected: zero dependencies is why
`npx pileup` works with no install step, and that is the adoption story. Also
worth noting that `cl100k_base` is not Claude's tokenizer either, so the
precision gained is partly nominal. The honest fix is to calibrate and publish
real error bars for the heuristic — see the P0 claim-softening item and the
Triage entry.

**MCP schema trimming / proxying**
Sourced from the community "reduce MCP overhead" thread. Rejected: any tool that
trims schemas has to sit in the request path at runtime. pileup is an auditor,
runs offline against files and logs, and has no business intercepting traffic.
Measuring the cost so someone else can decide what to disconnect is the P0
`pileup mcp-cost` item.
