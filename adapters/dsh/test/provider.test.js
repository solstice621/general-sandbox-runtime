import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rmSync, writeFileSync, symlinkSync, linkSync, readFileSync, statSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { RuntimeSandboxProvider } from '../../../dist/adapters/dsh/provider.js'
import { fixture } from './helpers.js'
import { pathContains, pathsOverlap, dshInstallationRoot } from '../../../dist/adapters/dsh/path-trust.js'
import { RuntimeError } from '../../../dist/src/policy.js'

test('both DSH modes map to immutable V1 policy; native argv and empty failure rules survive', async t => {
  const f = fixture(); t.after(() => rmSync(f.root, { recursive: true, force: true }))
  const provider = new RuntimeSandboxProvider(f.config)
  const input = ['/bin/bash', '-c', 'printf "%s" "$1"', '', 'a b\n"\'$x']
  for (const mode of ['read-only', 'workspace-write']) {
    const result = await provider.confine(input, { mode, workspaceRoot: f.workspace })
    assert.deepEqual(result.argv.slice(5), input)
    assert.equal(result.enforcement, 'full'); assert.deepEqual(result.runnerFailureRules, [])
    const policy = JSON.parse(result.argv[3])
    assert.equal(policy.version, 1); assert.equal(policy.network.mode, 'deny'); assert.equal(policy.ipc.hostUnixSockets, 'deny')
    assert.deepEqual(policy.filesystem.allowWrite, mode === 'read-only' ? [] : [{ path: f.workspace, scope: 'tree' }])
    assert.equal(policy.filesystem.temp, mode === 'read-only' ? 'none' : 'private')
    assert.throws(() => result.argv.push('mutate'), TypeError)
    assert.throws(() => provider.consumePrepared([...result.argv]), /one-shot/)
    provider.consumePrepared(result.argv); assert.throws(() => provider.consumePrepared(result.argv), /one-shot/)
  }
})

test('shared runtime policy validation owns rule semantics and produces independent frozen snapshots', t => {
  const f = fixture(); t.after(() => rmSync(f.root, { recursive: true, force: true }))
  const control = join(f.workspace, 'control'); writeFileSync(control, 'trusted')
  const denyWrite = [{ path: control, scope: 'file' }]
  const provider = new RuntimeSandboxProvider({ ...f.config, denyWrite })
  denyWrite[0].path = f.workspace
  const policy = provider.policyFor({ mode: 'workspace-write', workspaceRoot: f.workspace })
  assert.equal(policy.filesystem.denyWrite[0].path, control)
  assert.equal(Object.isFrozen(policy), true)
  assert.equal(Object.isFrozen(policy.filesystem.denyWrite), true)
  assert.equal(Object.isFrozen(policy.filesystem.denyWrite[0]), true)
  assert.doesNotMatch(JSON.stringify(policy), /"logical"/)
  assert.throws(() => new RuntimeSandboxProvider({ ...f.config, denyRead: [{ path: control, scope: 'glob' }] }), RuntimeError)
  assert.throws(() => new RuntimeSandboxProvider({ ...f.config, denyWrite: [{ path: control, scope: 'file', extra: true }] }), RuntimeError)
  assert.throws(() => new RuntimeSandboxProvider({ ...f.config, denyWrite: [{ path: control, scope: 'file', logical: control }] }), /private runtime metadata/)
})

test('refuses unsupported modes, scope, unknown config, runner overlap and symlink', async t => {
  const f = fixture(); t.after(() => rmSync(f.root, { recursive: true, force: true }))
  for (const scope of ['shared', 'ptc', 'pty', undefined]) assert.throws(() => new RuntimeSandboxProvider({ ...f.config, scope }), /bash-only/)
  assert.throws(() => new RuntimeSandboxProvider({ ...f.config, ignored: true }), /unknown/)
  const provider = new RuntimeSandboxProvider(f.config)
  await assert.rejects(provider.confine(['/bin/true'], { mode: 'danger-full-access', workspaceRoot: f.workspace }), /full access bypass/)
  await assert.rejects(provider.confine(['/bin/true'], { mode: 'workspace-write', workspaceRoot: f.root }), /overlaps/)
  const link = join(f.root, 'link'); symlinkSync(f.runner, link)
  assert.throws(() => new RuntimeSandboxProvider({ ...f.config, runnerPath: link }), /canonical/)
  linkSync(f.runner, join(f.root, 'hardlink'))
  assert.throws(() => new RuntimeSandboxProvider(f.config), /one link/)
})

