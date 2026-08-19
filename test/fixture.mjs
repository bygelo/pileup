// Fixtures are generated, not committed.
//
// A 600 KB decisions log checked into a repo whose whole point is "stop
// committing 600 KB decisions logs" would be a poor look. These are written to
// a temp dir at test time and thrown away with it.

import { execFileSync } from 'node:child_process'
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
  // Only ever reached for as `/slashed`, never as a Skill tool call. Counting one
  // channel and not the other reported a skill in daily use as never fired.
  skill(root, 'slashed', 'Rotate the signing certificate and restart the edge nodes.')
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
  write(
    transcript,
    'proj/session.jsonl',
    [
      turn('used'),
      turn('used'),
      turn('used'),
      // The other channel a definition fires through. `/slashed extra args` is
      // included deliberately: a pattern that stops at the closing tag only would
      // miss every invocation carrying arguments.
      JSON.stringify({ type: 'user', message: { content: '<command-name>/slashed</command-name>' } }),
      JSON.stringify({ type: 'user', message: { content: '<command-name>/slashed do the thing</command-name>' } }),
    ].join('\n'),
  )

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

  // `home` and `env` are pinned so the deferred-loading cohort split reads the
  // fixture and not the developer's own ~/.claude/settings.json. A test whose
  // result depends on the machine running it is not a test.
  return { transcript, config, home: base, env: {} }
}

/**
 * The same machine, but half its repos declare deferred tool loading.
 *
 * The confound this exists to catch: `defer*` repos have small prefixes because
 * their schemas load on demand, not because of which servers they declare.
 * Contrasting across that line prices the setting and blames a server.
 */
export function mcpDeferMachine() {
  const base = mkdtempSync(join(tmpdir(), 'pileup-defer-'))
  const transcript = join(base, 'projects')
  const repoBase = join(base, 'repo')

  // `off*` repos switch deferral OFF explicitly, because unset is the ON default
  // -- so an unset repo belongs to the deferring cohort, not the other one.
  const repo = [
    ...['off1', 'off2', 'off3', 'off4'].map((n) => [n, ['heavy'], 120_000, false]),
    ...['off5', 'off6'].map((n) => [n, [], 40_000, false]),
    ...['on1', 'on2', 'on3'].map((n) => [n, ['heavy'], 38_000, true]),
  ]

  const project = {}
  for (const [name, server, prefix, defer] of repo) {
    const cwd = join(repoBase, name)
    write(cwd, '.mcp.json', JSON.stringify({ mcpServers: Object.fromEntries(server.map((s) => [s, {}])) }))
    if (!defer)
      write(join(cwd, '.claude'), 'settings.json', JSON.stringify({ env: { ENABLE_TOOL_SEARCH: 'false' } }))
    project[cwd] = {}

    const turn = (total) =>
      JSON.stringify({
        type: 'assistant',
        cwd,
        version: '2.1.219',
        message: { usage: { cache_read_input_tokens: total, cache_creation_input_tokens: 0, input_tokens: 0 } },
      })
    write(transcript, `${name}/session.jsonl`, [turn(prefix + 250_000), turn(prefix)].join('\n'))
  }

  write(base, 'config.json', JSON.stringify({ mcpServers: {}, projects: project }))
  return { transcript, config: join(base, 'config.json'), home: base, env: {} }
}

/**
 * One repo whose sessions open at wildly different sizes.
 *
 * `small` opens at 12k -- system prompt, tools, memory, nothing else. `paste`
 * opens at 500k because the first message carried an attached dump. A median of
 * the two calls the always-on prefix ~256k and then blames MCP tool schemas for
 * the difference against disk. On a real repo that produced a 483k CRITICAL
 * prefix and a 475k CRITICAL "not on disk" gap where the true floor was 13k.
 */
