// Prefix churn -- the cache half of the bill.
//
// Cached input bills at roughly a tenth of normal input. That discount applies
// to the longest UNCHANGED prefix of the request. Change one byte near the top
// and every token after it is re-billed at full price, on every turn for the
// rest of the session.
//
// So this collector does not care about size. It cares about volatility: what
// rewrites the front of the prompt while a session is running.

import { execFileSync } from 'node:child_process'
import { artifactOf } from '../adapter.mjs'
import { mkFinding } from '../finding.mjs'
import { readText } from '../fs.mjs'

// Hook events whose output is injected into the model's context.
const INJECTING_EVENT = new Set(['SessionStart', 'UserPromptSubmit', 'PreCompact'])

// A hook that writes one of these rewrites the always-on prefix underneath a
// running session.
const PREFIX_FILE = /CLAUDE\.md|AGENTS\.md|GEMINI\.md|\.cursorrules|copilot-instructions|settings\.json|\.mcp\.json/

export const id = 'prefix'

export function collect(ctx) {
  const finding = []
  const surface = []

  for (const a of artifactOf(ctx.harness, 'setting')) {
    const text = readText(a.path)
    if (text == null || !a.path.endsWith('.json')) continue
    let config
    try {
      config = JSON.parse(text)
    } catch {
      continue
    }

    for (const [event, matcher] of Object.entries(config.hooks ?? {})) {
      for (const cmd of commandOf(matcher)) {
        surface.push({ event, command: cmd, path: a.rel, scope: a.scope })

        if (PREFIX_FILE.test(cmd)) {
          finding.push(
            mkFinding({
              id: 'prefix-hook-rewrites-memory',
              severity: 'high',
              surface: 'cache',
              title: `${event} hook writes a file that is part of the always-on prefix`,
              why:
                'Rewriting a memory or config file mid-session invalidates the prompt cache from that point on. ' +
                'Every subsequent turn re-bills the entire prefix at full price.',
              fix:
                'Have the hook write somewhere the prefix does not include, and let the agent read it on demand. ' +
                'If the content really must be in context, write it once at SessionStart and never again.',
              data: { event, command: truncate(cmd), path: a.rel, scope: a.scope },
            }),
          )
        } else if (INJECTING_EVENT.has(event)) {
          finding.push(
            mkFinding({
              id: 'prefix-injecting-hook',
              severity: event === 'UserPromptSubmit' ? 'medium' : 'low',
              surface: 'cache',
              title: `${event} hook injects output into context`,
              why:
                event === 'UserPromptSubmit'
                  ? 'This runs on every prompt. Whatever it prints is added to context each turn, and if the output ' +
                    'varies (timestamps, git status, ticket state) it is unstable context the model must re-read.'
                  : 'Runs once per session. Cheap, but its output is unbounded -- a chatty script can add thousands of tokens.',
              fix:
                'Keep the output short, stable and deterministic. Prefer emitting a pointer ("branch is X, see Y") ' +
                'over dumping the content itself.',
              data: { event, command: truncate(cmd), path: a.rel, scope: a.scope },
            }),
          )
        }
      }
    }
  }

  for (const churn of memoryChurn(ctx)) {
    if (churn.commit < 15) continue
    finding.push(
      mkFinding({
        id: 'prefix-volatile-memory',
        severity: churn.commit >= 40 ? 'medium' : 'low',
        surface: 'cache',
        title: `${churn.rel} changed ${churn.commit} times in the last 90 days`,
        why:
          'A memory file that is edited constantly is a prefix that is constantly invalidated. It also suggests ' +
          'the file is being used as a running log rather than as stable instructions.',
        fix:
          'Split it: stable instructions stay in the memory file and rarely change; the running state moves to a ' +
          'doc the agent reads on demand.',
        data: { path: churn.rel, commit: churn.commit },
      }),
    )
  }

  return { finding, surface }
}

function commandOf(matcher) {
  const out = []
  for (const m of Array.isArray(matcher) ? matcher : [matcher]) {
    for (const h of m?.hooks ?? []) if (h?.command) out.push(h.command)
    if (typeof m === 'string') out.push(m)
  }
  return out
}

function memoryChurn(ctx) {
  const out = []
  for (const a of artifactOf(ctx.harness, 'memory')) {
    if (a.scope !== 'repo') continue
    try {
      const log = execFileSync(
        'git',
        ['log', '--since=90.days', '--format=%h', '--', a.rel],
        { cwd: ctx.root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
      )
      out.push({ rel: a.rel, commit: log.split('\n').filter(Boolean).length })
    } catch {
      // no git, or the file is untracked -- nothing to say
    }
  }
  return out
}

function truncate(s, n = 120) {
  return s.length > n ? `${s.slice(0, n)}...` : s
}
