// Fixtures are generated, not committed.
//
// A 600 KB decisions log checked into a repo whose whole point is "stop
// committing 600 KB decisions logs" would be a poor look. These are written to
// a temp dir at test time and thrown away with it.

import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

export function buildFixture() {
  const root = mkdtempSync(join(tmpdir(), 'pileup-test-'))
  const bloated = join(root, 'bloated')
  const lean = join(root, 'lean')

  // A repo that has accumulated. Every surface has something wrong with it.
  write(bloated, 'CLAUDE.md',
    '# CLAUDE.md\n\nSee [decisions](docs/decisions.md) for history.\n\n@docs/imported.md\n\n' +
      'Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor. '.repeat(400))
  write(bloated, 'docs/imported.md',
    'Imported context that is inlined on every single turn. '.repeat(1200))
  write(bloated, 'docs/decisions.md',
    '### D001 something happened and here is a long paragraph about it. '.repeat(9000))
  write(bloated, '.mcp.json', JSON.stringify({
    mcpServers: Object.fromEntries('abcdefghi'.split('').map((c) => [`server-${c}`, { command: 'x' }])),
  }, null, 1))
  write(bloated, '.claude/settings.json', JSON.stringify({
    hooks: {
      UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'echo hi' }] }],
      SessionStart: [{ hooks: [{ type: 'command', command: 'update-context.sh > CLAUDE.md' }] }],
    },
  }, null, 1))
  write(bloated, '.claude/skills/verbose/SKILL.md',
    `---\nname: verbose\ndescription: ${'This skill does a great many things and here is an exhaustive list of all of them written out at length. '.repeat(14)}\n---\n\n# Verbose\n\n${'body line\n'.repeat(50)}`)
  write(bloated, '.claude/skills/tight/SKILL.md', TIGHT)

  // The same repo, done well.
  write(lean, 'CLAUDE.md',
    '# CLAUDE.md\n\nBuild: npm run build. Test: npm test. Naming is singular everywhere.\n')
  write(lean, '.claude/skills/tight/SKILL.md', TIGHT)

  return { root, bloated, lean }
}

/**
 * A skill discovery root with the four cases that matter: one skill that fires,
 * one that never has, two that collide, and one parked in a dot-dir where the
 * harness will never see it.
 */
export function skillRoot() {
  const base = mkdtempSync(join(tmpdir(), 'pileup-skill-'))
  const root = join(base, 'root')
  const pool = join(base, 'pool')
  const transcript = join(base, 'transcript')

  const skill = (dir, name, description) =>
    write(dir, `${name}/SKILL.md`, `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\nbody\n`)

  skill(root, 'used', 'Deploy the service to production and roll back on failure.')
  skill(root, 'ghost', 'Generate quarterly financial projections from ledger exports.')
  skill(root, 'twin-a', 'Audit database migration scripts for destructive column drops before applying.')
  skill(root, 'twin-b', 'Audit database migration scripts before applying, catching destructive drops.')
  skill(join(root, '.disabled'), 'parked', 'Parked out of discovery; costs nothing.')
  skill(pool, 'ghost', 'Generate quarterly financial projections from ledger exports.')

  write(base, 'ledger.json', JSON.stringify({ promotions: [{ from: 'x-used', to: 'used' }] }))

  // Three invocations of `used`, none of anything else.
  const turn = (name) =>
    JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Skill', input: { skill: name } }] },
    })
  write(transcript, 'proj/session.jsonl', [turn('used'), turn('used'), turn('used')].join('\n'))

  return { root, pool, transcript, ledger: join(base, 'ledger.json') }
}

/**
 * A synthetic machine for MCP cost attribution: several repos, each with a
 * declared server set and transcripts whose smallest billed turn is its prefix.
 *
 * Shaped so every refusal path is exercised — a single-server contrast that CAN
 * be priced, a two-server set that cannot, a one-repo set that is undersampled,
 * a sub-noise contrast, and a global server with no comparison group.
 */
export function mcpMachine() {
  const base = mkdtempSync(join(tmpdir(), 'pileup-mcp-'))
  const transcript = join(base, 'projects')
  const repoBase = join(base, 'repo')

  const repo = [
    ...['bare1', 'bare2', 'bare3', 'bare4'].map((n) => [n, [], 40_000]),
    ...['heavy1', 'heavy2', 'heavy3'].map((n) => [n, ['heavy'], 90_000]),
    ...['pair1', 'pair2'].map((n) => [n, ['alpha', 'beta'], 140_000]),
    ['lonely', ['solo'], 200_000],
    ['cheap1', ['tiny'], 41_000],
    ['cheap2', ['tiny'], 41_500],
  ]

  const project = {}
  for (const [name, server, prefix] of repo) {
    const cwd = join(repoBase, name)
    write(cwd, '.mcp.json', JSON.stringify({ mcpServers: Object.fromEntries(server.map((s) => [s, {}])) }))
    project[cwd] = {}

    // Two turns: the prefix, and a larger later turn it must not be confused with.
    const turn = (total) =>
      JSON.stringify({
        type: 'assistant',
        cwd,
        version: '2.0.0',
        message: { usage: { cache_read_input_tokens: total, cache_creation_input_tokens: 0, input_tokens: 0 } },
      })
    write(transcript, `${name}/session.jsonl`, [turn(prefix + 250_000), turn(prefix)].join('\n'))
  }

  const config = join(base, 'config.json')
  write(base, 'config.json', JSON.stringify({ mcpServers: { everywhere: {} }, projects: project }))

  return { transcript, config }
}

const TIGHT =
  '---\nname: tight\ndescription: Split a doc into an index plus entries. Use when a doc exceeds the window. Skip for code.\n---\n\n# Tight\n\nDo the thing.\n'

function write(base, rel, content) {
  const path = join(base, rel)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}
