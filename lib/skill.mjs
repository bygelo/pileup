// Skill-surface audit -- machine-scoped, not repo-scoped.
//
// A skill costs nothing where it is stored and everything where it is
// DISCOVERABLE. Tools like piper make that split explicit: a pool outside the
// harness's discovery root costs zero, and a curated subset is promoted into
// the discovery root where its description bills on every turn of every session
// in every repo on the machine.
//
// Promotion is therefore the single decision that spends always-on context, and
// it is usually made on judgement. piper's own ledger says so outright:
// "Promotion is judgment-driven for now (no automated gate)."
//
// This module is the evidence that gate needs. It answers three questions a
// static scan cannot: what does each promoted skill cost per turn, which ones
// have never actually fired, and which ones collide with each other.

import { readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { SKILL_BUDGET_FILL, SKILL_BUDGET_SHARE } from './budget.mjs'
import { gradeBy, mkFinding } from './finding.mjs'
import { resolveWindowMachine } from './model.mjs'
import { splitFrontmatter } from './frontmatter.mjs'
import { readText, safeStat } from './fs.mjs'
import { countInvocation } from './invocation.mjs'
import { estimateToken, formatToken } from './token.mjs'

// Where each harness looks for skills. Anything here bills on every turn.
const DISCOVERY_ROOT = ['.claude/skills', '.codex/skills', '.agents/skills']

const DEFAULT_POOL = '.piper/skills-pool'

// Two descriptions this similar are competing for the same prompts. The model
// picks one by fuzzy match, so the loser is rent with no upside.
const COLLISION_FLOOR = 0.2

const STOPWORD = new Set(
  ('when with that this from into only than then skip uses used your have been also they them what ' +
    'each over more most make just like both same does will very much such using every other about')
    .split(' '),
)

export function auditSkill(opt = {}) {
  const home = homedir()
  const root = (opt.root ? [opt.root] : DISCOVERY_ROOT.map((d) => join(home, d))).filter((d) =>
    safeStat(d)?.isDirectory(),
  )
  const poolDir = opt.pool ?? join(home, DEFAULT_POOL)
  const pool = safeStat(poolDir)?.isDirectory() ? readSkill(poolDir) : []
  const ledger = readLedger(opt.ledger)
  const invocation = countInvocation(opt.transcript ?? join(home, '.claude', 'projects'))

  // Installers copy the same skill into every discovery root they support, so a
  // flat list triple-counts. Only one harness runs at a time -- dedupe by name
  // and record which roots hold it, exactly as the repo audit does per harness.
  const seen = new Map()
  const byRoot = new Map()
  for (const dir of root) {
    let rootToken = 0
    for (const s of readSkill(dir)) {
      rootToken += s.descToken
      const existing = seen.get(s.name)
      if (existing) {
        existing.root.push(dir)
        continue
      }
      seen.set(s.name, {
        ...s,
        root: [dir],
        invoked: invocation.count.get(s.name) ?? 0,
        tracked: ledger
          ? ledger.has(s.name)
          : pool.some((p) => normalize(p.name) === normalize(s.name)),
      })
    }
    byRoot.set(dir, rootToken)
  }

  const skill = [...seen.values()].sort((a, b) => b.descToken - a.descToken)
  const finding = []
  // The bill is whichever single root is largest, not the sum of all of them.
  const perTurn = Math.max(0, ...byRoot.values())

  // Skill descriptions do not just cost tokens -- they compete for a bounded
  // character budget the harness sizes at 2% of the context window. Past it,
  // descriptions stop being a cost question and start being a routing one:
  // something has to give, and which skill loses is not the user's choice.
  //
  // The window matters here in a way it did not before. At 200k the budget is
  // 4,000 characters; on Opus 5's 1M window it is 20,000. A machine that was
  // over budget last year may be comfortably inside it now, purely because the
  // default model changed -- so pileup resolves the window rather than assuming.
  const window = resolveWindowMachine({
    window: opt.window,
    transcript: opt.transcript,
    home,
  })
  const budget = Math.round(window.window * SKILL_BUDGET_SHARE)
  const totalChar = skill.reduce((s, x) => s + x.char, 0)
  const fill = budget ? totalChar / budget : 0
  const budgetSeverity = gradeBy(fill, SKILL_BUDGET_FILL)

  if (budgetSeverity) {
    const over = totalChar - budget
    finding.push(
      mkFinding({
        id: 'skill-budget-fill',
        severity: budgetSeverity,
        surface: 'always-on',
        title:
          over > 0
            ? `skill descriptions total ${comma(totalChar)} chars, over the ${comma(budget)}-char budget by ${comma(over)}`
            : `skill descriptions fill ${Math.round(fill * 100)}% of the ${comma(budget)}-char budget`,
        why:
          `Claude Code sizes the skill description budget at ${Math.round(SKILL_BUDGET_SHARE * 100)}% of the context ` +
          `window, which is ${comma(budget)} characters against the ${formatToken(window.window)} window ` +
          `${
            window.source === 'flag'
              ? 'you specified'
              : window.source === 'default'
                ? 'pileup assumed, since nothing on this machine said otherwise'
                : `your transcripts report${window.model ? ` (${window.model})` : ''}`
          }. ` +
          `${skill.length} discoverable skills are competing for it` +
          (over > 0
            ? '. Over the ceiling this stops being a cost question: descriptions have to be dropped or truncated, and ' +
              'which skill loses is decided for you.'
            : '. There is headroom, but every promotion spends it and it is not recoverable by trimming bodies.'),
        fix:
          over > 0
            ? `Cut ${comma(over)} characters. Demoting the skills that have never fired is the cheapest way there, because it ` +
              'costs nothing in capability -- the numbers in this table say which those are.'
            : 'Nothing urgent. Worth knowing before the next promotion, since this budget is what promotions spend.',
        data: {
          token: perTurn,
          char: totalChar,
          budget,
          fill,
          window: window.window,
          windowSource: window.source,
          count: skill.length,
        },
      }),
    )
  }

  // Never fired. Only claimable when transcripts were actually scanned --
  // otherwise the absence of evidence is just an absence of transcripts.
  const unused = skill.filter((s) => s.invoked === 0)
  if (invocation.scanned > 0 && unused.length) {
    const wasted = unused.reduce((s, x) => s + x.descToken, 0)
    finding.push(
      mkFinding({
        id: 'skill-never-invoked',
        severity: wasted >= 1_500 ? 'high' : wasted >= 600 ? 'medium' : 'low',
        surface: 'always-on',
        title: `${unused.length} of ${skill.length} discoverable skills have never fired, costing ${formatToken(wasted)} tokens every turn`,
        why:
          `Across ${invocation.scanned} local transcripts holding ${invocation.total} skill invocations, these were ` +
          'never chosen. Their descriptions are still sent on every turn of every session in every repo on this machine.',
        fix:
          'Move them out of the discovery root into a pool. A pooled skill costs nothing until you promote it back, ' +
          'and you can still invoke it explicitly by path. Promote on evidence, not on intent.',
        data: {
          token: wasted,
          count: unused.length,
          scanned: invocation.scanned,
          skill: unused.map((s) => ({ name: s.name, token: s.descToken, root: s.root })),
        },
      }),
    )
  }

  // In the discovery root but absent from the ledger that is supposed to govern it.
  const untracked = skill.filter((s) => !s.tracked)
  if ((ledger || pool.length) && untracked.length) {
    finding.push(
      mkFinding({
        id: 'skill-untracked',
        severity: untracked.length > skill.length / 2 ? 'medium' : 'low',
        surface: 'always-on',
        title: `${untracked.length} of ${skill.length} discoverable skills are not in the ${ledger ? 'promotion ledger' : 'pool'}`,
        why:
          'The ledger is the record of what was deliberately promoted into the always-on surface. Entries missing ' +
          'from it were placed by hand, which means nothing is tracking what they cost or why they are there.',
        fix: ledger
          ? 'Either add each one to the ledger with a rationale, or move it back to the pool. An untracked entry in ' +
            'the discovery root is a cost nobody signed off on.'
          : 'Point pileup at the promotion ledger with --ledger so tracked and hand-placed entries can be told apart.',
        data: {
          token: untracked.reduce((s, x) => s + x.descToken, 0),
          count: untracked.length,
          skill: untracked.map((s) => s.name),
        },
      }),
    )
  }

  const collision = findCollision(skill)
  for (const c of collision) {
    finding.push(
      mkFinding({
        id: 'skill-collision',
        severity: c.score >= 0.35 ? 'medium' : 'low',
        surface: 'always-on',
        title: `${c.a} and ${c.b} describe overlapping triggers (${Math.round(c.score * 100)}% shared vocabulary)`,
        why:
          'The model routes by fuzzy match against descriptions. Two this similar compete for the same prompts, so ' +
          'one of them tends to lose consistently while both keep billing every turn.' +
          (c.invokedA + c.invokedB > 0
            ? ` Measured here: ${c.a} fired ${plural(c.invokedA)}, ${c.b} fired ${plural(c.invokedB)}.`
            : ' Neither has fired in the scanned transcripts.'),
        fix:
          'Give each a disjoint boundary line -- "use for X, not Y" -- or merge them. Two skills that cannot be told ' +
          'apart from their descriptions are one skill with a routing problem.',
        data: { token: c.token, pair: [c.a, c.b], score: c.score, shared: c.shared },
      }),
    )
  }

  if (pool.length) {
    finding.push(
      mkFinding({
        id: 'skill-pool-ratio',
        severity: 'info',
        surface: 'always-on',
        title: `${skill.length} skills discoverable (${formatToken(perTurn)} tokens/turn), ${pool.length} pooled (free)`,
        why:
          'Pooled skills sit outside the discovery root, so they cost nothing until promoted. This ratio is the ' +
          'shape of the promotion decision.',
        fix: 'Promote on measured invocation, demote on measured silence. This report gives you both numbers.',
        data: { token: perTurn, discoverable: skill.length, pooled: pool.length },
      }),
    )
  }

  return {
    skill,
    pool,
    collision,
    finding,
    invocation,
    perTurn,
    budget: { char: totalChar, budget, fill, window: window.window, source: window.source },
    byRoot: [...byRoot].map(([dir, token]) => ({ root: dir, token })).sort((a, b) => b.token - a.token),
    ledger: ledger ? [...ledger] : null,
  }
}

/** Thousands separators. A hard character limit deserves its exact digits. */
function comma(n) {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

/**
 * Direct children only: `<root>/<name>/SKILL.md`.
 *
 * Not a recursive walk. A harness discovers exactly one level, and dot-prefixed
 * directories -- `.disabled/`, `.system/` -- are how tools park skills OUT of
 * discovery. Descending into them reports skills that cost nothing as if they
 * were billing every turn, which is the precise error this tool exists to catch.
 */
function readSkill(dir) {
  const hit = []
  for (const name of entryOf(dir)) {
    if (name.startsWith('.')) continue
    const path = join(dir, name, 'SKILL.md')
    const text = readText(path)
    if (text == null) continue
    const { meta, body } = splitFrontmatter(text)
    const description = meta.description ?? ''
    hit.push({
      name: meta.name ?? name,
      path,
      root: dir,
      description,
      char: description.length,
      descToken: estimateToken(description),
      bodyToken: estimateToken(body),
    })
  }
  return hit
}

function entryOf(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() || e.isSymbolicLink())
      .map((e) => e.name)
  } catch {
    return []
  }
}

