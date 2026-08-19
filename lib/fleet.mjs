// Every repo at once, ranked by what each document actually cost.
//
// A single-repo audit answers "what does this repo inject". It cannot answer the
// question people actually have, which is "of everything I have accumulated,
// what is worth deleting first". That needs two things one repo cannot give:
//
//   1. BREADTH. A skill promoted into ~/.claude/skills bills in every repo on
//      the machine. Audited one repo at a time it looks like a 200-token line
//      item forty separate times, and never once like the 8,000 tokens per turn
//      it is.
//   2. FREQUENCY. Cost is size times how often you pay it, and how often you
//      pay it is a property of how much you work in each repo -- which is
//      measured in transcripts, not inferable from disk.
//
// So the unit here is not the repo, it is the DOCUMENT, and the number it is
// ranked by is:
//
//      paid  =  tokens per turn  x  turns measured in the repos it is injected into
//
// That product is the ranking. A 90-token description in a repo with 12,000
// measured turns has cost more than a 6,000-token memory file in a repo touched
// twice. Sorting by size gets that backwards every time.
//
// Three things `paid` is not, all of which the report states rather than hides:
//
//   - It is not half measured and half not, blended. `turns` is measured;
//     `tokens per turn` is the same estimate as everywhere else in pileup.
//   - It is not history. It applies TODAY's size to every past turn, and a file
//     that grew to its current size cost less than this along the way. Read it
//     as "what this document is costing me now, weighted by how much I actually
//     work where it applies" -- which is the number a deletion decision needs.
//   - It is not a bill. Cached input bills at about a tenth of fresh input, so
//     the dollar figure is far below the token figure. The ranking is unaffected,
//     which is why pileup reports the ratio and not a price.

import { readdirSync } from 'node:fs'
import { basename, join } from 'node:path'
import { audit } from './audit.mjs'
import { mkFinding } from './finding.mjs'
import { safeStat } from './fs.mjs'
import { countInvocation } from './invocation.mjs'
import { formatToken } from './token.mjs'

// Directories that are never a project of yours, and are expensive to descend.
const SKIP = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', 'target', 'vendor', 'Library',
  '.next', '.nuxt', '.venv', 'venv', '__pycache__', '.cache', 'coverage', '.Trash',
  'go', '.rustup', '.cargo', '.npm', '.pnpm-store', 'Applications', 'Pictures', 'Music',
])

// How deep to look for a `.git`. Repos live two or three levels under a work
// directory; past this it is somebody's vendored dependency.
const DEPTH = 4

// A document has to have cost at least this much across the fleet before it is
// worth a line. Below it, the report is longer than the saving.
const WORTH_NAMING = 50_000

/** Every git repo under `dir`, not descending into one once found. */
export function discoverRepo(dir, depth = DEPTH) {
  const hit = []
  walk(dir, 0)
  return hit.sort()

  function walk(cur, d) {
    if (d > depth) return
    let entry
    try {
      entry = readdirSync(cur, { withFileTypes: true })
    } catch {
      return
    }
    // A repo is a leaf. Descending into it would report every submodule and
    // vendored checkout as a project the user chose to have.
    if (entry.some((e) => e.isDirectory() && e.name === '.git')) {
      hit.push(cur)
      return
    }
    for (const e of entry) {
      if (!e.isDirectory() || e.name.startsWith('.') || SKIP.has(e.name)) continue
      walk(join(cur, e.name), d + 1)
    }
  }
}

/**
 * @param {object} opt
 * @param {string[]} [opt.dir]   directories to scan for repos
 * @param {string[]} [opt.repo]  explicit repo paths, scanned as given
 * @param {number} [opt.limit]   stop after this many repos (default 60)
 */
