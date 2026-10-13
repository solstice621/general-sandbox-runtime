import { realpathSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareLaunch } from '../../src/transport.js';
const runtimeRoot = realpathSync(fileURLToPath(new URL('../../../', import.meta.url)));
/** No SDK runtime dependency: OpenCode loads the documented { id, setup } object. */
const plugin = {
    id: 'sandbox-runtime.bash',
    async setup(ctx) {
        const workspaceRoot = realpathSync(ctx.location.directory);
        // Install the guard before validating options. A hook failure must not leave
        // an invocation pointing at the native shell, even on a failed preparation.
        await ctx.shell.hook('create.before', async (event) => {
            event.shell = '/usr/bin/false';
            const originalEnv = event.env;
            event.env = Object.fromEntries([...new Set([...Object.keys(process.env), ...Object.keys(originalEnv)])].map(key => [key, undefined]));
            const options = ctx.options;
            const { mode = 'workspace-write', ...config } = options;
            if (mode !== 'read-only' && mode !== 'workspace-write')
                throw new Error('mode must be read-only or workspace-write');
            const clientConfig = {
                ...config,
                runnerPath: `${runtimeRoot}/bin/sandbox-runner`,
                protectedPaths: [runtimeRoot, dirname(realpathSync(process.execPath)), ...(config.protectedPaths ?? [])],
            };
            const cwd = realpathSync(resolve(workspaceRoot, event.cwd));
            if (!statSync(cwd).isDirectory())
                throw new Error('cwd must be a directory');
            const prepared = await prepareLaunch(clientConfig, { mode, workspaceRoot });
            // Keep command unchanged: native ShellTool scans this command AFTER the
            // hook, preserving its real permission resources and background jobs.
            event.cwd = cwd;
            event.env = { ...event.env, ...prepared.environment, SANDBOX_RUNTIME_POLICY: prepared.policyJSON };
            event.shell = `${runtimeRoot}/bin/opencode/bash`;
        });
    },
};
export default plugin;
//# sourceMappingURL=entry.js.map