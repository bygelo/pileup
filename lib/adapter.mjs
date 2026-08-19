// Harness adapters.
//
// The only thing that differs between Claude Code, Codex, Cursor and Copilot is
// WHERE they keep their files. Every analysis downstream of this module is
// shared. Adding a harness means adding a row to the table below -- nothing
// else in pileup should ever need to know a harness name.

import { homedir } from 'node:os'
import { expandPattern, relative, safeStat } from './fs.mjs'

/**
 * kind:
 *   memory   instruction file injected on every turn
 *   skill    progressive-disclosure skill (frontmatter always-on, body on-invoke)
 *   agent    subagent definition
 *   command  slash command
 *   mcp      MCP server config; every server's tool schemas ride every turn
 *   setting  harness config, read for hooks and other prefix churn
 */
export const HARNESS = [
  {
    id: 'claude',
    name: 'Claude Code',
    marker: ['CLAUDE.md', '.claude'],
    repo: {
      memory: ['CLAUDE.md', '.claude/CLAUDE.md', 'CLAUDE.local.md'],
      skill: ['.claude/skills/*/SKILL.md'],
      agent: ['.claude/agents/**/*.md'],
      command: ['.claude/commands/**/*.md'],
      mcp: ['.mcp.json'],
      setting: ['.claude/settings.json', '.claude/settings.local.json'],
    },
    user: {
      memory: ['.claude/CLAUDE.md'],
      skill: ['.claude/skills/*/SKILL.md'],
      agent: ['.claude/agents/**/*.md'],
      command: ['.claude/commands/**/*.md'],
      setting: ['.claude/settings.json'],
      // machine-wide MCP servers live here, and they ride every repo
      mcp: ['.claude.json'],
    },
  },
  {
    id: 'codex',
    name: 'Codex',
    marker: ['AGENTS.md', '.codex', '.agents'],
    repo: {
      memory: ['AGENTS.md', '.codex/AGENTS.md'],
      skill: ['.codex/skills/*/SKILL.md', '.agents/skills/*/SKILL.md'],
      setting: ['.codex/config.toml'],
      mcp: ['.codex/config.toml'],
    },
    user: {
      memory: ['.codex/AGENTS.md'],
      skill: ['.codex/skills/*/SKILL.md', '.agents/skills/*/SKILL.md'],
      agent: ['.codex/agents/*.toml'],
      setting: ['.codex/config.toml'],
      mcp: ['.codex/config.toml'],
    },
  },
  {
    id: 'cursor',
    name: 'Cursor',
    marker: ['.cursorrules', '.cursor'],
    repo: {
      memory: ['.cursorrules', '.cursor/rules/**/*.mdc', '.cursor/rules/**/*.md'],
      command: ['.cursor/commands/**/*.md'],
      mcp: ['.cursor/mcp.json'],
    },
    user: {
      mcp: ['.cursor/mcp.json'],
    },
  },
  {
    id: 'copilot',
    name: 'GitHub Copilot',
    marker: ['.github/copilot-instructions.md', '.github/instructions'],
    repo: {
      memory: ['.github/copilot-instructions.md', '.github/instructions/**/*.instructions.md'],
      agent: ['.github/agents/**/*.md'],
      command: ['.github/prompts/**/*.prompt.md'],
      mcp: ['.vscode/mcp.json'],
    },
    user: {},
  },
  {
    id: 'gemini',
    name: 'Gemini CLI',
    marker: ['GEMINI.md', '.gemini'],
    repo: {
      memory: ['GEMINI.md', '.gemini/GEMINI.md'],
      command: ['.gemini/commands/**/*.toml'],
      setting: ['.gemini/settings.json'],
      mcp: ['.gemini/settings.json'],
    },
    user: {
      memory: ['.gemini/GEMINI.md'],
      setting: ['.gemini/settings.json'],
    },
  },
  {
    id: 'windsurf',
    name: 'Windsurf',
    marker: ['.windsurfrules', '.windsurf'],
    repo: {
      memory: ['.windsurfrules', '.windsurf/rules/**/*.md'],
      command: ['.windsurf/workflows/**/*.md'],
    },
    user: {},
  },
  {
    id: 'aider',
    name: 'Aider',
    marker: ['CONVENTIONS.md', '.aider.conf.yml'],
    repo: {
      memory: ['CONVENTIONS.md'],
      setting: ['.aider.conf.yml'],
    },
    user: {},
  },
]

/**
 * Resolve every harness artifact present for a repo.
 *
 * @param {string} root       absolute repo path
 * @param {object} [opt]
 * @param {boolean} [opt.user=true]  also resolve the user-global surface, which
 *                                   is injected into every repo on the machine
 * @param {string[]} [opt.harness]   restrict to these harness ids
 *
 * Named `harness`, not `only`. It used to be `only`, which collided with
 * `audit`'s collector `--only` -- the same object is passed to both, so
 * `pileup --only memory` filtered the HARNESS list against collector names,
 * matched nothing, and reported a repo with no harness files at all.
 */
export function resolveHarness(root, opt = {}) {
  const includeUser = opt.user !== false
  const home = opt.home ?? homedir()
  const seen = new Set()

  const resolved = HARNESS.filter((h) => !opt.harness?.length || opt.harness.includes(h.id)).map((h) => {
    const artifact = []
    collect(h.repo, root, 'repo')
    if (includeUser) collect(h.user, home, 'user')

    return {
      id: h.id,
      name: h.name,
      // A harness counts as in use here only if the REPO says so. User-global
      // files alone prove nothing -- everyone has a stray ~/.gemini lying around,
      // and auditing it against an unrelated repo is exactly the kind of noise
      // pileup exists to remove.
      detected:
        h.marker.some((m) => safeStat(`${root}/${m}`)) || artifact.some((a) => a.scope === 'repo'),
      artifact,
    }

    function collect(group, base, scope) {
      for (const [kind, pattern] of Object.entries(group ?? {})) {
        for (const p of pattern) {
          for (const path of expandPattern(base, p)) {
            // AGENTS.md and friends are shared across harnesses; first one wins.
            const key = `${kind}:${path}`
            if (seen.has(key)) continue
            seen.add(key)
            artifact.push({ kind, scope, path, rel: relative(base, path) })
          }
        }
      }
    }
  })

  const detected = resolved.filter((h) => h.detected)
  if (detected.length) return detected

  // Nothing in the repo names a harness. Fall back to whatever is installed
  // machine-wide, so a bare repo still gets an honest always-on number.
  return resolved.filter((h) => h.artifact.length > 0)
}

/** Flatten resolved harnesses into one artifact list tagged with its harness. */
export function artifactOf(harness, kind) {
  return harness.flatMap((h) =>
    h.artifact.filter((a) => !kind || a.kind === kind).map((a) => ({ ...a, harness: h.id })),
  )
}
