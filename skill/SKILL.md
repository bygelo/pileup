---
name: pileup
description: Measure what a repo injects into an agent's context and rank it by cost per turn. Use when a session feels expensive, a repo has grown memory files or skills, or before adding an MCP server. Skip when debugging behaviour rather than cost.
---

# pileup

Run it, read the top of the report, act on the always-on findings first.

```sh
npx pileup                 # audit this repo
npx pileup session         # measured spend from local transcripts
npx pileup --json          # for further analysis
```

## Reading the report

Findings are ranked by **cost x how often you pay it**, not by size. The label
under each finding says which:

- `every turn` — always-on. Fix these first even when the number looks small.
- `cache` — prefix churn. Cheap to fix, compounds across every later turn.
- `if opened` — a read trap. Nothing forces the agent to open it; nothing stops it either.
- `on invoke` — only paid when reached for. Lowest priority.

## Acting on it

pileup names the fix but never applies it. The three that recur:

**Always-on is rent.** A memory file earns its place only if it changes
behaviour on an arbitrary turn — build commands, hard invariants, naming rules.
History, decisions and narrative belong in docs the agent opens on demand.
`@import` inlines the whole file into the prefix; a plain path does not.

**Descriptions route, they do not document.** One sentence of trigger plus one
of boundary. Every skill's description is re-sent every turn whether or not it
fires, so an unused skill still bills.

**Split read traps, do not just warn about them.** One file per entry plus a
small index the memory file points at. The agent then opens the index and one
entry instead of the archive.

## The gap

If `pileup session` reports a much larger prefix than the static estimate, the
difference is the harness system prompt plus MCP tool schemas. Disconnect
servers this repo does not use and re-measure — that gap is often the single
largest line in the whole audit.
