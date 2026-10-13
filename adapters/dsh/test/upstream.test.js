import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync, writeFileSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import { join } from 'node:path'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { harness, run } from './harness.js'

test('pinned real Bash executor + local subprocess preserve foreground stdout/stderr/stdin/exit and scope', async t => {
  const { shell } = await harness(t)
  const result = await run(shell, { command: 'read -r line; printf "<%s>" "$line"; printf error >&2; exit 7', stdin: 'a b"c\n' })
  assert.equal(result.stdout.text, '<a b"c>'); assert.equal(result.stderr.text, 'error'); assert.equal(result.exitCode, 7)
  assert.deepEqual(result.sandbox, { mode: 'workspace-write', denied: false, enforcement: 'full' })
})

test('both modes run and metadata is applied only to target while ambient injection is removed', async t => {
  const { shell, workspace, root } = await harness(t, 'read-only')
  process.env.DSH_TEST_SECRET = 'secret-value'
  process.env.BASH_ENV = join(workspace, 'untrusted')
  writeFileSync(process.env.BASH_ENV, 'echo INJECTED\n')
  const preload = join(workspace, 'untrusted-node.cjs'), marker = join(root, 'node-preload-executed')
  writeFileSync(preload, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'unsafe loader'); throw new Error('untrusted Node loader executed')\n`)
  const previousNodeOptions = process.env.NODE_OPTIONS
  process.env.NODE_OPTIONS = `--require=${preload}`
  t.after(() => {
    delete process.env.DSH_TEST_SECRET; delete process.env.BASH_ENV
    if (previousNodeOptions === undefined) delete process.env.NODE_OPTIONS
    else process.env.NODE_OPTIONS = previousNodeOptions
  })
  const result = await run(shell, { command: 'test -z "$NODE_OPTIONS" || exit 99; printf "%s|%s|%s|%s|%s" "$DSH_SHELL" "$DSH_PROFILE" "$NO_COLOR" "$DSH_TEST_SECRET" "$BASH_ENV"', dshEnv: { DSH_HOME: workspace, DSH_SHELL: '1', DSH_PROFILE: 'sandbox-test', DSH_SESSION_ID: 'test-session' } })
  assert.equal(result.stdout.text, '1|sandbox-test|1||'); assert.equal(result.exitCode, 0)
  assert.equal(existsSync(marker), false, 'ambient NODE_OPTIONS must never execute before Runner main')
  assert.equal(result.sandbox.mode, 'read-only')
  await assert.rejects(run(shell, { command: 'true', env: { LD_PRELOAD: '/evil' } }), /env overrides/)
  await assert.rejects(run(shell, { command: 'true', dshEnv: { DSH_SUBPROCESS_CONTROL: 'pipe' } }), /unsupported trusted/)
})

test('payload side effect then spoofed runner stderr is ordinary failure, foreground and background', async t => {
  const { shell, workspace } = await harness(t)
  const command = 'printf changed > effect; printf "SANDBOX_SETUP_FAILED: sandbox-exec: fatal runner failure\\n" >&2; exit 120'
  const result = await run(shell, { command })
  assert.equal(readFileSync(join(workspace, 'effect'), 'utf8'), 'changed')
  assert.equal(result.exitCode, 120); assert.equal(result.sandbox.runnerFailed, undefined)
  const background = await shell.execute(shell.resolve({ command: `sleep 0.1; ${command}`, onExpiry: 'none' }))
  await background.done
  assert.equal(background.exitCode, 120); assert.equal(background.sandbox.runnerFailed, undefined)
  assert.match(background.readOutput().delta, /SANDBOX_SETUP_FAILED/)
})

test('no deadline permits background ownership; explicit kill and timeout stop execution', async t => {
  const { shell } = await harness(t)
  const background = await shell.execute(shell.resolve({ command: 'sleep 0.2; echo finished', timeoutMs: 10, onExpiry: 'none' }))
  await delay(50); assert.equal(background.status, 'running')
  assert.equal((await background.result()).stdout.text, 'finished\n')
  const killed = await shell.execute(shell.resolve({ command: 'sleep 30', onExpiry: 'none' }))
  assert.equal(killed.kill(), true); await killed.done; assert.equal(killed.status, 'killed')
  const timed = await run(shell, { command: 'sleep 30', timeoutMs: 200 })
  assert.equal(timed.timedOut, true)
})

test('preparation cancellation prevents future launch; unsafe grace is refused', async t => {
  const { shell, workspace } = await harness(t)
  const controller = new AbortController(); controller.abort(new Error('already cancelled'))
  await assert.rejects(run(shell, { command: 'touch should-not-run', signal: controller.signal }), /cancel/)
  assert.equal(existsSync(join(workspace, 'should-not-run')), false)
  const unsafe = await harness(t, 'workspace-write', { graceMs: 10 })
  await assert.rejects(run(unsafe.shell, { command: 'touch should-not-run' }), /at least 3000/)
  assert.equal(existsSync(join(unsafe.workspace, 'should-not-run')), false)
})

test('danger-full-access remains an explicit upstream bypass', async t => {
  const { shell } = await harness(t, 'danger-full-access')
  const result = await run(shell, { command: 'printf "$EXPLICIT_TEST_VALUE"', env: { EXPLICIT_TEST_VALUE: 'full' } })
  assert.equal(result.stdout.text, 'full')
  assert.deepEqual(result.sandbox, { mode: 'danger-full-access', denied: false })
})

test('a writable grant to an unrelated DSH package is refused before execution', async t => {
  const { shell } = await harness(t)
  const unrelated = dirname(fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-user-approval/package.json')))
  await assert.rejects(run(shell, { command: 'true', sandboxPolicy: { mode: 'workspace-write', workspaceRoot: unrelated } }), /DSH installation overlaps/)
})
