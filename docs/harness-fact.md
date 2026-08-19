# Harness facts, and when each was last checked

Every row here is a claim about somebody else's software. None of it is derivable
from pileup's own code, none of it is enforced by a test against reality, and all
of it rots silently when a harness ships a release.

This file exists because that already happened. In July 2026 three of pileup's
shipped claims quietly became false and one started producing a wrong number
rather than a stale one — deferred tool loading inverted the premise of the `mcp`
collector, Opus 5's 1M window made every share-of-window figure overstate by five
times, and one tokenizer across every harness row guaranteed at least one wrong
row. The full test suite was green throughout, because every test asserted
pileup's own logic and none asserted anything about the world it models.

**Re-check this table when a harness ships a major version.** The `verify` column
says how, and every entry is greppable in `lib/` as `SOURCE:`.

| Fact | Value | Where | Source, and date read | Verify by |
|---|---|---|---|---|
| Skill description budget | 2% of the context window | [lib/budget.mjs](../lib/budget.mjs) `SKILL_BUDGET_SHARE` | Claude Code changelog — "skill character budget scales with context window (2% of context)". 2026-07-30. | Changelog search for "skill character budget" |
| Opus 5 context window | 1,000,000 | [lib/model.mjs](../lib/model.mjs) `MODEL_WINDOW` | Claude Code 2.1.219, 2026-07-24 — "Added Claude Opus 5 … 1M context". Read 2026-07-30. | `/context` in a session, or a transcript's `model_context_window` |
| `[1m]` model suffix means 1M | 1,000,000 | [lib/model.mjs](../lib/model.mjs) `MODEL_WINDOW` | Model ids observed in local transcripts, 2026-07-30. | grep a transcript for `"model":"claude-*[1m]"` |
| Deferred-tool-loading mode table | `auto:0`→on, `auto:100`→off, `auto`/`auto:N`→on, truthy→on, falsey→off, **unset→on** | [lib/toolsearch.mjs](../lib/toolsearch.mjs) `classify` | Decompiled from the shipped binary 2.1.220 (its own mode resolver), read 2026-07-30. **The strongest source in this table — not a blog post.** | `strings <claude binary> \| grep -A2 ENABLE_TOOL_SEARCH` |
| Deferred loading saves ~85% of tool-definition tokens | prose only, not a constant | [lib/collector/mcp.mjs](../lib/collector/mcp.mjs) | Anthropic, "Introducing advanced tool use on the Claude Developer Platform". Read 2026-07-30. Vendor figure. | Re-read the post; better, measure a prefix before/after |
| Tool selection 79.5% → 88.1% (Opus 4.5) | prose only | [lib/collector/mcp.mjs](../lib/collector/mcp.mjs) | Same post, read 2026-07-30. Vendor figure. | Same |
| Tokenizer ratios | tiktoken 0.91, Anthropic 1.0, SentencePiece 1.13 | [lib/token.mjs](../lib/token.mjs) `TOKENIZER` | Published cross-tokenizer comparisons: ~245/270/290–320 tokens per 1000 chars of English. Read 2026-07-30. Third-party, **not** a local calibration. | `count_tokens` against a committed corpus — the blocked P3 item |
| Transcript locations | `~/.claude/projects`, `~/.codex/sessions` | [lib/transcript.mjs](../lib/transcript.mjs) | Observed locally; exercised against 540+ real transcripts. | `ls` them |
| Harness file layouts | one row per harness | [lib/adapter.mjs](../lib/adapter.mjs) `HARNESS` | Claude Code and Codex are exercised against real repos. **Cursor, Copilot, Gemini, Windsurf and Aider are declared, unverified.** | A fixture per harness, or downgrade the README claim |
| Skill/command invocation shapes | `Skill` tool call, `<command-name>` tag | [lib/invocation.mjs](../lib/invocation.mjs) | Observed in local transcripts, 2026-07-30. | grep a transcript for both |

## The two that are load-bearing

**Deferred loading being on by default.** Get this backwards and pileup produces a
HIGH finding telling users to enable something already running, and — worse —
grades a token cost nobody is paying. It did exactly that before 2026-07-30.

**The context window.** Every percentage in every report scales with it. The
resolver in [lib/model.mjs](../lib/model.mjs) prefers measured sources and labels
which one it used, so a wrong table degrades to a labelled guess rather than a
silent rescale. Keep it that way: never add a model to `MODEL_WINDOW` on a hunch.

## What would make this file unnecessary

A check that fails when a fact goes stale, rather than a table someone has to
remember to read. `npm run harness-fact` is the first step — it only proves every
fact is *documented and dated*, not that it is still *true*. Closing the gap for
real means asserting against a live harness, which is the open **Track the
harness** item in [ROADMAP.md](../ROADMAP.md).
