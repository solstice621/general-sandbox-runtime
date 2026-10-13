import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { Context } from '@deepseek-ai/cordis'
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local'
import { createBashOnlyPlugin } from '../../../dist/adapters/dsh/plugin.js'
import { fixture } from './helpers.js'

export async function harness(t, mode = 'workspace-write', options = {}) {
  const f = fixture()
  if (process.env.SANDBOX_RUNNER) f.config.runnerPath = process.env.SANDBOX_RUNNER
  const ctx = new Context()
  t.after(async () => { await ctx.fiber.dispose(); rmSync(f.root, { recursive: true, force: true }) })
  const existingProvider = { sentinel: 'shared provider remains outside our scope' }
  ctx.provide('sandbox', existingProvider)
  // Authorization is supplied as an already-resolved trusted policy. UI/LLM approval is outside this test.
  ctx.provide('sandboxPolicy', { defaultMode: mode, resolve: () => ({ mode, workspaceRoot: f.workspace }) })
  await ctx.plugin(LocalSubprocessRuntime)
  ctx.subprocess.adapterTestSentinel = 'original subprocess'
  await ctx.plugin(createBashOnlyPlugin(f.config, { cwd: f.workspace, timeoutMs: 5_000, ...options }))
  assert.equal(ctx.sandbox.sentinel, existingProvider.sentinel)
  assert.equal(ctx.subprocess.adapterTestSentinel, 'original subprocess')
  return { ...f, ctx, shell: ctx.shell }
}
export const run = async (shell, request) => (await shell.execute(shell.resolve(request))).result()
