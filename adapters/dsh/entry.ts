import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { createBashOnlyPlugin, type BashPluginOptions } from './plugin.js'
import type { ClientConfig } from '../../src/client.js'

export const name = 'sandbox-runtime-dsh-bash'
export const inject = ['subprocess', 'sandboxPolicy']
export interface Config {
  readonly runtime?: Omit<ClientConfig, 'runnerPath'>
  readonly bash?: BashPluginOptions
}

export async function apply(ctx: Context, config: Config = {}): Promise<void> {
  if (Object.keys(config).some(key => key !== 'runtime' && key !== 'bash')) throw new Error('unknown DSH plugin setting')
  const root = realpathSync(fileURLToPath(new URL('../../../', import.meta.url)))
  await ctx.plugin(createBashOnlyPlugin({
    ...config.runtime,
    runnerPath: `${root}/bin/sandbox-runner`,
    protectedPaths: [root, ...(config.runtime?.protectedPaths ?? [])],
  }, config.bash))
}