export function auditFleet(opt = {}) {
  const root = opt.repo?.length
    ? opt.repo.filter((r) => safeStat(r)?.isDirectory())
    : (opt.dir ?? [process.cwd()]).flatMap((d) => discoverRepo(d, opt.depth))

  const limit = opt.limit ?? 60
  const scanned = root.slice(0, limit)

  if (!scanned.length)
    return { repo: [], item: [], finding: [], note: 'no git repos found to audit' }

  const repo = []
  for (const path of scanned) {
    let report
    try {
      report = audit(path, {
        user: opt.user,
        window: opt.window,
        // `doc` and `output` answer a different question and are the two slowest
        // collectors. A fleet run is about always-on rent across repos.
        only: ['memory', 'definition', 'mcp', 'session'],
        // A fleet run is a frequency survey, so the single-repo default of 20
        // sessions is wrong here: on a real machine it undercounted one repo's
        // turns by about half (6,938 against 14,354) and every `paid` weighted by
        // it with them. Read far more by default, and disclose any repo still
        // capped rather than presenting a floor as a total.
        sessionLimit: opt.sessionLimit ?? 200,
        home: opt.home,
        env: opt.env,
        claudeDir: opt.claudeDir,
        codexDir: opt.codexDir,
      })
    } catch (e) {
      repo.push({ path, name: basename(path), error: e.message, turn: 0 })
      continue
    }

    const session = report.surface.session ?? []
    const coverage = report.meta.session
    repo.push({
      path,
      name: basename(path),
      turn: session.reduce((s, x) => s + x.turn, 0),
      session: session.length,
      // True when this repo had more history than was read, which makes its turn
      // count -- and every `paid` figure weighted by it -- a floor.
      capped: coverage ? coverage.discovered > coverage.read : false,
      discovered: coverage?.discovered ?? session.length,
      alwaysOn: report.alwaysOn.byHarness[0]?.token ?? 0,
      prefix: median(session.map((s) => s.prefixToken).filter(Boolean)),
      window: report.window,
      report,
    })
  }

  const invocation = countInvocation(opt.transcript ?? claudeProject(opt))
  const item = rankItem(repo, invocation)
  const finding = judge(item, repo, invocation, root.length > scanned.length ? root.length : 0)

  return {
    repo: repo.map(({ report, ...r }) => r),
    // `importRel` is internal to twinMemory. Stripped here rather than in
    // rankItem so judge can still see it, and never reaches the JSON contract
    // that booted's catalog reads.
    item: item.map(({ importRel, ...row }) => row),
    finding,
    invocation,
    turn: repo.reduce((s, r) => s + r.turn, 0),
    note:
      root.length > scanned.length
        ? `${root.length} repos found, ${scanned.length} audited (--limit ${limit})`
        : null,
  }
}

/**
 * Collapse per-repo surfaces into one row per document.
 *
 * Identity is the crux. A user-global skill is ONE document billing in forty
 * repos, so it must collapse to one row whose turn count is the sum. A
 * repo-local `CLAUDE.md` of the same name in forty repos is forty different
 * documents and must not collapse at all. Scope decides which.
 */
function rankItem(repo, invocation) {
  const byKey = new Map()

  for (const r of repo) {
    if (!r.report) continue

    const add = (kind, name, rel, scope, harness, perTurn, importRel = []) => {
      if (!perTurn) return

      // Identity, and the two traps in it.
      //
      // A user-global skill is ONE document even when an installer has copied
      // it into .claude/skills, .codex/skills and .agents/skills -- only one
      // harness runs at a time, so keying on the path would report three times
      // a cost nobody pays. Key on the name instead, exactly as `pileup skill`
      // does across discovery roots.
      //
      // A repo-local file of the same name in forty repos is forty documents
      // and must not collapse, so repo scope keys on the repo path -- but on the
      // NAME within it, not the path, because a repo can also hold the same
      // skill in `.claude/skills/` and `.agents/skills/` and that is still one
      // document. Memory files are unaffected: their name IS the filename, so
      // CLAUDE.md and AGENTS.md stay the two distinct documents they are.
      const key = scope === 'user' ? `${kind}:user:${name}` : `${kind}:${r.path}:${name}`
      const row = byKey.get(key) ?? {
        kind,
        name,
        rel,
        scope,
        harness: [],
        perTurn: 0,
        repo: new Set(),
        turn: 0,
        // Memory only, and internal: which files this one @imports. Stripped
        // before the item is returned -- twinMemory is the only consumer.
        importRel: [],
      }
      // Worst case across tokenizers: the same text is a different number of
      // tokens per harness, and only one of them is the session you are having.
      row.perTurn = Math.max(row.perTurn, perTurn)
      if (!row.harness.includes(harness)) row.harness.push(harness)
      for (const i of importRel) if (!row.importRel.includes(i)) row.importRel.push(i)

      // Turns are added once per REPO, never once per harness copy. Adding them
      // per copy would multiply the frequency half of the ranking by however
      // many discovery roots an installer happened to write to.
      if (!row.repo.has(r.name)) {
        row.repo.add(r.name)
        row.turn += r.turn
      }
      byKey.set(key, row)
    }

    for (const m of r.report.surface.memory ?? [])
      add('memory', m.rel.split('/').pop(), m.rel, m.scope, m.harness, m.token, (m.import ?? []).map((i) => i.rel))

    for (const d of r.report.surface.definition ?? [])
      add(d.kind, d.name, d.rel, d.scope, d.harness, d.descToken)
  }

  return [...byKey.values()]
    .map(({ repo, ...row }) => ({
      ...row,
      repo: [...repo],
      repoCount: repo.size,
      // Measured turns times estimated size. The only ranking that respects that
      // two documents of the same size are not the same cost.
      paid: row.perTurn * row.turn,
      // Firing is only observable for things the transcript names. A memory file
      // is never "invoked", so null means unobservable, not zero.
      fired: FIRED_KIND.has(row.kind) ? (invocation.count.get(row.name) ?? 0) : null,
    }))
    .sort((a, b) => b.paid - a.paid)
}

