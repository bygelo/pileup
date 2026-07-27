#!/usr/bin/env node
// pileup -- audit what your coding agent actually reads.

import { resolve } from 'node:path'
import { audit } from '../lib/audit.mjs'
import { auditSkill } from '../lib/skill.mjs'
import { render, renderFinding, renderSession, renderSkill } from '../lib/report/text.mjs'

const USAGE = `
pileup -- audit what your coding agent actually reads

  pileup [audit] [path]     rank the repo's context surface by cost x frequency
  pileup session [path]     measured token spend from local session transcripts
  pileup skill              what the skill discovery root costs, and what it earns
  pileup surface [path]     dump every surface pileup found, no grading

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

pileup reports and prescribes. It never edits your repo.
`

const arg = process.argv.slice(2)
if (arg.includes('--help') || arg.includes('-h')) {
  process.stdout.write(USAGE)
  process.exit(0)
}

const COMMAND = new Set(['audit', 'session', 'surface', 'skill'])
const command = COMMAND.has(arg[0]) ? arg.shift() : 'audit'

const flag = parseFlag(arg)

// `skill` audits the machine, not a repo -- promotion is a machine-wide decision.
if (command === 'skill') {
  const report = auditSkill({
    pool: flag.pool,
    ledger: flag.ledger,
    root: flag.root,
  })
  if (flag.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  else {
    process.stdout.write(renderSkill(report))
    process.stdout.write(renderFinding(report.finding, { all: flag.all }))
  }
  process.exit(0)
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
