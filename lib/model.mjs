// Which context window the shares in this report are measured against.
//
// pileup used to assume 200k for everything. That assumption stopped being safe
// in July 2026, when Claude Opus 5 became Claude Code's default Opus model with
// a 1M window. Every "% of the window" number computed against 200k on a 1M
// session overstates by five times, which inflates severity on exactly the
// findings the report leads with.
//
// So the window is resolved rather than assumed, and the report says where the
// number came from:
//
//   flag      --window, which always wins
//   reported  the harness wrote it into the transcript (Codex: model_context_window)
//   model     derived from the model name observed in a transcript
//   default   nothing said, so DEFAULT_WINDOW and the report labels it assumed
//
// Only the first two are measured. `model` is a lookup, and the table below is
// deliberately short: it holds the windows that are documented, and returns
// null for everything else instead of guessing. A wrong window is worse than an
// admitted-unknown one, because it silently rescales every share in the report.

import { homedir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_WINDOW } from './budget.mjs'
import { readHead, safeStat, walkFile } from './fs.mjs'
import { discoverTranscript } from './transcript.mjs'

/**
 * Model name -> context window. Ordered; first match wins.
 *
 * SOURCE: Claude Code changelog 2.1.219 (2026-07-24), read 2026-07-30 -- "Added
 * Claude Opus 5 (claude-opus-5), now the default Opus model -- 1M context". A
 * harness fact; see docs/harness-fact.md.
 *
 * Kept to what is documented. Anthropic's long-context variants carry an
 * explicit `[1m]` suffix in the model id, which is more reliable than any name
 * table, so it is matched first.
 */
export const MODEL_WINDOW = [
  [/\[1m\]/i, 1_000_000],
  [/claude-opus-5/i, 1_000_000],
]

/** Documented window for a model id, or null when nothing is known about it. */
export function windowOfModel(model) {
  if (!model) return null
  for (const [pattern, window] of MODEL_WINDOW) if (pattern.test(model)) return window
  return null
}

/**
 * Resolve the window to grade against, cheaply.
 *
 * This runs before the collectors, so it cannot use what the session collector
 * measures. Instead it reads the HEAD of the newest transcript per harness --
 * enough to see a model id and, on Codex, the reported window -- without
 * parsing whole logs. The session collector still cross-checks its full parse
 * and reports a mismatch if this probe got it wrong.
 */
export function resolveWindow(root, opt = {}) {
  return fromProbe(opt, () => probePath(discoverTranscript(root, opt).map((t) => t.path)))
}

/**
 * The same question for a machine-scoped audit like `pileup skill`, where there
 * is no repo to read transcripts for. Answers from the newest transcript
 * anywhere, which is the model the user is actually running today.
 */
export function resolveWindowMachine(opt = {}) {
  const dir = opt.transcript ?? join(opt.home ?? homedir(), '.claude', 'projects')
  return fromProbe(opt, () =>
    safeStat(dir) ? probePath(walkFile(dir, (n) => n.endsWith('.jsonl'), 3)) : { model: null, window: null },
  )
}

function fromProbe(opt, probe) {
  if (opt.window) return { window: opt.window, source: 'flag', model: null }

  const found = probe()
  if (found.window) return { window: found.window, source: 'reported', model: found.model }

  const derived = windowOfModel(found.model)
  if (derived) return { window: derived, source: 'model', model: found.model }

  return { window: DEFAULT_WINDOW, source: 'default', model: found.model }
}

const HEAD = 131_072

// Model ids as they appear in either transcript format. Claude writes
// `"model":"claude-opus-5[1m]"` on assistant messages; Codex writes it in
// session_meta alongside `model_context_window`.
const MODEL_KEY = /"model"\s*:\s*"([^"]+)"/g
const WINDOW_KEY = /"model_context_window"\s*:\s*(\d+)/

function probePath(path) {
  if (!path.length) return { model: null, window: null }

  // Newest first: the model in use now matters, not the one from March.
  const newest = path
    .map((p) => ({ path: p, mtime: safeStat(p)?.mtimeMs ?? 0 }))
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, 3)

  let model = null
  for (const t of newest) {
    const head = readHead(t.path, HEAD)
    if (!head) continue

    const window = head.match(WINDOW_KEY)
    if (window) return { model: lastModel(head) ?? model, window: Number(window[1]) }

    model ??= lastModel(head)
  }
  return { model, window: null }
}

/**
 * The last model id in the sampled head, not the first.
 *
 * A resumed or long-running session can open on one model and continue on
 * another; the later one is the one still billing.
 */
function lastModel(head) {
  let hit = null
  for (const m of head.matchAll(MODEL_KEY)) {
    // Both formats also carry unrelated `model` keys on sub-objects (usage
    // summaries, provider metadata). Anything without a vendor prefix is noise.
    if (/^(claude|gpt|o[0-9]|gemini|grok)/i.test(m[1])) hit = m[1]
  }
  return hit
}