const FIRED_KIND = new Set(['skill', 'command'])

// Big enough that a reader would notice two rows for one repo and draw the wrong
// conclusion from them.
const TWIN_FLOOR = 4_000

/**
 * Repos carrying a memory file for more than one harness at once.
 *
 * Only the biggest pair per repo, and only when both are large enough to matter.
 * The point is to explain two adjacent rows, not to enumerate every repo that
 * happens to have both files.
 */
/**
 * True when one of the pair is a pointer to the other rather than a second copy.
 *
 * `CLAUDE.md` holding nothing but `@AGENTS.md` IS the fix this finding
 * prescribes, so reporting it as a twin tells someone to do what they already
 * did -- and pileup grading compliance as a problem is the same class of wrong
 * as the claims the July pass had to retract. An @import is resolved into the
 * prefix, which is why both rows still carry a large perTurn: the cost is real,
 * the drift is not.
 */
function isPointerPair(a, b) {
  return (a.importRel ?? []).includes(b.rel) || (b.importRel ?? []).includes(a.rel)
}

function twinMemory(item) {
  const byRepo = new Map()
  for (const x of item) {
    if (x.kind !== 'memory' || x.scope !== 'repo' || x.perTurn < TWIN_FLOOR) continue
    const repo = x.repo[0]
    if (!repo) continue
    if (!byRepo.has(repo)) byRepo.set(repo, [])
    byRepo.get(repo).push(x)
  }

  const hit = []
  for (const [repo, file] of byRepo) {
    if (file.length < 2) continue
    const sorted = file.sort((a, b) => b.perTurn - a.perTurn)
    if (isPointerPair(sorted[0], sorted[1])) continue
    hit.push({
      repo,
      name: [sorted[0].name, sorted[1].name],
      perTurn: sorted[0].perTurn,
      other: sorted[1].perTurn,
    })
  }
  return hit.sort((a, b) => b.perTurn - a.perTurn).slice(0, 5)
}

/**
 * Fleet cost per harness, reported as the worst one.
 *
 * Never the sum over documents. Only one harness runs at a time, so a machine
 * carrying parallel instruction files for two of them pays the larger surface,
 * not both. A document visible to several harnesses counts once in each of
 * their totals, which is correct -- it really is paid in whichever session you
 * are having.
 */
function fleetTotal(item) {
  const byHarness = new Map()
  for (const x of item)
    for (const h of x.harness) byHarness.set(h, (byHarness.get(h) ?? 0) + x.paid)

  const worst = [...byHarness].sort((a, b) => b[1] - a[1])[0]
  return {
    token: worst?.[1] ?? 0,
    harness: worst?.[0] ?? null,
    byHarness: [...byHarness].map(([harness, token]) => ({ harness, token })),
  }
}

