import { chmodSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

// Executed from dist/scripts by npm's install lifecycle, after files are copied.
const root = realpathSync(fileURLToPath(new URL('../../', import.meta.url)))
const node = realpathSync(process.execPath)
const [major, minor] = process.versions.node.split('.').map(Number)
if (major < 24 || major === 24 && minor < 19) throw new Error('Node >=24.19.0 is required')
const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`
const runner = join(root, 'bin/sandbox-runner')
for (const [template, target, marker, value] of [
  ['launcher.sh', runner, '__NODE__', node],
  ['opencode-shell.sh', join(root, 'bin/opencode/bash'), '__RUNNER__', runner],
]) {
  const source = readFileSync(join(root, 'scripts', template), 'utf8')
  if (source.split(`exec ${marker}`).length !== 2) throw new Error(`invalid launcher template: ${template}`)
  mkdirSync(join(target, '..'), { recursive: true })
  writeFileSync(target, source.replace(`exec ${marker}`, `exec ${quote(value)}`), { mode: 0o755 })
  chmodSync(target, 0o755)
}
process.stdout.write(`Bound sandbox launchers to ${node}\n`)
