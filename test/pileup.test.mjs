import assert from 'node:assert/strict'
import test from 'node:test'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

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

test('token: each harness is counted with its own tokenizer, not one shared guess', async () => {
  const { estimateTokenFor, familyOf, TOKENIZER } = await import('../lib/token.mjs')

  const text = 'The context window is not the same size to every vendor. '.repeat(40)
  const claude = estimateTokenFor(text, 'claude')
  const gpt = estimateTokenFor(text, 'codex')
  const gemini = estimateTokenFor(text, 'gemini')

  // tiktoken is the leanest of the three on English, SentencePiece the densest.
  // Reporting one number for all three made at least one harness row wrong.
  assert.ok(gpt < claude, `gpt ${gpt} must be under claude ${claude}`)
  assert.ok(gemini > claude, `gemini ${gemini} must be over claude ${claude}`)
  assert.equal(claude, estimateToken(text), 'claude is the reference family')

  assert.equal(familyOf('codex'), 'gpt')
  assert.equal(familyOf('copilot'), 'gpt')
  // A model picker is not a model vendor, and pileup must not pretend to know.
  assert.equal(familyOf('cursor'), 'unknown')
  assert.equal(TOKENIZER.unknown.ratio, 1)
  assert.equal(estimateTokenFor('', 'claude'), 0)
})

