// Terminal report. ANSI only, no dependency, degrades to plain text when the
// stream is not a TTY or NO_COLOR is set.

import { SEVERITY } from '../finding.mjs'
import { formatShare, formatToken } from '../token.mjs'

const useColor = process.stdout.isTTY && !process.env.NO_COLOR
const paint = (code, s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s)

const dim = (s) => paint('2', s)
const bold = (s) => paint('1', s)

const TINT = {
  critical: (s) => paint('1;31', s),
  high: (s) => paint('31', s),
  medium: (s) => paint('33', s),
  low: (s) => paint('36', s),
  info: (s) => paint('2', s),
}

// Where the window came from. Only the first two are measured, and a reader
// deciding whether to trust a percentage needs to know which they are looking at.
const WINDOW_SOURCE = {
  flag: '--window',
  reported: 'reported by the harness',
  model: 'from the model in your transcripts',
  default: 'assumed -- nothing said otherwise',
}

const windowNote = (source) => (WINDOW_SOURCE[source] ? `(${WINDOW_SOURCE[source]})` : '')

const SURFACE_LABEL = {
  'always-on': 'every turn',
  'on-invoke': 'on invoke',
  'on-read': 'if opened',
  cache: 'cache',
}

export function render(report, opt = {}) {
  const out = []
  const p = (s = '') => out.push(s)

  p()
  p(`${bold('pileup')}  ${report.root}`)
  p(
    dim(
      `harness  ${report.harness.map((h) => `${h.name} (${h.artifact})`).join(' · ') || 'none detected'}`,
    ),
  )
  p()

  p(
    bold('ALWAYS-ON') +
      dim(
        `  estimated from disk, per harness, against a ${formatToken(report.window)} window ${windowNote(report.windowSource)}`,
      ),
  )
  p(
    dim(
      `  ${'harness'.padEnd(16)}${'total'.padStart(8)}${'memory'.padStart(9)}${'descr'.padStart(9)}${'defs'.padStart(7)}${'mcp'.padStart(6)}${'  window'}  tokenizer`,
    ),
  )
  const row = report.alwaysOn.byHarness.filter((a) => a.token > 0 || a.mcpServer > 0)
  if (!row.length) p(dim('  no harness files in this repo -- nothing is being injected from disk'))
  for (const a of row) {
    p(
      `  ${a.name.padEnd(16)}${formatToken(a.token).padStart(8)}${formatToken(a.memory).padStart(9)}${formatToken(a.description).padStart(9)}${String(a.definition).padStart(7)}${String(a.mcpServer || '-').padStart(6)}${formatShare(a.token, report.window).padStart(8)}  ${dim(a.tokenizerName ?? '')}`,
    )
  }
  p(
    dim(
      '  rows differ partly because tokenizers do: the same file is a different number of tokens to each vendor',
    ),
  )
  p(
    dim(
      report.meta?.mcp?.toolSearch?.deferring
        ? '  mcp schemas are expected to load on demand here, so they may not be in the prefix at all -- confirm with `pileup session`'
        : '  mcp counts servers, not their tool schemas -- those are only visible in `pileup session`',
    ),
  )
  p()

  const count = tally(report.finding)
  const summary = SEVERITY.slice()
    .reverse()
    .filter((s) => count[s])
    .map((s) => TINT[s](`${count[s]} ${s}`))
    .join(dim(' · '))
  p(bold('FINDINGS') + `  ${summary || dim('none')}`)
  p()

  p(renderFinding(report.finding, opt))

  for (const [collector, message] of Object.entries(report.note ?? {}))
    p(dim(`note  ${collector}: ${message}`))
  for (const e of report.error) p(TINT.high(`error  ${e.collector}: ${e.message}`))
  if (Object.keys(report.note ?? {}).length || report.error.length) p()

  p(dim('pileup reports; it never edits your repo. Token counts are estimates unless marked measured.'))
  p()

  return out.join('\n')
}

export function renderFinding(finding, opt = {}) {
  const out = []
  const p = (s = '') => out.push(s)
  const shown = opt.all ? finding : finding.filter((f) => f.severity !== 'info')
  for (const f of shown) {
    p(`${TINT[f.severity](f.severity.toUpperCase().padEnd(8))} ${f.title}`)
    p(`${' '.repeat(9)}${dim(SURFACE_LABEL[f.surface])}`)
    if (f.why) for (const l of wrap(f.why, 88)) p(`${' '.repeat(9)}${l}`)
    if (f.fix) for (const l of wrap(`fix: ${f.fix}`, 88)) p(`${' '.repeat(9)}${dim(l)}`)
    p()
  }
  return out.join('\n')
}

export function renderMcpCost(report) {
  const out = []
  const p = (s = '') => out.push(s)
  p()
  p(bold('MCP COST') + dim('   measured by contrast across every repo on this machine'))
  p()
  p(dim(`  ${'repos'.padStart(7)}${'prefix'.padStart(10)}${'vs base'.padStart(10)}  declared servers`))
  const base = report.baseline?.median ?? 0
  for (const g of report.group) {
    const delta = g.median - base
    const label = g === report.baseline ? dim('baseline') : (delta > 0 ? '+' : '') + formatToken(delta)
    p(
      `  ${String(g.sample).padStart(7)}${formatToken(g.median).padStart(10)}${label.padStart(g === report.baseline ? 18 : 10)}  ${g.server.length ? g.server.join(', ') : dim('none')}`,
    )
  }
  p()
  if (report.note) p(dim(`  ${report.note}`))
  p(dim('  a declared server that never connects also measures as free -- zero means "not loading", not "no schemas"'))
  p()
  return out.join('\n')
}

