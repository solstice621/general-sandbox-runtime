import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
export const name = 'sandbox-runtime-profile-acceptance'
export const inject = ['shell', 'sandboxPolicy']
export function apply(ctx) {
  ctx.appReady.onReady(() => { void (async () => {
    const run = async (command, mode = 'workspace-write') => (await ctx.shell.execute(ctx.shell.resolve({ command, sandboxPolicy: { mode, workspaceRoot: process.cwd() } }))).result()
    try {
      assert.equal((await run('printf profile-ok > profile-allowed; printf stdout; printf stderr >&2; exit 7')).exitCode, 7)
      assert.equal(readFileSync('profile-allowed', 'utf8'), 'profile-ok')
      const outside = resolve('../profile-denied')
      assert.notEqual((await run(`printf forbidden > '${outside}'`)).exitCode, 0)
      assert.equal(existsSync(outside), false)
      assert.notEqual((await run('printf forbidden > profile-readonly', 'read-only')).exitCode, 0)
      assert.equal(existsSync('profile-readonly'), false)
      process.stdout.write('SANDBOX_PROFILE_ACCEPTANCE_OK\n')
      ctx.appExit(0)
    } catch (error) { console.error(error); ctx.appExit(1) }
  })() })
}
