// MCP servers.
//
// The quiet one. Nothing in a repo shows you this cost: every connected
// server's tool schemas -- name, description and full JSON Schema for every
// tool -- sit in the always-on prefix. A browser-automation server alone can
// carry thirty tools. pileup cannot read those schemas without launching the
// servers, so it reports the count honestly and points at `pileup session`,
// which measures the real prefix from what the API actually billed.

import { artifactOf } from '../adapter.mjs'
import { MCP_SERVER_COUNT } from '../budget.mjs'
import { gradeBy, mkFinding } from '../finding.mjs'
import { readText } from '../fs.mjs'

export const id = 'mcp'

export function collect(ctx) {
  const finding = []
  const server = []

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
    if (severity) {
      finding.push(
        mkFinding({
          id: 'mcp-server-count',
          severity,
          surface: 'always-on',
          title: `${server.length} MCP servers configured`,
          why:
            'Every connected server contributes its full tool schemas to the always-on prefix, on every turn, ' +
            'whether or not the session ever calls one. pileup cannot size those schemas without starting the ' +
            'servers -- run `pileup session` to see what the prefix actually cost.',
          fix:
            'Keep servers you use most sessions. Move the rest behind a per-project config so they load only where ' +
            'they are needed. Harnesses that support deferred or on-demand tool schemas should have it turned on.',
          data: {
            token: null,
            count: server.length,
            server: server.map((s) => s.name),
          },
        }),
      )
    }
  }

  return { finding, surface: server }
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
