// How often each definition was actually reached for, read from transcripts.
//
// This is the measured half of every "never fired" claim pileup makes, which
// makes undercounting here the most damaging kind of bug the tool can have: it
// does not produce a vague number, it produces a confident instruction to delete
// something you use.
//
// It lives in one module because it already went wrong by living in two.
// `pileup skill` counted only `Skill` tool calls while `pileup fleet` counted
// those AND slash commands, so the same skill read 51 in one report and 81 in the
// other -- and a skill only ever invoked as `/parcel` was reported as never fired
// by the command whose entire job is to say which skills are unused.
//
// SOURCE: both invocation shapes were read out of local Claude Code transcripts on
// 2026-07-30 and validated against 545 of them. A harness fact -- if either shape
// changes, every "never fired" claim silently becomes a false positive. See
// docs/harness-fact.md.
//
// A definition fires through two channels and both count:
//
//   Skill tool call   {"type":"tool_use","name":"Skill","input":{"skill":"foo"}}
//   slash command     <command-name>/foo</command-name> in the expanded user turn
//
// In Claude Code `/foo` invokes the skill `foo`, so treating those as different
// events would be a distinction the user does not experience.

import { readText, safeStat, walkFile } from './fs.mjs'

// Transcripts run to hundreds of megabytes and almost no line mentions either,
// so both channels are tested with a cheap string check before anything parses.
const COMMAND = /<command-name>\/?([^<\s]+)(?:\s[^<]*)?<\/command-name>/g

/**
 * @param {string} dir  a transcript root, e.g. ~/.claude/projects
 * @returns {{count: Map<string, number>, scanned: number, total: number}}
 *   `scanned` is how many transcripts were read. Zero means no claim about
 *   firing is available -- absence of evidence, not evidence of absence.
 */
export function countInvocation(dir) {
  const count = new Map()
  let scanned = 0
  let total = 0
  if (!dir || !safeStat(dir)) return { count, scanned, total }

  const bump = (name) => {
    if (!name) return
    count.set(name, (count.get(name) ?? 0) + 1)
    total += 1
  }

  for (const path of walkFile(dir, (n) => n.endsWith('.jsonl'), 4)) {
    const text = readText(path)
    if (text == null) continue
    scanned += 1

    for (const line of text.split('\n')) {
      const hasSkill = line.includes('"Skill"')
      const hasCommand = line.includes('<command-name>')
      if (!hasSkill && !hasCommand) continue

      if (hasCommand) for (const [, name] of line.matchAll(COMMAND)) bump(name)

      if (!hasSkill) continue
      let d
      try {
        d = JSON.parse(line)
      } catch {
        continue
      }
      if (d.type !== 'assistant') continue
      for (const b of d.message?.content ?? [])
        if (b?.type === 'tool_use' && b.name === 'Skill') bump(b.input?.skill)
    }
  }
  return { count, scanned, total }
}
