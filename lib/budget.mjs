// Thresholds, in tokens, all in one place so they are arguable rather than
// scattered through the collectors. Every table is [severity, floor] ordered
// most-severe first and read by `gradeBy`.
//
// The numbers come from a simple principle: the always-on surface is rent you
// pay on every single turn. Under ~10k tokens it is noise. Past ~25k it is a
// meaningful slice of every request and it never stops costing.

export const DEFAULT_WINDOW = 200_000

/**
 * The MEASURED prefix, from session transcripts. Graded harder than the static
 * estimate because this number is real and includes everything: the harness
 * system prompt, its built-in tools, and every connected MCP server's schemas.
 * Past 100k the agent is paying for a second context window's worth of overhead
 * on every single turn.
 */
export const PREFIX = [
  ['critical', 100_000],
  ['high', 50_000],
  ['medium', 25_000],
]

/** Sum of everything injected before the agent has done anything. */
export const ALWAYS_ON_TOTAL = [
  ['critical', 40_000],
  ['high', 25_000],
  ['medium', 15_000],
  ['low', 10_000],
]

/** A single memory file: CLAUDE.md, AGENTS.md, .cursorrules, copilot-instructions.md. */
export const MEMORY_FILE = [
  ['critical', 20_000],
  ['high', 10_000],
  ['medium', 5_000],
  ['low', 3_000],
]

/**
 * One skill/agent/command description, in characters.
 *
 * A good description needs a trigger and a boundary -- what it does, when to
 * use it, when to skip -- which lands around 200-400 characters. Past ~700 it
 * has stopped routing and started documenting, and it is doing that on every
 * turn whether or not the skill ever fires.
 */
export const DESCRIPTION = [
  ['high', 1_200],
  ['medium', 700],
  ['low', 400],
]

/** A skill or agent body. Only paid on invoke, so the bar is much higher. */
export const BODY = [
  ['high', 15_000],
  ['medium', 8_000],
]

/**
 * Share of the context window Claude Code allots to skill descriptions.
 *
 * SOURCE: Claude Code changelog, read 2026-07-30 -- "skill character budget
 * scales with context window (2% of context)". A harness fact, so it rots when
 * they change it; see docs/harness-fact.md.
 *
 * Not a pileup heuristic -- the harness scales a skill character budget with the
 * context window at 2%, so this is a real ceiling rather than an opinion about
 * taste. On a 200k window that is 4,000 characters of description across every
 * discoverable skill; on Opus 5's 1M window it is 20,000.
 *
 * It is expressed in CHARACTERS, not tokens, because that is how the harness
 * counts it -- so pileup measures it in characters too rather than converting
 * through an estimator and introducing error into a hard limit.
 */
export const SKILL_BUDGET_SHARE = 0.02

/** How full the skill character budget is. Descriptions compete for one pool. */
export const SKILL_BUDGET_FILL = [
  ['high', 1.0],
  ['medium', 0.75],
  ['low', 0.5],
]

/** Sum of every description. This is the number that actually bills. */
export const DESCRIPTION_TOTAL = [
  ['high', 8_000],
  ['medium', 4_000],
  ['low', 2_000],
]

/**
 * A doc the agent could open whole. Nothing forces it to, which is exactly why
 * this is dangerous: one `Read` and the window is gone.
 */
export const READ_TRAP = [
  ['critical', 150_000],
  ['high', 50_000],
  ['medium', 25_000],
  ['low', 12_000],
]

/** MCP servers configured. Every server's tool schemas ride along on every turn. */
export const MCP_SERVER_COUNT = [
  ['high', 8],
  ['medium', 5],
  ['low', 3],
]

/**
 * Cache read as a share of all cached-eligible input. Inverted: lower is worse.
 * Cached input bills at 10% of normal, so a low ratio is a direct multiplier on
 * the bill, and on a subscription it is a direct multiplier on quota burn.
 */
export const CACHE_HIT_FLOOR = [
  ['high', 0.5],
  ['medium', 0.7],
  ['low', 0.85],
]

/**
 * Relative token prices, expressed as multiples of one uncached input token.
 * These are ratios, not prices -- they hold across model tiers and they are
 * what matters for deciding where the spend actually is. On a subscription the
 * same ratios govern how fast the quota drains.
 */
export const RELATIVE_PRICE = {
  input: 1,
  cacheWrite: 1.25,
  cacheRead: 0.1,
  output: 5,
}

/** Output tokens per turn. High numbers mean prose nobody asked for. */
export const OUTPUT_PER_TURN = [
  ['medium', 2_000],
  ['low', 1_200],
]

/** Inverted grading for ratios where small is bad. */
export function gradeFloor(value, table) {
  for (const [severity, ceiling] of table) if (value < ceiling) return severity
  return null
}
