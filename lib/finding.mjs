// Finding model. Every collector emits these and nothing else, so the
// reporters never need to know which collector produced what.

export const SEVERITY = ['info', 'low', 'medium', 'high', 'critical']

const RANK = Object.fromEntries(SEVERITY.map((s, i) => [s, i]))

/**
 * Where the cost lands. This is the axis that matters more than raw size:
 * 2k tokens on every turn beats 200k tokens read once.
 *
 *   always-on  every turn of every session (memory files, frontmatter, tool schemas)
 *   on-invoke  only when the agent reaches for it (skill bodies, agent defs)
 *   on-read    only if the agent opens it, but nothing stops it (big docs)
 *   cache      not size at all: prefix churn that re-bills tokens already paid for
 */
export const SURFACE = ['always-on', 'on-invoke', 'on-read', 'cache']

/**
 * @param {object} spec
 * @param {string} spec.id       stable slug, e.g. 'memory-oversized'
 * @param {string} spec.severity one of SEVERITY
 * @param {string} spec.surface  one of SURFACE
 * @param {string} spec.title    one line, leads with the number
 * @param {string} [spec.why]    why this costs what it costs
 * @param {string} [spec.fix]    the prescription; pileup never applies it
 * @param {object} [spec.data]   structured payload for diffing runs
 */
export function mkFinding(spec) {
  // `info` ranks 0, so test for membership rather than truthiness.
  if (!(spec.severity in RANK)) throw new Error(`bad severity: ${spec.severity}`)
  if (!SURFACE.includes(spec.surface)) throw new Error(`bad surface: ${spec.surface}`)
  return {
    id: spec.id,
    severity: spec.severity,
    surface: spec.surface,
    title: spec.title,
    why: spec.why ?? null,
    fix: spec.fix ?? null,
    data: spec.data ?? {},
  }
}

// Within one severity, cost paid on every turn beats cost paid only if the
// agent happens to open something. This ordering is the whole thesis of the
// tool, so it lives in the sort.
const SURFACE_RANK = { 'always-on': 0, cache: 1, 'on-read': 2, 'on-invoke': 3 }

/** Most severe first, then by frequency of payment, then by token cost. */
export function rankFinding(finding) {
  return [...finding].sort(
    (a, b) =>
      RANK[b.severity] - RANK[a.severity] ||
      SURFACE_RANK[a.surface] - SURFACE_RANK[b.surface] ||
      (b.data.token ?? 0) - (a.data.token ?? 0),
  )
}

/** Pick a severity by walking a descending threshold table. */
export function gradeBy(value, table) {
  for (const [severity, floor] of table) if (value >= floor) return severity
  return null
}

export function worstOf(finding) {
  return finding.reduce(
    (worst, f) => (RANK[f.severity] > RANK[worst] ? f.severity : worst),
    'info',
  )
}
