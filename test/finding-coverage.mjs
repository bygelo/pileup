#!/usr/bin/env node
// Which findings are PROVEN to fire, and which are only believed to.
//
// Line coverage is the wrong unit here. pileup's output is a list of findings,
// and the meaningful question is not "was this line executed" but "does a test
// assert that this finding fires". A collector can be fully exercised while the
// finding it is supposed to emit never appears in a single assertion.
//
// The ROADMAP quoted a number from this cross-check for months without the
// cross-check existing anywhere runnable, so the number went stale the moment
// anyone added a finding. It runs in `npm test` now.
//
//   node test/finding-coverage.mjs          report, exit 1 if the ratio dropped
//   node test/finding-coverage.mjs --list   just the uncovered ids, one per line

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

// The ratchet. Raise it when coverage improves; never lower it to make a run
// pass -- that is the one edit this file exists to make visible in a diff.
const FLOOR = 34

function walk(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) out.push(...walk(path))
    else if (path.endsWith('.mjs')) out.push(path)
  }
  return out
}

/** Every id passed to mkFinding, in source order, with the file that emits it. */
export function declaredFinding() {
  const found = new Map()
  for (const path of walk(join(ROOT, 'lib'))) {
    const src = readFileSync(path, 'utf8')
    // mkFinding({ ... id: 'x' ... }) -- the id may not be the first key.
    for (const call of src.split('mkFinding(').slice(1)) {
      const match = /\bid:\s*'([a-z0-9-]+)'/.exec(call.slice(0, 400))
      if (match && !found.has(match[1])) found.set(match[1], path.slice(ROOT.length))
    }
  }
  return found
}

/** Every finding id named anywhere in the test suite. */
export function assertedFinding() {
  const named = new Set()
  const src = walk(join(ROOT, 'test'))
    .filter((p) => !p.endsWith('finding-coverage.mjs'))
    .map((p) => readFileSync(p, 'utf8'))
    .join('\n')
  for (const match of src.matchAll(/'([a-z0-9-]+)'/g)) named.add(match[1])
  return named
}

const declared = declaredFinding()
const asserted = assertedFinding()
const uncovered = [...declared.keys()].filter((id) => !asserted.has(id)).sort()
const covered = declared.size - uncovered.length
const percent = Math.round((covered / declared.size) * 100)

if (process.argv.includes('--list')) {
  process.stdout.write(`${uncovered.join('\n')}\n`)
} else {
  process.stdout.write(`finding-coverage: ${covered}/${declared.size} (${percent}%) findings have a test that names them\n`)
  if (uncovered.length) {
    process.stdout.write(`  uncovered: ${uncovered.join(', ')}\n`)
  }
  if (covered < FLOOR) {
    process.stderr.write(`finding-coverage: dropped below the ${FLOOR} floor. Add a test, do not lower the floor.\n`)
    process.exitCode = 1
  }
}
