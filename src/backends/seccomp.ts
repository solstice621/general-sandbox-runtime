import { RuntimeError } from '../policy.js';

export interface Instruction { code: number; jt: number; jf: number; k: number }
export const BPF = { load: 0x20, equal: 0x15, set: 0x45, and: 0x54, ret: 0x06 } as const;
export const SECCOMP = { kill: 0x80000000, allow: 0x7fff0000, eperm: 0x00050001, enosys: 0x00050026 } as const;
export interface SyscallABI { audit: number; socket: number; socketpair: number; clone: number; clone3: number; ioctl: number; deny: number[] }

export function syscallTable(arch: string): SyscallABI {
  const common = [425, 426, 427, 428, 429, 430, 431, 432, 433, 438, 442];
  if (arch === 'x64') return { audit: 0xc000003e, socket: 41, socketpair: 53, clone: 56, clone3: 435, ioctl: 16,
    deny: [...common, 101, 103, 133, 155, 161, 165, 166, 167, 168, 169, 170, 171, 172, 173, 174, 175, 176,
      179, 246, 248, 249, 250, 259, 272, 298, 300, 303, 304, 308, 310, 311, 313, 320, 321, 323] };
  if (arch === 'arm64') return { audit: 0xc00000b7, socket: 198, socketpair: 199, clone: 220, clone3: 435, ioctl: 29,
    deny: [...common, 33, 39, 40, 41, 51, 89, 97, 104, 105, 106, 116, 117, 142, 161, 162, 163,
      171, 217, 218, 224, 225, 241, 262, 264, 265, 268, 270, 271, 273, 280, 282] };
  throw new RuntimeError('UNSUPPORTED_POLICY', `seccomp supports only Linux x64 and arm64, got ${arch}`);
}

const load = (k: number): Instruction => ({ code: BPF.load, jt: 0, jf: 0, k });
const ret = (k: number): Instruction => ({ code: BPF.ret, jt: 0, jf: 0, k });
const eq = (k: number, jt: number, jf: number): Instruction => ({ code: BPF.equal, k, jt, jf });

/** Native classic-BPF bytes consumed by Bubblewrap. No native addon or helper. */
export function seccompProgram(arch: string, network: string): Buffer {
  const a = syscallTable(arch);
  if (network !== 'deny' && network !== 'host') throw new RuntimeError('UNSUPPORTED_POLICY', `unsupported network mode ${network}`);
  const f: Instruction[] = [load(4), eq(a.audit, 1, 0), ret(SECCOMP.kill), load(0)];
  if (arch === 'x64') f.push({ code: BPF.set, k: 0x40000000, jt: 0, jf: 1 }, ret(SECCOMP.kill));
  for (const nr of a.deny) f.push(eq(nr, 0, 1), ret(SECCOMP.eperm));
  // libc must be able to fall back from clone3 to its legacy thread syscall.
  f.push(eq(a.clone3, 0, 1), ret(SECCOMP.enosys));
  // Prevent terminal injection even when stdin is a caller-authorized TTY.
  f.push(eq(a.ioctl, 0, 5), load(24), eq(0x5412, 2, 0), eq(0x541c, 1, 0), ret(SECCOMP.allow), ret(SECCOMP.eperm));
  // Namespace creation and CLONE_PTRACE are forbidden; ordinary threads work.
  f.push(eq(a.clone, 0, 4), load(16), { code: BPF.set, k: 0x7e022000, jt: 0, jf: 1 }, ret(SECCOMP.eperm), ret(SECCOMP.allow));
  if (network === 'deny') f.push(eq(a.socket, 0, 1), ret(SECCOMP.eperm));
  else {
    const body = [load(20), eq(0, 1, 0), ret(SECCOMP.eperm), load(16), eq(2, 2, 0), eq(10, 1, 0), ret(SECCOMP.eperm),
      load(24), { code: BPF.and, k: 0xf, jt: 0, jf: 0 }, eq(1, 2, 0), eq(2, 1, 0), ret(SECCOMP.eperm), ret(SECCOMP.allow)];
    f.push(eq(a.socket, 0, body.length), ...body);
  }
  // Unix datagram pairs can reconnect/sendto host endpoints. Only connected
  // STREAM/SEQPACKET pairs are allowed, including Node's anonymous IPC pipes.
  const pair = [load(20), eq(0, 1, 0), ret(SECCOMP.eperm), load(16), eq(1, 1, 0), ret(SECCOMP.eperm),
    load(24), { code: BPF.and, k: 0xf, jt: 0, jf: 0 }, eq(1, 2, 0), eq(5, 1, 0), ret(SECCOMP.eperm), ret(SECCOMP.allow)];
  f.push(eq(a.socketpair, 0, pair.length), ...pair, ret(SECCOMP.allow));
  const out = Buffer.alloc(f.length * 8);
  f.forEach((op, i) => { out.writeUInt16LE(op.code, i * 8); out[i * 8 + 2] = op.jt; out[i * 8 + 3] = op.jf; out.writeUInt32LE(op.k >>> 0, i * 8 + 4); });
  return out;
}
