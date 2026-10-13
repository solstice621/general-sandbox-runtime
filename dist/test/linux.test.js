import test from 'node:test';
import assert from 'node:assert/strict';
import { BPF, SECCOMP, seccompProgram, syscallTable } from '../src/backends/seccomp.js';
import { linuxMountPlan } from '../src/backends/linux.js';
/** Execute emitted bytes against synthetic struct seccomp_data. Kernel loading
 * and behavior are covered separately by the real Linux black-box suite. */
function evaluate(program, audit, syscall, args = []) {
    const data = Buffer.alloc(64);
    data.writeUInt32LE(syscall >>> 0, 0);
    data.writeUInt32LE(audit >>> 0, 4);
    args.forEach((argument, index) => data.writeBigUInt64LE(argument, 16 + index * 8));
    let accumulator = 0;
    for (let pc = 0; pc < program.length / 8; pc++) {
        const offset = pc * 8;
        const op = program.readUInt16LE(offset);
        const jt = program[offset + 2], jf = program[offset + 3], k = program.readUInt32LE(offset + 4);
        switch (op) {
            case BPF.load:
                accumulator = data.readUInt32LE(k);
                break;
            case BPF.equal:
                pc += accumulator === k ? jt : jf;
                break;
            case BPF.set:
                pc += (accumulator & k) !== 0 ? jt : jf;
                break;
            case BPF.and:
                accumulator = (accumulator & k) >>> 0;
                break;
            case BPF.ret: return k;
            default: throw new Error(`unknown instruction ${op}`);
        }
    }
    throw new Error('BPF execution fell off program');
}
for (const arch of ['x64', 'arm64']) {
    const abi = syscallTable(arch);
    test(`${arch} seccomp gates ABI, privileged syscalls and namespace creation`, () => {
        const program = seccompProgram(arch, 'deny');
        assert.equal(evaluate(program, 0, 0), SECCOMP.kill);
        if (arch === 'x64')
            assert.equal(evaluate(program, abi.audit, 0x40000000), SECCOMP.kill);
        for (const syscall of abi.deny)
            assert.equal(evaluate(program, abi.audit, syscall), SECCOMP.eperm, `syscall ${syscall}`);
        assert.equal(evaluate(program, abi.audit, abi.clone3), SECCOMP.enosys);
        assert.equal(evaluate(program, abi.audit, abi.clone, [0n]), SECCOMP.allow);
        assert.equal(evaluate(program, abi.audit, abi.clone, [0x10000n]), SECCOMP.allow);
        for (const flag of [0x20000n, 0x20000000n, 0x40000000n, 0x2000n])
            assert.equal(evaluate(program, abi.audit, abi.clone, [flag]), SECCOMP.eperm);
        assert.equal(evaluate(program, abi.audit, abi.ioctl, [0n, 0x5412n]), SECCOMP.eperm);
        assert.equal(evaluate(program, abi.audit, abi.ioctl, [0n, 0x541cn]), SECCOMP.eperm);
        assert.equal(evaluate(program, abi.audit, abi.ioctl, [0n, 0x5413n]), SECCOMP.allow);
    });
    test(`${arch} host mode permits IP TCP/UDP while denying Unix/raw socket routes`, () => {
        const host = seccompProgram(arch, 'host'), deny = seccompProgram(arch, 'deny');
        for (const domain of [2n, 10n]) {
            for (const type of [1n, 2n, 0x80001n, 0x80802n]) {
                assert.equal(evaluate(host, abi.audit, abi.socket, [domain, type]), SECCOMP.allow);
                assert.equal(evaluate(deny, abi.audit, abi.socket, [domain, type]), SECCOMP.eperm);
            }
        }
        for (const domain of [1n, 16n, 17n, 0x100000002n])
            assert.equal(evaluate(host, abi.audit, abi.socket, [domain, 1n]), SECCOMP.eperm);
        assert.equal(evaluate(host, abi.audit, abi.socket, [2n, 3n]), SECCOMP.eperm);
        for (const program of [host, deny]) {
            for (const type of [1n, 5n])
                assert.equal(evaluate(program, abi.audit, abi.socketpair, [1n, type]), SECCOMP.allow);
            for (const type of [2n, 3n])
                assert.equal(evaluate(program, abi.audit, abi.socketpair, [1n, type]), SECCOMP.eperm);
        }
    });
}
test('unsupported architecture and network mode fail before execution', () => {
    assert.throws(() => seccompProgram('ia32', 'deny'), { code: 'UNSUPPORTED_POLICY' });
    assert.throws(() => seccompProgram('x64', 'unknown'), { code: 'UNSUPPORTED_POLICY' });
});
test('mount order pins protected ancestors and prevents nested allows reopening denials', () => {
    const policy = { version: 1,
        filesystem: { read: 'host', temp: 'private', allowWrite: [{ path: '/workspace', scope: 'tree' }, { path: '/workspace/deep/secret/nested', scope: 'tree' }],
            denyWrite: [{ path: '/workspace/deep/locked', scope: 'file' }], denyRead: [{ path: '/workspace/deep/secret', scope: 'tree' }] },
        network: { mode: 'deny' }, ipc: { hostUnixSockets: 'deny' }, environment: { inherit: [] } };
    assert.deepEqual(linuxMountPlan(policy, '/tmp/private'), [
        { path: '/workspace', kind: 'rw' }, { path: '/tmp/private', kind: 'rw' }, { path: '/workspace/deep', kind: 'rw' },
        { path: '/workspace/deep/locked', kind: 'ro' }, { path: '/workspace/deep/secret', kind: 'hide-dir' },
    ]);
});
//# sourceMappingURL=linux.test.js.map