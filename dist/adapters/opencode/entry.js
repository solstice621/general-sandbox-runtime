import { realpathSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareLaunch } from '../../src/transport.js';
export const OPENCODE_VERSION = '2.0.14';
const runtimeRoot = realpathSync(fileURLToPath(new URL('../../../', import.meta.url)));
/** No SDK runtime dependency: OpenCode loads the documented { id, setup } object. */
const plugin = {
    id: 'sandbox-runtime.bash',
    async setup(ctx) {
        const workspaceRoot = realpathSync(ctx.location.directory);
        // Install the guard before validating options. A hook failure must not leave
        // an invocation pointing at the native shell, even on a failed preflight.
        await ctx.shell.hook('create.before', async (event) => {
            event.shell = '/usr/bin/false';
            const originalEnv = event.env;
            event.env = Object.fromEntries([...new Set([...Object.keys(process.env), ...Object.keys(originalEnv)])].map(key => [key, undefined]));
            if (ctx.app.version.replace(/^v/, '') !== OPENCODE_VERSION)
                throw new Error(`OpenCode ${OPENCODE_VERSION} is required; found ${ctx.app.version}`);
            const options = ctx.options;
            if (Object.keys(options).some(key => !['mode', 'network', 'denyRead', 'denyWrite', 'protectedPaths', 'checkTimeoutMs'].includes(key)))
                throw new Error('unknown OpenCode plugin setting');
            const { mode = 'workspace-write', ...config } = options;
            if (mode !== 'read-only' && mode !== 'workspace-write')
                throw new Error('mode must be read-only or workspace-write');
            const clientConfig = {
                ...config,
                scope: 'bash-only',
                runnerPath: `${runtimeRoot}/bin/sandbox-runner`,
                protectedPaths: [runtimeRoot, dirname(realpathSync(process.execPath)), ...(config.protectedPaths ?? [])],
            };
            const cwd = realpathSync(resolve(workspaceRoot, event.cwd));
            if (!statSync(cwd).isDirectory())
                throw new Error('cwd must be a directory');
            const prepared = await prepareLaunch(clientConfig, { mode, workspaceRoot }, ['/bin/bash', '-c', event.command]);
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