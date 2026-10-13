import { mkdtempSync, realpathSync, writeFileSync, chmodSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'sandbox-dsh-')))
  const workspace = join(root, 'workspace'); mkdirSync(workspace)
  const runner = join(root, 'runner')
  writeFileSync(runner, `#!/bin/sh
case "$1" in
run) shift; while [ "$1" != '--' ]; do shift; done; shift; exec "$@";;
*) exit 120;;
esac
`)
  chmodSync(runner, 0o700)
  return { root, workspace, runner, config: { runnerPath: runner } }
}
