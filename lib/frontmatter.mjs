// Minimal YAML frontmatter reader.
//
// Skill and agent files only ever use flat scalar keys plus the occasional
// block scalar, so a real YAML parser would be a dependency bought for nothing.
// Anything it cannot parse comes back as raw text rather than throwing.

const FENCE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/

export function splitFrontmatter(text) {
  const m = text.match(FENCE)
  if (!m) return { meta: {}, body: text, raw: '' }
  return { meta: parseFlatYaml(m[1]), body: text.slice(m[0].length), raw: m[1] }
}

function parseFlatYaml(raw) {
  const meta = {}
  const line = raw.split(/\r?\n/)
  let key = null
  let buffer = []

  const flush = () => {
    if (key) meta[key] = buffer.join('\n').trim()
    key = null
    buffer = []
  }

  for (const l of line) {
    const head = l.match(/^([A-Za-z_][\w-]*):\s?(.*)$/)
    if (head && !/^\s/.test(l)) {
      flush()
      key = head[1]
      const value = head[2].trim()
      // `key: >-` / `key: |` open a block scalar; the value is on later lines.
      buffer = value === '' || value === '>' || value === '|' || value === '>-' || value === '|-'
        ? []
        : [stripQuote(value)]
      continue
    }
    if (key) buffer.push(l.trim())
  }
  flush()
  return meta
}

function stripQuote(v) {
  if (v.length > 1 && ((v[0] === '"' && v.at(-1) === '"') || (v[0] === "'" && v.at(-1) === "'")))
    return v.slice(1, -1)
  return v
}
