// What MCP servers actually cost, measured by contrast across your own repos.
//
// `pileup audit` can tell you the prefix is huge and that most of it is not on
// disk. It cannot tell you WHICH server to disconnect, because tool schemas are
// only visible to a running harness.
//
// This module recovers that by natural experiment. Every repo on the machine is
// a sample: a declared server set and a measured opening prefix. Repos with a
// server, compared against repos without it, price it.
//
// The discipline that makes this trustworthy is refusing to answer. Two groups
// differing by six servers at once price the SET, not any server in it. Saying
// otherwise would be six confident numbers invented from one observation, which
// is exactly the failure mode this tool exists to catch elsewhere.

import { readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { mkFinding } from './finding.mjs'
import { readText, safeStat, walkFile } from './fs.mjs'
import { formatToken } from './token.mjs'
import { settingPath, toolSearchOf } from './toolsearch.mjs'

// A repo whose prefix is this far above its own group is almost certainly a
// project where every transcript is a resumed session -- the opening turn was
// never observed, so the floor is not the prefix.
const OUTLIER_FACTOR = 2.5

// Below this, a group is one anecdote.
const MIN_SAMPLE = 2

// Contrasts smaller than this are indistinguishable from the noise between
// repos: different memory files, different harness versions, different luck in
// which turn happened to be smallest. A negative contrast is always noise --
// a server cannot make the prefix shorter.
const NOISE_FLOOR = 3_000

export function auditMcpCost(opt = {}) {
  const projectDir = opt.transcript ?? join(homedir(), '.claude', 'projects')
  const config = readGlobalConfig(opt.config ?? join(homedir(), '.claude.json'))

  const scanned = scanRepo(projectDir, config, opt)
  if (scanned.length < 4)
    return {
      repo: scanned,
      group: [],
      finding: [],
      note: `only ${scanned.length} repos have measurable transcripts; contrast needs at least 4`,
    }

  // Deferred tool loading is a confound, not a detail. A repo whose schemas load
  // on demand has a structurally smaller prefix than one whose schemas do not,
  // and comparing across that line prices the SETTING while calling it a server.
  // So the contrast runs inside one cohort, and the other is set aside and named.
  const cohort = cohortOf(scanned)
  const repo = cohort.pricing
  const finding = []

  if (cohort.setAside.length) {
    finding.push(
      mkFinding({
        id: 'mcp-cost-defer-confound',
        severity: 'info',
        surface: 'always-on',
        title: `${cohort.setAside.length} repos excluded from the contrast: their deferred-loading setting differs`,
        why:
          `Pricing runs across the ${repo.length} repos where deferred tool loading is ` +
          `${cohort.deferred ? 'on' : 'off'}. Deferred loading moves tool schemas out of the prefix entirely, so a ` +
          'repo on the other side of that setting has a smaller prefix for a reason that has nothing to do with which ' +
          'servers it declares. Mixing the two would price the setting and label it a server.',
        fix:
          'Nothing, unless you want the excluded repos priced too -- then set the same deferred-loading state across ' +
          'them so they form their own cohort of at least 2.',
        data: {
          token: null,
          pricing: repo.length,
          setAside: cohort.setAside.map((r) => r.repo),
          deferred: cohort.deferred,
        },
      }),
    )
  }

  if (repo.length < 4)
    return {
      repo: scanned,
      group: [],
      finding,
      note:
        `only ${repo.length} of ${scanned.length} repos share a deferred-loading state; ` +
        'contrast needs at least 4 comparable repos',
    }

  const group = groupBySet(repo)
  const baseline = group.find((g) => g.server.length === 0) ?? group[0]

  // The setting is itself a natural experiment, and the most valuable one on the
  // machine: both cohorts are real sessions differing in how schemas load. It is
  // coarser than a server contrast, because the two cohorts also declare
  // different servers -- so it is reported with that named, never as clean.
  const deferContrast = contrastDefer(cohort)
  if (deferContrast) finding.push(deferContrast)

  const quiet = []

  for (const g of group) {
    if (g === baseline) continue
    const delta = g.median - baseline.median
    const separable = g.server.filter((s) => !baseline.server.includes(s))

    // Below the noise floor there is nothing to report per group. Collect them
    // and say so once -- "costs about -1.2k tokens" is not a finding.
    if (delta < NOISE_FLOOR) {
      quiet.push(...separable)
      continue
    }

    if (g.sample < MIN_SAMPLE) {
      finding.push(
        mkFinding({
          id: 'mcp-cost-undersampled',
          severity: 'info',
          surface: 'always-on',
          title: `${describe(g.server)}: ${formatToken(delta)} above baseline, but only ${g.sample} repo`,
          why: 'One repo is an anecdote. Its prefix could just as easily be a large memory file or a long-lived session.',
          fix: `Use this set in at least ${MIN_SAMPLE} repos, or disconnect it in ${g.repo[0]} and re-measure.`,
          data: { token: delta, server: g.server, sample: g.sample, repo: g.repo },
        }),
      )
      continue
    }

    // Exactly one server different: the contrast prices that server.
    if (separable.length === 1) {
      finding.push(
        mkFinding({
          id: 'mcp-server-cost',
          severity: gradeDelta(delta),
          surface: 'always-on',
          title: `${separable[0]} costs about ${formatToken(delta)} tokens on every turn`,
          why:
            `${g.sample} repos declare it (median prefix ${formatToken(g.median)}) against ${baseline.sample} that ` +
            `do not (median ${formatToken(baseline.median)}). It is the only server that differs between the two groups.`,
          fix:
            delta > 5_000
              ? `Disconnect ${separable[0]} in repos that do not use it and re-run \`pileup session\` to confirm the drop.`
              : `Cheap enough to leave connected. Note that a declared server that never connects also measures as free, ` +
                `so a zero here can mean "not actually loading" rather than "costs nothing".`,
          data: { token: delta, server: separable[0], with: g.sample, without: baseline.sample },
        }),
      )
      continue
    }

    // More than one server different: the SET is priced, nothing inside it is.
    finding.push(
      mkFinding({
        id: 'mcp-set-cost',
        severity: gradeDelta(delta),
        surface: 'always-on',
        title: `${separable.length} servers together cost about ${formatToken(delta)} tokens on every turn`,
        why:
          `${describe(separable)} always appear together across ${g.sample} repos, so their individual costs cannot be ` +
          `separated. Together they take the prefix from ${formatToken(baseline.median)} to ${formatToken(g.median)} — ` +
          `paid on every turn of every session in ${g.repo.join(', ')}.`,
        fix:
          'Disconnect them one at a time and re-run `pileup mcp-cost` after each. Each removal creates a new group and ' +
          'the next run can price what changed.',
        data: { token: delta, server: separable, sample: g.sample, repo: g.repo },
      }),
    )
  }

  // Confirmation, from measurement rather than from the setting.
  //
  // `mcp-deferred` can only report that deferral is DECLARED (or defaulted). This
  // is the other half: if servers are declared across repos and their measured
  // contrast is inside the noise floor, their schemas are not in the prefix. That
  // is what deferral working looks like, observed rather than asserted -- and it
  // is the only check that also catches the two runtime conditions no file scan
  // can see, a non-first-party base URL and Vertex.
  const priced = group.filter((g) => g !== baseline && g.server.length)
  const quietShare = priced.length ? quiet.length / new Set(priced.flatMap((g) => g.server)).size : 0
  if (cohort.deferred && priced.length >= 2 && quietShare >= 0.6) {
    finding.push(
      mkFinding({
        id: 'mcp-defer-confirmed',
        severity: 'info',
        surface: 'always-on',
        title: `deferred tool loading looks like it is actually working: ${quiet.length} of ${new Set(priced.flatMap((g) => g.server)).size} servers cost nothing measurable`,
        why:
          `Across ${repo.length} comparable repos, most declared servers move the measured prefix by less than ` +
          `${formatToken(NOISE_FLOOR)} against a ${formatToken(baseline.median)} baseline. Loaded schemas could not ` +
          'hide like that -- a single browser-automation server carries dozens of tools. This is the confirmation the ' +
          'setting alone cannot give, and it covers the runtime conditions no file scan can see.',
        fix:
          'Nothing. Recorded because the opposite conclusion -- assuming schemas are in the prefix -- is what makes ' +
          'pileup recommend disconnecting servers that are already free.',
        data: {
          token: 0,
          quiet: quiet.length,
          declared: new Set(priced.flatMap((g) => g.server)).size,
          baseline: baseline.median,
          repo: repo.length,
        },
      }),
    )
  }

  const quietSet = [...new Set(quiet)].sort()
  if (quietSet.length) {
    finding.push(
      mkFinding({
        id: 'mcp-cost-negligible',
        severity: 'info',
        surface: 'always-on',
        title: `${quietSet.length} servers show no cost above noise: ${describe(quietSet)}`,
        why:
          `Their repos sit within ${formatToken(NOISE_FLOOR)} of the ${formatToken(baseline.median)} baseline, which is ` +
          'inside the spread caused by differing memory files and harness versions.',
        fix:
          'Nothing to do, with one caveat: a server declared but never approved or never started also measures as free. ' +
          'A zero here can mean "not actually loading" rather than "carries no schemas".',
        data: { token: 0, server: quietSet, noiseFloor: NOISE_FLOOR },
      }),
    )
  }

  if (config.global.length) {
    finding.push(
      mkFinding({
        id: 'mcp-cost-global',
        severity: 'info',
        surface: 'always-on',
        title: `${describe(config.global)} configured globally, so ${config.global.length === 1 ? 'it is' : 'they are'} unpriceable`,
        why:
          'A server present in every repo has no comparison group. Its cost is folded into the baseline and cannot be ' +
          'separated from the harness system prompt.',
        fix:
          'Move it to the repos that actually use it. Once some repos lack it, the next run can price it — and scoping ' +
          'it is worth doing regardless, since a global server bills in every repo on the machine.',
        data: { token: null, server: config.global },
      }),
    )
  }

  const excluded = repo.filter((r) => r.excluded)
  const version = [...new Set(scanned.map((r) => r.version).filter(Boolean))].sort()

  const note = []
  if (excluded.length)
    note.push(
      `${excluded.length} repo${excluded.length === 1 ? '' : 's'} excluded as outliers (prefix > ${OUTLIER_FACTOR}x their group median, usually transcripts that only ever resumed)`,
    )
  if (version.length > 1)
    note.push(
      `samples span ${version.length} harness versions (${version[0]} to ${version.at(-1)}); the system prompt changes between releases, so contrasts under ${formatToken(NOISE_FLOOR)} are not trustworthy`,
    )

  return {
    repo: scanned,
    priced: repo,
    group,
    baseline,
    finding,
    version,
    cohort: { pricing: repo.length, setAside: cohort.setAside.length, deferred: cohort.deferred },
    note: note.join('. ') || null,
  }
}

/**
 * Split the scanned repos by declared deferred-loading state.
 *
 * The larger side prices servers; the smaller is set aside. Larger rather than
 * "the one matching this machine's global setting", because the point is to keep
 * as many comparable samples as possible, and a cohort of 8 prices better than
 * a cohort of 2 regardless of which way the setting went.
 */
function cohortOf(scanned) {
  const on = scanned.filter((r) => r.toolSearch.deferring)
  const off = scanned.filter((r) => !r.toolSearch.deferring)
  const [pricing, setAside] = on.length > off.length ? [on, off] : [off, on]
  return { pricing, setAside, deferred: pricing === on, on, off }
}

/**
 * Price the SETTING by contrasting the two cohorts.
 *
 * Coarser than a server contrast and reported as such: the cohorts differ in
 * their declared servers too, so this bounds the setting's worth rather than
 * measuring it. Reported only when both sides have enough repos to have a
 * median worth taking.
 */
function contrastDefer({ on, off }) {
  if (on.length < MIN_SAMPLE || off.length < MIN_SAMPLE) return null

  const onMedian = median(on.map((r) => r.prefix))
  const offMedian = median(off.map((r) => r.prefix))
  const delta = offMedian - onMedian
  if (delta < NOISE_FLOOR) return null

  const onServer = median(on.map((r) => r.server.length))
  const offServer = median(off.map((r) => r.server.length))

  return mkFinding({
    id: 'mcp-defer-measured',
    severity: gradeDelta(delta),
    surface: 'always-on',
    title: `deferred tool loading looks worth about ${formatToken(delta)} tokens on every turn here`,
    why:
      `${off.length} repos without it median ${formatToken(offMedian)}; ${on.length} with it median ` +
      `${formatToken(onMedian)}. This is coarser than a per-server contrast, because the two groups also declare ` +
      `different servers (median ${offServer} without, ${onServer} with) -- so read it as the order of magnitude the ` +
      'setting is worth on this machine, not as its exact price.',
    fix:
      'To sharpen it, turn the setting on in a repo and re-run `pileup session` before and after. That contrast holds ' +
      'the server set fixed and is the only version of this number that is clean.',
    data: {
      token: delta,
      withDefer: { repo: on.length, median: onMedian, server: onServer },
      withoutDefer: { repo: off.length, median: offMedian, server: offServer },
    },
  })
}

/** One row per repo: its declared servers and its smallest observed prefix. */
function scanRepo(projectDir, config, opt = {}) {
  if (!safeStat(projectDir)) return []
  const row = []

  for (const dir of childDir(projectDir)) {
    let cwd = null
    let prefix = null
    let version = null

    for (const path of walkFile(dir, (n) => n.endsWith('.jsonl'), 2)) {
      const text = readText(path)
      if (text == null) continue
      for (const line of text.split('\n')) {
        if (!line.includes('"usage"') && !line.includes('"cwd"')) continue
        let d
        try {
          d = JSON.parse(line)
        } catch {
          continue
        }
        if (!cwd && d.cwd) cwd = d.cwd
        const u = d.type === 'assistant' ? d.message?.usage : null
        if (!u) continue
        const turn =
          (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.input_tokens ?? 0)
        // The prefix is a floor: the smallest turn ever billed in this repo.
        // Record which harness version produced it -- the system prompt changes
        // between releases, and that drift can masquerade as a server cost.
        if (turn > 1_000 && (prefix === null || turn < prefix)) {
          prefix = turn
          version = d.version ?? null
        }
      }
    }

    if (cwd && prefix)
      row.push({
        repo: basename(cwd),
        cwd,
        prefix,
        version,
        server: serverOf(cwd, config),
        toolSearch: toolSearchOf(settingPath(cwd, opt), opt),
      })
  }
  return row
}

/** Declared servers for a repo, excluding global ones (which have no comparison group). */
function serverOf(cwd, config) {
  const set = new Set()
  const local = readJson(join(cwd, '.mcp.json'))
  for (const k of Object.keys(local?.mcpServers ?? {})) set.add(k)
  for (const k of Object.keys(config.project[cwd]?.mcpServers ?? {})) set.add(k)
  for (const g of config.global) set.delete(g)
  return [...set].sort()
}

function groupBySet(repo) {
  const bucket = new Map()
  for (const r of repo) {
    const key = r.server.join(',')
    if (!bucket.has(key)) bucket.set(key, { server: r.server, member: [] })
    bucket.get(key).member.push(r)
  }

  return [...bucket.values()]
    .map((b) => {
      const rough = median(b.member.map((m) => m.prefix))
      // Drop repos whose transcripts never captured an opening turn.
      const kept = b.member.filter((m) => m.prefix <= rough * OUTLIER_FACTOR)
      for (const m of b.member) m.excluded = !kept.includes(m)
      const use = kept.length ? kept : b.member
      return {
        server: b.server,
        median: median(use.map((m) => m.prefix)),
        sample: use.length,
        repo: use.map((m) => m.repo),
        spread: [Math.min(...use.map((m) => m.prefix)), Math.max(...use.map((m) => m.prefix))],
      }
    })
    .sort((a, b) => a.server.length - b.server.length || a.median - b.median)
}

function readGlobalConfig(path) {
  const json = readJson(path)
  return {
    global: Object.keys(json?.mcpServers ?? {}).sort(),
    project: json?.projects ?? {},
  }
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

function childDir(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => join(dir, e.name))
  } catch {
    return []
  }
}

function median(n) {
  const s = [...n].sort((a, b) => a - b)
  return s.length % 2 ? s[(s.length - 1) / 2] : Math.round((s[s.length / 2 - 1] + s[s.length / 2]) / 2)
}

function gradeDelta(delta) {
  if (delta >= 100_000) return 'critical'
  if (delta >= 40_000) return 'high'
  if (delta >= 10_000) return 'medium'
  if (delta >= 3_000) return 'low'
  return 'info'
}

function describe(server) {
  if (server.length === 1) return server[0]
  if (server.length <= 4) return server.join(', ')
  return `${server.slice(0, 3).join(', ')} and ${server.length - 3} more`
}
