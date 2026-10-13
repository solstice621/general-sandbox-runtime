import assert from 'node:assert/strict';
import test from 'node:test';
import { checkMacos, MACOS_HELPER, prepareMacos, profile } from '../src/backends/macos.js';
function policy() {
    return {
        version: 1,
        filesystem: { read: 'host', denyRead: [], allowWrite: [], denyWrite: [], temp: 'private' },
        network: { mode: 'deny' },
        ipc: { hostUnixSockets: 'deny' },
        environment: { inherit: [] },
    };
}
test('Seatbelt quotes path metacharacters as a single literal', () => {
    const p = policy();
    const path = '/authorized/"quoted" \\ (allow default) 中文';
    p.filesystem.allowWrite.push({ path, scope: 'file' });
    const lines = profile(p, '').split('\n');
    const grants = lines.filter((line) => line.startsWith('(allow file-write*'));
    assert.deepEqual(grants, ['(allow file-write* (literal "/authorized/\\"quoted\\" \\\\ (allow default) 中文"))']);
    assert.equal(lines.includes('(allow default)'), false);
});
test('Seatbelt protects canonical and logical paths and their directory ancestors', () => {
    const p = policy();
    p.filesystem.allowWrite.push({ path: '/private/work/project', logical: '/work/project', scope: 'tree' });
    p.filesystem.denyWrite.push({ path: '/private/work/project/frozen/item', logical: '/work/project/frozen/item', scope: 'file' });
    p.filesystem.denyRead.push({ path: '/private/work/secret', logical: '/work/secret', scope: 'tree' });
    const rendered = profile(p, '/private/tmp/runtime-123');
    for (const spelling of ['/private/work/project', '/work/project']) {
        assert.ok(rendered.includes(`(allow file-write* (subpath "${spelling}"))`));
    }
    for (const spelling of ['/private/work/project/frozen/item', '/work/project/frozen/item']) {
        assert.ok(rendered.includes(`(deny file-write* (literal "${spelling}"))`));
    }
    for (const spelling of ['/private/work/secret', '/work/secret']) {
        assert.ok(rendered.includes(`(deny file-read* file-write* (subpath "${spelling}"))`));
    }
    const anchors = rendered.split('\n').filter((line) => line.startsWith('(deny file-write-unlink'));
    const expectedPaths = [
        '/', '/private', '/private/tmp', '/private/tmp/runtime-123', '/private/work',
        '/private/work/project', '/private/work/project/frozen', '/private/work/secret',
        '/work', '/work/project', '/work/project/frozen', '/work/secret',
    ];
    assert.deepEqual(anchors, expectedPaths.map((path) => `(deny file-write-unlink (require-all (vnode-type DIRECTORY) (literal "${path}")))`));
    assert.ok(rendered.includes('(allow file-write* (subpath "/private/tmp/runtime-123"))'));
});
test('host networking never grants named UNIX sockets or fcntl escape operations', () => {
    for (const mode of ['deny', 'host']) {
        const p = policy();
        p.network.mode = mode;
        const rendered = profile(p, '');
        assert.ok(rendered.includes('(allow system-socket (socket-domain AF_UNIX))'));
        assert.ok(rendered.includes('(deny network-bind (local unix-socket))'));
        assert.ok(rendered.includes('(deny network-outbound (remote unix-socket))'));
        assert.ok(rendered.includes('(deny mach-lookup (xpc-service-name-prefix ""))'));
        assert.ok(rendered.includes('(deny system-fcntl (fcntl-command 80 110))'));
        assert.equal(rendered.includes('(allow system-socket (socket-domain AF_INET))'), mode === 'host');
        assert.equal(rendered.includes('(allow system-socket (socket-domain AF_INET6))'), mode === 'host');
        assert.equal(rendered.includes('(allow network-outbound (remote ip "*:*"))'), mode === 'host');
    }
});
test('profile generation leaves policy rule lists unchanged', () => {
    const p = policy();
    p.filesystem.allowWrite.push({ path: '/authorized', scope: 'tree' });
    const before = structuredClone(p);
    Object.freeze(p.filesystem.allowWrite);
    Object.freeze(p.filesystem.denyRead);
    Object.freeze(p.filesystem.denyWrite);
    profile(p, '/private/tmp/private');
    assert.deepEqual(p, before);
});
test('macOS backend retains argv boundaries, explicit descriptors, and isolated process group', {
    skip: process.platform !== 'darwin',
}, () => {
    const p = policy();
    const context = {
        argv: ['/bin/sh', '-c', 'printf "%s" "$1"', '--', 'a;echo injection'],
        env: { PATH: '/usr/bin:/bin', HOME: '/private/tmp/runtime/home' },
        cwd: '/private/tmp',
        tempDir: '/private/tmp/runtime',
        rootDir: '/runtime',
        stdio: ['ignore', 'pipe', 'pipe', 7],
        grantedTargets: [3],
        graceMs: 200,
        runtimePaths: { root: '/runtime', node: '/usr/bin/node', linuxSupervisor: '/runtime/supervisor.js' },
    };
    const plan = prepareMacos(p, context);
    assert.equal(plan.command, MACOS_HELPER);
    assert.deepEqual(plan.args, ['-p', profile(p, context.tempDir), '--', ...context.argv]);
    assert.deepEqual(plan.options, { cwd: context.cwd, env: context.env, stdio: context.stdio, detached: true });
    assert.equal(plan.controlFd, undefined);
    plan.release();
    plan.release();
});
test('macOS backend reports unavailable on other operating systems', {
    skip: process.platform === 'darwin',
}, () => {
    assert.throws(() => checkMacos(policy()), { code: 'BACKEND_UNAVAILABLE' });
});
//# sourceMappingURL=macos.test.js.map