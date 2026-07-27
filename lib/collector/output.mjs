// The output side of the bill.
//
// Every other collector measures what goes IN. Output tokens bill at roughly
// five times an input token, which makes terseness skills -- caveman and its
// relatives -- genuinely attractive, and they are the most popular answer going
// to "my sessions cost too much".
//
// They are also the easiest thing to be wrong about. A terseness skill cuts
// prose, but prose is a minority of a coding session, and the skill itself adds
// an always-on description to every turn forever. Whether that trade wins is
// arithmetic, not opinion, and pileup already has both numbers.
//
// This collector does not tell you to install anything. It tells you what the
// trade is worth in YOUR sessions.

import { OUTPUT_PER_TURN, RELATIVE_PRICE as PRICE } from '../budget.mjs'
import { gradeBy, mkFinding } from '../finding.mjs'
import { formatToken } from '../token.mjs'

// Published measurements of terseness skills cluster around a 65% cut, but only
// on discursive text -- generated code, diffs and tool arguments are untouched
// and are most of what a coding agent emits. This is the share that is even
// eligible to shrink.
const PROSE_SHARE = 0.3
const PROSE_CUT = 0.65

export const id = 'output'

export function collect(ctx) {
  const session = ctx.surface?.session ?? []
  if (!session.length) return { finding: [], surface: [] }

  const total = session.reduce(
    (s, x) => ({
      turn: s.turn + x.turn,
      output: s.output + x.output,
      cacheRead: s.cacheRead + x.cacheRead,
      cacheCreate: s.cacheCreate + x.cacheCreate,
      input: s.input + x.input,
    }),
    { turn: 0, output: 0, cacheRead: 0, cacheCreate: 0, input: 0 },
  )
  if (!total.turn || !total.output) return { finding: [], surface: [] }

  const inputCost =
    total.cacheRead * PRICE.cacheRead + total.cacheCreate * PRICE.cacheWrite + total.input * PRICE.input
  const outputCost = total.output * PRICE.output
  const outputShare = outputCost / (inputCost + outputCost)
  const perTurn = Math.round(total.output / total.turn)

  const finding = []
  const surface = [{ ...total, perTurn, outputShare, inputCost, outputCost }]

  const severity = gradeBy(perTurn, OUTPUT_PER_TURN)
  if (severity) {
    finding.push(
      mkFinding({
        id: 'output-verbose',
        severity,
        surface: 'on-invoke',
        title: `${formatToken(perTurn)} output tokens per turn across ${total.turn} turns`,
        why:
          'Output bills at about five times an input token. At this rate the agent is writing more explanation than ' +
          'most turns need.',
        fix:
          'Ask for less prose in the memory file -- "answer, do not narrate" costs one line of always-on context. ' +
          'A terseness skill does the same thing more aggressively; see the trade below before installing one.',
        data: { token: total.output, perTurn, turn: total.turn },
      }),
    )
  }

  // The break-even. A terseness skill can only touch prose, and it charges an
  // always-on description on every turn to do it.
  const saving = total.output * PROSE_SHARE * PROSE_CUT * PRICE.output
  const savingShare = saving / (inputCost + outputCost)
  const breakEven = Math.round(saving / total.turn / PRICE.cacheRead)

  finding.push(
    mkFinding({
      id: 'output-terseness-tradeoff',
      severity: savingShare >= 0.05 ? 'low' : 'info',
      surface: 'on-invoke',
      title: `output is ${pct(outputShare)} of billed cost; a terseness skill could recover about ${pct(savingShare)}`,
      why:
        `${formatToken(total.output)} output tokens against ${formatToken(Math.round(inputCost))} input-equivalent. ` +
        'Terseness skills cut discursive text by roughly two thirds, but generated code, diffs and tool arguments are ' +
        'untouched and are most of what a coding agent emits.',
      fix:
        `The trade pays off as long as the skill adds less than about ${formatToken(breakEven)} tokens of cached ` +
        'always-on context per turn, which most of them clear comfortably -- so install one if you like the style. ' +
        `Just rank it honestly: it is worth ${pct(savingShare)}, and the always-on findings above are usually worth more. ` +
        'To check rather than assume, re-run `pileup session` afterwards and compare the prefix.',
      data: {
        token: total.output,
        outputShare,
        recoverableShare: savingShare,
        breakEvenPerTurn: breakEven,
        assumption: { proseShare: PROSE_SHARE, proseCut: PROSE_CUT, priceRatio: PRICE },
      },
    }),
  )

  return { finding, surface }
}

function pct(v) {
  return `${(v * 100).toFixed(1)}%`
}
