# pileup

Audit what your coding agent actually reads.

```
npx pileup
```

No install, no dependencies, no API key. It reports and prescribes. **It never edits your repo.**

---

## The problem

A repo accumulates instructions the way a desk accumulates paper. A `CLAUDE.md`
here, an `AGENTS.md` there, twenty skills, a decisions log that has been appended
to for eight months, six MCP servers someone connected once. Nothing about any
single addition looks expensive.

Then you measure the opening turn of a session and it bills **227,000 tokens
before the agent has done anything at all** — and every later turn pays it again.

That number is real; it came from auditing a working repo with this tool. The
files on disk accounted for 5,600 of it. The other 221,000 were invisible to
anything that only looks at files.

## The idea

Context cost is not size. It is **size × how often you pay it**. pileup sorts
everything an agent could load into four surfaces and ranks by that product:

| surface | paid | example |
|---|---|---|
| **always-on** | every turn, every session | memory files, skill descriptions, MCP tool schemas |
| **cache** | whenever the prefix churns | a hook that rewrites `CLAUDE.md`, switching models mid-session |
| **on-read** | only if the agent opens it | a 1.1 MB decisions log linked from your memory file |
| **on-invoke** | only when reached for | a skill body |

2k tokens of always-on beats 200k tokens read once. A finding that costs you on
every turn outranks a bigger one that might never be paid — that ordering is the
whole thesis, and it lives in the sort.

## What it looks like

```
pileup  ~/work/api
harness  Claude Code (32) · Codex (35)

ALWAYS-ON  estimated from disk, per harness, against a 1.0M window
  harness            total   memory    descr   defs   mcp  window
  Claude Code         5.6k     2.7k     2.9k     26     6    0.6%
  Codex               4.2k      548     3.7k     29     2    0.4%

FINDINGS  9 critical · 7 high · 15 medium · 5 low

CRITICAL measured always-on prefix: 223k tokens (worst 228k)
         every turn
         The smallest billed turn of each session, which is its opening turn: system prompt,
         tool schemas, memory files and skill descriptions, before the session has done
         anything. Every later turn pays this too.

CRITICAL 218k tokens of always-on context are not on disk
         every turn
         Sessions measured a 223k-token prefix; the files pileup can read account for only
         5.6k. The remainder is the harness's own system prompt and tool schemas -- including
         6 MCP servers you configured, which can be the larger half of it.
         fix: Disconnect MCP servers you do not use in this repo and re-run `pileup session`.

CRITICAL docs/decisions.md is 327k tokens (33% of the window)
         if opened
         CLAUDE.md points the agent at this file. One whole-file read spends 33% of the
         context window in a single tool call.
         fix: Split docs/decisions.md into one file per entry plus a small index that maps
         identifiers to files. Then the agent opens the index and one entry, not the archive.
```

## Usage

```sh
pileup                     # audit the current repo
pileup ~/some/repo         # audit somewhere else
pileup session             # measured token spend from local session transcripts
pileup skill               # what the skill discovery root costs, and what it earns
pileup mcp-cost            # price MCP servers by contrast across all your repos
pileup surface             # every surface pileup found, ungraded, as JSON
pileup --json              # the full report, machine-readable
```

### `pileup mcp-cost` — which server is it, actually

`pileup audit` can tell you the prefix is enormous and that most of it isn't on
disk. It can't tell you *which server to disconnect*, because tool schemas are
only visible to a running harness.

`mcp-cost` recovers that by natural experiment. Every repo on your machine is a
sample: a declared server set and a measured opening prefix. Repos with a server,
compared against repos without it, price it.

```
    repos    prefix   vs base  declared servers
       38       38k  baseline  none
        4       37k     -1.2k  repo-index
        2       33k     -4.9k  repo-index, chat, search
        3      308k     +270k  browser, docs, sheets, notes, chat

CRITICAL 5 servers together cost about 270k tokens on every turn
         browser, docs, sheets and 2 more always appear together across 3
         repos, so their individual costs cannot be separated.
         fix: Disconnect them one at a time and re-run. Each removal creates a new
         group and the next run can price what changed.

INFO     4 servers show no cost above noise: repo-index, chat, notes, search
INFO     browser configured globally, so it is unpriceable
```

**Knowing when to refuse is the whole design.** A regression over this data would
have produced six confident per-server numbers from one observation. Instead:

- Servers that always co-occur price as a **set**, and the finding says so.
- A set used in one repo is an anecdote, not a measurement.
- Contrasts inside the noise floor are reported as *no measurable cost*, never as
  a negative one.
- A globally-configured server has no comparison group and is called unpriceable.
- The report names its own confounds — outlier repos excluded, and how many
  harness versions the samples span, since the system prompt changes per release.