export function renderSkill(report) {
  const out = []
  const p = (s = '') => out.push(s)
  p()
  p(bold('SKILL') + dim('   what the discovery root costs, and what it earns'))
  p()
  p(dim(`  ${'skill'.padEnd(26)}${'tok/turn'.padStart(9)}${'fired'.padStart(7)}${'tracked'.padStart(9)}`))
  for (const s of report.skill) {
    // Pad before tinting -- ANSI codes are characters too, and padding a
    // coloured string silently breaks every column after it.
    const fired = String(s.invoked).padStart(7)
    const tracked = (s.tracked ? 'yes' : 'no').padStart(9)
    p(
      `  ${s.name.slice(0, 25).padEnd(26)}${String(s.descToken).padStart(9)}` +
        `${s.invoked === 0 ? TINT.medium(fired) : fired}${s.tracked ? tracked : dim(tracked)}`,
    )
  }
  p()
  for (const r of report.byRoot)
    p(dim(`  ${formatToken(r.token).padStart(7)}  ${r.root}`))
  p()
  p(
    dim(
      `  ${report.skill.length} distinct skills · ${formatToken(report.perTurn)} tokens every turn (largest root) · ` +
        `${report.pool.length} pooled at no cost · ${report.invocation.total} invocations across ${report.invocation.scanned} transcripts`,
    ),
  )
  if (report.budget)
    p(
      dim(
        `  ${report.budget.char} of ${report.budget.budget} chars of the harness skill budget: ` +
          `2% of a ${formatToken(report.budget.window)} window ${windowNote(report.budget.source)}`,
      ),
    )
  p()
  return out.join('\n')
}

export function renderFleet(report) {
  const out = []
  const p = (s = '') => out.push(s)
  p()
  p(bold('FLEET') + dim('   every always-on document, ranked by measured turns x estimated size'))
  p()
  p(
    dim(
      `  ${'document'.padEnd(28)}${'kind'.padEnd(9)}${'scope'.padEnd(6)}${'tok/turn'.padStart(9)}${'turns'.padStart(7)}${'repos'.padStart(7)}${'paid'.padStart(9)}${'fired'.padStart(7)}`,
    ),
  )
  for (const x of report.item.slice(0, 25)) {
    // Pad every cell BEFORE tinting -- ANSI codes are characters too, and a
    // coloured string padded to width silently breaks every column after it.
    const fired = (x.fired === null ? '-' : String(x.fired)).padStart(7)
    p(
      `  ${x.name.slice(0, 27).padEnd(28)}${x.kind.padEnd(9)}${x.scope.padEnd(6)}` +
        `${String(x.perTurn).padStart(9)}${formatToken(x.turn).padStart(7)}${String(x.repoCount).padStart(7)}` +
        `${formatToken(x.paid).padStart(9)}` +
        `${x.fired === 0 ? TINT.medium(fired) : x.fired === null ? dim(fired) : fired}`,
    )
  }
  p()

  const worked = report.repo.filter((r) => r.turn > 0)
  p(
    dim(
      `  ${report.repo.length} repos audited · ${worked.length} with session history · ` +
        `${report.turn.toLocaleString('en-US')} measured turns · ${report.item.length} always-on documents`,
    ),
  )
  p(dim('  paid = tok/turn x turns, at each document\'s CURRENT size. Turns are measured; tok/turn is estimated.'))
  p(dim('  do not sum this column: two rows for one repo are two harnesses, and you only ever run one of them.'))
  p(dim('  `fired` is - where firing is not observable, and 0 only where transcripts were actually read.'))
  if (report.note) p(dim(`  ${report.note}`))
  p()
  return out.join('\n')
}

export function renderSession(surface) {
  const out = []
  const p = (s = '') => out.push(s)
  p()
  p(bold('SESSION') + dim('   measured from transcripts, not estimated'))
  p()
  p(
    dim(
      `  ${'session'.padEnd(10)}${'harness'.padEnd(9)}${'turn'.padStart(6)}${'prefix'.padStart(9)}${'cache rd'.padStart(10)}${'cache wr'.padStart(10)}${'out'.padStart(8)}${'  hit'}`,
    ),
  )
  for (const s of surface) {
    const billable = s.cacheRead + s.cacheCreate + s.input
    const hit = billable ? Math.round((s.cacheRead / billable) * 100) : 0
    p(
      `  ${s.id.slice(0, 8).padEnd(10)}${(s.harness ?? 'claude').padEnd(9)}${String(s.turn).padStart(6)}${formatToken(s.prefixToken).padStart(9)}${formatToken(s.cacheRead).padStart(10)}${formatToken(s.cacheCreate).padStart(10)}${formatToken(s.output).padStart(8)}${`${hit}%`.padStart(6)}`,
    )
  }
  p()
  return out.join('\n')
}

function tally(finding) {
  const count = {}
  for (const f of finding) count[f.severity] = (count[f.severity] ?? 0) + 1
  return count
}

function wrap(text, width) {
  const line = []
  let cur = ''
  for (const word of text.split(/\s+/)) {
    if (cur && cur.length + word.length + 1 > width) {
      line.push(cur)
      cur = word
    } else cur = cur ? `${cur} ${word}` : word
  }
  if (cur) line.push(cur)
  return line
}
