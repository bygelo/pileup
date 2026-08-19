# AGENTS.md — pileup

Guidance for any agent. `CLAUDE.md` is `@AGENTS.md`.

## What this is

A zero-dependency Node CLI that audits what a coding agent actually reads, and
ranks it by **cost × frequency** rather than by size. It is published — `npx
pileup` must work with no install — so every rule below protects either that
distribution story or the credibility of a number the tool prints.

Current state is [README.md](README.md). History is [CHANGELOG.md](CHANGELOG.md).
Forward work is [ROADMAP.md](ROADMAP.md), including what was deliberately
rejected ([docs/roadmap-rejected.md](docs/roadmap-rejected.md)) — read that before
proposing a dashboard, a dollar-cost table, or an auto-fix.

## Commands

```bash
npm test                  # 31 tests + the harness-fact and finding-coverage checks
npm run harness-fact      # the dated-source register on its own
npm run coverage          # which findings have a test that names them (ratchet floor)
node bin/pileup.mjs       # audit this repo
node bin/pileup.mjs --format md
node bin/pileup.mjs fleet ~/Antigravity --json
```

## Hard rules

1. **Zero dependencies.** No `dependencies`, no `devDependencies`, no lockfile.
   CI fails the build if one appears. This is the reason `npx pileup` works.
2. **Report-only.** pileup never edits, moves, or deletes a file in the repo it
   audits. It points at other people's repos; a tool that rewrites them is a
   different product.
3. **Every hard-coded fact about a harness carries a dated source comment and a
   row in [docs/harness-fact.md](docs/harness-fact.md).** `npm test` fails
   otherwise. Model windows, the skill-description budget, tokenizer ratios and
   the deferred-loading key are all claims about somebody else's release notes,
   and they rot silently — that is exactly how three shipped claims went false.
4. **A new finding ships with a test that asserts its id fires.** `npm run coverage`
   measures it and `npm test` enforces a ratchet floor. Raise the floor when you
   improve coverage; never lower it to make a run pass.
5. **Never state an accuracy the repo cannot show.** The token estimator is
   uncalibrated and says so. A measurement tool that overstates its own precision
   discredits every other number it prints.
6. **Singular everywhere** — variables, keys, params, filenames. Collections too:
   `finding: Finding[]`, never `findings`.
7. README is a **STATE** doc — current-state only, no dated entries. CHANGELOG is
   the **LOG**. Do not let history accumulate in the README.

## Map

- `bin/pileup.mjs` — arg parsing and command dispatch
- `lib/collector/` — one module per surface (`memory`, `definition`, `mcp`, `doc`,
  `session`, `prefix`, `output`); each returns findings, none prints
- `lib/audit.mjs` — the single-repo run · `lib/fleet.mjs` — every repo at once
- `lib/invocation.mjs` — how often a definition was actually reached for. Shared
  on purpose: it went wrong by existing in two copies that drifted.
- `lib/model.mjs` · `lib/toolsearch.mjs` · `lib/token.mjs` · `lib/budget.mjs` —
  the harness-fact modules rule 3 governs
- `lib/finding.mjs` — `mkFinding`, severity, the cost × frequency sort
- `lib/report/text.mjs` · `lib/report/markdown.mjs` — the only modules that print
- `skill/SKILL.md` — the shipped skill; keep it in step with `--help`

## Consumers

At least one dashboard shells `pileup fleet --json` and renders context cost
beside its other per-repo columns. That makes the fleet JSON a published
interface: renaming a key in it is a breaking change for something you cannot
see from here.
