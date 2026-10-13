export declare const INVALID_POLICY = "INVALID_POLICY";
export declare const UNSUPPORTED_POLICY = "UNSUPPORTED_POLICY";
export declare const BACKEND_UNAVAILABLE = "BACKEND_UNAVAILABLE";
export declare const SANDBOX_SETUP_FAILED = "SANDBOX_SETUP_FAILED";
export declare const MAX_POLICY_BYTES: number;
export declare const MAX_AUDIT_ENTRIES = 100000;
export declare const SAFE_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
export declare class RuntimeError extends Error {
    readonly code: string;
    constructor(code: string, message: string, options?: ErrorOptions);
}
export interface Rule {
    readonly path: string;
    readonly scope: "file" | "tree";
    /** Internal original spelling. Non-enumerable on normalized rules; never a wire field. */
    readonly logical?: string;
}
export interface Policy {
    readonly version: 1;
    readonly filesystem: {
        readonly read: "host";
        readonly denyRead: readonly Rule[];
        readonly allowWrite: readonly Rule[];
        readonly denyWrite: readonly Rule[];
        readonly temp: "none" | "private";
    };
    readonly network: {
        readonly mode: "deny" | "host";
    };
    readonly ipc: {
        readonly hostUnixSockets: "deny";
    };
    readonly environment: {
        readonly inherit: readonly string[];
    };
}
/** Parses the original UTF-8 wire representation; logical is intentionally not a wire field. */
export declare function parsePolicy(data: string | Uint8Array): Policy;
/** Validates current filesystem state and returns an independent immutable snapshot. */
export declare function validatePolicy(input: Policy): Policy;
/** Protects trusted installation paths even when a broader writable ancestor is granted. */
export declare function addProtected(input: Policy, ...paths: string[]): Policy;
/** Must also be applied by the trusted launcher BEFORE it starts Node/Runner. */
export declare function safeEnvironment(input: Policy, environment: NodeJS.ProcessEnv, tempDir: string): NodeJS.ProcessEnv;
