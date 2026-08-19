// Deferred tool loading -- the setting that invalidates pileup's oldest premise.
//
// pileup shipped saying, flatly, that every connected MCP server's tool schemas
// ride the always-on prefix on every turn. That was true when it was written and
// is now conditional. Anthropic's Tool Search Tool hands the model tool NAMES and
// loads a full JSON Schema only when it reaches for one -- reportedly ~85% fewer
// tool-definition tokens, and better tool selection at scale rather than worse.
//
// THE DEFAULT IS ON, AND ASSUMING OTHERWISE IS A FALSE POSITIVE.
//
// SOURCE: the mode table below is decompiled from the shipped Claude Code binary
// (version 2.1.220, read 2026-07-30) -- its own mode resolver, not a third-party
// writeup. The token/accuracy figures quoted in the findings are vendor numbers;
// see lib/collector/mcp.mjs. Both are harness facts: docs/harness-fact.md.
//
// The first version of this module treated a missing `ENABLE_TOOL_SEARCH` as
// "off" and produced a HIGH finding telling the user to turn on something already
// running. The semantics below are instead read out of the shipped Claude Code
// binary (2.1.220, read 2026-07-30), whose mode resolver is:
//
//   auto:0        -> tst        tool search on, defer everything
//   auto:100      -> standard   off
//   auto | auto:N -> tst-auto   on, defers past a threshold of N tools
//   true | 1      -> tst        on
//   false | 0     -> standard   off
//   UNSET         -> tst        ON. This is the default.
//
// Two host checks can still disable it at runtime regardless of the setting: a
// non-first-party `ANTHROPIC_BASE_URL`, and Vertex AI, which does not accept the
// tool-search beta header. Both are invisible to a file scan, which is the whole
// reason `state` below can be 'default' rather than a confident boolean -- and why
// the only real confirmation is a measured prefix.

import { homedir } from 'node:os'
import { join } from 'node:path'
import { readText, safeStat } from './fs.mjs'

const KEY = 'ENABLE_TOOL_SEARCH'

const FALSEY = new Set(['0', 'false', 'off', 'no'])
const TRUTHY = new Set(['1', 'true', 'on', 'yes'])

/**
 * @typedef {object} ToolSearchState
 * @property {'on'|'off'|'default'} state  declared on, declared off, or nothing said
 * @property {boolean} deferring   whether schemas are expected OUT of the prefix
 * @property {string|null} value   raw declared value, for the report
 * @property {string|null} source  where it was declared
 * @property {string|null} mode    the harness's own mode name for this value
 */

/** Read the declared deferred-loading state from a set of settings file paths. */
export function toolSearchOf(path, opt = {}) {
  for (const p of path) {
    const found = fromFile(p)
    if (found) return found
  }
  const env = (opt.env ?? process.env)[KEY]
  if (env != null) return classify(env, 'environment')

  // Nothing said, so the harness default applies -- which is ON. Reported as
  // `default` rather than `on` because pileup did not see it declared and cannot
  // see the runtime host checks that may still disable it.
  return { state: 'default', deferring: true, value: null, source: null, mode: 'tst' }
}

/**
 * Settings files that could carry the setting for a repo, most specific last.
 *
 * `opt.user === false` drops the user-global file, matching `--no-user`: a run
 * that is deliberately ignoring the machine-wide surface should not quietly read
 * a machine-wide setting out of it either.
 */
export function settingPath(root, opt = {}) {
  const home = opt.home ?? homedir()
  return [
    ...(opt.user === false ? [] : [join(home, '.claude', 'settings.json')]),
    ...(root ? [join(root, '.claude', 'settings.json'), join(root, '.claude', 'settings.local.json')] : []),
  ].filter((p) => safeStat(p)?.isFile())
}

function fromFile(path) {
  const text = readText(path)
  if (text == null) return null
  let json
  try {
    json = JSON.parse(text)
  } catch {
    return null
  }
  // Claude Code accepts env-style settings both at the top level and under an
  // `env` block; check both rather than betting on one.
  const raw = json?.env?.[KEY] ?? json?.[KEY]
  if (raw == null) return null
  return classify(raw, path)
}

/** Mirror of the harness's own mode resolver. See the header for provenance. */
function classify(raw, source) {
  const value = String(raw).trim()
  const lower = value.toLowerCase()

  const auto = lower.startsWith('auto:') ? Number(lower.slice(5)) : null
  const mode =
    auto === 0
      ? 'tst'
      : auto === 100
        ? 'standard'
        : lower === 'auto' || (auto != null && Number.isFinite(auto))
          ? 'tst-auto'
          : TRUTHY.has(lower)
            ? 'tst'
            : FALSEY.has(lower)
              ? 'standard'
              : // An unparseable value: the harness logs "Invalid ENABLE_TOOL_SEARCH
                // value" and falls through to the default, so pileup does too.
                'tst'

  const deferring = mode !== 'standard'
  return { state: deferring ? 'on' : 'off', deferring, value, source, mode }
}
