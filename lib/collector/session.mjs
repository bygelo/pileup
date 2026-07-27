// Session telemetry -- the only numbers here that are not estimates.
//
// Every other collector reasons about files on disk. This one reads what the
// API actually billed: how big the prefix really was, how much of it was
// cached, which tool results landed in the window and how big they were.
//
// Today this reads Claude Code transcripts. Other harnesses log in their own
// formats; when one is not supported pileup says so rather than guessing.

import { homedir } from 'node:os'
import { join } from 'node:path'
import { CACHE_HIT_FLOOR, PREFIX, gradeFloor } from '../budget.mjs'
import { gradeBy, mkFinding } from '../finding.mjs'
import { readText, safeStat, walkFile } from '../fs.mjs'
import { estimateToken, formatToken } from '../token.mjs'

const BIG_RESULT = 25_000 // tokens in one tool result before it is worth naming

export const id = 'session'

export function collect(ctx) {
  const dir = transcriptDir(ctx.root)
  if (!dir) return { finding: [], surface: [], note: 'no Claude Code transcripts found for this repo' }

  const session = walkFile(dir, (n) => n.endsWith('.jsonl'))
    .map((p) => readSession(p, ctx))
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

  return { finding, surface: session, note: null }
}

function transcriptDir(root) {
  const base = join(homedir(), '.claude', 'projects')
  if (!safeStat(base)) return null
  const slug = root.replace(/[^a-zA-Z0-9]/g, '-')
  for (const candidate of [slug, slug.toLowerCase(), slug.replace(/^([a-zA-Z])/, (c) => c.toUpperCase())]) {
    const dir = join(base, candidate)
    if (safeStat(dir)?.isDirectory()) return dir
  }
  return null
}

function readSession(path, ctx) {
  const text = readText(path)
  if (text == null) return null

  const s = {
    id: path.split(/[\\/]/).pop().replace('.jsonl', ''),
    mtime: safeStat(path)?.mtimeMs ?? 0,
    turn: 0,
    cacheRead: 0,
    cacheCreate: 0,
    input: 0,
    output: 0,
    prefixToken: 0,
    model: [],
    result: [],
  }
  const pending = new Map() // tool_use_id -> { tool, target }

  for (const line of text.split('\n')) {
    if (!line) continue
    let d
    try {
      d = JSON.parse(line)
    } catch {
      continue
    }

    if (d.type === 'assistant' && d.message?.usage) {
      const u = d.message.usage
      s.turn += 1
      s.cacheRead += u.cache_read_input_tokens ?? 0
      s.cacheCreate += u.cache_creation_input_tokens ?? 0
      s.input += u.input_tokens ?? 0
      s.output += u.output_tokens ?? 0
      // Context only grows within a session, so the smallest turn is the closest
      // thing to the bare prefix. Taking the FIRST turn instead would be wrong
      // for resumed or compacted sessions, which start mid-conversation.
      const turnTotal =
        (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.input_tokens ?? 0)
      if (turnTotal > 1_000 && (s.prefixToken === 0 || turnTotal < s.prefixToken))
        s.prefixToken = turnTotal
      if (d.message.model && !s.model.includes(d.message.model)) s.model.push(d.message.model)

      for (const block of d.message.content ?? [])
        if (block?.type === 'tool_use')
          pending.set(block.id, { tool: block.name, target: targetOf(block.input) })
      continue
    }

    if (d.type === 'user' && Array.isArray(d.message?.content)) {
      for (const block of d.message.content) {
        if (block?.type !== 'tool_result') continue
        const meta = pending.get(block.tool_use_id) ?? { tool: 'unknown', target: null }
        const token = estimateToken(
          typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? ''),
        )
        if (token >= 2_000) s.result.push({ ...meta, token })
      }
    }
  }

  return s
}

function targetOf(input) {
  if (!input || typeof input !== 'object') return null
  const t = input.file_path ?? input.path ?? input.pattern ?? input.command ?? input.query ?? null
  return typeof t === 'string' ? (t.length > 80 ? `${t.slice(0, 80)}...` : t) : null
}

function median(n) {
  const sorted = [...n].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)] ?? 0
}
