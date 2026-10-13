import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { harness, run } from './harness.js'

if (!process.env.SANDBOX_RUNNER) throw new Error('SANDBOX_RUNNER is required: this suite never substitutes a fake runner or skips confinement')

test('actual DSH workspace-write allows its root and denies an outside write with checked side effects', async t => {
  const { shell, workspace, root } = await harness(t)
  assert.equal((await run(shell, { command: 'printf allowed > inside' })).exitCode, 0)
  assert.equal(readFileSync(join(workspace, 'inside'), 'utf8'), 'allowed')
  const result = await run(shell, { command: 'printf forbidden > ../outside' })
  assert.notEqual(result.exitCode, 0); assert.equal(result.sandbox.denied, true)
  assert.equal(existsSync(join(root, 'outside')), false)
})

test('actual DSH read-only denies writes, including children', async t => {
  const { shell, workspace } = await harness(t, 'read-only')
  const result = await run(shell, { command: '/bin/bash -c "printf forbidden > readonly"' })
  assert.notEqual(result.exitCode, 0); assert.equal(result.sandbox.denied, true)
  assert.equal(existsSync(join(workspace, 'readonly')), false)
})

test('overlapping DSH executions keep their policy and output independently', async t => {
  const { shell, workspace } = await harness(t)
  const [readonly, writable] = await Promise.all([
    run(shell, { command: 'sleep 0.05; printf forbidden > readonly', sandboxPolicy: { mode: 'read-only', workspaceRoot: workspace } }),
    run(shell, { command: 'printf allowed > writable; sleep 0.1', sandboxPolicy: { mode: 'workspace-write', workspaceRoot: workspace } }),
  ])
  assert.notEqual(readonly.exitCode, 0); assert.equal(readonly.sandbox.mode, 'read-only')
  assert.equal(writable.exitCode, 0); assert.equal(writable.sandbox.mode, 'workspace-write')
  assert.equal(existsSync(join(workspace, 'readonly')), false)
  assert.equal(readFileSync(join(workspace, 'writable'), 'utf8'), 'allowed')
})
