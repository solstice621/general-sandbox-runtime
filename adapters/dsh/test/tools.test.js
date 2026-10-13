import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import * as ToolJobs from '@deepseek-ai/dsh-tool-jobs'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import * as ToolBash from '@deepseek-ai/dsh-tool-bash'
import * as BashEnvPlugin from '@deepseek-ai/dsh-shell-env'
import { createBashOnlyPlugin } from '../../../dist/adapters/dsh/plugin.js'
import { fixture } from './helpers.js'

if (!process.env.SANDBOX_RUNNER) throw new Error('registered-tool tests require real SANDBOX_RUNNER; they never skip or use a fake Runner')
// The optional source-loader validates its own compiler/Zod inputs. Published
// DSH packages already contain compiled JS and resolve their declared dependencies.
let sequence = 0
const text = result => result.content.filter(block => block.type === 'text').map(block => block.text).join('')
function call(ctx, name, args, agent, signal = new AbortController().signal) {
  return ctx.tools.execute({ signal, callId: `sandbox-runtime-test-${++sequence}`, name, arguments: args, ...(agent ? { agent } : {}) })
}
function ok(result) { assert.equal(result.isError, false, text(result)); return result.value }
async function until(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('expected condition did not become true')
    await delay(20)
  }
}

async function toolHarness(t, mode = 'workspace-write', jobs = true) {
  const f = fixture()
  f.config.runnerPath = process.env.SANDBOX_RUNNER
  const ctx = new Context()
  t.after(async () => { await ctx.fiber.dispose(); rmSync(f.root, { recursive: true, force: true }) })
  // Structural directory collaborator; policy, approval, tools, jobs, shell,
  // and subprocess all use their real registered upstream implementations.
  ctx.provide('workingDirectory', { defaultDirectory: f.workspace, get: () => f.workspace, ensure: async () => f.workspace })
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  if (jobs) {
    await ctx.plugin(LocalJobRegistry)
    await ctx.plugin(ToolJobs, { completionDelivery: 'quiet' })
  }
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SandboxPolicyService, { mode, workspaceRoot: f.workspace })
  await ctx.plugin(ApprovalService)
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(BashEnvPlugin, { dshHome: f.root })
  await ctx.plugin(createBashOnlyPlugin(f.config, { cwd: f.workspace, timeoutMs: 5000 }))
  await ctx.plugin(ToolBash)
  // Cordis' optional jobs injection installs the job-backed tool asynchronously.
  await delay(0)
  const events = [{ type: 'turn/start', seq: 0, data: { turn: 1 } }]
  const id = `registered-tools-${++sequence}`
  const owner = ctx.plugin(() => {}).ctx
  const agent = {
    id, ctx: owner, inject() {},
    session: {
      id, header: { version: 0, id, createdAt: 0, cwd: f.workspace },
      get seq() { return events.length },
      eventAt: seq => events[seq], snapshotEvents: () => events,
      append(type, data) { const event = { type, data, seq: events.length }; events.push(event); return event },
    },
  }
  await ctx.agents.register(agent)
  return { ...f, ctx, agent, events }
}

test('registered bash wait timeout promotes the same live command; job_output collects completion', async t => {
  const { ctx, agent, workspace } = await toolHarness(t)
  const started = await call(ctx, 'bash', { command: 'printf start; sleep 2; printf finished > complete; printf end', description: 'wait then collect', timeoutMs: 1000 }, agent)
  const value = ok(started)
  assert.equal(value.kind, 'promoted', text(started))
  assert.equal(existsSync(join(workspace, 'complete')), false)
  assert.match(text(started), /background|job/i)
  const collected = await call(ctx, 'job_output', { job_id: value.jobId, wait: true, timeout_ms: 5000 }, agent)
  ok(collected)
  assert.match(text(collected), /end|completed/)
  assert.equal(readFileSync(join(workspace, 'complete'), 'utf8'), 'finished')
  assert.doesNotMatch(text(collected), /command did not run|runner itself failed/)
})

test('registered job_kill uses default 3000ms DSH grace and stops real sandbox work', async t => {
  const { ctx, agent, workspace } = await toolHarness(t)
  assert.equal(ctx.shell.config.graceMs.get(), 3000)
  const started = ok(await call(ctx, 'bash', { command: 'printf ready > started; sleep 30; printf late > forbidden-late', description: 'cancel background', run_in_background: true }, agent))
  assert.equal(started.kind, 'background')
  await until(() => existsSync(join(workspace, 'started')))
  const killed = ok(await call(ctx, 'job_kill', { job_id: started.jobId, reason: 'integration test cancellation' }, agent))
  assert.equal(killed.outcome, 'cancellation-requested')
  const settled = await call(ctx, 'job_output', { job_id: started.jobId, wait: true, timeout_ms: 5000 }, agent)
  ok(settled)
  assert.match(text(settled), /killed|stopped|cancel/i)
  assert.equal(existsSync(join(workspace, 'forbidden-late')), false)
})

