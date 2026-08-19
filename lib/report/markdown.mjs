// Markdown report -- the format you paste into a PR or commit to a repo.
//
// The terminal renderer is the primary one and stays that way; this is a second
// view over the same report object, not a second report. It exists because the
// findings people most want to act on are the ones they have to convince someone
// else about, and a screenshot of a terminal is not reviewable.
//
// Sectioned by SURFACE rather than by severity, because the surface is the part
// that decides whether a finding matters: 2k tokens billed every turn beats 200k
// read once, and a reader scanning headings should see that ordering.

import { SEVERITY } from '../finding.mjs'
import { formatShare, formatToken } from '../token.mjs'

// Ordered by how often you pay it -- the same order the sort in finding.mjs uses.
const SURFACE_ORDER = ['always-on', 'cache', 'on-read', 'on-invoke']

const SURFACE_HEADING = {
  'always-on': 'Always-on — paid every turn',
  cache: 'Cache — paid whenever the prefix churns',
  'on-read': 'On-read — paid only if the agent opens it',
  'on-invoke': 'On-invoke — paid only when reached for',
}

const WINDOW_SOURCE = {
  flag: 'from --window',
  harness: 'reported by the harness',
  model: 'from the model in your transcripts',
  default: 'assumed',
}

/** A markdown table cell must not break the row it sits in. */
function cell(s) {
  return String(s ?? '').replace(/\|/g, '\\|').replace(/\n+/g, ' ').trim()
}

function section(finding, all) {
  const out = []
  const shown = all ? finding : finding.filter((f) => f.severity !== 'info')
  for (const surface of SURFACE_ORDER) {
    const row = shown.filter((f) => f.surface === surface)
    if (!row.length) continue
    out.push(`### ${SURFACE_HEADING[surface] ?? surface}`, '')
    for (const f of row) {
      out.push(`#### ${f.severity.toUpperCase()} — ${f.title}`, '')
      if (f.why) out.push(f.why, '')
      if (f.fix) out.push(`**fix:** ${f.fix}`, '')
    }
  }
  return out
}

function tally(finding) {
  const count = {}
  for (const f of finding) count[f.severity] = (count[f.severity] ?? 0) + 1
  return SEVERITY.slice()
    .reverse()
    .filter((s) => count[s])
    .map((s) => `${count[s]} ${s}`)
    .join(' · ')
}

/** The single-repo audit, as markdown. */
export function renderMarkdown(report, opt = {}) {
  const out = []
  const p = (s = '') => out.push(s)

  p(`# pileup — \`${report.root}\``)
  p()
  p(
    `Harness: ${report.harness.map((h) => `${h.name} (${h.artifact} artifacts)`).join(', ') || 'none detected'}. ` +
      `Measured against a ${formatToken(report.window)} window (${WINDOW_SOURCE[report.windowSource] ?? report.windowSource}).`,
  )
  p()

  p('## Always-on, estimated from disk')
  p()
  p('| harness | total | memory | descriptions | definitions | mcp | window | tokenizer |')
  p('|---|---:|---:|---:|---:|---:|---:|---|')
  const row = report.alwaysOn.byHarness.filter((a) => a.token > 0 || a.mcpServer > 0)
  if (!row.length) {
    p('| _no harness files in this repo_ | | | | | | | |')
  }
  for (const a of row) {
    p(
      `| ${cell(a.name)} | ${formatToken(a.token)} | ${formatToken(a.memory)} | ${formatToken(a.description)} ` +
        `| ${a.definition} | ${a.mcpServer || '—'} | ${formatShare(a.token, report.window)} | ${cell(a.tokenizerName ?? '')} |`,
    )
  }
  p()
  p('Rows are per harness and are never summed: only one harness runs at a time, and the same file is a')
  p('different number of tokens to each vendor.')
  p()

  p('## Findings')
  p()
  p(tally(opt.all ? report.finding : report.finding.filter((f) => f.severity !== 'info')) || '_none_')
  p()
  out.push(...section(report.finding, opt.all))

  const note = Object.entries(report.note ?? {})
  if (note.length || report.error.length) {
    p('## Notes')
    p()
    for (const [collector, message] of note) p(`- \`${collector}\`: ${message}`)
    for (const e of report.error) p(`- **error** \`${e.collector}\`: ${e.message}`)
    p()
  }

  p('---')
  p()
  p('pileup reports; it never edits your repo. Token counts are estimates unless marked measured.')
  p()
  return out.join('\n')
}

/** The whole-machine fleet report, as markdown. */
export function renderFleetMarkdown(report, opt = {}) {
  const out = []
  const p = (s = '') => out.push(s)

  p('# pileup fleet')
  p()
  const worked = report.repo.filter((r) => r.turn > 0)
  p(
    `${report.repo.length} repos audited, ${worked.length} with session history, ` +
      `${report.turn.toLocaleString('en-US')} measured turns, ${report.item.length} always-on documents.`,
  )
  if (report.note) {
    p()
    p(`> ${report.note}`)
  }
  p()

  p('## Documents, ranked by what they have cost')
  p()
  p('| document | kind | scope | tok/turn | turns | repos | paid | fired |')
  p('|---|---|---|---:|---:|---:|---:|---:|')
  for (const x of report.item.slice(0, opt.limit ?? 25)) {
    p(
      `| \`${cell(x.rel ?? x.name)}\` | ${cell(x.kind)} | ${cell(x.scope)} | ${x.perTurn} | ${formatToken(x.turn)} ` +
        `| ${x.repoCount} | ${formatToken(x.paid)} | ${x.fired === null ? '—' : x.fired === 0 ? '**never**' : x.fired} |`,
    )
  }
  p()
  p('`paid` is tok/turn × turns at each document\'s CURRENT size. Turns are measured; tok/turn is estimated.')
  p('Do not sum the column: two rows for one repo are two harnesses, and only one of them runs at a time.')
  p('`fired` is — where firing is not observable, and 0 only where transcripts were actually read.')
  p()

  p('## Findings')
  p()
  p(tally(opt.all ? report.finding : report.finding.filter((f) => f.severity !== 'info')) || '_none_')
  p()
  out.push(...section(report.finding, opt.all))

  p('---')
  p()
  p('pileup reports; it never edits your repo.')
  p()
  return out.join('\n')
}
