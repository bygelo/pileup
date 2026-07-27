// Just enough filesystem to walk a repo with zero dependencies.

import { closeSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs'
import { join, sep } from 'node:path'

const IGNORE = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', 'target', 'vendor',
  '.next', '.nuxt', '.venv', 'venv', '__pycache__', '.cache', 'coverage',
])

export function safeStat(path) {
  try {
    return statSync(path)
  } catch {
    return null
  }
}

export function readText(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

/** First `bytes` of a file, for sampling something too big to hold in memory. */
export function readHead(path, bytes) {
  let fd
  try {
    fd = openSync(path, 'r')
    const buf = Buffer.alloc(bytes)
    const read = readSync(fd, buf, 0, bytes, 0)
    return buf.subarray(0, read).toString('utf8')
  } catch {
    return null
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

function entryOf(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

/**
 * Expand a slash-separated pattern under `root`. Supports `*` (one segment)
 * and `**` (any depth). Returns absolute paths of existing files.
 *
 * Deliberately not a full glob: pileup only ever asks for shapes like
 * `.claude/skills/*​/SKILL.md`, and a real glob library is a dependency.
 */
export function expandPattern(root, pattern) {
  const segment = pattern.split('/').filter(Boolean)
  const hit = []
  walk(root, 0)
  return hit

  function walk(dir, i) {
    if (i === segment.length) {
      const st = safeStat(dir)
      if (st?.isFile()) hit.push(dir)
      return
    }
    const part = segment[i]

    if (part === '**') {
      walk(dir, i + 1)
      for (const e of entryOf(dir)) {
        if (!e.isDirectory() || IGNORE.has(e.name)) continue
        walk(join(dir, e.name), i)
      }
      return
    }

    if (part.includes('*')) {
      const re = globToRegExp(part)
      for (const e of entryOf(dir)) {
        if (IGNORE.has(e.name) || !re.test(e.name)) continue
        walk(join(dir, e.name), i + 1)
      }
      return
    }

    walk(join(dir, part), i + 1)
  }
}

function globToRegExp(part) {
  const body = part.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/\\\\]*')
  return new RegExp(`^${body}$`, 'i')
}

/** Every file under `dir` matching `test`, skipping the usual junk. */
export function walkFile(dir, test, depth = 12) {
  const hit = []
  const stack = [[dir, 0]]
  while (stack.length) {
    const [cur, d] = stack.pop()
    if (d > depth) continue
    for (const e of entryOf(cur)) {
      if (IGNORE.has(e.name)) continue
      const path = join(cur, e.name)
      if (e.isDirectory()) stack.push([path, d + 1])
      else if (test(e.name, path)) hit.push(path)
    }
  }
  return hit
}

/** Repo-relative, forward-slashed, for stable reporting across platforms. */
export function relative(root, path) {
  const rel = path.startsWith(root) ? path.slice(root.length) : path
  return rel.replace(/^[\\/]+/, '').split(sep).join('/')
}
