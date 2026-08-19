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
pileup fleet ~/work        # every repo under a folder, ranked by what each doc cost
pileup session             # measured token spend from local session transcripts
pileup skill               # what the skill discovery root costs, and what it earns
pileup mcp-cost            # price MCP servers by contrast across all your repos
pileup surface             # every surface pileup found, ungraded, as JSON
pileup --json              # the full report, machine-readable
pileup --format md         # markdown, for a PR comment or a committed doc
```

`--format md` renders the same report as the terminal view, sectioned by **surface**
rather than by severity — so the cost x frequency ordering that is the whole thesis
survives into the headings. It covers `audit` and `fleet`; the other commands refuse
the flag rather than silently printing the terminal view at you.

### `pileup fleet` — one row per document, not per repo

A single-repo audit cannot answer the question people actually have, which is
*"of everything I have accumulated, what should I delete first"*. That needs two
things one repo does not have. **Breadth**: a skill promoted into
`~/.claude/skills` bills in every repo on the machine, and audited one repo at a
time it looks like a 200-token line item forty separate times rather than the
number it is. **Frequency**: cost is size × how often you pay it, and how often
you pay it depends on how much you actually work in each repo — which is measured
in transcripts, not inferable from disk.

So the unit is the document and the sort key is
`paid = tokens per turn × turns measured in the repos it is injected into`.

Run against 101 real repos, this is what it said — and then what acting on it did.
Every number below is from an actual run:

```
  document                    kind     scope  tok/turn  turns  repos     paid  fired
  CLAUDE.md                   memory   repo     115765    14k      1     1.7B      -
  AGENTS.md                   memory   repo     101585    14k      1     1.5B      -
  CLAUDE.md                   memory   repo      33834    17k      1     590M      -
  fanout                      skill    user        262   490k    100     129M     11
  convention                  skill    user        186   490k    100      91M     19
  dispatch                    skill    user         88   490k    100      43M      0

  101 repos audited · 23 with session history · 490,478 measured turns · 70 documents

HIGH     CLAUDE.md in sisia-app has cost about 1.7B tokens (repo-scoped memory)
         every turn
         115,765 tokens per turn times 14,354 turns measured in the 1 repo it is injected
         into. Across the whole fleet, 70 always-on documents come to roughly 4.4B tokens
         for the worst harness (claude) -- per harness, not summed, because only one runs
         at a time.

HIGH     17 skills and commands have cost about 473M tokens and never fired
         every turn
         Across 545 transcripts holding 380 invocations, none of these was ever chosen.
         Their descriptions were still re-sent on every turn of every session in every repo
         that could see them. This is the cleanest deletion list on the machine: measured
         cost, measured zero use.

LOW      sisia-app carries CLAUDE.md and AGENTS.md, 116k and 102k tokens per turn
         every turn
         Two memory files for two harnesses in one repo. You pay the larger, never both.
         The cost of the pair is not tokens, it is drift: whichever one you edit, the other
         harness keeps running the old rules.