/** piper-shaped ledger: { promotions: [{ from, to }] }. `to` is the promoted name. */
function readLedger(path) {
  if (!path) return null
  const text = readText(path)
  if (text == null) return null
  try {
    const json = JSON.parse(text)
    const row = json.promotions ?? json.promotion ?? []
    return new Set(row.map((p) => p.to ?? p.name ?? p.from).filter(Boolean))
  } catch {
    return null
  }
}

function findCollision(skill) {
  const term = skill.map((s) => ({ s, t: termOf(s.description) })).filter((x) => x.t.size >= 4)
  const hit = []
  for (let i = 0; i < term.length; i++)
    for (let j = i + 1; j < term.length; j++) {
      const a = term[i].t
      const b = term[j].t
      let inter = 0
      for (const w of a) if (b.has(w)) inter++
      const score = inter / (a.size + b.size - inter)
      if (score < COLLISION_FLOOR) continue
      hit.push({
        a: term[i].s.name,
        b: term[j].s.name,
        score,
        shared: inter,
        token: term[i].s.descToken + term[j].s.descToken,
        invokedA: term[i].s.invoked ?? 0,
        invokedB: term[j].s.invoked ?? 0,
      })
    }
  return hit.sort((x, y) => y.score - x.score)
}

function termOf(description) {
  return new Set((description.toLowerCase().match(/[a-z]{4,}/g) ?? []).filter((w) => !STOPWORD.has(w)))
}

function plural(n) {
  return `${n} time${n === 1 ? '' : 's'}`
}

/** piper renames on promotion, so compare loosely when there is no ledger. */
function normalize(name) {
  return name.replace(/^piper-/, '').replace(/^(other|audit|build|review|fix|research)-/, '')
}
