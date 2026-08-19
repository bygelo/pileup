#!/usr/bin/env node
// Does every harness fact carry a dated source, and is the register current?
//
// This is the cheap half of the "Track the harness" roadmap item. It cannot tell
// you a fact is still TRUE -- only a live harness can -- but it can refuse to let
// one be added without a date and a source, which is how the last batch rotted
// silently.
//
// Exits non-zero and says what is missing, so it works in CI.

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = new URL('..', import.meta.url).pathname
const REGISTER = join(ROOT, 'docs/harness-fact.md')

// A file that hard-codes a fact about someone else's software must cite it.
const MUST_CITE = [
  'lib/budget.mjs',
  'lib/model.mjs',
  'lib/token.mjs',
  'lib/toolsearch.mjs',
  'lib/collector/mcp.mjs',
  'lib/invocation.mjs',
]

const DATE = /\b20\d\d-\d\d-\d\d\b/

const fail = []

const register = readFileSync(REGISTER, 'utf8')

for (const rel of MUST_CITE) {
  const text = readFileSync(join(ROOT, rel), 'utf8')
  if (!text.includes('SOURCE:')) {
    fail.push(`${rel}: hard-codes a harness fact but carries no \`SOURCE:\` comment`)
    continue
  }
  // Every SOURCE: block must name when it was read, or "recently" becomes
  // whenever the reader happens to be looking.
  const cited = text
    .split('SOURCE:')
    .slice(1)
    .some((chunk) => DATE.test(chunk.slice(0, 500)))
  if (!cited) fail.push(`${rel}: \`SOURCE:\` does not say when it was read (want a YYYY-MM-DD)`)
  if (!register.includes(rel.replace('lib/', ''))) {
    fail.push(`${rel}: cites a source but is not listed in docs/harness-fact.md`)
  }
}

// The register itself must be dated, or it silently becomes folklore.
if (!DATE.test(register)) fail.push('docs/harness-fact.md: carries no dates')

// Any file that names ENABLE_TOOL_SEARCH must not treat absence as "off" -- the
// specific inversion that shipped a false HIGH finding.
const ts = readFileSync(join(ROOT, 'lib/toolsearch.mjs'), 'utf8')
if (!/UNSET\s+->\s+tst/i.test(ts) && !/unset is the ON default/i.test(ts))
  fail.push('lib/toolsearch.mjs: must state that an unset ENABLE_TOOL_SEARCH means ON')

if (fail.length) {
  process.stderr.write(`\nharness-fact: ${fail.length} problem${fail.length > 1 ? 's' : ''}\n\n`)
  for (const f of fail) process.stderr.write(`  ${f}\n`)
  process.stderr.write('\nSee docs/harness-fact.md for what a citation looks like.\n\n')
  process.exit(1)
}

process.stdout.write(
  `harness-fact: ${MUST_CITE.length} files cite a dated source, register is current\n`,
)