export function bimodalSession() {
  const base = mkdtempSync(join(tmpdir(), 'pileup-bimodal-'))
  const cwd = join(base, 'repo')
  const projects = join(base, 'projects')
  write(cwd, 'CLAUDE.md', `# repo\n\n${'Build with npm run build. '.repeat(200)}`)

  const turn = (total) =>
    JSON.stringify({
      type: 'assistant',
      cwd,
      message: {
        model: 'claude-opus-5',
        usage: { cache_read_input_tokens: total, cache_creation_input_tokens: 0, input_tokens: 0 },
      },
    })

  const slug = cwd.replace(/[^a-zA-Z0-9]/g, '-')
  // Opening turn first, then a larger one: the opening is the smallest.
  write(projects, `${slug}/small.jsonl`, [turn(12_000), turn(90_000)].join('\n'))
  write(projects, `${slug}/paste.jsonl`, [turn(500_000), turn(560_000)].join('\n'))

  return { cwd, home: base, claudeDir: projects }
}

/**
 * A real git repo with a committed doc, an untracked one, and an ignored one.
 *
 * The case this exists for: pileup tells you to split a huge memory file into a
 * doc, you do, and the new doc is invisible to the next audit because it has not
 * been committed. A file an agent can plainly open, created by following pileup's
 * own advice, that pileup could not see. Ignored files stay out, which is the
 * reason the git index was trusted in the first place.
 */
export function gitRepo() {
  const root = mkdtempSync(join(tmpdir(), 'pileup-git-'))
  const big = (label) => `# ${label}\n\n${`Line of ${label} prose that costs real tokens. `.repeat(2000)}`

  write(root, '.gitignore', 'ignored/\n')
  write(root, 'CLAUDE.md', '# CLAUDE\n\nSee [committed](docs/committed.md).\n')
  write(root, 'docs/committed.md', big('committed'))
  write(root, 'docs/untracked.md', big('untracked'))
  write(root, 'ignored/generated.md', big('ignored'))

  const git = (...a) =>
    execFileSync('git', a, { cwd: root, stdio: 'ignore', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } })
  git('init', '-q')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'test')
  git('add', 'CLAUDE.md', 'docs/committed.md', '.gitignore')
  git('commit', '-qm', 'first')

  return { root }
}

/**
 * A machine with several repos, so a document's cost can be spread across them.
 *
 * Shaped around the two traps in a fleet ranking. `wide` is one user-global
 * skill copied into three discovery roots -- one document, not three. `busy` has
 * 100 measured turns and `quiet` has 2, so ranking by size and ranking by
 * size x frequency give different answers, which is the whole point.
 */
export function fleetMachine() {
  const base = mkdtempSync(join(tmpdir(), 'pileup-fleet-'))
  const home = join(base, 'home')
  const work = join(base, 'work')
  const transcript = join(home, '.claude', 'projects')

  const skill = (dir, name, description) =>
    write(dir, `${name}/SKILL.md`, `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\nbody\n`)

  // One user-global skill, installed into all three roots an installer writes to.
  for (const root of ['.claude/skills', '.codex/skills', '.agents/skills'])
    skill(join(home, root), 'wide', 'A promoted skill that every repo on the machine can see and pay for.')
  // A second that has never fired.
  skill(join(home, '.claude', 'skills'), 'ghost', 'Never chosen by anything, in any repo, ever.')

  const repo = [
    ['busy', 100],
    ['quiet', 2],
    ['idle', 0],
  ]

  // A slash command with no `name:` frontmatter, so its name comes from the
  // filename. It must arrive as `runme`, not `runme.md`, or invocation counting
  // can never match what a transcript records.
  write(
    join(home, '.claude', 'commands'),
    'runme.md',
    '---\ndescription: Run the thing that needs running, then report what it did.\n---\n\n# Run me\n',
  )

  for (const [name, turn] of repo) {
    const cwd = join(work, name)
    mkdirSync(join(cwd, '.git'), { recursive: true })
    // Two parallel memory files, ~identical, one per harness. You pay the larger
    // and never both -- the fleet total must not sum them.
    write(cwd, 'CLAUDE.md', `# ${name}\n\n${'Build with npm run build and keep naming singular. '.repeat(500)}`)
    write(cwd, 'AGENTS.md', `# ${name}\n\n${'Build with npm run build and keep naming singular. '.repeat(460)}`)
    // The same repo-local skill in two discovery roots: still one document.
    for (const root of ['.claude/skills', '.agents/skills'])
      skill(join(cwd, root), 'local', 'A repo-local skill installed into two discovery roots at once.')

    if (!turn) continue
    const line = []
    for (let i = 0; i < turn; i++)
      line.push(
        JSON.stringify({
          type: 'assistant',
          cwd,
          message: {
            model: 'claude-opus-5',
            usage: { cache_read_input_tokens: 20_000, cache_creation_input_tokens: 0, input_tokens: 0 },
            content: i === 0 ? [{ type: 'tool_use', name: 'Skill', input: { skill: 'wide' } }] : [],
          },
        }),
      )
    // A slash command invocation, which is how a command's firing is observable
    // at all -- it never appears as a `Skill` tool call.
    line.push(JSON.stringify({ type: 'user', cwd, message: { content: '<command-name>/runme</command-name>' } }))
    // Claude partitions transcripts by an encoded repo path.
    write(transcript, `${cwd.replace(/[^a-zA-Z0-9]/g, '-')}/session.jsonl`, line.join('\n'))
  }

  return { home, work, transcript }
}

