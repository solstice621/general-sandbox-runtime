import { type Policy } from './policy.js';
import type { RuntimePaths } from './backend-types.js';
export interface RunEvent {
    runId: string;
    backend: string;
    policyDigest: string;
    phase: string;
    exitCode?: number;
    errorCode?: string;
    cleanupFailed: boolean;
}
export interface RunResult {
    exitCode: number;
    signal?: NodeJS.Signals;
    cleanupError?: Error;
    runId: string;
}
declare const grantBrand: unique symbol;
/** Only communicationGrant() can create a valid grant; the object holds no ownership of the caller FD. */
export interface CommunicationGrant {
    readonly source: number;
    readonly target: number;
    readonly [grantBrand]: true;
}
/** The trusted embedding host must own this live pipe/socket until run() has spawned. */
export declare function communicationGrant(source: number, target: number): CommunicationGrant;
export interface RunOptions {
    policy: Policy;
    argv: readonly string[];
    grants?: readonly CommunicationGrant[];
    signal?: AbortSignal;
    timeoutMs?: number;
    graceMs?: number;
    parentPID?: number;
    cwd?: string;
    environment?: NodeJS.ProcessEnv;
    observe?: (event: Readonly<RunEvent>) => void;
}
export declare function runtimePaths(): RuntimePaths;
export declare function resourceBase(): string;
/** Static preflight; run always revalidates before enforcing an OS boundary. */
export declare function check(input: Policy): Policy;
export declare function run(options: RunOptions): Promise<RunResult>;
export {};
