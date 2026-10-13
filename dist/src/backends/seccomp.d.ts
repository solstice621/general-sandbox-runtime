export interface Instruction {
    code: number;
    jt: number;
    jf: number;
    k: number;
}
export declare const BPF: {
    readonly load: 32;
    readonly equal: 21;
    readonly set: 69;
    readonly and: 84;
    readonly ret: 6;
};
export declare const SECCOMP: {
    readonly kill: 2147483648;
    readonly allow: 2147418112;
    readonly eperm: 327681;
    readonly enosys: 327718;
};
export interface SyscallABI {
    audit: number;
    socket: number;
    socketpair: number;
    clone: number;
    clone3: number;
    ioctl: number;
    deny: number[];
}
export declare function syscallTable(arch: string): SyscallABI;
/** Native classic-BPF bytes consumed by Bubblewrap. No native addon or helper. */
export declare function seccompProgram(arch: string, network: string): Buffer;
