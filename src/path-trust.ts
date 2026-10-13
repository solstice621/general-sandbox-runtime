import { statSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, relative, sep } from 'node:path'

/**
 * A canonical path string is not a filesystem identity: realpath on a
 * case-insensitive host may preserve the caller's spelling. Compare each
 * existing child ancestor's device/inode as well as literal containment.
 */
export function pathContains(parent: string, child: string): boolean {
  const tail = relative(parent, child)
  if (tail === '' || tail !== '..' && !tail.startsWith(`..${sep}`) && !isAbsolute(tail)) return true
  const anchor = statSync(parent, { bigint: true })
  let current = realpathSync(child)
  for (;;) {
    const candidate = statSync(current, { bigint: true })
    if (candidate.dev === anchor.dev && candidate.ino === anchor.ino) return true
    const next = dirname(current)
    if (next === current) return false
    current = next
  }
}

export function pathsOverlap(a: string, b: string): boolean { return pathContains(a, b) || pathContains(b, a) }
