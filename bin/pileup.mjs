#!/usr/bin/env node
// pileup -- audit what your coding agent actually reads.

import { resolve } from 'node:path'
import { audit } from '../lib/audit.mjs'
import { auditFleet } from '../lib/fleet.mjs'
import { auditSkill } from '../lib/skill.mjs'
import { auditMcpCost } from '../lib/mcpcost.mjs'
import {
  render,
  renderFinding,
  renderFleet,
  renderMcpCost,
  renderSession,
  renderSkill,
} from '../lib/report/text.mjs'

const USAGE = `
pileup -- audit what your coding agent actually reads

  pileup [audit] [path]     rank the repo's context surface by cost x frequency
  pileup fleet [dir...]     every repo under dir, ranked by measured turns x size
  pileup session [path]     measured token spend from local session transcripts
  pileup skill              what the skill discovery root costs, and what it earns
  pileup mcp-cost           price MCP servers by contrast across all your repos
  pileup surface [path]     dump every surface pileup found, no grading

fleet options
  --repo <a,b>              audit exactly these repos instead of discovering them
  --limit <n>               stop after this many repos (default 60)
  --depth <n>               how deep to look for a .git (default 4)

skill options
  --pool <dir>              skill pool outside the discovery root (default ~/.piper/skills-pool)
  --ledger <file>           promotion ledger, e.g. piper's data/promotions.json
  --root <dir>              audit one discovery root instead of all of them

options
  --json                    machine-readable report on stdout
  --window <n>              context window to measure against (default 200000)
  --no-user                 ignore the user-global surface (~/.claude, ~/.codex)
  --only <a,b>              run only these collectors
  --skip <a,b>              skip these collectors
  --all                     include info-level findings
  --sessions <n>            how many recent sessions to read (default 20)

collectors
  memory      instruction files injected on every turn, and their @imports
  definition  skill, agent and command frontmatter (always-on) vs body (on-invoke)
  mcp         configured MCP servers, whose tool schemas ride every turn
  prefix      hooks and churn that invalidate the prompt cache
  doc         large files an agent could open whole
  session     what the API actually billed
  output      output-token share, and what a terseness skill is worth here

pileup reports and prescribes. It never edits your repo.
`

const arg = process.argv.slice(2)

// Every command used to end in `process.exit(0)`. On a pipe, stdout is async --
// exiting truncates whatever has not flushed, which showed up as a fleet report
// cut off at exactly 65,536 bytes when anything read it with `| jq` or spawned
// it. Dispatch returns now; node exits on its own once the write drains.
main()

function main() {
if (arg.includes('--help') || arg.includes('-h')) {
  process.stdout.write(USAGE)
  return
}

const COMMAND = new Set(['audit', 'fleet', 'session', 'surface', 'skill', 'mcp-cost'])
const command = COMMAND.has(arg[0]) ? arg.shift() : 'audit'

const flag = parseFlag(arg)

// `fleet` takes directories to search rather than one repo, because the whole
// point is that a document's cost is spread across repos.
if (command === 'fleet') {
  const report = auditFleet({
    dir: flag._.length ? flag._.map((d) => resolve(d)) : undefined,
    repo: split(flag.repo)?.map((r) => resolve(r)),
    limit: flag.limit ? Number(flag.limit) : undefined,
    depth: flag.depth ? Number(flag.depth) : undefined,
    window: flag.window ? Number(flag.window) : undefined,
    user: !flag['no-user'],
    sessionLimit: flag.sessions ? Number(flag.sessions) : undefined,
  })
  if (flag.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  else if (!report.item.length) process.stdout.write(`\n  ${report.note ?? 'nothing to report'}\n\n`)
  else {
    process.stdout.write(renderFleet(report))
    process.stdout.write(renderFinding(report.finding, { all: flag.all }))
  }
  return
}

// `mcp-cost` prices servers by comparing every repo on the machine, so it takes
// no path either.
if (command === 'mcp-cost') {
  const report = auditMcpCost({})
  if (flag.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  else if (report.note && !report.group.length) process.stdout.write(`\n  ${report.note}\n\n`)
  else {
    process.stdout.write(renderMcpCost(report))
    process.stdout.write(renderFinding(report.finding, { all: true }))
  }
  return
}

// `skill` audits the machine, not a repo -- promotion is a machine-wide decision.
if (command === 'skill') {
  const report = auditSkill({
    pool: flag.pool,
    ledger: flag.ledger,
    root: flag.root,
    window: flag.window ? Number(flag.window) : undefined,
  })
  if (flag.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  else {
    process.stdout.write(renderSkill(report))
    process.stdout.write(renderFinding(report.finding, { all: flag.all }))
  }
  return
}

const root = resolve(flag._[0] ?? process.cwd())

const report = audit(root, {
  window: flag.window ? Number(flag.window) : undefined,
  user: !flag['no-user'],
  only: split(flag.only),
  skip: split(flag.skip),
  sessionLimit: flag.sessions ? Number(flag.sessions) : undefined,
})

if (flag.json) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
} else if (command === 'session') {
  const surface = report.surface.session ?? []
  if (!surface.length) {
    process.stdout.write(`\n  ${report.note.session ?? 'no session data available'}\n\n`)
  } else {
    process.stdout.write(renderSession(surface))
    const relevant = report.finding.filter((f) => f.surface === 'cache' || f.id.startsWith('session-') || f.id === 'prefix-gap')
    process.stdout.write(renderFinding(relevant, { all: true }))
  }
} else if (command === 'surface') {
  process.stdout.write(`${JSON.stringify(report.surface, null, 2)}\n`)
} else {
  process.stdout.write(render(report, { all: flag.all }))
}
}

function parseFlag(argv) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) {
      out._.push(a)
      continue
    }
    const key = a.slice(2)
    const next = argv[i + 1]
    if (next && !next.startsWith('--')) {
      out[key] = next
      i++
    } else out[key] = true
  }
  return out
}

function split(v) {
  return typeof v === 'string' ? v.split(',').map((s) => s.trim()).filter(Boolean) : undefined
}