test('pre-aborted and asynchronously aborted checks never return prepared argv', async t => {
  const f = fixture(); t.after(() => rmSync(f.root, { recursive: true, force: true }))
  const provider = new RuntimeSandboxProvider(f.config)
  const pre = new AbortController(); pre.abort(new Error('pre-cancelled'))
  await assert.rejects(provider.confine(['/bin/true'], { mode: 'read-only', workspaceRoot: f.workspace }, pre.signal), /pre-cancelled/)
  writeFileSync(f.runner, '#!/bin/sh\nexec /bin/sleep 30\n')
  const during = new AbortController()
  const promise = provider.confine(['/bin/true'], { mode: 'read-only', workspaceRoot: f.workspace }, during.signal)
  setTimeout(() => during.abort(new Error('cancelled during check')), 20)
  await assert.rejects(promise, /abort|cancelled/i)
})

test('preflight missing capability, malformed output and deadline fail closed', async t => {
  const f = fixture(); t.after(() => rmSync(f.root, { recursive: true, force: true }))
  for (const script of ['exit 120', 'echo invalid', 'echo \'{"ok":true,"version":1,"platform":"wrong","network":"deny"}\'', 'exec /bin/sleep 30']) {
    writeFileSync(f.runner, `#!/bin/sh\n${script}\n`)
    const provider = new RuntimeSandboxProvider({ ...f.config, checkTimeoutMs: 30 })
    await assert.rejects(provider.confine(['/bin/true'], { mode: 'read-only', workspaceRoot: f.workspace }), error => error.code === 'SANDBOX_UNAVAILABLE')
  }
})

test('runner check starts with a clean environment before runner main', async t => {
  const f = fixture(); t.after(() => rmSync(f.root, { recursive: true, force: true }))
  const captured = join(f.root, 'environment')
  writeFileSync(f.runner, `#!/bin/sh\n/usr/bin/env > '${captured}'\nprintf '%s' '{"ok":true,"version":1,"platform":"${process.platform}","network":"deny"}'\n`)
  process.env.SANDBOX_TEST_SECRET = 'never-pass'
  process.env.NODE_OPTIONS = '--require=/untrusted/file'
  t.after(() => { delete process.env.SANDBOX_TEST_SECRET; delete process.env.NODE_OPTIONS })
  await new RuntimeSandboxProvider(f.config).confine(['/bin/true'], { mode: 'read-only', workspaceRoot: f.workspace })
  const env = readFileSync(captured, 'utf8')
  assert.doesNotMatch(env, /never-pass|NODE_OPTIONS|SECRET/)
  assert.match(env, /PATH=\/usr\/bin:\/bin:\/usr\/sbin:\/sbin/)
})

test('trusted path overlap follows filesystem identity, including case aliases when the host resolves them', async t => {
  const f = fixture(); t.after(() => rmSync(f.root, { recursive: true, force: true }))
  const alias = join(f.root, 'alias'); symlinkSync(f.root, alias)
  assert.equal(pathContains(alias, f.runner), true)
  assert.equal(pathsOverlap(alias, f.workspace), true)
  const uppercaseRoot = f.root.toUpperCase()
  let caseAlias = false
  try {
    const a = statSync(f.root, { bigint: true }), b = statSync(uppercaseRoot, { bigint: true })
    caseAlias = a.dev === b.dev && a.ino === b.ino
  } catch { /* A case-sensitive host has no such alias. Symlink identity remains tested above. */ }
  if (caseAlias) {
    assert.equal(pathContains(uppercaseRoot, f.runner), true)
    await assert.rejects(new RuntimeSandboxProvider(f.config).confine(['/bin/true'], { mode: 'workspace-write', workspaceRoot: uppercaseRoot }), /overlaps/)
    t.diagnostic('case-insensitive filesystem alias regression executed')
  } else {
    t.diagnostic('case-sensitive host: uppercase spelling is a distinct/nonexistent path; symlink identity regression executed')
  }
})

test('installation discovery protects the whole DSH monorepo or outer npm dependency tree', t => {
  const f = fixture(); t.after(() => rmSync(f.root, { recursive: true, force: true }))
  const source = join(f.root, 'source'); mkdirSync(join(source, 'packages', 'shell', 'bash'), { recursive: true })
  writeFileSync(join(source, 'package.json'), '{"name":"@deepseek-ai/dsh-root"}')
  assert.equal(dshInstallationRoot(join(source, 'packages', 'shell', 'bash')), source)
  const dependencies = join(f.root, 'node_modules')
  const nested = join(dependencies, '.pnpm', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-bash-local')
  mkdirSync(nested, { recursive: true })
  assert.equal(dshInstallationRoot(nested), dependencies)
  assert.throws(() => dshInstallationRoot(f.workspace), /unsupported deployment layout/)
})