function judge(item, repo, invocation, foundMore) {
  const finding = []
  const worked = repo.filter((r) => r.turn > 0)
  if (!worked.length)
    return [
      mkFinding({
        id: 'fleet-no-frequency',
        severity: 'info',
        surface: 'always-on',
        title: `${repo.length} repos audited, but no transcripts to weight them by`,
        why:
          'Without measured turns per repo there is no frequency half to the ranking, so this run can only report ' +
          'size -- which is the ordering pileup exists to argue against.',
        fix: 'Nothing to fix. The ranking becomes meaningful once these repos have session history to read.',
        data: { token: null, repo: repo.length },
      }),
    ]

  // The fleet total is PER HARNESS and reported as the largest, never the sum.
  //
  // This is the same rule the single-repo audit follows, and getting it wrong
  // here was subtle: a repo with both a CLAUDE.md and an AGENTS.md contributes
  // two documents to the table, correctly, because they are two files. Adding
  // their cost describes a session nobody has -- only one harness runs at a
  // time, so you pay the larger, not both. On a real machine those two files
  // were 97% identical and 115k/101k tokens, and summing them overstated one
  // repo by 100k tokens per turn.
  const total = fleetTotal(item)

  // The headline: the most expensive documents on the machine, measured.
  const top = item.filter((x) => x.paid >= WORTH_NAMING).slice(0, 10)
  if (top.length) {
    finding.push(
      mkFinding({
        id: 'fleet-top-cost',
        severity: top[0].paid >= 5_000_000 ? 'high' : top[0].paid >= 1_000_000 ? 'medium' : 'low',
        surface: 'always-on',
        title: `${top[0].name} in ${top[0].repo[0] ?? 'the fleet'} has cost about ${formatToken(top[0].paid)} tokens (${top[0].scope}-scoped ${top[0].kind})`,
        why:
          `${top[0].perTurn.toLocaleString('en-US')} tokens per turn times ${top[0].turn.toLocaleString('en-US')} turns ` +
          `measured in the ${top[0].repoCount} repo${top[0].repoCount === 1 ? '' : 's'} it is injected into. The turn ` +
          'count is measured; the per-turn size is estimated. Across the whole fleet, ' +
          `${item.length} always-on documents come to roughly ${formatToken(total.token)} tokens for the worst ` +
          `harness (${total.harness}) -- per harness, not summed, because only one runs at a time. ` +
          `${worked.length} of ${repo.length} repos had session history to weight by at all. This applies each ` +
          'document\'s CURRENT size to every measured turn, so a file that grew into its size cost less than this ' +
          'historically -- it ranks what each one is costing you now, not what it has billed.',
        fix:
          'Rank deletions by this column, not by file size. The cheapest large win is usually a user-global document ' +
          'that only a few repos need -- scope it down and every other repo stops paying for it.',
        data: {
          token: top[0].paid,
          fleetTotal: total.token,
          fleetTotalHarness: total.harness,
          fleetTotalByHarness: total.byHarness,
          item: top.map((x) => ({
            rel: x.rel,
            kind: x.kind,
            scope: x.scope,
            perTurn: x.perTurn,
            turn: x.turn,
            repo: x.repoCount,
            paid: x.paid,
            fired: x.fired,
          })),
        },
      }),
    )
  }

  // Rent with nothing to show for it. Only claimable where firing is observable
  // and transcripts were actually read.
  const dead = item.filter((x) => x.fired === 0 && x.paid >= WORTH_NAMING)
  if (invocation.scanned > 0 && dead.length) {
    const wasted = dead.reduce((s, x) => s + x.paid, 0)
    finding.push(
      mkFinding({
        id: 'fleet-unfired-rent',
        severity: wasted >= 2_000_000 ? 'high' : wasted >= 500_000 ? 'medium' : 'low',
        surface: 'always-on',
        title: `${dead.length} skills and commands have cost about ${formatToken(wasted)} tokens and never fired`,
        why:
          `Across ${invocation.scanned} transcripts holding ${invocation.total} invocations, none of these was ever ` +
          'chosen. Their descriptions were still re-sent on every turn of every session in every repo that could see ' +
          'them. This is the cleanest deletion list on the machine: measured cost, measured zero use.',
        fix:
          'Move them out of the discovery root. A pooled definition costs nothing until promoted, and can still be ' +
          'invoked explicitly by path when you want it.',
        data: {
          token: wasted,
          count: dead.length,
          item: dead.map((x) => ({ name: x.name, kind: x.kind, paid: x.paid, repo: x.repoCount })),
        },
      }),
    )
  }

  // Parallel instruction files for two harnesses in one repo. Worth naming for
  // the opposite of the obvious reason: it is NOT double cost, and a reader
  // looking at two big rows for one repo will assume it is. What it does cost is
  // drift -- edit one and the other harness is now working from stale rules.
  for (const twin of twinMemory(item)) {
    finding.push(
      mkFinding({
        id: 'fleet-twin-memory',
        severity: 'low',
        surface: 'always-on',
        title: `${twin.repo} carries ${twin.name.join(' and ')}, ${formatToken(twin.perTurn)} and ${formatToken(twin.other)} tokens per turn`,
        why:
          'Two memory files for two harnesses in one repo. You pay the larger, never both -- only one harness runs ' +
          'at a time, which is why the fleet total above is per harness rather than a sum. The cost of the pair is ' +
          'not tokens, it is drift: whichever one you edit, the other harness keeps running the old rules.',
        fix:
          'Keep one file and make the other a pointer to it, or generate one from the other in a commit hook. Two ' +
          'hand-maintained copies of the same instructions diverge, and the divergence is silent.',
        data: { token: twin.perTurn, repo: twin.repo, file: twin.name, perTurn: [twin.perTurn, twin.other] },
      }),
    )
  }

  // One repo far above the rest is where a fix pays back fastest.
  const heavy = [...worked].sort((a, b) => b.turn * b.alwaysOn - a.turn * a.alwaysOn)[0]
  const fleetMedian = median(worked.map((r) => r.alwaysOn))
  if (heavy && fleetMedian && heavy.alwaysOn > fleetMedian * 2) {
    finding.push(
      mkFinding({
        id: 'fleet-skewed-repo',
        severity: 'medium',
        surface: 'always-on',
        title: `${heavy.name} carries ${formatToken(heavy.alwaysOn)} tokens per turn against a fleet median of ${formatToken(fleetMedian)}`,
        why:
          `It also has ${heavy.turn.toLocaleString('en-US')} measured turns, so it is both the heaviest and among the ` +
          'most used. Work concentrated in one repo makes that repo the highest-leverage place to cut.',
        fix: `Run \`pileup ${heavy.path}\` for the itemised version, and fix that repo before the fleet.`,
        data: { token: heavy.alwaysOn, repo: heavy.name, turn: heavy.turn, median: fleetMedian },
      }),
    )
  }

  const capped = repo.filter((r) => r.capped)
  if (capped.length) {
    finding.push(
      mkFinding({
        id: 'fleet-turn-floor',
        severity: 'info',
        surface: 'always-on',
        title: `${capped.length} repos had more session history than was read, so their turn counts are floors`,
        why:
          `${capped.map((r) => r.name).slice(0, 4).join(', ')}${capped.length > 4 ? ` and ${capped.length - 4} more` : ''} ` +
          'hit the --sessions cap. Every `paid` figure weighted by those repos is therefore a lower bound, not a total. ' +
          'The ranking is unaffected as long as the cap applies evenly, which it does.',
        fix: 'Re-run with a higher --sessions if you want the totals rather than the ordering.',
        data: {
          token: null,
          repo: capped.map((r) => ({ name: r.name, read: r.session, discovered: r.discovered })),
        },
      }),
    )
  }

  if (foundMore) {
    finding.push(
      mkFinding({
        id: 'fleet-truncated',
        severity: 'info',
        surface: 'always-on',
        title: `${foundMore} repos found but only ${repo.length} audited`,
        why: 'The rest were not read, so nothing here accounts for what they inject or how often they are used.',
        fix: 'Re-run with a higher --limit for a complete picture.',
        data: { token: null, found: foundMore, audited: repo.length },
      }),
    )
  }

  return finding
}

function claudeProject(opt) {
  const home = opt.home
  return home ? join(home, '.claude', 'projects') : join(process.env.HOME ?? '', '.claude', 'projects')
}

function median(n) {
  if (!n.length) return 0
  const s = [...n].sort((a, b) => a - b)
  return s.length % 2 ? s[(s.length - 1) / 2] : Math.round((s[s.length / 2 - 1] + s[s.length / 2]) / 2)
}