/**
 * A Codex rollout transcript for one repo.
 *
 * Deliberately encodes the trap: `input_tokens` is the WHOLE prompt and
 * `cached_input_tokens` is a subset of it, unlike Claude where the two are
 * disjoint. A reader that adds them reports more cache than there was prompt.
 * Also logs each compaction twice, exactly as Codex does.
 */
export function codexMachine() {
  const base = mkdtempSync(join(tmpdir(), 'pileup-codex-'))
  const cwd = join(base, 'repo')
  const sessions = join(base, 'sessions')
  write(cwd, 'AGENTS.md', '# AGENTS\n\nBuild: npm run build.\n')

  const line = []
  line.push(JSON.stringify({ type: 'session_meta', payload: { cwd, model: 'gpt-x' } }))

  const turn = (prompt, cached) =>
    JSON.stringify({
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          last_token_usage: {
            input_tokens: prompt,
            cached_input_tokens: cached,
            cache_write_input_tokens: 0,
            output_tokens: 500,
            reasoning_output_tokens: 200,
          },
          model_context_window: 258_400,
        },
        rate_limits: { primary: { used_percent: 94, window_minutes: 10_080 }, plan_type: 'pro' },
      },
    })

  line.push(turn(20_000, 12_000)) // opening turn -> the prefix
  line.push(turn(60_000, 55_000)) // later, larger turn

  // One compaction, logged as both a record and an event.
  line.push(JSON.stringify({ type: 'compacted', payload: { message: '' } }))
  line.push(JSON.stringify({ type: 'event_msg', payload: { type: 'context_compacted' } }))

  write(sessions, '2026/07/26/rollout-2026-07-26T20-22-01-019f9e60-06f1-7f01-b164-fe5e7025dd47.jsonl',
    line.join('\n'))

  return { cwd, home: base, codexDir: sessions }
}

const TIGHT =
  '---\nname: tight\ndescription: Split a doc into an index plus entries. Use when a doc exceeds the window. Skip for code.\n---\n\n# Tight\n\nDo the thing.\n'

function write(base, rel, content) {
  const path = join(base, rel)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

/**
 * A repo whose `--json` report is comfortably larger than a 64 KB pipe buffer.
 *
 * It exists for one regression: the CLI used to `process.exit(0)` immediately
 * after writing, which truncated piped output at exactly 65,536 bytes. Nothing
 * smaller than the buffer can catch that, so the fixture's only real property
 * is its size.
 */
export function bigReportRepo(count = 400) {
  const root = mkdtempSync(join(tmpdir(), 'pileup-big-'))
  write(root, 'CLAUDE.md', '# CLAUDE.md\n\nSmall on purpose. The skills are the bulk.\n')
  for (let i = 0; i < count; i++) {
    const name = `skill-${String(i).padStart(3, '0')}`
    write(root, `.claude/skills/${name}/SKILL.md`,
      `---\nname: ${name}\ndescription: Does the ${name} thing, and describes it at enough length that the report has something to carry.\n---\n\n# ${name}\n\nbody\n`)
  }
  return root
}