One honest caveat it prints itself: a server that is declared but never actually
connects also measures as free. A zero can mean *"not loading"* rather than
*"carries no schemas"*.

### `pileup skill` — promotion as a measured decision

A skill costs nothing where it is *stored* and everything where it is
*discoverable*. Skill-pool managers make that split explicit: a pool kept
outside the discovery root is free, and a curated subset gets promoted into
`~/.claude/skills`, where its description bills on every turn, in every repo,
forever.

Promotion is therefore the one decision that spends always-on context — and it
is almost always made on judgement. One such tool says so in its own promotion
ledger: *"Promotion is judgment-driven for now (no automated gate)."*

`pileup skill` is the evidence that gate needs:

```
  skill                      tok/turn  fired  tracked
  fanout                          262      1       no
  parcel                          237      0       no
  sync-docs                       176     23       no
  dispatch                         88      0      yes
  cache                            84      0      yes

  18 distinct skills · 2.1k tokens every turn · 33 pooled at no cost
  98 invocations across 360 transcripts

MEDIUM   8 of 18 discoverable skills have never fired, costing 742 tokens every turn
MEDIUM   13 of 18 discoverable skills are not in the promotion ledger
LOW      design-brand-a and design-brand-b describe overlapping triggers (29% shared)
```

`fired` comes from actual `Skill` tool calls in local transcripts, so "unused" is
measured rather than assumed — and pileup says nothing at all when there are no
transcripts to read. Point it at a ledger with `--ledger` and a pool with
`--pool`; it dedupes across discovery roots and never counts a skill parked in a
`.disabled/` directory as billing.

| option | |
|---|---|
| `--window <n>` | context window to measure against (default `200000`) |
| `--no-user` | ignore the user-global surface (`~/.claude`, `~/.codex`) |
| `--only a,b` / `--skip a,b` | pick collectors |
| `--all` | include info-level findings |
| `--sessions <n>` | how many recent sessions to read (default `20`) |
| `--pool` / `--ledger` / `--root` | `pileup skill` only — see below |

pileup reads no config file and exactly one environment variable:

| env | |
|---|---|
| `NO_COLOR` | set to any value to disable ANSI colour ([no-color.org](https://no-color.org)). Colour is also off automatically when stdout is not a TTY. |

## Collectors

Each one is independent. A collector that throws is reported and skipped — a
partial audit is still worth reading.

| | |
|---|---|
| **memory** | instruction files injected on every turn, and the `@import`s they inline. An `@import` is not a link; its full text lands in the prefix. |
| **definition** | skills, subagents and slash commands. Frontmatter `description` is always-on; the body is on-invoke. Grades the two separately, because they are not the same cost. |
| **mcp** | configured servers. Every server's tool schemas ride every turn. |
| **prefix** | hooks that rewrite the prefix mid-session, and memory files churning hard enough to keep invalidating the cache. |
| **doc** | large files an agent could open whole. Escalates when a memory file points at one, because then the repo is not merely exposed to the risk — it is directing the agent into it. |
| **session** | what the API actually billed, from Claude Code and Codex transcripts. The only numbers here that are not estimates. |
| **output** | the other side of the bill. Output tokens cost ~5x an input token, which is why terseness skills are popular — this prices that trade against your own sessions instead of a blog post's. |

### On terseness skills

The most popular answer to "my sessions cost too much" is a terseness skill —
[caveman](https://github.com/juliusbrussee/caveman) and its relatives — which
cut discursive output by around 65%.

pileup does not tell you to install one. It tells you what it is worth:

```
INFO     output is 9.3% of billed cost; a terseness skill could recover about 1.8%
         on invoke
         1.4M output tokens against 47M input-equivalent. Terseness skills cut discursive
         text by roughly two thirds, but generated code, diffs and tool arguments are
         untouched and are most of what a coding agent emits.
         fix: The trade pays off as long as the skill adds less than about 9.8k tokens of
         cached always-on context per turn, which most of them clear comfortably -- so
         install one if you like the style. Just rank it honestly: it is worth 1.8%, and
         the always-on findings above are usually worth more.
```

That is a real audit of a real repo. The skill is net-positive and worth having.
It is also worth 1.8%, while the always-on prefix in the same repo was worth
223,000 tokens **per turn**. Both facts are true; only one of them is where the
money is, and it is not the one with the landing page.

## Harnesses

pileup detects Claude Code, Codex, Cursor, GitHub Copilot, Gemini CLI, Windsurf
and Aider. The only thing that differs between them is *where they keep their
files*; every analysis downstream is shared.

**Claude Code and Codex are the two that have been exercised** — against real
repos and real transcripts. The other five adapter rows are declared paths that
no test or real run has yet confirmed. Treat them as best-effort and report
anything wrong; the fix is a one-line table edit.

Session-level findings need a transcript format pileup can read, which today
means Claude Code (`~/.claude/projects`) and Codex (`~/.codex/sessions`). For
other harnesses the static half still works and the session half reports nothing
rather than guessing.

Always-on cost is reported **per harness, never summed** — only one runs at a
time, and adding them would describe a session nobody has.

Adding a harness is one row in the table at the top of [lib/adapter.mjs](lib/adapter.mjs).
Nothing else in pileup knows a harness name.

A harness counts as in use only if the *repo* says so. Everyone has a stray
`~/.gemini` lying around, and auditing it against an unrelated repo is exactly
the noise pileup exists to remove.

## On accuracy

pileup ships zero dependencies, so it cannot run the real BPE tokenizer. It
estimates from character-class runs, which tracks tokenizer behaviour better
than the usual `chars / 4`.

**Those error bars are not yet measured.** On the one corpus where an
independent hand-written reference exists, the estimator ran **5–13% high**.
That is a sample of three files, not a calibration, and treating it as one would
be exactly the kind of unverified number this tool exists to catch. Calibrating
it properly is [a P0 item](ROADMAP.md). Until then, treat every estimate as a
ranking signal rather than a measurement — ranking is all pileup needs it for.

These are **measured, not estimated**:

- everything under `pileup session`, which reads what the API billed
- the always-on prefix, taken from the smallest billed turn of each session
- on Codex, the real context window and **the subscription quota actually spent** —
  `rate_limits.primary.used_percent` is the provider's own count, so no estimate
  can improve on it:

```
HIGH     subscription quota at 100% of its 1-week window (pro)
         Read straight from the transcript, so this is what the provider actually
         counted. On a subscription the always-on prefix is the dominant term: it
         is re-sent every turn whether or not the turn needed it.

MEDIUM   52 compactions across 20 sessions
         Compacting discards the cached prefix; the next turn rebuilds it at
         cache-write price -- roughly 21k tokens rewritten per compaction here.
```

The two harnesses disagree about what "input tokens" means, and getting it wrong
is silent: Claude's `input` / `cache_read` / `cache_creation` are **disjoint**,
while Codex's `input_tokens` is the **whole prompt** with `cached_input_tokens`
as a subset of it. Adding Codex's the way you add Claude's reports more cache
than there was prompt. [lib/transcript.mjs](lib/transcript.mjs) normalises both
to the disjoint form so every downstream number means one thing.

Everything else is an estimate and the report says so. When pileup cannot see
something — MCP tool schemas, which need the servers running — it reports the
gap rather than guessing at it.

## What it will not do

It does not edit your repo. It names the file, the number, and the specific fix,
and stops there. Deciding what a `CLAUDE.md` is *for* is not a decision a linter
gets to make.

There is no daemon, no telemetry upload, no config file, and nothing to log into.
It reads your repo and, if you ask for `session`, your local transcripts. Nothing
leaves the machine.

## Prior art

pileup is not the only tool in this space and does not try to be all of it.

- **[ctxlint](https://github.com/YawLabs/ctxlint)** — asks whether your context
  files are *true*: broken paths, commands that don't exist, stale references,
  contradictions, leaked secrets. ~81 rules across 16 clients, also zero-dep and
  `npx`-able. **Run it alongside pileup**; correctness and cost are different
  axes and it is ahead of pileup on the first one.
- **[context-viewer](https://github.com/auditt98/context-viewer)** — Python +
  real `tiktoken`, dollar costs, compaction timelines, an interactive view.
  Reach for it when you want a session microscope rather than a repo verdict.
- **Skill-consolidation tooling** (piper and similar) — the prescriptive half:
  cache discipline, session handoff, context budgeting as a practice. pileup
  produces the numbers those skills otherwise ask you to estimate, and
  `pileup skill` is built to feed their promotion decisions.

What pileup does that those don't: run the static and measured halves together
and **report the gap between them**, then rank everything by cost × frequency
rather than by rule count. On the reference repo that gap was 218,000 tokens per
turn, and neither half alone can see it.

## Contributing

```sh
npm test          # 17 tests, node:test, no install step
```

Fixtures are **generated into a temp dir at test time, never committed** — a repo
whose point is "stop committing 600 KB decisions logs" should not ship one.

Two constraints worth knowing before opening a PR: **zero dependencies** (it is
why `npx pileup` works with no install), and **no writes to the audited repo**.
Both are load-bearing, not incidental.

Shipped history is in [CHANGELOG.md](CHANGELOG.md); planned work and known gaps
are in [ROADMAP.md](ROADMAP.md), including a rejections log so settled arguments
stay settled.

## License

MIT
