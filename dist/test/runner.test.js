import assert from 'node:assert/strict';
import test, {} from 'node:test';
import { spawnSync } from 'node:child_process';
import { closeSync, constants, existsSync, fstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { communicationGrant, run } from '../src/runner.js';
function policy(workspace) {
    return { version: 1,
        filesystem: { read: 'host', denyRead: [], allowWrite: workspace ? [{ path: workspace, scope: 'tree' }] : [], denyWrite: [], temp: workspace ? 'private' : 'none' },
        network: { mode: 'deny' }, ipc: { hostUnixSockets: 'deny' }, environment: { inherit: [] } };
}
function fixture(t) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'sandbox-api-test-')));
    const workspace = join(root, 'workspace');
    mkdirSync(workspace);
    t.after(() => rmSync(root, { recursive: true, force: true }));
    return { root, workspace, marker: join(workspace, 'payload-marker') };
}
function markerCommand(marker) {
    // Positional arguments preserve paths without constructing shell source from them.
    return ['/bin/sh', '-c', 'printf executed > "$1"', 'marker-command', marker];
}
test('pre-aborted API invocation returns its signal result without preparation or side effects', async (t) => {
    const f = fixture(t), controller = new AbortController(), events = [];
    controller.abort({ signal: 'SIGINT' });
    const result = await run({ policy: policy(f.workspace), argv: markerCommand(f.marker), signal: controller.signal, observe: event => events.push(event) });
    assert.equal(result.exitCode, 130);
    assert.equal(result.cleanupError, undefined);
    assert.match(result.runId, /^[a-f0-9]{24}$/u);
    assert.equal(existsSync(f.marker), false);
    assert.deepEqual(events.map(event => event.phase), ['validate', 'finished']);
    assert.equal(events.at(-1)?.exitCode, 130);
});
test('caller identity mismatch blocks API preparation and payload launch', async (t) => {
    const f = fixture(t), events = [];
    const result = await run({ policy: policy(f.workspace), argv: markerCommand(f.marker), parentPID: process.ppid + 1, observe: event => events.push(event) });
    assert.equal(result.exitCode, 143);
    assert.equal(existsSync(f.marker), false);
    assert.deepEqual(events.map(event => event.phase), ['validate', 'finished']);
});
test('deadline already consumed by API entry blocks preparation and payload launch', async (t) => {
    const f = fixture(t), events = [];
    const result = await run({ policy: policy(f.workspace), argv: markerCommand(f.marker), timeoutMs: 1e-9, observe: event => events.push(event) });
    assert.equal(result.exitCode, 124);
    assert.equal(existsSync(f.marker), false);
    assert.deepEqual(events.map(event => event.phase), ['validate', 'finished']);
});
test('invalid and timer-overflow API deadlines fail before any preparation', async () => {
    for (const timeoutMs of [-1, NaN, Infinity, 2147483648]) {
        await assert.rejects(run({ policy: policy(), argv: ['/usr/bin/true'], timeoutMs }), { code: 'INVALID_POLICY' });
    }
    for (const graceMs of [-1, NaN, Infinity, 5001]) {
        await assert.rejects(run({ policy: policy(), argv: ['/usr/bin/true'], graceMs }), { code: 'INVALID_POLICY' });
    }
});
test('communication grant factory refuses invalid indices, unavailable handles and regular files', t => {
    for (const [source, target] of [[2, 7], [1025, 7], [3, 2], [3, 65], [3.5, 7], [3, 7.5], [NaN, 7]]) {
        assert.throws(() => communicationGrant(source, target), { code: 'INVALID_POLICY' });
    }
    const f = fixture(t), path = join(f.root, 'ordinary-file');
    writeFileSync(path, 'original');
    const fd = openSync(path, 'r');
    try {
        assert.throws(() => communicationGrant(fd, 7), { code: 'INVALID_POLICY' });
    }
    finally {
        closeSync(fd);
    }
    assert.throws(() => communicationGrant(fd, 7), { code: 'INVALID_POLICY' });
    assert.equal(readFileSync(path, 'utf8'), 'original');
});
// Actual API execution is opt-in because ordinary unit-test environments can
// themselves prohibit Seatbelt or user namespaces. Once enabled, missing or
// broken isolation is a failure, never a conditional skip or ordinary execution.
const integration = { skip: process.env.SANDBOX_RUNTIME_INTEGRATION !== '1', timeout: 10000 };
function pipeFixture(t, root) {
    const path = join(root, 'application-pipe');
    const made = spawnSync('/usr/bin/mkfifo', [path], { encoding: 'utf8' });
    assert.equal(made.status, 0, made.stderr || String(made.error));
    const fd = openSync(path, constants.O_RDWR | constants.O_NONBLOCK);
    let open = true;
    const close = () => { if (open) {
        closeSync(fd);
        open = false;
    } };
    t.after(close);
    return { fd, close };
}
test('API grants require opaque factory objects, reject duplicate targets, and revalidate live identity', integration, async (t) => {
    const f = fixture(t), pipe = pipeFixture(t, f.root);
    const grant = communicationGrant(pipe.fd, 7);
    assert.equal(Object.isFrozen(grant), true);
    const options = { policy: policy(f.workspace), argv: markerCommand(f.marker) };
    await assert.rejects(run({ ...options, grants: [{ source: pipe.fd, target: 7 }] }), { code: 'INVALID_POLICY' });
    await assert.rejects(run({ ...options, grants: [grant, communicationGrant(pipe.fd, 7)] }), { code: 'INVALID_POLICY' });
    const phases = [];
    await assert.rejects(run({ ...options, grants: [grant], observe: event => {
            phases.push(event.phase);
            if (event.phase === 'prepare')
                pipe.close();
        } }), { code: 'INVALID_POLICY' });
    assert.ok(phases.includes('prepare'));
    assert.ok(phases.includes('cleanup'));
    assert.equal(phases.includes('supervisor-started'), false);
    assert.equal(existsSync(f.marker), false);
});
test('explicit API communication grant reaches a child and remains owned by the caller', integration, async (t) => {
    const f = fixture(t), pipe = pipeFixture(t, f.root);
    const result = await run({ policy: policy(f.workspace), argv: ['/bin/sh', '-c', '/bin/sh -c \'printf fd-authorized >&7\''], grants: [communicationGrant(pipe.fd, 7)], cwd: f.workspace });
    assert.equal(result.exitCode, 0);
    assert.equal(result.cleanupError, undefined);
    const bytes = Buffer.alloc(64);
    assert.equal(bytes.subarray(0, readSync(pipe.fd, bytes, 0, bytes.length, null)).toString(), 'fd-authorized');
    assert.equal(fstatSync(pipe.fd).isFIFO(), true, 'run must not close the embedding caller descriptor');
});
async function waitForFile(path) {
    const limit = performance.now() + 5000;
    while (!existsSync(path)) {
        assert.ok(performance.now() < limit, `payload readiness file was not created: ${path}`);
        await delay(10);
    }
}
test('API cancellation reaches the payload handler, preserves its exit and cleans private temp', integration, async (t) => {
    const f = fixture(t), controller = new AbortController(), events = [];
    const ready = join(f.workspace, 'ready');
    const fallback = setTimeout(() => controller.abort(), 6000);
    t.after(() => clearTimeout(fallback));
    const execution = run({ policy: policy(f.workspace), argv: ['/bin/sh', '-c', 'trap "exit 23" TERM; printf "%s" "$TMPDIR" > "$1"; while :; do sleep 1; done', 'signal-handler', ready],
        cwd: f.workspace, graceMs: 1500, signal: controller.signal, observe: event => events.push(event) });
    try {
        await waitForFile(ready);
    }
    finally {
        controller.abort({ signal: 'SIGTERM' });
    }
    const result = await execution;
    assert.equal(result.exitCode, 23);
    assert.equal(result.cleanupError, undefined);
    assert.equal(existsSync(readFileSync(ready, 'utf8')), false, 'private temp must be cleaned after the payload handler exits');
    assert.equal(events.filter(event => event.phase === 'stopping').length, 1);
    assert.equal(events.at(-1)?.phase, 'finished');
    assert.equal(events.at(-1)?.exitCode, 23);
});
test('API execution deadline terminates an unresponsive payload and removes private temp', integration, async (t) => {
    const f = fixture(t), ready = join(f.workspace, 'deadline-ready');
    const began = performance.now();
    const result = await run({ policy: policy(f.workspace), argv: ['/bin/sh', '-c', 'trap "" TERM; printf "%s" "$TMPDIR" > "$1"; while :; do sleep 1; done', 'deadline', ready],
        cwd: f.workspace, timeoutMs: 1000, graceMs: 100 });
    assert.equal(result.exitCode, 124);
    assert.equal(result.cleanupError, undefined);
    assert.ok(existsSync(ready), 'payload must actually start to exercise running deadline escalation');
    assert.equal(existsSync(readFileSync(ready, 'utf8')), false);
    assert.ok(performance.now() - began < 6000, 'deadline must finish without leaving a live supervisor wait');
});
//# sourceMappingURL=runner.test.js.map