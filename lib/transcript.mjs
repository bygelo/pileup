// Transcript readers, one per harness, normalising to a single shape.
//
// Grading lives in collector/session.mjs. This file only knows how to turn a
// log format into the same set of numbers, so adding a harness never touches
// the findings.
//
// The important subtlety is that the two formats do NOT mean the same thing by
// "input tokens":
//
//   Claude Code   input / cache_read / cache_creation are DISJOINT; the prompt
//                 is their sum.
//   Codex         input_tokens is the WHOLE prompt, and cached_input_tokens is
//                 the part of it that was cached -- a subset, not a sibling.
//
// Reading Codex with Claude's semantics double-counts the cached portion and
// reports a cache hit rate above 100%. Both readers below emit the disjoint
// form, so every downstream number means one thing.

import { homedir } from 'node:os'
import { join } from 'node:path'
import { readHead, readText, safeStat, walkFile } from './fs.mjs'
import { estimateToken } from './token.mjs'

const MIN_TURN = 1_000 // below this a turn is a stub, not a real request

/** Every transcript belonging to `root`, tagged with the harness that wrote it. */
export function discoverTranscript(root, opt = {}) {
  const home = opt.home ?? homedir()
  return [...claudeTranscript(root, home, opt), ...codexTranscript(root, home, opt)]
}

function claudeTranscript(root, home, opt) {
  const base = opt.claudeDir ?? join(home, '.claude', 'projects')
  if (!safeStat(base)) return []
  // Claude partitions by repo, encoding the path as a directory name.
  const slug = root.replace(/[^a-zA-Z0-9]/g, '-')
  for (const name of [slug, slug.toLowerCase(), slug.replace(/^([a-z])/, (c) => c.toUpperCase())]) {
    const dir = join(base, name)
    if (safeStat(dir)?.isDirectory())
      return walkFile(dir, (n) => n.endsWith('.jsonl'), 2).map((path) => ({ harness: 'claude', path }))
  }
  return []
}

function codexTranscript(root, home, opt) {
  const base = opt.codexDir ?? join(home, '.codex', 'sessions')
  if (!safeStat(base)) return []
  // Codex files them by date, not by repo, so the cwd has to be read out of
  // each one. Only the first record is needed, so read a head rather than a file.
  const want = normalizePath(root)
  return walkFile(base, (n) => n.endsWith('.jsonl'), 6)
    .filter((path) => {
      const head = readHead(path, 65_536)
      if (!head) return false
      const first = head.slice(0, head.indexOf('\n') + 1 || head.length)
      try {
        return normalizePath(JSON.parse(first)?.payload?.cwd ?? '') === want
      } catch {
        return false
      }
    })
    .map((path) => ({ harness: 'codex', path }))
}

export function readTranscript({ harness, path }) {
  const text = readText(path)
  if (text == null) return null
  return harness === 'codex' ? readCodex(path, text) : readClaude(path, text)
}

function blank(path, harness) {
  return {
    id: sessionId(path),
    harness,
    mtime: safeStat(path)?.mtimeMs ?? 0,
    turn: 0,
    cacheRead: 0,
    cacheCreate: 0,
    input: 0,
    output: 0,
    prefixToken: 0,
    compaction: 0,
    // True once this session has compacted. Everything after that point is
    // unusable for measuring the prefix -- see notePrefix.
    compacted: false,
    window: null,
    quota: null,
    model: [],
    result: [],
  }
}

function readClaude(path, text) {
  const s = blank(path, 'claude')
  const pending = new Map()

  for (const line of text.split('\n')) {
    if (!line) continue
    let d
    try {
      d = JSON.parse(line)
    } catch {
      continue
    }

    if (d.isCompactSummary || d.subtype === 'compact_boundary') {
      s.compaction += 1
      s.compacted = true
    }

    if (d.type === 'assistant' && d.message?.usage) {
      const u = d.message.usage
      const read = u.cache_read_input_tokens ?? 0
      const write = u.cache_creation_input_tokens ?? 0
      const fresh = u.input_tokens ?? 0
      s.turn += 1
      s.cacheRead += read
      s.cacheCreate += write
      s.input += fresh
      s.output += u.output_tokens ?? 0
      if (!s.compacted) notePrefix(s, read + write + fresh)
      if (d.message.model && !s.model.includes(d.message.model)) s.model.push(d.message.model)

      for (const b of d.message.content ?? [])
        if (b?.type === 'tool_use') pending.set(b.id, { tool: b.name, target: targetOf(b.input) })
      continue
    }

    if (d.type === 'user' && Array.isArray(d.message?.content))
      for (const b of d.message.content) {
        if (b?.type !== 'tool_result') continue
        const meta = pending.get(b.tool_use_id) ?? { tool: 'unknown', target: null }
        const token = estimateToken(
          typeof b.content === 'string' ? b.content : JSON.stringify(b.content ?? ''),
        )
        if (token >= 2_000) s.result.push({ ...meta, token })
      }
  }
  return s
}

