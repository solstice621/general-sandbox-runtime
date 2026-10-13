/** Trusted namespace-local entry point. The workload never receives its control channel. */
import fs from 'node:fs';
import { constants as osConstants } from 'node:os';
import { spawn } from 'node:child_process';
import { Socket } from 'node:net';
import { fileURLToPath } from 'node:url';
const permittedSignals = new Set(['SIGHUP', 'SIGINT', 'SIGQUIT', 'SIGTERM', 'SIGUSR1', 'SIGUSR2', 'SIGWINCH', 'SIGCONT']);
const MAX_CONFIG_BYTES = 8 * 1024 * 1024;
const MAX_CONTROL_BYTES = 4096;
function descriptor(value) {
    if (value === undefined || !/^[0-9]+$/u.test(value))
        throw new Error('invalid private descriptor');
    const fd = Number(value);
    if (!Number.isSafeInteger(fd) || fd < 3 || fd > 131072)
        throw new Error('invalid private descriptor');
    return fd;
}
function readConfig(fd) {
    try {
        const info = fs.fstatSync(fd);
        if (!info.isFile() || info.nlink !== 0 || info.size > MAX_CONFIG_BYTES)
            throw new Error('invalid private launch configuration');
        const bytes = fs.readFileSync(fd);
        if (bytes.length > MAX_CONFIG_BYTES)
            throw new Error('oversized launch configuration');
        const config = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
        if (config === null || typeof config !== 'object')
            throw new Error('invalid launch configuration');
        const value = config;
        if (!Array.isArray(value.argv) || value.argv.length === 0 || value.argv.some((arg) => typeof arg !== 'string' || arg.includes('\0')) || !value.argv[0])
            throw new Error('invalid payload command');
        if (typeof value.cwd !== 'string' || !value.cwd.startsWith('/') || value.cwd.includes('\0'))
            throw new Error('invalid payload working directory');
        if (value.env === null || typeof value.env !== 'object' || Array.isArray(value.env) || Object.entries(value.env).some(([name, entry]) => name === '' || name.includes('=') || name.includes('\0') || typeof entry !== 'string' || entry.includes('\0')))
            throw new Error('invalid payload environment');
        if (!Array.isArray(value.grantedTargets) || value.grantedTargets.some((fd) => !Number.isSafeInteger(fd) || fd < 3 || fd > 1024) || new Set(value.grantedTargets).size !== value.grantedTargets.length)
            throw new Error('invalid payload descriptor grants');
        if (typeof value.graceMs !== 'number' || !Number.isFinite(value.graceMs) || value.graceMs < 0 || value.graceMs > 5000)
            throw new Error('invalid signal grace period');
        return value;
    }
    finally {
        fs.closeSync(fd);
    }
}
/** Defense in depth after the host replaces every unapproved inherited target
 * with /dev/null. This removes non-CLOEXEC leftovers while retaining Node's own
 * event-loop descriptors. This filter alone is not an inheritance boundary:
 * Node startup can mark inherited descriptors CLOEXEC before this code runs. */