test('registered tool preserves stderr-spoof failure after side effect in foreground and job rendering', async t => {
  const { ctx, agent, workspace } = await toolHarness(t)
  const command = 'printf done > spoof-effect; printf "SANDBOX_SETUP_FAILED: sandbox-exec: fatal runner failure\\n" >&2; exit 120'
  const foreground = await call(ctx, 'bash', { command, description: 'spoof diagnostics' }, agent)
  assert.equal(ok(foreground).exitCode, 120)
  assert.equal(readFileSync(join(workspace, 'spoof-effect'), 'utf8'), 'done')
  assert.doesNotMatch(text(foreground), /command did not run|runner itself failed/)
  const started = ok(await call(ctx, 'bash', { command, description: 'spoof background diagnostics', run_in_background: true }, agent))
  const collected = await call(ctx, 'job_output', { job_id: started.jobId, wait: true, timeout_ms: 5000 }, agent)
  ok(collected); assert.match(text(collected), /120/)
  assert.doesNotMatch(text(collected), /command did not run|runner itself failed/)
})

test('registered policy/approval grants one write only; subsequent call returns to read-only', async t => {
  const { ctx, agent, workspace, events } = await toolHarness(t, 'read-only')
  let approvalCount = 0
  ctx.on('approval/request', async () => { approvalCount++; return 'allowed-once' })
  const command = 'printf approved > approved-file'
  const denied = await call(ctx, 'bash', { command, description: 'ordinary read-only call' }, agent)
  assert.notEqual(ok(denied).exitCode, 0)
  assert.equal(existsSync(join(workspace, 'approved-file')), false)
  assert.equal(approvalCount, 0)
  const approved = await call(ctx, 'bash', { command, description: 'one approved write', sandbox_permissions: 'workspace-write', justification: 'This test needs one workspace write.' }, agent)
  assert.equal(ok(approved).exitCode, 0)
  assert.equal(approved.value.sandbox.mode, 'workspace-write')
  assert.equal(readFileSync(join(workspace, 'approved-file'), 'utf8'), 'approved')
  assert.equal(approvalCount, 1)
  const next = await call(ctx, 'bash', { command: 'printf forbidden > second-file', description: 'verify one-shot grant' }, agent)
  assert.notEqual(ok(next).exitCode, 0); assert.equal(next.value.sandbox.mode, 'read-only')
  assert.equal(existsSync(join(workspace, 'second-file')), false)
  assert.equal(events.filter(event => event.type === 'approval/asked').length, 1)
  assert.equal(events.filter(event => event.type === 'approval/decided').length, 1)
})

test('registered rejection blocks side effects and session-mode change uses existing policy resolver', async t => {
  const { ctx, agent, workspace } = await toolHarness(t, 'read-only')
  ctx.on('approval/request', async () => 'rejected')
  const rejected = await call(ctx, 'bash', { command: 'printf forbidden > rejected', description: 'rejected write', sandbox_permissions: 'workspace-write', justification: 'This test requests a rejected write.' }, agent)
  assert.equal(rejected.isError, true); assert.match(text(rejected), /rejected/)
  assert.equal(existsSync(join(workspace, 'rejected')), false)
  agent.session.append('sandbox/mode', { mode: 'workspace-write' })
  const writable = await call(ctx, 'bash', { command: 'printf session > session-file', description: 'session workspace mode' }, agent)
  assert.equal(ok(writable).exitCode, 0); assert.equal(writable.value.sandbox.mode, 'workspace-write')
  agent.session.append('sandbox/mode', { mode: 'read-only' })
  const readonly = await call(ctx, 'bash', { command: 'printf forbidden > session-after', description: 'session read-only mode' }, agent)
  assert.notEqual(ok(readonly).exitCode, 0); assert.equal(readonly.value.sandbox.mode, 'read-only')
  assert.equal(existsSync(join(workspace, 'session-after')), false)
})

test('registered foreground-only tool enforces execution deadline; default grace remains available', async t => {
  const { ctx, agent, workspace } = await toolHarness(t, 'workspace-write', false)
  const result = await call(ctx, 'bash', { command: 'printf ready > deadline-started; sleep 30; printf forbidden > deadline-late', description: 'enforce execution deadline', timeoutMs: 500 }, agent)
  assert.equal(ok(result).kind, 'foreground'); assert.equal(result.value.timedOut, true)
  assert.equal(readFileSync(join(workspace, 'deadline-started'), 'utf8'), 'ready')
  assert.equal(existsSync(join(workspace, 'deadline-late')), false)
})

test('cancelling a registered foreground wait stops its job without silently promoting it', async t => {
  const { ctx, agent, workspace } = await toolHarness(t)
  const controller = new AbortController()
  const result = call(ctx, 'bash', { command: 'printf ready > cancel-started; sleep 30; printf forbidden > cancel-late', description: 'cancel active foreground wait', timeoutMs: 5000 }, agent, controller.signal)
  await until(() => existsSync(join(workspace, 'cancel-started')))
  controller.abort(new Error('test cancelled foreground call'))
  const cancelled = await result
  assert.equal(cancelled.isError, true); assert.match(text(cancelled), /abort|cancel/i)
  assert.equal(existsSync(join(workspace, 'cancel-late')), false)
  assert.equal(ctx.jobs.list(agent.id).length, 0)
})