```

That `CLAUDE.md` is a real 405 KB file. Every "never fired" claim above was
re-checked against the transcripts by hand before this was written; two earlier
false positives are described in [CHANGELOG.md](CHANGELOG.md).

Acting on that report, in the order it ranked things:

| | before | after | |
|---|---|---|---|
| `sisia-app/CLAUDE.md` | 115,765 | 33,376 | 74% of it was one "runtime gotchas" section — 142 entries moved to a doc, with a titles-only index left inline so the agent still knows they exist |
| `sisia-app/AGENTS.md` | 101,585 | 32,424 | same section, same archive — one source of truth, so the twins stop drifting |
| `blead/CLAUDE.md` | 73,542 | 30,980 | a dated shipped-work log; newest entry kept, 25 archived |
| `blead/AGENTS.md` | 41,483 | 30,093 | pointed at the same archive |
| `nookr2/CLAUDE.md` | 33,834 | 24,956 | "Phase History" detail archived, its summary table kept as the index |
| `nookr2/AGENTS.md` | 27,569 | 21,437 | same archive |
| **total per turn** | **393,778** | **173,266** | **−56%**, with nothing deleted |
| discoverable skills | 24 (2.3k/turn) | 12 (1.8k/turn) | 12 that had never fired moved to a pool, still invocable by path |

The shape of every fix was the same, and it is the one this tool argues for: history
and reference material do not belong in a file that is re-sent on every turn, but
they do belong somewhere the agent can reach, with a small index telling it when to
look.

Three things `paid` is **not**, all of which the report states rather than hides:

- Not uniformly measured. `turns` is measured; `tok/turn` is the same estimate as
  everywhere else in pileup.
- Not history. It applies each document's *current* size to every past turn, so a
  file that grew into its size cost less than this along the way. Read it as
  *"what this is costing me now, weighted by where I actually work"* — which is
  what a deletion decision needs.
- Not a bill. Cached input bills at roughly a tenth of fresh input. The ranking is
  unaffected, which is why pileup reports ratios and not prices.

It also refuses in the same places the rest of pileup does: one document installed
into several discovery roots collapses to one row, turns accrue once per repo rather
than once per installed copy, `fired` shows `-` where firing is not observable and
`0` only where transcripts were actually read, and a run with no session history
reports that it has no frequency half rather than falling back to ranking by size.

**Do not sum the `paid` column.** Two rows for one repo are two harnesses — a
`CLAUDE.md` and an `AGENTS.md` — and you only ever run one of them. The fleet total
is reported per harness and the report says which one, the same rule the single-repo
audit follows. On the machine this was developed against, those two files were 97%
identical; the pair is reported as `fleet-twin-memory`, not because it is double
cost but because it is *not*, and because two hand-maintained copies of the same
instructions drift apart silently.

`--sessions` defaults to 200 per repo here rather than the single-repo default of
20, because a fleet run is a frequency survey and 20 undercounted one real repo's
turns by more than half. Any repo that still hits the cap is named, so a floor is
never presented as a total.

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
| `--window <n>` | context window to measure against. Omit it and pileup resolves one — see [On the context window](#on-the-context-window) |
| `--repo <a,b>` | `pileup fleet` only — audit exactly these repos instead of discovering them |
| `--limit <n>` / `--depth <n>` | `pileup fleet` only — how many repos to audit (default `60`) and how deep to look for a `.git` (default `4`) |
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
| **mcp** | configured servers, and whether **deferred tool loading** is declared. With it off, every server's tool schemas ride every turn; with it on they may not be in the prefix at all — so this collector grades two different worlds. See [On deferred tool loading](#on-deferred-tool-loading). |
| **prefix** | hooks that rewrite the prefix mid-session, and memory files churning hard enough to keep invalidating the cache. |
| **doc** | large files an agent could open whole. Escalates when a memory file points at one, because then the repo is not merely exposed to the risk — it is directing the agent into it. |
| **session** | what the API actually billed, from Claude Code and Codex transcripts. The only numbers here that are not estimates. |
| **output** | the other side of the bill. Output tokens cost ~5x an input token, which is why terseness skills are popular — this prices that trade against your own sessions instead of a blog post's. |

### On deferred tool loading

pileup used to say, flatly, that every connected MCP server's tool schemas ride
the always-on prefix on every turn. That was true when it was written and is now
**conditional**, which is a more interesting fact than the original claim.

Anthropic's [Tool Search Tool](https://www.anthropic.com/engineering/advanced-tool-use)
(`defer_loading` on the API, `ENABLE_TOOL_SEARCH` in Claude Code's settings) hands
the model tool *names* and loads a full JSON Schema only when it reaches for one.
**In current Claude Code it is on by default** — an unset `ENABLE_TOOL_SEARCH`
resolves to on, not off. pileup got this backwards once and produced a HIGH finding
telling users to enable something already running; the mode table now mirrors the
resolver read out of the shipped binary rather than a writeup.
Reported effect: about **85% fewer tool-definition tokens**, and one Claude Code
case going from 31.7k tokens of MCP schemas to zero. The part that makes this not
merely a cost tradeoff is that tool *selection* improves — published evaluations
put Opus 4.5 at 79.5% correct tool choice with every schema loaded and 88.1% with
search, because a model picking from a catalogue beats one picking from a wall of
JSON. There is no accuracy argument for leaving it off.

Two things follow, and the second was a bug rather than a gap:

1. Grading a server count as an always-on cost is wrong when pileup has reason to
   believe that cost is not being paid. When schemas are expected to defer the
   finding is `info` and says whether that is declared or defaulted; a real
   severity fires only when something actually switched deferral **off**.
   Confirmation comes from measurement, not the setting: `mcp-defer-confirmed`
   fires when declared servers measure no cost above the noise floor across your
   repos, which is also the only check that catches the two runtime conditions no
   file scan can see — a non-first-party `ANTHROPIC_BASE_URL`, and Vertex AI,
   which rejects the beta header.
2. `pileup mcp-cost` prices servers by contrasting repos. Two repos on opposite
   sides of this setting are **not comparable samples**, and contrasting them
   prices the setting while blaming a server. It now prices inside one cohort,
   names the repos it set aside, and separately prices the setting itself by
   cross-cohort contrast — labelled coarse, because those cohorts also declare
   different servers.

### On the context window

Every share-of-window figure in a report scales with one number, so pileup no
longer assumes it. Claude Opus 5 became Claude Code's default Opus model in July
2026 with a **1M** window; grading its sessions against the old 200k default
overstated every share by five times, on exactly the findings the report leads
with.

The window is now resolved in four steps, and the report labels which one it used:

| source | measured? | |
|---|---|---|
| `--window` | — | you said so |
| reported | yes | the harness wrote it into the transcript |
| model | no | derived from the model id seen in a transcript |
| default | no | nothing said, so 200k, and the report says *assumed* |

The model→window table is deliberately short: it holds windows that are
documented and returns *unknown* for everything else. A wrong window is worse
than an admitted-unknown one, because it silently rescales the whole report.

The same resolution feeds `pileup skill`, because Claude Code sizes its skill
description budget at **2% of the context window** — 4,000 characters at 200k,
20,000 at 1M. Past that ceiling this stops being a cost question: descriptions get
dropped or truncated, and which skill loses is not your choice.

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

Tokenizers are also **not interchangeable**, and pileup reports per harness — so
one estimator applied to every row meant at least one row was wrong. Published
cross-tokenizer comparisons put 1,000 characters of English at roughly 245 tokens
on GPT-5, 270 on Claude and 290–320 on Gemini: Claude runs 10–20% above tiktoken,
Gemini above both. pileup applies a ratio per family (`tiktoken` 0.91, Anthropic
1.0, SentencePiece 1.13) and names the tokenizer in each row.

Be clear about what that is and is not. It is **not** a calibration — the ratios
come from published third-party comparisons, not from a local run against real
tokenizers, and they say nothing about whether the absolute level is right. What
they fix is the *relative* error between two harness rows in the same report,
which was previously zero by construction and therefore wrong. Harnesses that are
model *pickers* rather than model vendors — Cursor, Windsurf, Aider — are labelled
`model-dependent` and counted at the reference ratio, because nothing on disk
reliably says which model you chose.

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
npm test          # 25 tests + the harness-fact check, node:test, no install step
```

Fixtures are **generated into a temp dir at test time, never committed** — a repo
whose point is "stop committing 600 KB decisions logs" should not ship one.

Two constraints worth knowing before opening a PR: **zero dependencies** (it is
why `npx pileup` works with no install), and **no writes to the audited repo**.
Both are load-bearing, not incidental, and CI fails on the first one.

A third, learned the hard way: **every hard-coded fact about a harness needs a
dated `SOURCE:` comment and a row in [docs/harness-fact.md](docs/harness-fact.md)**.
`npm test` enforces it. Three of pileup's claims went stale in a single month
without a single test going red, because every test asserted pileup's own logic and
none asserted anything about the world it models.

Shipped history is in [CHANGELOG.md](CHANGELOG.md); planned work and known gaps
are in [ROADMAP.md](ROADMAP.md), including a rejections log so settled arguments
stay settled.

## License

MIT
