import { execFile } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { userInfo } from 'node:os'
import { promisify } from 'node:util'
import type { ClientConfig, ExecutionPolicy } from './client.js'

export interface LaunchPlan {
  readonly policyJSON: string
  readonly environment: Readonly<Record<string, string>>
}

const execute = promisify(execFile)

/** Bun delegates filesystem policy preparation to the same installed Node runtime. */
export async function prepareLaunch(config: ClientConfig, policy: ExecutionPolicy, signal?: AbortSignal): Promise<LaunchPlan> {
  const { stdout } = await execute(config.runnerPath, ['prepare', '--request-json', JSON.stringify({ config, policy })], {
    env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: realpathSync(userInfo().homedir), LANG: 'C', LC_ALL: 'C', TERM: 'dumb' },
    encoding: 'utf8', maxBuffer: 131072, signal,
  })
  return JSON.parse(stdout) as LaunchPlan
}