export function closeAmbientDescriptors(approved) {
    for (const name of fs.readdirSync('/proc/self/fd')) {
        if (!/^[0-9]+$/u.test(name))
            continue;
        const fd = Number(name);
        if (fd < 3 || approved.has(fd))
            continue;
        let info;
        try {
            info = fs.readFileSync(`/proc/self/fdinfo/${fd}`, 'utf8');
        }
        catch (cause) {
            if (cause.code === 'ENOENT')
                continue;
            throw cause;
        }
        const match = /^flags:\s+([0-7]+)$/mu.exec(info);
        if (match === null)
            throw new Error(`cannot determine descriptor flags for ${fd}`);
        const flags = Number.parseInt(match[1], 8);
        if ((flags & 0o2000000) === 0)
            fs.closeSync(fd);
    }
}
export function supervise(configFd, controlFd) {
    if (configFd === controlFd)
        throw new Error('private descriptors overlap');
    const config = readConfig(configFd);
    if (config.grantedTargets.includes(controlFd) || config.grantedTargets.includes(configFd))
        throw new Error('private descriptor overlaps workload grant');
    // An anonymous socketpair cannot be reopened through /proc/<pid>/fd, unlike
    // an ordinary pipe which would let the workload forge controller messages.
    if (!fs.fstatSync(controlFd).isSocket())
        throw new Error('signal control channel must be an anonymous socketpair');
    closeAmbientDescriptors(new Set([controlFd, ...config.grantedTargets]));
    const control = new Socket({ fd: controlFd, readable: true, writable: false });
    const nullFd = fs.openSync('/dev/null', fs.constants.O_RDWR);
    const stdio = [0, 1, 2];
    const maxTarget = Math.max(2, ...config.grantedTargets);
    const grants = new Set(config.grantedTargets);
    for (let target = 3; target <= maxTarget; target++)
        stdio.push(grants.has(target) ? target : nullFd);
    let child;
    let finished = false;
    let stopping = false;
    let timer;
    let buffer = '';
    const killGroup = (signal) => {
        if (child?.pid === undefined)
            return;
        try {
            process.kill(-child.pid, signal);
        }
        catch (cause) {
            if (cause.code !== 'ESRCH')
                throw cause;
        }
    };
    const finish = (code) => {
        if (finished)
            return;
        finished = true;
        if (timer !== undefined)
            clearTimeout(timer);
        try {
            killGroup('SIGKILL');
        }
        catch { /* Namespace teardown is the final boundary. */ }
        control.destroy();
        // Wait for child exit, not close: escaped descendants can retain stdio.
        process.exit(code);
    };
    const failClosed = () => {
        if (finished || stopping)
            return;
        stopping = true;
        try {
            killGroup('SIGTERM');
        }
        catch {
            finish(125);
            return;
        }
        timer = setTimeout(() => finish(125), config.graceMs);
    };
    control.on('data', (chunk) => {
        if (finished || stopping)
            return;
        buffer += chunk.toString('utf8');
        if (Buffer.byteLength(buffer) > MAX_CONTROL_BYTES) {
            failClosed();
            return;
        }
        for (;;) {
            const newline = buffer.indexOf('\n');
            if (newline < 0)
                break;
            const line = buffer.slice(0, newline);
            buffer = buffer.slice(newline + 1);
            try {
                const message = JSON.parse(line);
                if (message === null || typeof message !== 'object' || Array.isArray(message) || Object.keys(message).length !== 1 || !Object.hasOwn(message, 'signal'))
                    throw new Error('invalid control frame');
                const signal = message.signal;
                if (typeof signal !== 'string' || !permittedSignals.has(signal))
                    throw new Error('invalid control signal');
                killGroup(signal);
            }
            catch {
                failClosed();
                return;
            }
        }
    });
    control.on('end', failClosed);
    control.on('error', failClosed);
    try {
        child = spawn(config.argv[0], config.argv.slice(1), { cwd: config.cwd, env: config.env, stdio, detached: true });
        child.on('error', () => finish(127));
        child.on('exit', (code, signal) => finish(code ?? (signal === null ? 125 : 128 + (osConstants.signals[signal] ?? 0))));
    }
    finally {
        fs.closeSync(nullFd);
        // Only the payload retains application grants; EOF must not depend on this
        // supervisor's lifetime. Node's child spawn duplicates them synchronously.
        for (const fd of config.grantedTargets)
            fs.closeSync(fd);
    }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
    try {
        supervise(descriptor(process.argv[2]), descriptor(process.argv[3]));
    }
    catch (cause) {
        process.stderr.write(`sandbox-runtime: Linux supervisor setup failed: ${cause instanceof Error ? cause.message : String(cause)}\n`);
        process.exit(125);
    }
}
//# sourceMappingURL=linux-supervisor.js.map