function readCodex(path, text) {
  const s = blank(path, 'codex')

  for (const line of text.split('\n')) {
    if (!line) continue
    let d
    try {
      d = JSON.parse(line)
    } catch {
      continue
    }
    const p = d.payload
    if (!p) continue

    // Codex logs each compaction twice: once as a `compacted` record holding
    // the replacement history, and once as a `context_compacted` event. Count
    // the record only.
    if (d.type === 'compacted') {
      s.compaction += 1
      s.compacted = true
    }

    if (d.type === 'session_meta' && p.model && !s.model.includes(p.model)) s.model.push(p.model)

    if (d.type !== 'event_msg' || p.type !== 'token_count') continue
    const u = p.info?.last_token_usage
    if (!u) continue

    // cached_input_tokens is a SUBSET of input_tokens -- subtract to get the
    // disjoint form the rest of pileup assumes.
    const prompt = u.input_tokens ?? 0
    const read = Math.min(u.cached_input_tokens ?? 0, prompt)
    const write = u.cache_write_input_tokens ?? 0
    const fresh = Math.max(0, prompt - read)

    s.turn += 1
    s.cacheRead += read
    s.cacheCreate += write
    s.input += fresh
    // reasoning_output_tokens is already counted inside output_tokens.
    s.output += u.output_tokens ?? 0
    if (!s.compacted) notePrefix(s, prompt + write)

    if (p.info?.model_context_window) s.window = p.info.model_context_window
    const limit = p.rate_limits?.primary
    if (limit?.used_percent != null)
      s.quota = {
        usedPercent: limit.used_percent,
        windowMinute: limit.window_minutes ?? null,
        plan: p.rate_limits?.plan_type ?? null,
      }
  }
  return s
}

/**
 * Context only grows within a session, so the smallest billed turn is the
 * closest thing to the bare prefix.
 *
 * Only turns BEFORE the first compaction count, and that restriction is
 * load-bearing. A compaction replaces the conversation with a summary that every
 * later turn then carries, so the smallest post-compaction turn is not a prefix
 * at all -- it is a prefix plus a summary. Without this guard one real repo
 * reported a 483k "always-on prefix" and a 475k "not on disk" gap, both CRITICAL,
 * both artefacts: its compacted sessions measured ~515k while the one session
 * that never compacted measured 41k.
 *
 * A session that compacted before its first billed turn -- a resume -- therefore
 * yields no prefix at all, which is correct. pileup cannot see that session's
 * opening turn, so it declines to guess rather than reporting the summary size as
 * always-on cost.
 */
function notePrefix(s, total) {
  if (total > MIN_TURN && (s.prefixToken === 0 || total < s.prefixToken)) s.prefixToken = total
}

function targetOf(input) {
  if (!input || typeof input !== 'object') return null
  const t = input.file_path ?? input.path ?? input.pattern ?? input.command ?? input.query ?? null
  if (typeof t !== 'string') return null
  return t.length > 80 ? `${t.slice(0, 80)}...` : t
}

/**
 * Claude names a file after the session uuid; Codex prefixes a timestamp
 * (`rollout-2026-07-26T20-22-01-019f9e60-...`). Truncating the raw filename
 * makes every Codex session read as "rollout-", so pull the uuid out.
 */
function sessionId(path) {
  const name = path.split(/[\\/]/).pop().replace(/\.jsonl$/, '')
  const uuid = name.match(/([0-9a-f]{8})-[0-9a-f]{4}-[0-9a-f]{4}-/i)
  return uuid ? uuid[1] : name
}

function normalizePath(p) {
  return p.replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase()
}
