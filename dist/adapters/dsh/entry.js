import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createBashOnlyPlugin } from './plugin.js';
export const name = 'sandbox-runtime-dsh-bash';
export const inject = ['subprocess', 'sandboxPolicy'];
export async function apply(ctx, config = {}) {
    if (Object.keys(config).some(key => key !== 'runtime' && key !== 'bash'))
        throw new Error('unknown DSH plugin setting');
    const root = realpathSync(fileURLToPath(new URL('../../../', import.meta.url)));
    await ctx.plugin(createBashOnlyPlugin({
        ...config.runtime,
        runnerPath: `${root}/bin/sandbox-runner`,
        protectedPaths: [root, ...(config.runtime?.protectedPaths ?? [])],
    }, config.bash));
}
//# sourceMappingURL=entry.js.map