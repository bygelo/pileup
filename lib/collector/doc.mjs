// Read traps.
//
// The one that actually kills sessions. These files cost nothing until an agent
// opens one, and then they cost everything at once. A 1.1 MB decisions log is
// roughly 290k tokens: a single `Read` and the window is gone, mid-task, with
// no warning and nothing to show for it.
//
// Severity escalates when a memory file points at the trap, because then the
// repo is not merely exposed to the risk -- it is directing the agent into it.

import { join } from 'node:path'
import { READ_TRAP } from '../budget.mjs'
import { SEVERITY, gradeBy, mkFinding } from '../finding.mjs'
import { readHead, readText, relative, walkFile } from '../fs.mjs'
import { trackedFile } from '../git.mjs'
import { artifactOf } from '../adapter.mjs'
import { estimateToken, formatShare, formatToken } from '../token.mjs'

const READABLE = /\.(md|markdown|txt|rst|jsonl|json|csv|tsv|ya?ml|log)$/i
const SIZE_FLOOR = 40_000 // bytes; below this nothing is worth reporting
const SAMPLE = 262_144 // sample this many bytes of a huge file and extrapolate
const TOP = 12 // name this many traps individually, then roll the rest up

export const id = 'doc'

export function collect(ctx) {
  const finding = []
  const surface = []

  const referenced = referenceOf(ctx)
  const tracked = trackedFile(ctx.root)
  const candidate = tracked
    ? [...tracked].filter((rel) => READABLE.test(rel)).map((rel) => join(ctx.root, rel))
    : walkFile(ctx.root, (name) => READABLE.test(name) && !name.startsWith('._'))

  for (const path of candidate) {
    const size = ctx.sizeOf(path)
    if (size == null || size < SIZE_FLOOR) continue

    const rel = relative(ctx.root, path)
    const token = tokenOf(path, size)
    const linked = referenced.get(rel) ?? null

    surface.push({ rel, size, token, linkedFrom: linked })
  }

  surface.sort((a, b) => b.token - a.token)

  let trimmed = 0
  let trimmedToken = 0
  for (const d of surface) {
    const { rel, size, token, linkedFrom: linked } = d

    let severity = gradeBy(token, READ_TRAP)
    if (!severity) continue
    if (linked) severity = bump(severity)

    if (finding.length >= TOP) {
      trimmed += 1
      trimmedToken += token
      continue
    }

    finding.push(
      mkFinding({
        id: linked ? 'doc-linked-read-trap' : 'doc-read-trap',
        severity,
        surface: 'on-read',
        title: `${rel} is ${formatToken(token)} tokens (${formatShare(token, ctx.window)} of the window)`,
        why: linked
          ? `${linked} points the agent at this file. One whole-file read spends ${formatShare(token, ctx.window)} of the context window in a single tool call.`
          : 'Nothing forces an agent to open this, and nothing stops it either. One whole-file read ends the session usefully.',
        fix:
          token >= 150_000
            ? `Split ${rel} into one file per entry plus a small index that maps identifiers to files. ` +
              'Then the agent opens the index and one entry, not the archive.'
            : `Add ${rel} to a read-discipline note in the memory file: grep it, or read it with an offset and limit. ` +
              'If it is append-only history, cap it and roll the tail into an archive file.',
        data: { path: rel, token, byte: size, linkedFrom: linked, share: token / ctx.window },
      }),
    )
  }

  if (trimmed) {
    finding.push(
      mkFinding({
        id: 'doc-more-trap',
        severity: 'low',
        surface: 'on-read',
        title: `${trimmed} more files over the read-trap threshold (${formatToken(trimmedToken)} tokens between them)`,
        why: `pileup names the ${TOP} worst individually and rolls the rest up here so the report stays readable.`,
        fix: 'Run `pileup surface` for the full list, or fix the named ones first -- they are the same problem at scale.',
        data: { token: trimmedToken, count: trimmed },
      }),
    )
  }

  const exposure = surface.reduce((s, d) => s + d.token, 0)
  if (exposure > ctx.window) {
    finding.push(
      mkFinding({
        id: 'doc-total-exposure',
        severity: exposure > ctx.window * 4 ? 'high' : 'medium',
        surface: 'on-read',
        title: `${formatToken(exposure)} tokens sit across ${surface.length} readable files -- ${(exposure / ctx.window).toFixed(1)}x the context window`,
        why:
          'No single file has to be the problem. An agent exploring a repo of this shape will fill its window with ' +
          'documents before it reaches the code.',
        fix:
          'Give the repo a map: one small index file the memory file points at, listing what each large doc is for ' +
          'and how to search it. An agent that knows where to look does not have to read to find out.',
        data: { token: exposure, count: surface.length, window: ctx.window },
      }),
    )
  }

  return { finding, surface }
}

/** Map of repo-relative path -> the memory file that mentions it. */
function referenceOf(ctx) {
  const map = new Map()
  for (const a of artifactOf(ctx.harness, 'memory')) {
    const text = readText(a.path)
    if (!text) continue
    // Any path-looking token: markdown links, backticked paths, bare mentions.
    for (const [, hit] of text.matchAll(/[`(\s]([\w.\-/]+\.(?:md|markdown|txt|jsonl|json|csv))[`)\s]/g)) {
      const rel = hit.replace(/^\.\//, '')
      if (!map.has(rel)) map.set(rel, a.rel)
    }
  }
  return map
}

function tokenOf(path, size) {
  if (size <= SAMPLE) return estimateToken(readText(path) ?? '')
  const head = readHead(path, SAMPLE)
  if (head == null) return Math.round(size / 4)
  return Math.round(estimateToken(head) * (size / Buffer.byteLength(head, 'utf8')))
}

function bump(severity) {
  const i = SEVERITY.indexOf(severity)
  return SEVERITY[Math.min(i + 1, SEVERITY.length - 1)]
}
