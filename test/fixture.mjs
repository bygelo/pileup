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

const TIGHT =
  '---\nname: tight\ndescription: Split a doc into an index plus entries. Use when a doc exceeds the window. Skip for code.\n---\n\n# Tight\n\nDo the thing.\n'

function write(base, rel, content) {
  const path = join(base, rel)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}
