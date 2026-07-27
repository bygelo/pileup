import assert from 'node:assert/strict'
import test from 'node:test'

import { audit } from '../lib/audit.mjs'
import { estimateToken, formatToken } from '../lib/token.mjs'
import { splitFrontmatter } from '../lib/frontmatter.mjs'
import { gradeBy, mkFinding, rankFinding } from '../lib/finding.mjs'
import { expandPattern } from '../lib/fs.mjs'
import { buildFixture } from './fixture.mjs'

const built = buildFixture()
const fixture = (name) => built[name]

// Every audit in these tests ignores the user-global surface. Otherwise the
// results would depend on whose machine is running them.
const auditFixture = (name, opt) =>
  audit(fixture(name), { user: false, skip: ['session'], ...opt })

const findingOf = (report, id) => report.finding.filter((f) => f.id === id)

test('token: estimates scale with content and format compactly', () => {
  assert.equal(estimateToken(''), 0)
  assert.ok(estimateToken('hello world') <= 4)

  // Prose should land near the 3.5-4.5 chars/token band real tokenizers hit.
  const prose = 'The quick brown fox jumps over the lazy dog. '.repeat(200)
  const perToken = prose.length / estimateToken(prose)
  assert.ok(perToken > 3 && perToken < 5.5, `chars per token was ${perToken}`)

  assert.equal(formatToken(500), '500')
  assert.equal(formatToken(1500), '1.5k')
  assert.equal(formatToken(290_000), '290k')
  assert.equal(formatToken(118_000_000), '118M')
})

test('frontmatter: reads flat keys and leaves the body alone', () => {
  const { meta, body } = splitFrontmatter('---\nname: x\ndescription: hello there\n---\n# Title\n')
  assert.equal(meta.name, 'x')
  assert.equal(meta.description, 'hello there')
  assert.equal(body, '# Title\n')

  const none = splitFrontmatter('# No frontmatter\n')
  assert.deepEqual(none.meta, {})
  assert.equal(none.body, '# No frontmatter\n')
})

test('finding: grading and ranking put per-turn cost first', () => {
  assert.equal(gradeBy(100, [['high', 50], ['low', 10]]), 'high')
  assert.equal(gradeBy(5, [['high', 50], ['low', 10]]), null)

  const ranked = rankFinding([
    mkFinding({ id: 'b', severity: 'critical', surface: 'on-read', title: 'read', data: { token: 900_000 } }),
    mkFinding({ id: 'a', severity: 'critical', surface: 'always-on', title: 'turn', data: { token: 10 } }),
    mkFinding({ id: 'c', severity: 'low', surface: 'always-on', title: 'small' }),
  ])
  assert.deepEqual(ranked.map((f) => f.id), ['a', 'b', 'c'])
  assert.throws(() => mkFinding({ id: 'x', severity: 'nope', surface: 'cache', title: 't' }))
})

test('fs: expandPattern handles * and ** without a glob library', () => {
  const hit = expandPattern(fixture('bloated'), '.claude/skills/*/SKILL.md')
  assert.equal(hit.length, 2)
  assert.ok(expandPattern(fixture('bloated'), '.claude/**/*.json').length >= 1)
  assert.equal(expandPattern(fixture('bloated'), 'nope/*.md').length, 0)
})

test('audit: a lean repo produces no always-on or read-trap findings', () => {
  const report = auditFixture('lean')
  assert.ok(report.harness.some((h) => h.id === 'claude'))
  assert.equal(findingOf(report, 'always-on-total').length, 0)
  assert.equal(findingOf(report, 'doc-read-trap').length, 0)
  assert.equal(findingOf(report, 'doc-linked-read-trap').length, 0)
  assert.equal(report.error.length, 0)
})

test('audit: a bloated repo is caught on every surface', () => {
  const report = auditFixture('bloated')

  // always-on: an oversized memory file, and the @import counted inside it
  const memory = findingOf(report, 'memory-oversized')[0]
  assert.ok(memory, 'expected memory-oversized')
  assert.ok(memory.data.importToken > 10_000, 'the @import should be billed to the memory file')
  assert.ok(findingOf(report, 'memory-heavy-import').length === 1)

  // always-on: a description long enough to be documentation
  assert.ok(findingOf(report, 'definition-fat-description').some((f) => f.data.name === 'verbose'))
  assert.ok(!findingOf(report, 'definition-fat-description').some((f) => f.data.name === 'tight'))

  // always-on: too many MCP servers
  assert.equal(findingOf(report, 'mcp-server-count')[0].data.count, 9)

  // on-read: the trap is linked from CLAUDE.md, so it escalates to critical
  const trap = findingOf(report, 'doc-linked-read-trap').find((f) => f.data.path === 'docs/decisions.md')
  assert.ok(trap, 'expected docs/decisions.md to be flagged')
  assert.equal(trap.severity, 'critical')
  assert.equal(trap.data.linkedFrom, 'CLAUDE.md')

  // cache: a hook that rewrites the prefix mid-session
  const hook = findingOf(report, 'prefix-hook-rewrites-memory')[0]
  assert.ok(hook, 'expected the CLAUDE.md-writing hook to be caught')
  assert.equal(hook.severity, 'high')
  assert.ok(findingOf(report, 'prefix-injecting-hook').length >= 1)

  assert.equal(report.error.length, 0)
})

test('audit: --window changes shares, not findings', () => {
  const small = auditFixture('bloated', { window: 200_000 })
  const large = auditFixture('bloated', { window: 1_000_000 })
  assert.equal(small.window, 200_000)
  assert.equal(large.window, 1_000_000)
  const smallTrap = findingOf(small, 'doc-linked-read-trap')[0]
  const largeTrap = findingOf(large, 'doc-linked-read-trap')[0]
  assert.equal(smallTrap.data.token, largeTrap.data.token)
  assert.ok(smallTrap.data.share > largeTrap.data.share)
})

test('audit: one broken collector does not take the run with it', () => {
  const report = audit(fixture('bloated'), { user: false, only: ['nonexistent'] })
  assert.equal(report.finding.length, 0)
  assert.equal(report.error.length, 0)
})

test('audit: always-on is reported per harness, never summed across them', () => {
  const report = auditFixture('bloated')
  assert.ok(Array.isArray(report.alwaysOn.byHarness))
  for (const h of report.alwaysOn.byHarness)
    assert.equal(h.token, h.memory + h.description, `${h.harness} total should be its own parts`)
})
