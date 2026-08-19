// MCP servers.
//
// The quiet one. Nothing in a repo shows you this cost: every connected
// server's tool schemas -- name, description and full JSON Schema for every
// tool -- sit in the always-on prefix. A browser-automation server alone can
// carry thirty tools. pileup cannot read those schemas without launching the
// servers, so it reports the count honestly and points at `pileup session`,
// which measures the real prefix from what the API actually billed.
//
// That paragraph is now CONDITIONAL, and the condition defaults the other way.
// Deferred tool loading moves those schemas out of the prefix and loads them on
// demand, and in current Claude Code it is ON unless something switched it off.
// An earlier version of this collector assumed an unset `ENABLE_TOOL_SEARCH`
// meant off, and produced a HIGH finding telling the user to enable something
// already running. See lib/toolsearch.mjs for the mode table, read out of the
// shipped binary rather than inferred.

// SOURCE: the numbers quoted in the findings below, all read 2026-07-30 --
//   ~85% fewer tool-definition tokens, and Opus 4.5 tool selection 79.5% -> 88.1%
//   with search enabled -- Anthropic, "Introducing advanced tool use on the Claude
//   Developer Platform". Third-party/vendor figures, not measured by pileup.
// The mode table itself is read out of the shipped binary; see lib/toolsearch.mjs.

import { artifactOf } from '../adapter.mjs'
import { MCP_SERVER_COUNT } from '../budget.mjs'
import { SEVERITY, gradeBy, mkFinding } from '../finding.mjs'
import { readText } from '../fs.mjs'
import { settingPath, toolSearchOf } from '../toolsearch.mjs'

export const id = 'mcp'

export function collect(ctx) {
  const finding = []
  const server = []
  const toolSearch = toolSearchOf(
    settingPath(ctx.root, { home: ctx.home, user: ctx.user }),
    { env: ctx.env },
  )

  for (const a of artifactOf(ctx.harness, 'mcp')) {
    const text = readText(a.path)
    if (text == null) continue
    for (const name of parseServer(a.path, text)) {
      if (server.some((s) => s.name === name)) continue
      server.push({ name, path: a.rel, scope: a.scope, harness: a.harness })
    }
  }

  if (server.length) {
    const severity = gradeBy(server.length, MCP_SERVER_COUNT)

    // Deferred loading is ON unless something turned it off, so the schemas are
    // probably NOT in the prefix. Grading a server count as always-on cost would
    // assert a cost pileup has reason to believe is not paid.
    if (toolSearch.deferring) {
      finding.push(
        mkFinding({
          id: 'mcp-deferred',
          severity: 'info',
          surface: 'always-on',
          title: `${server.length} MCP servers configured, with tool schemas expected to load on demand`,
          why:
            (toolSearch.state === 'default'
              ? `${KEY_LABEL} is not set, and unset is the ON default in current Claude Code (mode \`tst\`) -- ` +
                'not off. '
              : `${KEY_LABEL} is \`${toolSearch.value}\`${toolSearch.source ? ` in ${short(toolSearch.source)}` : ''} ` +
                `(mode \`${toolSearch.mode}\`). `) +
            'The model is given tool names and loads a full schema only when it reaches for one, so these servers ' +
            'likely cost far less than their count suggests. Two runtime checks can still disable it invisibly: a ' +
            'non-first-party ANTHROPIC_BASE_URL, and Vertex AI, which rejects the tool-search beta header.',
          fix:
            'Confirm rather than trust, since neither the setting nor the default proves the effect: run ' +
            '`pileup session` and compare the measured prefix against what this many servers would cost loaded. ' +
            'A prefix in the tens of thousands with this many servers means deferral is working.',
          data: {
            token: null,
            count: server.length,
            server: server.map((s) => s.name),
            toolSearch,
          },
        }),
      )
    } else {
      // Explicitly turned off. Now the original premise holds again.
      finding.push(
        mkFinding({
          id: 'mcp-defer-disabled',
          severity: server.length >= 5 ? 'high' : 'medium',
          surface: 'always-on',
          title: `deferred tool loading is switched off, so ${server.length} servers' schemas ride every turn`,
          why:
            `${KEY_LABEL} is \`${toolSearch.value}\`${toolSearch.source ? ` in ${short(toolSearch.source)}` : ''}, ` +
            `which resolves to mode \`${toolSearch.mode}\` -- every server's full JSON Schema is loaded up front, on ` +
            'every turn, whether or not the session calls one. Deferring instead is reported to cut tool-definition ' +
            'tokens by about 85%, and it IMPROVES tool selection at this scale: published evaluations put Opus 4.5 at ' +
            '79.5% correct tool choice with every schema loaded and 88.1% with search. There is no accuracy argument ' +
            'for this setting.',
          fix:
            `Remove ${KEY_LABEL} to fall back to the default, which is on, or set it to \`auto\` to defer past a ` +
            'threshold. Then run `pileup session` before and after and compare the measured prefix.',
          data: {
            token: null,
            count: server.length,
            server: server.map((s) => s.name),
            toolSearch,
          },
        }),
      )
    }

    // Scope is a separate problem from the setting, and survives it: a model
    // still has to choose among these, and published evaluations show selection
    // degrading past roughly 30-50 tools however the schemas are loaded.
    //
    // It steps down ONLY when `mcp-defer-disabled` is also shouting, so the
    // report leads with the cheaper fix. When deferral is working this is the
    // only real finding here and downgrading it would bury the one thing left
    // worth acting on.
    if (severity) {
      finding.push(
        mkFinding({
          id: 'mcp-server-count',
          severity: toolSearch.deferring ? severity : step(severity),
          surface: 'always-on',
          title: `${server.length} MCP servers configured in one repo`,
          why:
            'Even with schemas loaded on demand, every server contributes a name and a description the model reads ' +
            'while deciding what to reach for, and past roughly 30-50 tools published evaluations show tool selection ' +
            'itself degrading. This is an accuracy cost rather than only a token one.',
          fix:
            'Keep the servers you use in most sessions here and move the rest behind a per-project config, so they ' +
            'load only where they are needed.',
          data: {
            token: null,
            count: server.length,
            server: server.map((s) => s.name),
            toolSearch,
          },
        }),
      )
    }
  }

  return { finding, surface: server, meta: { toolSearch } }
}

const KEY_LABEL = 'ENABLE_TOOL_SEARCH'

/** One step less severe, so two overlapping findings do not both shout. */
function step(severity) {
  const i = SEVERITY.indexOf(severity)
  return SEVERITY[Math.max(i - 1, 1)]
}

function short(path) {
  return path === 'environment' ? 'the environment' : path.split(/[\\/]/).slice(-2).join('/')
}

function parseServer(path, text) {
  if (path.endsWith('.toml')) {
    // Codex: [mcp_servers.NAME]
    return [...text.matchAll(/^\s*\[mcp_servers\.([^\]\.]+)\]/gm)].map((m) => m[1])
  }
  try {
    const json = JSON.parse(text)
    const bag = json.mcpServers ?? json.servers ?? json.mcp?.servers ?? {}
    return Object.keys(bag)
  } catch {
    return []
  }
}
