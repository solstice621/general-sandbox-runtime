import type { Policy, Rule } from './policy.js';
export { SAFE_PATH } from './policy.js';
/** Public configuration uses wire rules; logical is private runtime normalization metadata. */
export type AdapterRule = Pick<Rule, 'path' | 'scope'>;
export interface ClientConfig {
    readonly scope: 'bash-only';
    readonly runnerPath: string;
    readonly network?: 'deny' | 'host';
    readonly denyRead?: readonly AdapterRule[];
    readonly denyWrite?: readonly AdapterRule[];
    readonly checkTimeoutMs?: number;
    readonly protectedPaths?: readonly string[];
}
export interface ExecutionPolicy {
    readonly mode: 'read-only' | 'workspace-write' | 'danger-full-access';
    readonly workspaceRoot: string;
    readonly sessionId?: string;
}
export interface PreparedCommand {
    argv: string[];
    enforcement: 'full';
    denialSignatures: string[];
    runnerFailureRules: [];
}
export declare class AdapterError extends Error {
    readonly code: 'INVALID_ADAPTER_CONFIG' | 'UNSUPPORTED_CONSUMER' | 'SANDBOX_UNAVAILABLE';
    constructor(code: AdapterError['code'], message: string);
}
export declare function unsupported(message: string): never;
/** Host-neutral preparation. Launch only with safeEnvironment(); argv alone does not secure a loader. */
export declare class RuntimeClient {
    #private;
    constructor(config: ClientConfig);
    safeEnvironment(): NodeJS.ProcessEnv;
    policyFor(policy: ExecutionPolicy): Policy;
    confine(argv: readonly string[], policy: ExecutionPolicy, signal?: AbortSignal): Promise<PreparedCommand>;
    /** One-shot, identity-based authorization, never a command-prefix heuristic. */
    consumePrepared(argv: readonly string[]): void;
}
