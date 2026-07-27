// Git is the cheapest correct answer to "what is actually in this repo".
//
// Walking the tree by hand means reinventing .gitignore, and getting it wrong
// means auditing 34 MB of untracked exports nobody committed. When a repo is
// under git, pileup trusts the index; when it is not, it falls back to a walk.

import { execFileSync } from 'node:child_process'

export function trackedFile(root) {
  try {
    const out = execFileSync('git', ['ls-files', '-z'], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const file = out.split('\0').filter(Boolean)
    return file.length ? new Set(file) : null
  } catch {
    return null
  }
}
