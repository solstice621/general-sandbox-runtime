import { AsyncLocalStorage } from 'node:async_hooks';
import { isAbsolute, dirname } from 'node:path';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SandboxProvider } from '@deepseek-ai/dsh-sandbox';
import { SubprocessRuntime, scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess';
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local';
import { SandboxBashExecutor } from '@deepseek-ai/dsh-bash-sandbox';
import { RuntimeSandboxProvider, unsupported } from './provider.js';
import { pathsOverlap, dshInstallationRoot } from './path-trust.js';
const FIXED_ENV = Object.freeze({ NO_COLOR: '1', TERM: 'dumb', PAGER: 'cat', GIT_PAGER: 'cat' });
const DSH_ENTRYPOINTS = ['@deepseek-ai/cordis', '@deepseek-ai/cosmokit', '@deepseek-ai/schemastery', '@deepseek-ai/dsh-sandbox', '@deepseek-ai/dsh-shell', '@deepseek-ai/dsh-subprocess', '@deepseek-ai/dsh-subprocess-local', '@deepseek-ai/dsh-bash-sandbox', '@deepseek-ai/dsh-bash-local'];
function assertProtectedInstallations(workspace) {
    const root = realpathSync(workspace);
    const installations = new Set();
    for (const name of DSH_ENTRYPOINTS) {
        const directory = dirname(fileURLToPath(import.meta.resolve(`${name}/package.json`)));
        // A grant can target a DIFFERENT package such as approval or jobs. The
        // entrypoints locate installations; they are not the protected-path list.
        installations.add(dshInstallationRoot(directory));
    }
    for (const path of installations)
        if (pathsOverlap(root, path))
            unsupported('DSH installation overlaps writable workspace; install trusted components outside it');
}
function targetMetadata(spec) {
    if (spec.env && Object.keys(spec.env).length)
        unsupported('ordinary Bash env overrides are not supported in V1');
    const result = { ...FIXED_ENV };
    for (const [key, value] of Object.entries(spec.dshEnv ?? {})) {
        if (typeof value !== 'string' || value.length > 4096 || /[\x00-\x1f\x7f]/.test(value))
            unsupported(`invalid trusted Bash metadata: ${key}`);
        const valid = ['DSH_HOME', 'DSH_PROFILE_DIR'].includes(key) ? isAbsolute(value)
            : key === 'DSH_SHELL' ? value === '1'
                : ['DSH_PROFILE', 'DSH_SESSION_ID'].includes(key) && /^[a-zA-Z0-9_.:-]{1,256}$/.test(value);
        if (!valid)
            unsupported(`unsupported trusted Bash metadata: ${key}`);
        result[key] = value;
    }
    return Object.freeze(result);
}
/**
 * Replace only the Bash executor, leaving shared sandbox/subprocess services intact.
 * PTC and PTY cannot obtain this provider or its private launch authorization.
 * The trusted DSH composition must supply the pinned source's local subprocess.
 */
export function createBashOnlyPlugin(config, bashConfig = {}) {
    const provider = new RuntimeSandboxProvider(config);
    const scope = new AsyncLocalStorage();
    return {
        name: 'sandbox-runtime-bash-only',
        inject: ['subprocess', 'sandboxPolicy'],
        async apply(ctx) {
            const parent = ctx.subprocess;
            if (!(parent instanceof LocalSubprocessRuntime))
                unsupported('Bash adapter requires the audited DSH LocalSubprocessRuntime');
            if (ctx.get('shell'))
                unsupported('replace the existing Bash executor in the composition before installing this plugin');
            const inner = ctx.isolate('sandbox').isolate('subprocess');
            class BashProvider extends SandboxProvider {
                async confine(argv, policy, signal) {
                    const invocation = scope.getStore();
                    if (!invocation || invocation.mode !== policy.mode)
                        unsupported('provider is private to an active Bash invocation; PTC/shared use is unsupported');
                    // Identity is the private execution scope above, not this pinned-source shape assertion.
                    const command = argv[2];
                    if (argv.length !== 3 || argv[0] !== 'bash' || argv[1] !== '-c' || typeof command !== 'string')
                        unsupported('DSH Bash argv contract changed; revalidate the pinned integration');
                    const result = await provider.confine(['/usr/bin/env', ...Object.entries(invocation.metadata).map(([name, value]) => `${name}=${value}`), '/bin/bash', '-c', command], policy, signal);
                    invocation.argv = result.argv;
                    return result;
                }
            }
            class BashSubprocess extends SubprocessRuntime {
                resolveExecutable() { return unsupported('executable lookup is not part of this private Bash launch boundary'); }
                terminalEnvironment() { return unsupported('PTY is unsupported by the Bash-only adapter'); }
                spawnTerminal() { return unsupported('PTY is unsupported by the Bash-only adapter'); }
                spawn(spec) {
                    const invocation = scope.getStore();
                    if (!invocation)
                        unsupported('subprocess launch outside the private Bash execution scope');
                    if (invocation.mode === 'danger-full-access')
                        return parent.spawn(spec);
                    if (spec.argv !== invocation.argv)
                        unsupported('spawn does not match this Bash invocation');
                    if (spec.stdio.control !== undefined || spec.stdio.stdin !== 'ignore' && !(spec.stdio.stdin && typeof spec.stdio.stdin === 'object' && Object.keys(spec.stdio.stdin).length === 1 && 'data' in spec.stdio.stdin))
                        unsupported('only Bash data/closed stdin and no application control FD are supported');
                    if (typeof spec.stdio.stdout !== 'object' || spec.stdio.stdout === null || typeof spec.stdio.stderr !== 'object' || spec.stdio.stderr === null)
                        unsupported('Bash output must use managed collection, not inherited handles');
                    if (spec.graceMs < 3_000)
                        unsupported('DSH termination grace must be at least 3000ms to contain Runner cleanup');
                    provider.consumePrepared(spec.argv);
                    // Tombstones are applied AFTER DSH's scrubbed ambient/proxy base. No ambient
                    // loader variable can reach Runner before main, including newly added names.
                    // The installed launcher invokes its trusted Node binary by absolute path.
                    const env = Object.fromEntries([...new Set([...Object.keys(process.env), ...Object.keys(scrubbedParentEnv())])].map(key => [key, undefined]));
                    Object.assign(env, provider.safeEnvironment());
                    return parent.spawn({ ...spec, env });
                }
            }
            class BashExecutor extends SandboxBashExecutor {
                constructor(localContext, localConfig) {
                    super(localContext, localConfig);
                    // Cordis normally rebinds service this.ctx to the calling context.
                    // Capture the constructed instance so a root ctx.shell call cannot
                    // replace the private sandbox/subprocess scopes with shared services.
                    this.execute = (spec) => {
                        const policy = spec.sandboxPolicy;
                        if (!policy || !['read-only', 'workspace-write', 'danger-full-access'].includes(policy.mode))
                            unsupported('Bash requires a resolved sandbox policy');
                        const mode = policy.mode;
                        if (mode === 'workspace-write')
                            assertProtectedInstallations(policy.workspaceRoot);
                        const metadata = mode === 'danger-full-access' ? {} : targetMetadata(spec);
                        return scope.run({ mode, metadata }, () => super.execute(spec));
                    };
                }
            }
            await inner.plugin(BashProvider);
            await inner.plugin(BashSubprocess);
            await inner.plugin(BashExecutor, bashConfig);
        },
    };
}
//# sourceMappingURL=plugin.js.map