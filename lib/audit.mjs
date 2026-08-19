// The dispatcher.
//
// Collectors are independent on purpose: one throwing must not take the run
// with it, because a partial report is still worth reading.

import { resolveHarness } from './adapter.mjs'
import { ALWAYS_ON_TOTAL } from './budget.mjs'
import { gradeBy, mkFinding, rankFinding } from './finding.mjs'
import { safeStat } from './fs.mjs'
import { resolveWindow } from './model.mjs'
import { TOKENIZER, familyOf, formatShare, formatToken } from './token.mjs'

import * as memory from './collector/memory.mjs'
import * as definition from './collector/definition.mjs'
import * as mcp from './collector/mcp.mjs'
import * as prefix from './collector/prefix.mjs'
import * as doc from './collector/doc.mjs'
import * as session from './collector/session.mjs'
import * as output from './collector/output.mjs'

// Ordered. `output` reads what `session` measured, so it runs after it.
export const COLLECTOR = [memory, definition, mcp, prefix, doc, session, output]

export function audit(root, opt = {}) {
  const resolved = resolveWindow(root, opt)
  const window = resolved.window
  const harness = resolveHarness(root, { user: opt.user, home: opt.home, harness: opt.harness })
  const ctx = {
    root,
    harness,
    window,
    windowSource: resolved.source,
    model: resolved.model,
    // Threaded so a test can pin the machine-wide surface instead of reading
    // whatever the developer happens to have in their own ~/.claude.
    home: opt.home,
    user: opt.user,
    env: opt.env,
    // Transcript roots, overridable for the same reason: a test must not read
    // the developer's session history.
    claudeDir: opt.claudeDir,
    codexDir: opt.codexDir,
    sessionLimit: opt.sessionLimit,
    sizeOf: (p) => safeStat(p)?.size ?? null,
  }

  const finding = []
  const surface = {}
  const error = []
  const note = {}
  const meta = {}

  // Later collectors can read what earlier ones measured.
  ctx.surface = surface
  ctx.meta = meta

  for (const c of COLLECTOR) {
    if (opt.skip?.includes(c.id)) continue
    if (opt.only?.length && !opt.only.includes(c.id)) continue
    try {
      const out = c.collect(ctx)
      finding.push(...out.finding)
      surface[c.id] = out.surface
      if (out.note) note[c.id] = out.note
      if (out.meta) meta[c.id] = out.meta
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

  const gap = prefixGap(worst, surface.session, meta.mcp?.toolSearch)
  if (gap) finding.push(gap)

  // Every share in this report is relative to the window. If nothing told
  // pileup what the window is, say so once rather than letting the shares read
  // as measured.
  if (resolved.source === 'default' && resolved.model) {
    finding.push(
      mkFinding({
        id: 'window-assumed',
        severity: 'info',
        surface: 'always-on',
        title: `window assumed to be ${formatToken(window)}; transcripts run ${resolved.model}, whose window pileup does not know`,
        why:
          'Every percentage-of-window figure in this report scales with this number. Claude Opus 5 carries a 1M ' +
          'window, five times the old default, so an assumed 200k overstates every share by five times.',
        fix: `Re-run with --window set to the real window for ${resolved.model}.`,
        data: { token: null, window, model: resolved.model, source: resolved.source },
      }),
    )
  }

  return {
    tool: 'pileup',
    root,
    window,
    windowSource: resolved.source,
    model: resolved.model,
    harness: harness.map((h) => ({ id: h.id, name: h.name, artifact: h.artifact.length })),
    alwaysOn,
    finding: rankFinding(finding),
    surface,
    meta,
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
function prefixGap(worst, session, toolSearch) {
  if (!worst || !session?.length) return null
  const measured = session.map((s) => s.prefixToken).filter((t) => t > 0)
  if (!measured.length) return null
  // The floor, not the median. A median of opening turns includes whatever those
  // first messages carried; only the lowest opening ever seen is safe to compare
  // against disk. Using the median blamed MCP tool schemas for 475k of pasted
  // attachments on one repo.
  const typical = Math.min(...measured)
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
    fix: toolSearch?.deferring
      ? 'Tool schemas are expected to load on demand here, so this gap is mostly the harness\'s own system prompt and ' +
        'built-in tools, which you cannot trim. Verify by disconnecting a server and re-running `pileup session`: if ' +
        'the prefix barely moves, the deferral is working and the gap is not yours to fix.'
      : 'Deferred tool loading is switched off here, so MCP schemas are in this gap. Remove ENABLE_TOOL_SEARCH to ' +
        'fall back to the default, and disconnect servers you do not use in this repo. Re-run `pileup session` after ' +
        'each change -- if the prefix drops, you found it.',
    data: {
      token: delta,
      measured: typical,
      onDisk: worst.token,
      mcpServer: worst.mcpServer,
      toolSearch: toolSearch ?? null,
    },
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
    const family = familyOf(h.id)
    return {
      harness: h.id,
      name: h.name,
      // Which tokenizer these numbers are counted with. Reported rather than
      // hidden: a Codex row and a Claude Code row for the same files are
      // legitimately different numbers, and a reader who does not know that
      // will read the difference as a bug.
      tokenizer: family,
      tokenizerName: TOKENIZER[family].name,
      token: memoryToken + def.reduce((s, d) => s + d.descToken, 0),
      memory: memoryToken,
      description: def.reduce((s, d) => s + d.descToken, 0),
      definition: def.length,
      mcpServer: mcp.length,
    }
  })
  return { byHarness: byHarness.sort((a, b) => b.token - a.token) }
}
