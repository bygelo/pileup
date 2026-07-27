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

/** Inverted grading for ratios where small is bad. */
export function gradeFloor(value, table) {
  for (const [severity, ceiling] of table) if (value < ceiling) return severity
  return null
}
