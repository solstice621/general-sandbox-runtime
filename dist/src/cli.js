import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { communicationGrant, check, run } from './runner.js';
import { MAX_POLICY_BYTES, parsePolicy, RuntimeError, safeEnvironment } from './policy.js';
import { RuntimeClient } from './client.js';
const parentPID = process.ppid;
const abort = new AbortController();
const handledSignals = ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT'];
const signalHandlers = new Map();
for (const signal of handledSignals) {
    const handler = () => abort.abort({ signal });
    process.on(signal, handler);
    signalHandlers.set(signal, handler);
}
function invalid(message) { throw new RuntimeError('INVALID_POLICY', message); }
function duration(value) {
    if (value === '0')
        return 0;
    const units = { ns: 1e-6, us: 1e-3, 'µs': 1e-3, ms: 1, s: 1000, m: 60000, h: 3600000 };
    let result = 0;
    let length = 0;
    for (const match of value.matchAll(/(\d+(?:\.\d+)?)(ns|us|µs|ms|s|m|h)/gu)) {
        if (match.index !== length)
            invalid('invalid duration');
        result += Number(match[1]) * units[match[2]];
        length += match[0].length;
    }
    if (length !== value.length || length === 0 || !Number.isFinite(result))
        invalid('invalid duration');
    return result;
}
function sourceGrants(specs) {
    const snapshot = process.env.SANDBOX_RUNTIME_SOURCE_SNAPSHOT ?? '';
    delete process.env.SANDBOX_RUNTIME_SOURCE_SNAPSHOT;
    const sources = snapshot ? snapshot.split(',') : [];
    const parsed = specs.map(spec => {
        if (!/^[1-9]\d*:[1-9]\d*$/u.test(spec))
            invalid('FD grant requires canonical source:target');
        const [source, target] = spec.split(':').map(Number);
        return { source, target };
    });
    if (sources.join(',') !== parsed.map(({ source }) => String(source)).join(',')) {
        invalid('caller FD snapshot missing or mismatched; use the installed launcher for CLI FD grants');
    }
    const targets = new Set();
    // Every factory call is fstat-only. No allocations may substitute later absent sources.
    return parsed.map(({ source, target }) => {
        if (targets.has(target))
            invalid('duplicate target FD');
        targets.add(target);
        return communicationGrant(source, target);
    });
}
function readPolicyFile(path) {
    let fd;
    try {
        fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
        if (!fstatSync(fd).isFile())
            invalid('policy-file must be a regular file');
        const data = Buffer.alloc(MAX_POLICY_BYTES + 1);
        let offset = 0;
        while (offset < data.length) {
            const count = readSync(fd, data, offset, data.length - offset, null);
            if (count === 0)
                break;
            offset += count;
        }
        return data.subarray(0, offset);
    }
    catch (error) {
        if (error instanceof RuntimeError)
            throw error;
        return invalid('cannot read policy-file');
    }
    finally {
        if (fd !== undefined)
            closeSync(fd);
    }
}
async function main() {
    const [action, ...args] = process.argv.slice(2);
    if (action === 'version') {
        process.stdout.write('sandbox-runtime 0.3.0 (TypeScript)\n');
        return 0;
    }
    if (action === 'prepare') {
        if (args.length !== 2 || args[0] !== '--request-json' || Buffer.byteLength(args[1]) > 131072)
            invalid('prepare requires one request-json argument, at most 128 KiB');
        const request = JSON.parse(args[1]);
        if (typeof request !== 'object' || request === null || Object.keys(request).sort().join(',') !== 'argv,config,policy')
            invalid('invalid prepare request');
        const data = request;
        const client = new RuntimeClient(data.config);
        const prepared = await client.confine(data.argv, data.policy, abort.signal);
        client.consumePrepared(prepared.argv);
        process.stdout.write(`${JSON.stringify({ version: 1, policyJSON: prepared.argv[3], environment: client.safeEnvironment() })}\n`);
        return 0;
    }
    if (action !== 'check' && action !== 'run')
        invalid('expected check or run');
    const values = new Map();
    const specs = [];
    let diagnostics = false;
    let argv = [];
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === '--') {
            argv = args.slice(i + 1);
            break;
        }
        if (!arg.startsWith('--')) {
            argv = args.slice(i);
            break;
        }
        const equals = arg.indexOf('=');
        const name = equals < 0 ? arg : arg.slice(0, equals);
        let value = equals < 0 ? undefined : arg.slice(equals + 1);
        if (name === '--diagnostics') {
            if (value !== undefined && value !== 'true' && value !== 'false')
                invalid('diagnostics requires true or false');
            diagnostics = value !== 'false';
            continue;
        }
        if (!['--policy-file', '--policy-json', '--timeout', '--grace', '--grant-fd'].includes(name))
            invalid(`unknown option ${name}`);
        if (value === undefined)
            value = args[++i];
        if (value === undefined)
            invalid(`missing value for ${name}`);
        if (name === '--grant-fd')
            specs.push(value);
        else {
            if (values.has(name))
                invalid(`duplicate option ${name}`);
            values.set(name, value);
        }
    }
    if (values.has('--policy-file') === values.has('--policy-json'))
        invalid('exactly one policy source is required');
    const timeoutMs = duration(values.get('--timeout') ?? '0');
    const graceMs = duration(values.get('--grace') ?? '500ms');
    if (timeoutMs > 2147483647)
        invalid('timeout must be 0..2147483647ms');
    if (graceMs > 5000)
        invalid('grace must be 0..5s');
    const preparationStarted = performance.now();
    const grants = sourceGrants(specs);
    const policy = parsePolicy(values.has('--policy-file') ? readPolicyFile(values.get('--policy-file')) : values.get('--policy-json'));
    if (action === 'check') {
        if (argv.length)
            invalid('check does not accept a command');
        check(policy);
        safeEnvironment({ ...policy, filesystem: { ...policy.filesystem, temp: 'none' } }, process.env, '');
        process.stdout.write(`${JSON.stringify({ ok: true, platform: process.platform, network: policy.network.mode, version: 1, scope: 'preflight; run rechecks and applies OS isolation' })}\n`);
        return 0;
    }
    if (!argv.length)
        invalid('run requires command after --');
    const remainingMs = timeoutMs > 0 ? Math.max(Number.EPSILON, timeoutMs - (performance.now() - preparationStarted)) : 0;
    const result = await run({ policy, argv, grants, parentPID, timeoutMs: remainingMs, graceMs, signal: abort.signal,
        observe: diagnostics ? event => { process.stderr.write(`${JSON.stringify(event)}\n`); } : undefined });
    if (result.cleanupError)
        process.stderr.write(`sandbox-runtime: cleanup failed run=${result.runId}: ${result.cleanupError.message}\n`);
    return result.exitCode;
}
let exitCode;
try {
    exitCode = await main();
}
catch (error) {
    const code = error instanceof RuntimeError ? error.code : 'SANDBOX_SETUP_FAILED';
    process.stderr.write(`sandbox-runtime: ${code}: ${error instanceof Error ? error.message : String(error)}\n`);
    exitCode = 125;
}
finally {
    for (const [signal, handler] of signalHandlers)
        process.off(signal, handler);
}
process.exitCode = exitCode;
//# sourceMappingURL=cli.js.map