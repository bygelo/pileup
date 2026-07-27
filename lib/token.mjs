// Token estimation without a tokenizer dependency.
//
// pileup ships zero dependencies on purpose, so it cannot run the real BPE.
// Instead it estimates from character-class runs, which tracks actual BPE
// behaviour far better than the usual `chars / 4`:
//
//   - a run of letters splits into subwords, ~4.5 chars each
//   - digits tokenize much denser, ~3 chars each
//   - punctuation usually merges into a neighbour, so it costs a fraction
//   - newlines are their own token more often than spaces are
//
// The error bars on this have NOT been measured against a real tokenizer -- see
// the calibration item in ROADMAP.md. What can be said honestly: on the one
// corpus where a hand-written reference exists (the read-discipline table in the
// tna repo's CLAUDE.md, whose author counted three large files independently),
// this estimator ran 5-13% high. Treat every number it produces as a ranking
// signal, not a measurement.
//
// Anything pileup reports is an estimate unless it came from `pileup session`,
// which reads tokens the API actually billed.

const RUN = /[A-Za-z]+|[0-9]+|\n|[ \t]+|[^\sA-Za-z0-9]/g

const CHAR_PER_ALPHA_TOKEN = 4.5
const CHAR_PER_DIGIT_TOKEN = 3
const NEWLINE_COST = 0.8
const SPACE_RUN_COST = 0.15
const SYMBOL_COST = 0.6

/** Estimated token count for a string. Never negative, always an integer. */
export function estimateToken(text) {
  if (!text) return 0
  let total = 0
  for (const [run] of text.matchAll(RUN)) {
    const head = run[0]
    if (head === '\n') total += NEWLINE_COST
    else if (head === ' ' || head === '\t') total += SPACE_RUN_COST
    else if (head >= '0' && head <= '9') total += Math.ceil(run.length / CHAR_PER_DIGIT_TOKEN)
    else if ((head >= 'a' && head <= 'z') || (head >= 'A' && head <= 'Z'))
      total += Math.max(1, Math.round(run.length / CHAR_PER_ALPHA_TOKEN))
    else total += SYMBOL_COST
  }
  return Math.round(total)
}

/** Human-readable token count: 1234 -> "1.2k", 290144 -> "290k", 1.2e8 -> "118M". */
export function formatToken(count) {
  if (count < 0) return `-${formatToken(-count)}`
  if (count < 1000) return String(count)
  if (count < 10_000) return `${(count / 1000).toFixed(1)}k`
  if (count < 1_000_000) return `${Math.round(count / 1000)}k`
  if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`
  return `${Math.round(count / 1_000_000)}M`
}

/** Share of a context window, as a percent string. */
export function formatShare(count, window) {
  const pct = (count / window) * 100
  if (pct < 0.1) return '<0.1%'
  return `${pct < 10 ? pct.toFixed(1) : Math.round(pct)}%`
}
