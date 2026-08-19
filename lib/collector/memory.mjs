// Memory files: CLAUDE.md, AGENTS.md, .cursorrules, copilot-instructions.md.
//
// These are the purest always-on cost. Every byte is re-sent on every turn of
// every session, forever, whether or not the turn has anything to do with it.

import { dirname, resolve } from 'node:path'
import { artifactOf } from '../adapter.mjs'
import { MEMORY_FILE } from '../budget.mjs'
import { gradeBy, mkFinding } from '../finding.mjs'
import { readText, relative } from '../fs.mjs'
import { estimateTokenFor, formatToken } from '../token.mjs'

// `@path/to/file` on its own line pulls that file into context too. Claude Code
// follows these recursively, which is how a 2k CLAUDE.md becomes a 40k prefix.
const IMPORT = /^\s*@([^\s`]+\.(?:md|markdown|txt))\s*$/gm

export const id = 'memory'

export function collect(ctx) {
  const finding = []
  const surface = []

  for (const a of artifactOf(ctx.harness, 'memory')) {
    const text = readText(a.path)
    if (text == null) continue

    const own = estimateTokenFor(text, a.harness)
    const imported = followImport(a.path, ctx.root, a.harness)
    const total = own + imported.reduce((s, i) => s + i.token, 0)

    surface.push({ ...a, token: total, own, import: imported })

    const severity = gradeBy(total, MEMORY_FILE)
    if (severity) {
      finding.push(
        mkFinding({
          id: 'memory-oversized',
          severity,
          surface: 'always-on',
          title: `${a.rel} costs ${formatToken(total)} tokens on every turn`,
          why:
            imported.length > 0
              ? `${formatToken(own)} of its own plus ${formatToken(total - own)} pulled in through ${imported.length} @import${imported.length > 1 ? 's' : ''}.`
              : 'Memory files are re-sent in full on every request, including turns that never touch the subject.',
          fix:
            'Keep only what changes agent behaviour on an arbitrary turn: build commands, hard invariants, naming rules. ' +
            'Move history, decisions and narrative into docs the agent opens on demand, and link them instead of inlining.',
          data: {
            path: a.rel,
            scope: a.scope,
            harness: a.harness,
            token: total,
            ownToken: own,
            importToken: total - own,
            import: imported.map((i) => i.rel),
          },
        }),
      )
    }

    for (const i of imported) {
      if (i.token < 4_000) continue
      finding.push(
        mkFinding({
          id: 'memory-heavy-import',
          severity: i.token >= 15_000 ? 'high' : 'medium',
          surface: 'always-on',
          title: `${a.rel} @imports ${i.rel} (${formatToken(i.token)} tokens)`,
          why: 'An @import is not a link. Its full text is inlined into the always-on prefix.',
          fix: `Drop the @ and reference ${i.rel} as a normal path so the agent reads it only when it needs it.`,
          data: { path: a.rel, import: i.rel, token: i.token, harness: a.harness },
        }),
      )
    }
  }

  return { finding, surface }
}

function followImport(path, root, harness, seen = new Set()) {
  const text = readText(path)
  if (text == null) return []
  const hit = []
  for (const [, target] of text.matchAll(IMPORT)) {
    const abs = resolve(dirname(path), target.replace(/^~[\\/]/, ''))
    if (seen.has(abs)) continue
    seen.add(abs)
    const body = readText(abs)
    if (body == null) continue
    hit.push({ rel: relative(root, abs), path: abs, token: estimateTokenFor(body, harness) })
    hit.push(...followImport(abs, root, harness, seen))
  }
  return hit
}
