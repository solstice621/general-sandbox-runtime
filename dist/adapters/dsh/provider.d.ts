import type { ConfinedArgv, SandboxPolicy } from '@deepseek-ai/dsh-sandbox';
import type { Policy, Rule } from '../../src/policy.js';
export { SAFE_PATH } from '../../src/policy.js';
export declare const DSH_COMMIT = "d743267388641bc76f17c45ce8b4c231aed1d32c";
/** Public configuration uses wire rules; logical is private runtime normalization metadata. */
export type AdapterRule = Pick<Rule, 'path' | 'scope'>;
export interface AdapterConfig {
    readonly scope: 'bash-only';
    readonly runnerPath: string;
    readonly network?: 'deny' | 'host';
    readonly denyRead?: readonly AdapterRule[];
    readonly denyWrite?: readonly AdapterRule[];
    readonly checkTimeoutMs?: number;
}
export declare class AdapterError extends Error {
    readonly code: 'INVALID_ADAPTER_CONFIG' | 'UNSUPPORTED_CONSUMER' | 'SANDBOX_UNAVAILABLE';
    constructor(code: AdapterError['code'], message: string);
}
export declare function unsupported(message: string): never;
/** Also use the private launch boundary in plugin.ts: argv alone cannot secure the loader environment. */
export declare class RuntimeSandboxProvider {
    #private;
    constructor(config: AdapterConfig);
    safeEnvironment(): NodeJS.ProcessEnv;
    policyFor(policy: SandboxPolicy): Policy;
    confine(argv: readonly string[], policy: SandboxPolicy, signal?: AbortSignal): Promise<ConfinedArgv>;
    /** One-shot, identity-based authorization, never a command-prefix heuristic. */
    consumePrepared(argv: readonly string[]): void;
}
