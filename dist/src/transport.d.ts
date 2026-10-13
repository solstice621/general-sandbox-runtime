import type { ClientConfig, ExecutionPolicy } from './client.js';
export interface LaunchPlan {
    readonly policyJSON: string;
    readonly environment: Readonly<Record<string, string>>;
}
/** Bun delegates filesystem policy preparation to the same installed Node runtime. */
export declare function prepareLaunch(config: ClientConfig, policy: ExecutionPolicy, signal?: AbortSignal): Promise<LaunchPlan>;
