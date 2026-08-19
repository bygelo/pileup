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
// corpus where an independent reference exists -- a repo whose CLAUDE.md carried
// a hand-written token-cost table for three large files -- this estimator ran
// 5-13% high. Three files is a sample, not a calibration. Treat every number it
// produces as a ranking signal rather than a measurement.
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

// Tokenizers are not interchangeable, and pileup reports per harness.
//
// One estimator applied to every harness row means at least one row is wrong:
// the same file is a different number of tokens to each vendor's tokenizer.
// OpenAI runs tiktoken, Anthropic its own BPE, Google SentencePiece.
//
// SOURCE: published cross-tokenizer comparisons, read 2026-07-30 -- 1000 chars of
// English at ~245 tokens on GPT-5, ~270 on Claude, ~290-320 on Gemini, so Claude
// runs 10-20% above tiktoken and Gemini above both. Third-party measurements, not
// a local calibration run. See docs/harness-fact.md.
//
// `estimateToken` below lands near 255 tok/1000ch on prose and 271 on markdown,
// so it is treated as the Claude-family estimate and the others are expressed
// relative to it.
//
// What this is NOT: a calibration. The ratios come from published third-party
// comparisons, not from a local run against real tokenizers, and they say
// nothing about whether the absolute level is right -- that is still the
// blocked item in ROADMAP.md. What they fix is the RELATIVE error between two
// harness rows in the same report, which was previously zero by construction
// and therefore wrong by up to about 20%.
export const TOKENIZER = {
  claude: { name: 'Anthropic BPE', ratio: 1.0 },
  gpt: { name: 'tiktoken', ratio: 0.91 },
  gemini: { name: 'SentencePiece', ratio: 1.13 },
  // Cursor, Windsurf and Aider are model pickers, not model vendors. Whatever
  // the user selected is what tokenizes, and nothing on disk reliably says
  // which -- so assume the reference family and label the assumption.
  unknown: { name: 'model-dependent', ratio: 1.0 },
}

const HARNESS_FAMILY = {
  claude: 'claude',
  codex: 'gpt',
  copilot: 'gpt',
  gemini: 'gemini',
}

/** Tokenizer family a harness id bills against, or 'unknown'. */
export function familyOf(harness) {
  return HARNESS_FAMILY[harness] ?? 'unknown'
}

/** Estimated tokens for `text` as the given harness's tokenizer would count it. */
export function estimateTokenFor(text, harness) {
  const { ratio } = TOKENIZER[familyOf(harness)]
  const base = estimateToken(text)
  return ratio === 1 ? base : Math.round(base * ratio)
}

/**
 * Human-readable token count: 1234 -> "1.2k", 290144 -> "290k", 1.2e8 -> "118M",
 * 3.1e9 -> "3.1B".
 *
 * The billion tier is not decoration. `pileup fleet` multiplies a per-turn cost
 * by tens of thousands of measured turns, which ran off the end of the M tier and
 * printed "3147M" -- a number a reader has to stop and parse.
 */
export function formatToken(count) {
  if (count < 0) return `-${formatToken(-count)}`
  if (count < 1000) return String(count)
  if (count < 10_000) return `${(count / 1000).toFixed(1)}k`
  if (count < 1_000_000) return `${Math.round(count / 1000)}k`
  if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`
  if (count < 1_000_000_000) return `${Math.round(count / 1_000_000)}M`
  if (count < 10_000_000_000) return `${(count / 1_000_000_000).toFixed(1)}B`
  return `${Math.round(count / 1_000_000_000)}B`
}

/** Share of a context window, as a percent string. */
export function formatShare(count, window) {
  const pct = (count / window) * 100
  if (pct < 0.1) return '<0.1%'
  return `${pct < 10 ? pct.toFixed(1) : Math.round(pct)}%`
}
