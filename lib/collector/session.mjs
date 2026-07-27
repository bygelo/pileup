// Session telemetry -- the only numbers here that are not estimates.
//
// Every other collector reasons about files on disk. This one reads what the
// API actually billed: how big the prefix really was, how much of it was
// cached, which tool results landed in the window and how big they were.
//
// Today this reads Claude Code transcripts. Other harnesses log in their own
// formats; when one is not supported pileup says so rather than guessing.

import { CACHE_HIT_FLOOR, PREFIX, gradeFloor } from '../budget.mjs'
import { gradeBy, mkFinding } from '../finding.mjs'
import { discoverTranscript, readTranscript } from '../transcript.mjs'
import { formatToken } from '../token.mjs'

const BIG_RESULT = 25_000 // tokens in one tool result before it is worth naming

export const id = 'session'

export function collect(ctx) {
  const found = discoverTranscript(ctx.root, ctx)
  if (!found.length)
    return { finding: [], surface: [], note: 'no Claude Code or Codex transcripts found for this repo' }

  const session = found
    .map(readTranscript)
    .filter((s) => s && s.turn > 0)
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, ctx.sessionLimit ?? 20)

  if (!session.length) return { finding: [], surface: [], note: 'transcripts found but none had billable turns' }

  const finding = []
  const total = session.reduce(
    (s, x) => ({
      cacheRead: s.cacheRead + x.cacheRead,
      cacheCreate: s.cacheCreate + x.cacheCreate,
      input: s.input + x.input,
      output: s.output + x.output,
    }),
    { cacheRead: 0, cacheCreate: 0, input: 0, output: 0 },
  )
  const billable = total.cacheRead + total.cacheCreate + total.input
  const hitRate = billable ? total.cacheRead / billable : 0

  const cacheSeverity = gradeFloor(hitRate, CACHE_HIT_FLOOR)
  if (cacheSeverity) {
    finding.push(
      mkFinding({
        id: 'session-low-cache-hit',
        severity: cacheSeverity,
        surface: 'cache',
        title: `${Math.round(hitRate * 100)}% of billed input was cache reads across ${session.length} sessions`,
        why:
          `${formatToken(total.cacheCreate)} tokens were written to cache and ${formatToken(total.cacheRead)} read back. ` +
          'Cache reads bill at about a tenth of normal input, so a low ratio is a direct multiplier on cost -- and on ' +
          'a subscription, on how fast you burn the quota.',
        fix:
          'Keep the front of the prompt still: stop switching models mid-session, stop editing memory files while a ' +
          'session runs, and let long sessions run rather than restarting them.',
        data: { token: total.cacheCreate, hitRate, ...total, session: session.length },
      }),
    )
  }

  const prefix = session.filter((s) => s.prefixToken > 0)
  if (prefix.length) {
    const worst = prefix.reduce((a, b) => (b.prefixToken > a.prefixToken ? b : a))
    finding.push(
      mkFinding({
        id: 'session-measured-prefix',
        severity: gradeBy(worst.prefixToken, PREFIX) ?? 'info',
        surface: 'always-on',
        title: `measured always-on prefix: ${formatToken(median(prefix.map((s) => s.prefixToken)))} tokens (worst ${formatToken(worst.prefixToken)})`,
        why:
          'The smallest billed turn of each session, which is its opening turn: system prompt, tool schemas, memory ' +
          'files and skill descriptions, before the session has done anything. Every later turn pays this too. ' +
          'This is the ground truth the static estimates approximate.',
        fix:
          'Compare against the always-on estimate. A large gap between the two is MCP tool schemas and the harness ' +
          'system prompt, neither of which pileup can size from disk.',
        data: {
          token: worst.prefixToken,
          median: median(prefix.map((s) => s.prefixToken)),
          sample: prefix.length,
        },
      }),
    )
  }

  for (const s of session) {
    if (s.model.length > 1) {
      finding.push(
        mkFinding({
          id: 'session-model-switch',
          severity: 'medium',
          surface: 'cache',
          title: `session ${s.id.slice(0, 8)} used ${s.model.length} models (${s.model.join(', ')})`,
          why: 'Each model keeps its own cache. Switching mid-session re-writes the entire prefix under the new model.',
          fix: 'Pick a model at the start of a session and stay on it. Delegate the cheap parts to subagents instead.',
          data: { session: s.id, model: s.model, cacheCreate: s.cacheCreate },
        }),
      )
    }
  }

  // One call site can blow the window a dozen times over a week. Group by what
  // was actually read, not by each occurrence, so the report names the habit
  // rather than repeating the symptom.
  const bySite = new Map()
  for (const s of session)
    for (const r of s.result) {
      if (r.token < BIG_RESULT) continue
      const key = `${r.tool}|${r.target ?? ''}`
      const site = bySite.get(key) ?? { tool: r.tool, target: r.target, hit: 0, token: 0, worst: 0 }
      site.hit += 1
      site.token += r.token
      site.worst = Math.max(site.worst, r.token)
      bySite.set(key, site)
    }

  for (const r of [...bySite.values()].sort((a, b) => b.token - a.token).slice(0, 8)) {
    finding.push(
      mkFinding({
        id: 'session-heavy-tool-result',
        severity: r.worst >= 80_000 ? 'high' : 'medium',
        surface: 'on-read',
        title:
          r.hit > 1
            ? `${r.tool} on ${r.target ?? 'an unnamed target'} cost ${formatToken(r.token)} tokens across ${r.hit} calls`
            : `one ${r.tool} result cost ${formatToken(r.worst)} tokens${r.target ? ` (${r.target})` : ''}`,
        why:
          'A tool result of this size stays in context for the rest of the session and is re-sent on every later ' +
          'turn until the window is compacted. Doing it repeatedly is a habit worth changing, not an accident.',
        fix:
          r.tool === 'Read'
            ? 'Read with an offset and limit, grep for the line first, or send the sweep to a subagent so only its conclusion comes back.'
            : 'Narrow the query, or run it in a subagent and return a summary rather than the raw output.',
        data: { tool: r.tool, target: r.target, token: r.token, worst: r.worst, call: r.hit },
      }),
    )
  }

  // Compaction is not free: the whole prompt is re-sent uncached afterwards, so
  // a session that compacts repeatedly pays the prefix over again each time.
  const compaction = session.reduce((s, x) => s + x.compaction, 0)
  if (compaction >= 2) {
    const typical = median(session.filter((s) => s.prefixToken > 0).map((s) => s.prefixToken))
    finding.push(
      mkFinding({
        id: 'session-compaction',
        severity: compaction >= 6 ? 'medium' : 'low',
        surface: 'cache',
        title: `${compaction} compactions across ${session.length} sessions`,
        why:
          'Compacting discards the cached prefix. The next turn rebuilds it at cache-write price and every turn after ' +
          `that re-reads it -- roughly ${formatToken(typical)} tokens rewritten per compaction here.`,
        fix:
          'Compact earlier rather than more often. A session compacted at ~60% of the window keeps a better summary ' +
          'than one compacted at 95%, and repeated compaction is usually a sign the session should have been handed ' +
          'off to a fresh one instead.',
        data: { token: typical * compaction, compaction, session: session.length },
      }),
    )
  }

  // Codex reports the real context window and the actual subscription usage.
  // Neither is inferable from Claude transcripts, so this only fires there.
  const withWindow = session.find((s) => s.window)
  if (withWindow && ctx.window && Math.abs(withWindow.window - ctx.window) > 1_000)
    finding.push(
      mkFinding({
        id: 'session-window-mismatch',
        severity: 'info',
        surface: 'always-on',
        title: `transcripts report a ${formatToken(withWindow.window)} context window, not the ${formatToken(ctx.window)} being measured against`,
        why: 'Shares reported elsewhere in this audit are against the assumed window, so they are proportionally off.',
        fix: `Re-run with --window ${withWindow.window}.`,
        data: { token: null, reported: withWindow.window, assumed: ctx.window },
      }),
    )

  const quota = session.map((s) => s.quota).filter(Boolean).sort((a, b) => b.usedPercent - a.usedPercent)[0]
  if (quota)
    finding.push(
      mkFinding({
        id: 'session-quota',
        severity: quota.usedPercent >= 90 ? 'high' : quota.usedPercent >= 70 ? 'medium' : 'info',
        surface: 'always-on',
        title: `subscription quota at ${Math.round(quota.usedPercent)}% of its ${formatWindow(quota.windowMinute)} window${quota.plan ? ` (${quota.plan})` : ''}`,
        why:
          'Read straight from the transcript, so this is what the provider actually counted -- not an estimate. On a ' +
          'subscription the always-on prefix is the dominant term: it is re-sent every turn whether or not the turn ' +
          'needed it.',
        fix:
          'The always-on findings in this report are the lever. Cutting the prefix cuts every turn for the rest of the ' +
          'window, which nothing else in a session does.',
        data: { token: null, ...quota },
      }),
    )

  return { finding, surface: session, note: null }
}

function formatWindow(minute) {
  if (!minute) return 'rate-limit'
  if (minute >= 10_080) return `${Math.round(minute / 10_080)}-week`
  if (minute >= 1_440) return `${Math.round(minute / 1_440)}-day`
  return `${minute}-minute`
}

function median(n) {
  const sorted = [...n].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)] ?? 0
}
