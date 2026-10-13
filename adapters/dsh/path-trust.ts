import { realpathSync, readFileSync } from 'node:fs'
import { dirname, basename, join } from 'node:path'
export { pathContains, pathsOverlap } from '../../src/path-trust.js'

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
