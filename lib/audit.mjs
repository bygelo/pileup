// The dispatcher.
//
// Collectors are independent on purpose: one throwing must not take the run
// with it, because a partial report is still worth reading.

import { resolveHarness } from './adapter.mjs'
import { ALWAYS_ON_TOTAL, DEFAULT_WINDOW } from './budget.mjs'
import { gradeBy, mkFinding, rankFinding } from './finding.mjs'
import { safeStat } from './fs.mjs'
import { formatShare, formatToken } from './token.mjs'

import * as memory from './collector/memory.mjs'
import * as definition from './collector/definition.mjs'
import * as mcp from './collector/mcp.mjs'
import * as prefix from './collector/prefix.mjs'
import * as doc from './collector/doc.mjs'
import * as session from './collector/session.mjs'

export const COLLECTOR = [memory, definition, mcp, prefix, doc, session]

export function audit(root, opt = {}) {
  const window = opt.window ?? DEFAULT_WINDOW
  const harness = resolveHarness(root, opt)
  const ctx = {
    root,
    harness,
    window,
    sessionLimit: opt.sessionLimit,
    sizeOf: (p) => safeStat(p)?.size ?? null,
  }

  const finding = []
  const surface = {}
  const error = []
  const note = {}

  for (const c of COLLECTOR) {
    if (opt.skip?.includes(c.id)) continue
    if (opt.only?.length && !opt.only.includes(c.id)) continue
    try {
      const out = c.collect(ctx)
      finding.push(...out.finding)
      surface[c.id] = out.surface
      if (out.note) note[c.id] = out.note
    } catch (e) {
      error.push({ collector: c.id, message: e.message })
    }
  }

  const alwaysOn = alwaysOnTotal(surface, harness)
  const worst = alwaysOn.byHarness.reduce((a, b) => (b.token > a.token ? b : a), alwaysOn.byHarness[0])

  if (worst && worst.token > 0) {
    const severity = gradeBy(worst.token, ALWAYS_ON_TOTAL)
    if (severity) {
      finding.push(
        mkFinding({
          id: 'always-on-total',
          severity,
          surface: 'always-on',
          title: `${worst.name} carries ${formatToken(worst.token)} tokens of always-on context before the agent does anything (${formatShare(worst.token, window)} of the window)`,
          why:
            `${formatToken(worst.memory)} from memory files and ${formatToken(worst.description)} from ` +
            `${worst.definition} skill, agent and command descriptions. This is re-sent on every turn of every ` +
            'session, and it does not include MCP tool schemas, which pileup cannot size from disk. ' +
            'Run `pileup session` for the measured number.',
          fix:
            'Rent is only worth paying for context that changes behaviour on an arbitrary turn. Everything else should ' +
            'be a pointer the agent follows when it needs to.',
          data: { token: worst.token, ...worst, window },
        }),
      )
    }
  }

  const gap = prefixGap(worst, surface.session)
  if (gap) finding.push(gap)

  return {
    tool: 'pileup',
    root,
    window,
    harness: harness.map((h) => ({ id: h.id, name: h.name, artifact: h.artifact.length })),
    alwaysOn,
    finding: rankFinding(finding),
    surface,
    note,
    error,
  }
}

/**
 * The difference between what pileup can see on disk and what the API actually
 * billed for the prefix. Everything in that gap is invisible to a file scan:
 * the harness's own system prompt, its built-in tool schemas, and -- the part
 * you control -- the tool schemas of every connected MCP server.
 */
function prefixGap(worst, session) {
  if (!worst || !session?.length) return null
  const measured = session.map((s) => s.prefixToken).filter((t) => t > 0)
  if (!measured.length) return null
  const typical = measured.sort((a, b) => a - b)[Math.floor(measured.length / 2)]
  const delta = typical - worst.token
  if (delta < 10_000) return null

  return mkFinding({
    id: 'prefix-gap',
    severity:
      delta >= 100_000 ? 'critical' : delta >= 50_000 ? 'high' : delta >= 30_000 ? 'medium' : 'low',
    surface: 'always-on',
    title: `${formatToken(delta)} tokens of always-on context are not on disk`,
    why:
      `Sessions measured a ${formatToken(typical)}-token prefix; the files pileup can read account for only ` +
      `${formatToken(worst.token)}. The remainder is the harness's own system prompt and tool schemas -- including ` +
      `${worst.mcpServer || 'any'} MCP server${worst.mcpServer === 1 ? '' : 's'} you configured, which can be the ` +
      'larger half of it.',
    fix:
      'Disconnect MCP servers you do not use in this repo and re-run `pileup session`. If the prefix drops, you found it. ' +
      'Harnesses that support on-demand or deferred tool schemas should have that turned on.',
    data: { token: delta, measured: typical, onDisk: worst.token, mcpServer: worst.mcpServer },
  })
}

/**
 * Always-on cost, split per harness rather than summed.
 *
 * Only one harness runs at a time. Adding Claude Code's surface to Codex's
 * would double-count the same skills installed to both, and would describe a
 * session nobody ever has.
 */
function alwaysOnTotal(surface, harness) {
  const byHarness = harness.map((h) => {
    const memoryToken = (surface.memory ?? [])
      .filter((m) => m.harness === h.id)
      .reduce((s, m) => s + m.token, 0)
    const def = (surface.definition ?? []).filter((d) => d.harness === h.id)
    const mcp = (surface.mcp ?? []).filter((m) => m.harness === h.id)
    return {
      harness: h.id,
      name: h.name,
      token: memoryToken + def.reduce((s, d) => s + d.descToken, 0),
      memory: memoryToken,
      description: def.reduce((s, d) => s + d.descToken, 0),
      definition: def.length,
      mcpServer: mcp.length,
    }
  })
  return { byHarness: byHarness.sort((a, b) => b.token - a.token) }
}
