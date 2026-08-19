// Git is the cheapest correct answer to "what is actually in this repo".
//
// Walking the tree by hand means reinventing .gitignore, and getting it wrong
// means auditing 34 MB of untracked exports nobody committed. When a repo is
// under git, pileup trusts the index; when it is not, it falls back to a walk.
//
// But "tracked" was too narrow, and the way it failed was embarrassing: pileup
// tells you to split a huge memory file into a doc, you do it, and the new doc is
// invisible to the next audit because it has not been committed yet. A 304 KB
// file an agent can absolutely open, produced by following pileup's own advice,
// and pileup could not see it.
//
// The right set is tracked PLUS untracked-but-not-ignored. That keeps the reason
// the index was trusted in the first place -- gitignored build output and exports
// stay out -- while including anything a human actually put in the repo. Note the
// asymmetry it accepts on purpose: a gitignored 300 MB log is still readable by
// an agent, but treating .gitignore as "not part of the repo" is the convention
// every other tool follows, and reinventing that judgement is not pileup's job.

import { execFileSync } from 'node:child_process'

const OPT = { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }

export function trackedFile(root) {
  const tracked = lsFiles(root, ['ls-files', '-z'])
  if (tracked === null) return null

  // `--others --exclude-standard` is untracked-and-not-ignored, exactly.
  const untracked = lsFiles(root, ['ls-files', '-z', '--others', '--exclude-standard']) ?? []
  const all = new Set([...tracked, ...untracked])
  return all.size ? all : null
}

function lsFiles(root, arg) {
  try {
    return execFileSync('git', arg, { cwd: root, ...OPT }).split('\0').filter(Boolean)
  } catch {
    return null
  }
}
