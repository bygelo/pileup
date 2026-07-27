// Skills, subagents and slash commands.
//
// These are two costs wearing one filename. The frontmatter `description` is
// ALWAYS-ON -- every harness lists it so the model can decide whether to reach
// for the thing, which means every unused skill still bills you on every turn.
// The body is ON-INVOKE and only bills when the agent actually opens it.
//
// That asymmetry is the whole point: a 30k-token skill body with a one-line
// description is well-built. A 2k-token body with a 900-character description
// is not.

import { artifactOf } from '../adapter.mjs'
import { BODY, DESCRIPTION, DESCRIPTION_TOTAL } from '../budget.mjs'
import { gradeBy, mkFinding } from '../finding.mjs'
import { splitFrontmatter } from '../frontmatter.mjs'
import { readText } from '../fs.mjs'
import { estimateToken, formatToken } from '../token.mjs'

const KIND = ['skill', 'agent', 'command']

export const id = 'definition'

export function collect(ctx) {
  const finding = []
  const surface = []

  for (const a of artifactOf(ctx.harness).filter((x) => KIND.includes(x.kind))) {
    const text = readText(a.path)
    if (text == null) continue

    const { meta, body } = splitFrontmatter(text)
    const name = meta.name ?? a.rel.replace(/\/(SKILL|index)\.md$/i, '').split('/').pop()
    const description = meta.description ?? ''
    const descToken = estimateToken(description)
    const bodyToken = estimateToken(body)

    surface.push({ ...a, name, descToken, bodyToken, char: description.length })

    if (a.kind === 'skill' && !description) {
      finding.push(
        mkFinding({
          id: 'definition-no-description',
          severity: 'medium',
          surface: 'always-on',
          title: `${a.rel} has no description`,
          why:
            'The description is the only thing the model sees when deciding whether to load this. ' +
            `Without one the ${formatToken(bodyToken)}-token body is dead weight that will never fire.`,
          fix: 'Add a one-line description covering what it does, when to use it, and when to skip it.',
          data: { path: a.rel, name, token: bodyToken, harness: a.harness, scope: a.scope },
        }),
      )
    }

  }

  // The aggregate is the number that actually bills. Individual descriptions
  // are only worth naming once the total is already a problem, and even then
  // only the worst few -- a report with fifty findings is its own kind of bloat.
  const descTotal = surface.reduce((s, d) => s + d.descToken, 0)
  const totalSeverity = gradeBy(descTotal, DESCRIPTION_TOTAL)
  const worst = [...surface].sort((a, b) => b.char - a.char)

  if (totalSeverity) {
    finding.push(
      mkFinding({
        id: 'definition-description-total',
        severity: totalSeverity,
        surface: 'always-on',
        title: `${formatToken(descTotal)} tokens of skill, agent and command descriptions on every turn`,
        why:
          `${surface.length} definitions are visible to the model, and every one of their descriptions is re-sent ` +
          'each turn so the model can decide whether to reach for it. Definitions you never use still bill.',
        fix:
          'Two levers. Trim the fattest descriptions to one line of trigger plus one of boundary, and uninstall or ' +
          'scope-down definitions this repo never invokes -- a machine-wide skill is paid for in every repo on the machine.',
        data: {
          token: descTotal,
          count: surface.length,
          worst: worst.slice(0, 8).map((d) => ({ name: d.name, char: d.char, scope: d.scope })),
        },
      }),
    )
  }

  for (const d of worst.slice(0, 8)) {
    const severity = gradeBy(d.char, DESCRIPTION)
    if (!severity || severity === 'low') continue
    finding.push(
      mkFinding({
        id: 'definition-fat-description',
        severity,
        surface: 'always-on',
        title: `${d.name} description is ${d.char} chars (~${d.descToken} tokens, every turn)`,
        why:
          'A description is a routing signal, not documentation. This one is long enough that the model reads a ' +
          'paragraph of prose on every turn just to decide it does not need the skill.',
        fix:
          'Cut to one sentence of trigger plus one of boundary: what it does, when to use it, when to skip it. ' +
          'Everything else belongs in the body, which costs nothing until the thing is actually invoked.',
        data: {
          path: d.rel,
          name: d.name,
          token: d.descToken,
          char: d.char,
          harness: d.harness,
          scope: d.scope,
        },
      }),
    )
  }

  const fatBody = [...surface].sort((a, b) => b.bodyToken - a.bodyToken).slice(0, 5)
  for (const d of fatBody) {
    const severity = gradeBy(d.bodyToken, BODY)
    if (!severity) continue
    finding.push(
      mkFinding({
        id: 'definition-fat-body',
        severity: severity === 'high' ? 'medium' : 'low',
        surface: 'on-invoke',
        title: `${d.name} body is ${formatToken(d.bodyToken)} tokens`,
        why:
          'Paid only when invoked, so this is far cheaper than an always-on cost -- but it lands in one shot ' +
          'and crowds out the work the agent was invoked to do.',
        fix:
          'Split the reference material into sibling files and have the body point at them. ' +
          'The agent then loads only the section it needs.',
        data: { path: d.rel, name: d.name, token: d.bodyToken, harness: d.harness, scope: d.scope },
      }),
    )
  }

  return { finding, surface }
}
