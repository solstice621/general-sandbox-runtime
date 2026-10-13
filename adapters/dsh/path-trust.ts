import { statSync, realpathSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, relative, sep, basename, join } from 'node:path'

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

/** Protect a complete DSH source checkout or an enclosing npm dependency tree. */
export function dshInstallationRoot(packageDirectory: string): string {
  let current = realpathSync(packageDirectory)
  let monorepo: string | undefined, nodeModules: string | undefined
  for (;;) {
    if (basename(current) === 'node_modules') nodeModules = current
    try {
      const metadata: unknown = JSON.parse(readFileSync(join(current, 'package.json'), 'utf8'))
      if (typeof metadata === 'object' && metadata !== null && 'name' in metadata && metadata.name === '@deepseek-ai/dsh-root') monorepo = current
    } catch (error: unknown) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error
    }
    const next = dirname(current)
    if (next === current) break
    current = next
  }
  const root = monorepo ?? nodeModules
  if (!root) throw new Error('cannot identify an enclosing DSH monorepo or node_modules installation; unsupported deployment layout')
  return root
}