test('model: the context window is resolved, not assumed at 200k', async () => {
  const { windowOfModel, resolveWindow } = await import('../lib/model.mjs')

  // Opus 5 defaults to 1M. Grading its sessions against 200k overstates every
  // share by five times, which is the whole reason this lookup exists.
  assert.equal(windowOfModel('claude-opus-5'), 1_000_000)
  assert.equal(windowOfModel('claude-opus-5[1m]'), 1_000_000)
  // Unknown means unknown. A wrong window silently rescales the whole report.
  assert.equal(windowOfModel('some-future-model'), null)
  assert.equal(windowOfModel(null), null)

  // --window always wins, and says so.
  const flagged = resolveWindow(fixture('lean'), { window: 123_456 })
  assert.deepEqual(flagged, { window: 123_456, source: 'flag', model: null })

  // No transcripts for a bare fixture repo, so the default is used and labelled.
  const bare = resolveWindow(fixture('lean'), {
    home: fixture('root'),
    claudeDir: join(fixture('root'), 'none'),
    codexDir: join(fixture('root'), 'none'),
  })
  assert.equal(bare.source, 'default')
  assert.equal(bare.window, 200_000)
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

test('output: prices the terseness trade from measured session data', async () => {
  const { collect } = await import('../lib/collector/output.mjs')

  // 100 turns, 1.5k output each, on a big cached prefix -- the shape of a real
  // coding session, where input dominates by an order of magnitude.
  const ctx = {
    surface: {
      session: [
        { turn: 100, output: 150_000, cacheRead: 20_000_000, cacheCreate: 500_000, input: 1_000 },
      ],
    },
  }
  const { finding, surface } = collect(ctx)

  assert.equal(surface[0].perTurn, 1500)
  const trade = finding.find((f) => f.id === 'output-terseness-tradeoff')
  assert.ok(trade, 'expected the terseness trade to be priced')
  assert.ok(trade.data.outputShare > 0 && trade.data.outputShare < 1)
  // Only prose shrinks, so recoverable is always a fraction of the output share.
  assert.ok(trade.data.recoverableShare < trade.data.outputShare)
  assert.ok(finding.some((f) => f.id === 'output-verbose'))

  // No transcripts means no claim, rather than a guess.
  assert.deepEqual(collect({ surface: {} }).finding, [])
})

test('finding: info is a valid severity even though it ranks zero', () => {
  assert.doesNotThrow(() =>
    mkFinding({ id: 'x', severity: 'info', surface: 'cache', title: 't' }),
  )
})

test('skill: dedupes across roots, ignores dot-dirs, and grades on measured firing', async () => {
  const { auditSkill } = await import('../lib/skill.mjs')
  const { skillRoot } = await import('./fixture.mjs')
  const f = skillRoot()

  const report = auditSkill({
    root: f.root,
    pool: f.pool,
    ledger: f.ledger,
    transcript: f.transcript,
  })

  const name = report.skill.map((s) => s.name).sort()
  // `.disabled/` is how a tool parks a skill OUT of discovery -- it costs nothing.
  assert.ok(!name.includes('parked'), 'dot-dirs must not be reported as billing')
  assert.deepEqual(name, ['ghost', 'slashed', 'twin-a', 'twin-b', 'used'])

  const used = report.skill.find((s) => s.name === 'used')
  const ghost = report.skill.find((s) => s.name === 'ghost')
  assert.equal(used.invoked, 3, 'invocations come from transcripts, not guesses')
  assert.equal(ghost.invoked, 0)
  assert.equal(used.tracked, true, 'the ledger decides tracked, not the name')
  assert.equal(ghost.tracked, false)

  // A definition fires through two channels and both count. Counting only `Skill`
  // tool calls reported a skill invoked daily as `/parcel` as never fired -- from
  // the one command whose whole job is saying which skills are unused.
  const slashed = report.skill.find((s) => s.name === 'slashed')
  assert.equal(slashed.invoked, 2, 'slash-command invocations count, arguments and all')

  const unused = report.finding.find((x) => x.id === 'skill-never-invoked')
  assert.ok(unused, 'a skill that never fired is pure always-on rent')
  assert.ok(unused.data.skill.some((s) => s.name === 'ghost'))
  assert.ok(!unused.data.skill.some((s) => s.name === 'used'))
  assert.ok(
    !unused.data.skill.some((s) => s.name === 'slashed'),
    'a skill only ever invoked as a slash command has still fired',
  )

  const collision = report.finding.find((x) => x.id === 'skill-collision')
  assert.ok(collision, 'twin-a and twin-b share a trigger vocabulary')
  assert.deepEqual(collision.data.pair.sort(), ['twin-a', 'twin-b'])

  assert.ok(report.finding.some((x) => x.id === 'skill-untracked'))
})

test('skill: says nothing about firing when there are no transcripts to read', async () => {
  const { auditSkill } = await import('../lib/skill.mjs')
  const { skillRoot } = await import('./fixture.mjs')
  const f = skillRoot()

  const report = auditSkill({ root: f.root, pool: f.pool, transcript: join(f.root, 'nope') })
  assert.equal(report.invocation.scanned, 0)
  assert.ok(
    !report.finding.some((x) => x.id === 'skill-never-invoked'),
    'absence of transcripts is not evidence a skill is unused',
  )
})

test('mcp-cost: prices what it can separate and refuses what it cannot', async () => {
  const { auditMcpCost } = await import('../lib/mcpcost.mjs')
  const { mcpMachine } = await import('./fixture.mjs')
  const m = mcpMachine()

  const report = auditMcpCost(m)
  const id = (x) => report.finding.filter((f) => f.id === x)

  // The prefix is the SMALLEST billed turn, never a later inflated one.
  assert.equal(report.baseline.median, 40_000)
  assert.equal(report.baseline.sample, 4)

  // One server differs from baseline -> that server can be priced.
  const single = id('mcp-server-cost')
  assert.equal(single.length, 1)
  assert.equal(single[0].data.server, 'heavy')
  assert.equal(single[0].data.token, 50_000)
  assert.equal(single[0].data.with, 3)

  // Two servers always co-occur -> price the set, name no individual server.
  const set = id('mcp-set-cost')
  assert.equal(set.length, 1)
  assert.deepEqual(set[0].data.server.sort(), ['alpha', 'beta'])
  assert.equal(set[0].data.token, 100_000)
  assert.ok(/cannot be separated/.test(set[0].why))

  // One repo is an anecdote, not a measurement.
  assert.deepEqual(id('mcp-cost-undersampled')[0].data.server, ['solo'])

  // A contrast inside the noise floor is not a cost.
  assert.ok(id('mcp-cost-negligible')[0].data.server.includes('tiny'))
  assert.equal(id('mcp-server-cost').some((f) => f.data.server === 'tiny'), false)

  // Deferral must NOT be reported as confirmed here. These repos leave the
  // setting unset, so it defaults ON -- but their servers demonstrably move the
  // prefix by 50k and 100k, so the schemas plainly ARE being loaded. Claiming
  // confirmation from a default would be asserting the thing measurement refutes.
  assert.equal(id('mcp-defer-confirmed').length, 0, 'measured cost refutes deferral, so do not confirm it')

  // A server in every repo has no comparison group.
  assert.deepEqual(id('mcp-cost-global')[0].data.server, ['everywhere'])
  assert.ok(
    report.group.every((g) => !g.server.includes('everywhere')),
    'a global server must not appear in any contrast group',
  )
})

test('mcp: deferred tool loading changes what the server count means', async () => {
  const { collect } = await import('../lib/collector/mcp.mjs')
  const { resolveHarness } = await import('../lib/adapter.mjs')

  const ctx = (env) => ({
    root: fixture('bloated'),
    harness: resolveHarness(fixture('bloated'), { user: false }),
    user: false,
    home: fixture('root'),
    env,
    window: 200_000,
  })

  // UNSET IS ON. Claude Code's mode resolver defaults to `tst` when the variable
  // is absent, so treating absence as "off" produced a HIGH finding telling the
  // user to enable something already running. That was a real false positive on a
  // real machine, and it is the case this test exists for.
  const unset = collect(ctx({}))
  const unsetId = unset.finding.map((f) => f.id)
  assert.equal(unset.meta.toolSearch.state, 'default')
  assert.equal(unset.meta.toolSearch.deferring, true)
  assert.ok(unsetId.includes('mcp-deferred'), 'unset must not be reported as off')
  assert.ok(!unsetId.includes('mcp-defer-disabled'))
  assert.equal(unset.finding.find((f) => f.id === 'mcp-deferred').severity, 'info')
  assert.match(unset.finding.find((f) => f.id === 'mcp-deferred').why, /unset is the ON default/)

  // Explicitly switched off: now the original premise holds and it is worth a
  // real severity, because the schemas really are in the prefix.
  const off = collect(ctx({ ENABLE_TOOL_SEARCH: 'false' }))
  const disabled = off.finding.find((f) => f.id === 'mcp-defer-disabled')
  assert.ok(disabled, 'an explicit off is the one case that deserves a finding')
  assert.equal(disabled.severity, 'high', '9 servers with schemas loaded up front')
  assert.equal(off.meta.toolSearch.state, 'off')
  assert.equal(off.meta.toolSearch.mode, 'standard')

  // The harness's own mode table, mirrored. auto:0 defers everything; auto:100 is
  // off; a bare `auto` defers past a threshold.
  const mode = (v) => collect(ctx({ ENABLE_TOOL_SEARCH: v })).meta.toolSearch
  assert.equal(mode('auto:0').mode, 'tst')
  assert.equal(mode('auto:0').deferring, true)
  assert.equal(mode('auto:100').mode, 'standard')
  assert.equal(mode('auto:100').deferring, false)
  assert.equal(mode('auto').mode, 'tst-auto')
  assert.equal(mode('auto:20').mode, 'tst-auto')
  assert.equal(mode('true').deferring, true)
  assert.equal(mode('0').deferring, false)

  // Scope is graded either way -- a model still chooses among these.
  assert.ok(unsetId.includes('mcp-server-count'))
})

test('skill: descriptions are graded against the harness character budget', async () => {
  const { auditSkill } = await import('../lib/skill.mjs')
  const { skillRoot } = await import('./fixture.mjs')
  const f = skillRoot()

  // The budget is 2% of the window, so the window decides whether the same
  // machine is over it. At 1M these four skills are comfortable...
  const roomy = auditSkill({ root: f.root, transcript: f.transcript, window: 1_000_000 })
  assert.equal(roomy.budget.budget, 20_000)
  assert.equal(roomy.finding.some((x) => x.id === 'skill-budget-fill'), false)

  // ...and against a tiny window the identical set is over the ceiling, which is
  // a routing failure rather than a cost one.
  const tight = auditSkill({ root: f.root, transcript: f.transcript, window: 10_000 })
  assert.equal(tight.budget.budget, 200)
  const over = tight.finding.find((x) => x.id === 'skill-budget-fill')
  assert.ok(over, 'over the budget must be reported')
  assert.equal(over.severity, 'high')
  assert.ok(over.data.char > over.data.budget)
  assert.match(over.title, /over the 200-char budget/)
  assert.equal(tight.budget.source, 'flag')
})

test('mcp-cost: refuses to contrast across the deferred-loading line', async () => {
  const { auditMcpCost } = await import('../lib/mcpcost.mjs')
  const { mcpDeferMachine } = await import('./fixture.mjs')

  const report = auditMcpCost(mcpDeferMachine())
  const id = (x) => report.finding.filter((f) => f.id === x)

  // Deferred-loading repos are set aside, so the contrast stays comparable.
  assert.equal(report.cohort.pricing, 6)
  assert.equal(report.cohort.setAside, 3)
  assert.equal(report.cohort.deferred, false)
  assert.deepEqual(id('mcp-cost-defer-confound')[0].data.setAside.sort(), ['on1', 'on2', 'on3'])

  // No group used for pricing may mix the two states.
  for (const g of report.group)
    for (const name of g.repo) assert.ok(!name.startsWith('on'), `${name} must not be priced here`)

  // Inside one cohort the server prices cleanly: 120k with, 40k without.
  const heavy = id('mcp-server-cost')
  assert.equal(heavy.length, 1)
  assert.equal(heavy[0].data.server, 'heavy')
  assert.equal(heavy[0].data.token, 80_000)

  // The setting itself is priced by the cross-cohort contrast, and says it is coarse.
  const defer = id('mcp-defer-measured')
  assert.equal(defer.length, 1)
  assert.equal(defer[0].data.token, 82_000)
  assert.match(defer[0].why, /also declare different servers/)
})

test('mcp-cost: refuses to contrast too few repos', async () => {
  const { auditMcpCost } = await import('../lib/mcpcost.mjs')
  const report = auditMcpCost({ transcript: join(tmpdir(), 'pileup-does-not-exist') })
  assert.deepEqual(report.finding, [])
  assert.match(report.note, /at least 4/)
})

test('fleet: ranks documents by measured turns, and counts one copy per document', async () => {
  const { auditFleet, discoverRepo } = await import('../lib/fleet.mjs')
  const { fleetMachine } = await import('./fixture.mjs')
  const f = fleetMachine()

  // Repo discovery stops at a `.git` rather than descending into it.
  assert.equal(discoverRepo(f.work).length, 3)

  const report = auditFleet({
    dir: [f.work],
    home: f.home,
    transcript: f.transcript,
    env: {},
    window: 200_000,
  })

  assert.equal(report.repo.length, 3)
  assert.equal(report.turn, 102, 'turns are measured from transcripts, not assumed')

  const wide = report.item.filter((x) => x.name === 'wide')
  assert.equal(wide.length, 1, 'three discovery-root copies are one document, not three')
  assert.deepEqual(wide[0].harness.sort(), ['claude', 'codex'])
  assert.equal(wide[0].scope, 'user')

  // Turns accrue once per repo, never once per installed copy -- otherwise the
  // frequency half of the ranking is multiplied by an installer's choices.
  assert.equal(wide[0].turn, 102)
  assert.equal(wide[0].repoCount, 3)
  assert.equal(wide[0].paid, wide[0].perTurn * 102)

  // A repo-local CLAUDE.md of the same name in three repos is three documents.
  const memory = report.item.filter((x) => x.kind === 'memory' && x.scope === 'repo' && x.name === 'CLAUDE.md')
  assert.equal(memory.length, 3)
  // And each is weighted by ITS repo, so the busy one outranks the idle one.
  const paid = Object.fromEntries(memory.map((m) => [m.repo[0], m.paid]))
  assert.ok(paid.busy > paid.quiet, 'busy repo outranks quiet at equal size')
  assert.equal(paid.idle, 0, 'a repo with no measured turns has paid nothing yet')

  // Firing is measured where observable and null where it is not. Both the busy
  // and quiet repos invoked `wide` once, so the fleet total is two.
  assert.equal(wide[0].fired, 2)
  assert.equal(report.item.find((x) => x.name === 'ghost').fired, 0)
  assert.equal(memory[0].fired, null, 'a memory file is never invoked, so this is unobservable')
})

test('fleet: never sums two harnesses, and names commands the way transcripts do', async () => {
  const { auditFleet } = await import('../lib/fleet.mjs')
  const { fleetMachine } = await import('./fixture.mjs')
  const f = fleetMachine()

  const report = auditFleet({
    dir: [f.work],
    home: f.home,
    transcript: f.transcript,
    env: {},
    window: 1_000_000,
  })

  // A command with no `name:` frontmatter must lose its extension. With it, the
  // name can never match what a transcript records -- a real machine reported an
  // actively-used command as never fired for exactly this reason.
  const runme = report.item.find((x) => x.kind === 'command')
  assert.equal(runme.name, 'runme', 'a command name must not carry .md')
  assert.equal(runme.fired, 2, 'slash-command firing is counted from <command-name>')

  // One repo-local skill installed into two discovery roots collapses WITHIN a
  // repo, while staying one document per repo -- three repos, three rows, not six.
  const local = report.item.filter((x) => x.name === 'local')
  assert.equal(local.length, 3, 'one row per repo, not one per discovery root')
  assert.deepEqual(local.map((x) => x.repo[0]).sort(), ['busy', 'idle', 'quiet'])
  const localBusy = local.find((x) => x.repo[0] === 'busy')
  assert.equal(localBusy.turn, 100, 'turns are not doubled by the second copy')
  assert.deepEqual(localBusy.harness.sort(), ['claude', 'codex'])

  // Parallel memory files for two harnesses are two documents...
  const busy = report.item.filter((x) => x.kind === 'memory' && x.scope === 'repo' && x.repo[0] === 'busy')
  assert.deepEqual(busy.map((x) => x.name).sort(), ['AGENTS.md', 'CLAUDE.md'])

  // ...but the fleet total pays the larger harness, never both. Summing them
  // describes a session nobody has.
  const top = report.finding.find((x) => x.id === 'fleet-top-cost')
  const summed = report.item.reduce((s, x) => s + x.paid, 0)
  assert.ok(
    top.data.fleetTotal < summed,
    `fleet total ${top.data.fleetTotal} must be per-harness, under the naive sum ${summed}`,
  )
  assert.equal(top.data.fleetTotal, Math.max(...top.data.fleetTotalByHarness.map((h) => h.token)))
  assert.match(top.why, /per harness, not summed/)

  // And the pair is reported, because a reader seeing two big rows for one repo
  // would otherwise assume it is double cost.
  const twin = report.finding.filter((x) => x.id === 'fleet-twin-memory')
  assert.ok(twin.length, 'parallel harness memory files must be explained')
  assert.match(twin[0].why, /pay the larger, never both/)
})

test('fleet: says nothing about frequency when there are no transcripts', async () => {
  const { auditFleet } = await import('../lib/fleet.mjs')
  const { fleetMachine } = await import('./fixture.mjs')
  const f = fleetMachine()

  const report = auditFleet({
    dir: [f.work],
    home: f.home,
    transcript: join(f.home, 'nope'),
    claudeDir: join(f.home, 'nope'),
    codexDir: join(f.home, 'nope'),
    env: {},
  })

  const id = report.finding.map((x) => x.id)
  assert.ok(!id.includes('fleet-top-cost'), 'no frequency means no ranking claim')
  assert.ok(!id.includes('fleet-unfired-rent'), 'absence of transcripts is not absence of use')
  // It says so rather than silently falling back to ranking by size.
  assert.deepEqual(id, ['fleet-no-frequency'])
})

test('codex: normalises subset-cached tokens instead of double-counting them', async () => {
  const { discoverTranscript, readTranscript } = await import('../lib/transcript.mjs')
  const { codexMachine } = await import('./fixture.mjs')
  const m = codexMachine()

  const found = discoverTranscript(m.cwd, { home: m.home, codexDir: m.codexDir, claudeDir: join(m.home, 'none') })
  assert.equal(found.length, 1, 'discovered by the cwd in session_meta, not by path layout')
  assert.equal(found[0].harness, 'codex')

  const s = readTranscript(found[0])
  assert.equal(s.turn, 2)
  assert.equal(s.id, '019f9e60', 'the uuid, not the rollout- timestamp prefix')

  // Codex: input_tokens is the whole prompt, cached_input_tokens a subset.
  // Normalised, the parts must sum back to the prompts: 20k + 60k.
  assert.equal(s.cacheRead, 12_000 + 55_000)
  assert.equal(s.input, 8_000 + 5_000)
  assert.equal(s.cacheRead + s.input + s.cacheCreate, 80_000)

  const hit = s.cacheRead / (s.cacheRead + s.input + s.cacheCreate)
  assert.ok(hit > 0 && hit <= 1, `hit rate must stay a proportion, got ${hit}`)

  // The prefix is the smaller turn, and reasoning tokens are already inside output.
  assert.equal(s.prefixToken, 20_000)
  assert.equal(s.output, 1_000)

  // Logged twice by Codex, counted once by pileup.
  assert.equal(s.compaction, 1)

  assert.equal(s.window, 258_400)
  assert.equal(s.quota.usedPercent, 94)
  assert.equal(s.quota.plan, 'pro')
})

test('codex: surfaces the real window and the measured subscription quota', async () => {
  const { collect } = await import('../lib/collector/session.mjs')
  const { codexMachine } = await import('./fixture.mjs')
  const m = codexMachine()

  const { finding } = collect({
    root: m.cwd,
    home: m.home,
    codexDir: m.codexDir,
    claudeDir: join(m.home, 'none'),
    window: 200_000,
  })
  const id = (x) => finding.find((f) => f.id === x)

  assert.match(id('session-window-mismatch').title, /258k/)
  assert.match(id('session-quota').title, /94%.*1-week.*pro/)
  assert.equal(id('session-quota').severity, 'high')
})

test('audit: always-on is reported per harness, never summed across them', () => {
  const report = auditFixture('bloated')
  assert.ok(Array.isArray(report.alwaysOn.byHarness))
  for (const h of report.alwaysOn.byHarness)
    assert.equal(h.token, h.memory + h.description, `${h.harness} total should be its own parts`)
})

test('doc: a doc you have not committed yet is still a doc an agent can open', async () => {
  const { gitRepo } = await import('./fixture.mjs')
  const { collect } = await import('../lib/collector/doc.mjs')
  const { resolveHarness } = await import('../lib/adapter.mjs')
  const { statSync } = await import('node:fs')
  const g = gitRepo()

  const out = collect({
    root: g.root,
    harness: resolveHarness(g.root, { user: false }),
    user: false,
    window: 200_000,
    sizeOf: (p) => {
      try { return statSync(p).size } catch { return null }
    },
  })
  const seen = out.surface.map((d) => d.rel).sort()

  // Committed: obviously in scope.
  assert.ok(seen.includes('docs/committed.md'))
  // Untracked but not ignored: pileup's own prescription creates these, and it
  // could not see them. A 300 KB file an agent can open is a read trap whether or
  // not it has been committed.
  assert.ok(seen.includes('docs/untracked.md'), 'an uncommitted doc is still readable')
  // Ignored: out, which is the whole reason the git index was trusted.
  assert.ok(!seen.some((r) => r.startsWith('ignored/')), 'gitignored output must stay out')
})

test('session: the always-on prefix is the floor across sessions, not their median', async () => {
  const { collect } = await import('../lib/collector/session.mjs')
  const { bimodalSession } = await import('./fixture.mjs')
  const b = bimodalSession()

  const out = collect({
    root: b.cwd,
    home: b.home,
    claudeDir: b.claudeDir,
    codexDir: join(b.home, 'none'),
    window: 1_000_000,
  })
  const prefix = out.finding.find((f) => f.id === 'session-measured-prefix')

  // An opening turn carries whatever the first message brought with it. Only the
  // lowest opening ever seen is free of that, so it is the always-on floor.
  assert.equal(prefix.data.floor, 12_000)
  assert.equal(prefix.data.worst, 500_000)
  assert.match(prefix.title, /floor: 12k/)

  // The median would have been 256k -- reported, but never used as the headline.
  assert.ok(prefix.data.median > prefix.data.floor)

  // And the range is explained rather than attributed to always-on cost.
  assert.match(prefix.why, /what individual first messages carried/)
  // 12k against a 1M window is not critical; the median would have graded it so.
  assert.ok(['info', 'medium'].includes(prefix.severity), `graded ${prefix.severity}`)
})
