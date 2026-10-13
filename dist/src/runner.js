/** One invocation owns one OS launcher, process group, and private resource root. */
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { closeSync, fstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, realpathSync, rmSync, rmdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { constants as osConstants } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setImmediate as immediate } from 'node:timers/promises';
import { addProtected, RuntimeError, SAFE_PATH, safeEnvironment, validatePolicy } from './policy.js';
import { checkMacos, MACOS_HELPER, prepareMacos } from './backends/macos.js';
import { checkLinux, prepareLinux } from './backends/linux.js';
const grants = new WeakMap();
/** The trusted embedding host must own this live pipe/socket until run() has spawned. */
export function communicationGrant(source, target) {
    if (!Number.isInteger(source) || source < 3 || source > 1024 || !Number.isInteger(target) || target < 3 || target > 64) {
        throw new RuntimeError('INVALID_POLICY', 'FD grants require source 3..1024 and target 3..64');
    }
    let info;
    try {
        info = fstatSync(source, { bigint: true });
    }
    catch {
        throw new RuntimeError('INVALID_POLICY', 'source FD unavailable');
    }
    if (!info.isFIFO() && !info.isSocket())
        throw new RuntimeError('INVALID_POLICY', 'only pipe/socket communication FD grants supported');
    const grant = Object.freeze({ source, target });
    grants.set(grant, { dev: info.dev, ino: info.ino, mode: info.mode });
    return grant;
}
function grantStdio(input) {
    const stdio = ['inherit', 'inherit', 'inherit'];
    const targets = new Set();
    // No descriptor allocations or asynchronous work between these checks and spawn.
    for (const grant of input) {
        const expected = grants.get(grant);
        if (!expected || targets.has(grant.target))
            throw new RuntimeError('INVALID_POLICY', 'invalid grant object or duplicate target FD');
        let current;
        try {
            current = fstatSync(grant.source, { bigint: true });
        }
        catch {
            throw new RuntimeError('INVALID_POLICY', 'granted FD was closed before spawn');
        }
        if (current.dev !== expected.dev || current.ino !== expected.ino || current.mode !== expected.mode) {
            throw new RuntimeError('INVALID_POLICY', 'granted FD identity changed before spawn');
        }
        while (stdio.length <= grant.target)
            stdio.push('ignore');
        stdio[grant.target] = grant.source;
        targets.add(grant.target);
    }
    return { stdio, targets: [...targets].sort((a, b) => a - b) };
}
export function runtimePaths() {
    return {
        root: realpathSync(fileURLToPath(new URL('../../', import.meta.url))),
        node: realpathSync(process.execPath),
        linuxSupervisor: fileURLToPath(new URL('./backends/linux-supervisor.js', import.meta.url)),
    };
}
export function resourceBase() { return process.platform === 'darwin' ? '/private/tmp' : '/tmp'; }
function backendCheck(policy) {
    if (process.platform === 'darwin')
        checkMacos(policy);
    else if (process.platform === 'linux')
        checkLinux(policy);
    else
        throw new RuntimeError('BACKEND_UNAVAILABLE', `unsupported platform ${process.platform}`);
}
/** Static preflight; run always revalidates before enforcing an OS boundary. */
export function check(input) {
    backendCheck(input);
    const policy = validatePolicy(input);
    const base = resourceBase();
    const encompassesStore = (rule) => {
        if (rule.scope !== 'tree')
            return false;
        const expected = statSync(rule.path, { bigint: true });
        for (let cursor = base;; cursor = dirname(cursor)) {
            const info = statSync(cursor, { bigint: true });
            if (expected.dev === info.dev && expected.ino === info.ino)
                return true;
            if (cursor === '/')
                return false;
        }
    };
    if (policy.filesystem.allowWrite.some(encompassesStore)) {
        throw new RuntimeError('UNSUPPORTED_POLICY', 'write grants must not encompass the runtime temporary store');
    }
    if (policy.filesystem.temp === 'private' && [...policy.filesystem.denyRead, ...policy.filesystem.denyWrite].some(encompassesStore)) {
        throw new RuntimeError('UNSUPPORTED_POLICY', 'private temporary storage conflicts with a denial covering its store');
    }
    const paths = runtimePaths();
    const helper = process.platform === 'darwin' ? MACOS_HELPER : '/usr/bin/bwrap';
    const protectedPolicy = addProtected(policy, paths.root, paths.node, helper);
    backendCheck(protectedPolicy);
    return protectedPolicy;
}
function resolveArgv(input, cwd) {
    if (!Array.isArray(input) || input.length === 0 || !input[0] || input.some(value => typeof value !== 'string' || value.includes('\0'))) {
        throw new RuntimeError('INVALID_POLICY', 'missing command or invalid argv');
    }
    const argv = [...input];
    if (!argv[0].includes('/')) {
        const found = SAFE_PATH.split(':').map(dir => join(dir, argv[0])).find(candidate => {
            try {
                const info = statSync(candidate);
                return info.isFile() && (info.mode & 0o111) !== 0;
            }
            catch {
                return false;
            }
        });
        if (!found)
            throw new RuntimeError('SANDBOX_SETUP_FAILED', 'command not found in safe PATH');
        argv[0] = found;
    }
    else if (!isAbsolute(argv[0]))
        argv[0] = resolve(cwd, argv[0]);
    return argv;
}
function errorOf(error) { return error instanceof Error ? error : new Error(String(error)); }
function signalNumber(signal) { return osConstants.signals[signal] ?? 15; }
function abortSignal(signal) {
    const reason = signal?.reason;
    if (reason && typeof reason === 'object' && 'signal' in reason && ['SIGTERM', 'SIGINT', 'SIGHUP', 'SIGQUIT'].includes(String(reason.signal))) {
        return reason.signal;
    }
    return 'SIGTERM';
}
function killGroup(child, signal) {
    if (!child.pid)
        return;
    try {
        process.kill(-child.pid, signal);
    }
    catch (error) {
        if (error.code !== 'ESRCH')
            throw error;
    }
}
export async function run(options) {
    const started = performance.now();
    const parent = options.parentPID ?? process.ppid;
    const timeout = options.timeoutMs ?? 0;
    const grace = options.graceMs === undefined || options.graceMs === 0 ? 500 : options.graceMs;
    if (!Number.isFinite(timeout) || timeout < 0 || timeout > 2147483647 || !Number.isFinite(grace) || grace < 0 || grace > 5000) {
        throw new RuntimeError('INVALID_POLICY', 'timeout must be 0..2147483647ms and grace must be 0..5000ms');
    }
    const result = { exitCode: 0, runId: randomBytes(12).toString('hex') };
    const digest = createHash('sha256').update(JSON.stringify(options.policy)).digest('hex');
    const emit = (phase, errorCode) => {
        try {
            options.observe?.(Object.freeze({ runId: result.runId, backend: process.platform, policyDigest: digest, phase,
                ...(phase === 'finished' && !errorCode ? { exitCode: result.exitCode } : {}),
                ...(errorCode ? { errorCode } : {}), cleanupFailed: !!result.cleanupError }));
        }
        catch { /* diagnostics do not own execution */ }
    };
    const preCancelled = () => {
        if (timeout > 0 && performance.now() - started >= timeout) {
            result.exitCode = 124;
            return true;
        }
        if (options.signal?.aborted) {
            result.exitCode = 128 + signalNumber(abortSignal(options.signal));
            return true;
        }
        if (process.ppid !== parent) {
            result.exitCode = 143;
            return true;
        }
        return false;
    };
    let root;
    let plan;
    let nullFd;
    let errorCode;
    emit('validate');
    try {
        if (preCancelled())
            return result;
        const policy = check(options.policy);
        const requested = [...(options.grants ?? [])];
        const descriptors = grantStdio(requested);
        if (process.platform === 'linux' && Array.isArray(descriptors.stdio)) {
            // Node only marks a contiguous low descriptor prefix CLOEXEC on startup.
            // Explicitly overwrite every observed ambient target in the child while
            // leaving the trusted embedding host's descriptors and ownership intact.
            const ambient = readdirSync('/proc/self/fd').map(Number).filter(Number.isInteger);
            const maximum = Math.max(2, ...ambient);
            if (maximum > 65535)
                throw new RuntimeError('UNSUPPORTED_POLICY', 'ambient descriptor exceeds supported isolation bound 65535');
            while (descriptors.stdio.length <= maximum)
                descriptors.stdio.push('ignore');
        }
        // libuv's Linux UV_IGNORE branch does not close inherited high-number holes.
        // Map them explicitly to /dev/null so bwrap's contiguous preserve range is safe.
        if (Array.isArray(descriptors.stdio) && descriptors.stdio.includes('ignore')) {
            nullFd = openSync('/dev/null', 'r+');
            descriptors.stdio = descriptors.stdio.map(value => value === 'ignore' ? nullFd : value);
        }
        if (preCancelled())
            return result;
        root = mkdtempSync(join(resourceBase(), `sandbox-runtime-${result.runId}-`));
        emit('prepare');
        writeFileSync(join(root, 'owner.json'), JSON.stringify({ runId: result.runId, pid: process.pid, created: new Date().toISOString(), platform: process.platform }), { mode: 0o600 });
        const tempDir = policy.filesystem.temp === 'private' ? join(root, 'tmp') : '';
        if (tempDir)
            mkdirSync(tempDir, { mode: 0o700 });
        const env = safeEnvironment(policy, options.environment ?? process.env, tempDir);
        const cwd = options.cwd ? resolve(options.cwd) : process.cwd();
        const argv = resolveArgv(options.argv, cwd);
        const context = { argv, env, cwd, tempDir, rootDir: root, stdio: descriptors.stdio, grantedTargets: descriptors.targets, graceMs: grace, runtimePaths: runtimePaths() };
        plan = process.platform === 'darwin' ? prepareMacos(policy, context) : prepareLinux(policy, context);
        // Deliver pending host signals after synchronous filesystem validation.
        await immediate();
        if (preCancelled())
            return result;
        if (process.platform === 'linux' && Array.isArray(plan.options.stdio)) {
            // Refresh after the event-loop yield: an embedding host may have opened a
            // descriptor in the meantime. Preserve all deliberate backend mappings.
            const maximum = Math.max(2, ...readdirSync('/proc/self/fd').map(Number).filter(Number.isInteger));
            if (maximum > 65535)
                throw new RuntimeError('UNSUPPORTED_POLICY', 'ambient descriptor exceeds supported isolation bound 65535');
            if (plan.options.stdio.length <= maximum && nullFd === undefined)
                nullFd = openSync('/dev/null', 'r+');
            while (plan.options.stdio.length <= maximum)
                plan.options.stdio.push(nullFd);
        }
        grantStdio(requested);
        const child = spawn(plan.command, plan.args, plan.options);
        child.once('spawn', () => emit('supervisor-started'));
        let escalation;
        let deadline;
        let stopping = false;
        const control = plan.controlFd === undefined ? undefined : child.stdio[plan.controlFd];
        control?.on('error', () => { });
        const stop = (signal, forcedExit) => {
            if (stopping)
                return;
            stopping = true;
            if (forcedExit !== undefined)
                result.exitCode = forcedExit;
            emit('stopping');
            try {
                if (control)
                    control.write(`${JSON.stringify({ signal })}\n`);
                else
                    killGroup(child, signal);
            }
            catch { /* escalate below if the private control path is unavailable */ }
            escalation = setTimeout(() => { try {
                killGroup(child, 'SIGKILL');
            }
            catch { } }, grace);
        };
        const onAbort = () => stop(abortSignal(options.signal));
        options.signal?.addEventListener('abort', onAbort, { once: true });
        const parentWatch = setInterval(() => { if (process.ppid !== parent)
            stop('SIGTERM', 143); }, 100);
        if (timeout > 0)
            deadline = setTimeout(() => stop('SIGTERM', 124), Math.max(0, timeout - (performance.now() - started)));
        if (options.signal?.aborted)
            onAbort();
        try {
            const status = await new Promise((resolveExit, reject) => {
                child.once('error', reject);
                child.once('exit', (code, signal) => resolveExit({ code, signal }));
            });
            emit('supervisor-exited');
            if (result.exitCode === 0)
                result.exitCode = status.signal ? 128 + signalNumber(status.signal) : status.code ?? 1;
            if (status.signal)
                result.signal = status.signal;
        }
        catch (error) {
            throw new RuntimeError('SANDBOX_SETUP_FAILED', errorOf(error).message, { cause: error });
        }
        finally {
            clearInterval(parentWatch);
            if (deadline)
                clearTimeout(deadline);
            if (escalation)
                clearTimeout(escalation);
            options.signal?.removeEventListener('abort', onAbort);
            try {
                killGroup(child, 'SIGKILL');
            }
            catch { }
            control?.destroy();
        }
        return result;
    }
    catch (error) {
        errorCode = error instanceof RuntimeError ? error.code : 'SANDBOX_SETUP_FAILED';
        throw error;
    }
    finally {
        try {
            plan?.release();
        }
        catch (error) {
            result.cleanupError = errorOf(error);
        }
        if (nullFd !== undefined) {
            try {
                closeSync(nullFd);
            }
            catch (error) {
                result.cleanupError = errorOf(error);
            }
        }
        if (root) {
            emit('cleanup');
            try {
                rmSync(join(root, 'tmp'), { recursive: true, force: true });
                try {
                    unlinkSync(join(root, 'owner.json'));
                }
                catch (error) {
                    if (error.code !== 'ENOENT')
                        throw error;
                }
                rmdirSync(root);
            }
            catch (error) {
                result.cleanupError = errorOf(error);
            }
        }
        emit('finished', errorCode);
    }
}
//# sourceMappingURL=runner.js.map