import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createBashOnlyPlugin } from './plugin.js';
export const name = 'sandbox-runtime-dsh-bash';
export const inject = ['subprocess', 'sandboxPolicy'];
export const DSH_VERSION = '0.2.1-alpha.2';
export async function apply(ctx, config = {}) {
    if (Object.keys(config).some(key => key !== 'runtime' && key !== 'bash'))
        throw new Error('unknown DSH plugin setting');
    const host = JSON.parse(readFileSync(fileURLToPath(import.meta.resolve('@deepseek-ai/dsh/package.json')), 'utf8'));
    if (host.version !== DSH_VERSION)
        throw new Error(`sandbox-runtime requires DSH ${DSH_VERSION}; found ${host.version}`);
    const root = realpathSync(fileURLToPath(new URL('../../../', import.meta.url)));
    await ctx.plugin(createBashOnlyPlugin({
        ...config.runtime,
        scope: 'bash-only',
        runnerPath: `${root}/bin/sandbox-runner`,
        protectedPaths: [root, ...(config.runtime?.protectedPaths ?? [])],
    }, config.bash));
}
//# sourceMappingURL=entry.js.map