import type { ClientConfig, ExecutionPolicy } from './client.js';
export interface LaunchPlan {
    readonly version: 1;
    readonly policyJSON: string;
    readonly environment: Readonly<Record<string, string>>;
}
/**
 * The transport runs under Node OR Bun; policy parsing and filesystem audits
 * always run in the bound Node CLI. Bun's fs.Dirent encoding differs from
 * Node, so importing and calling the in-process policy engine is unsupported.
 */
export declare function prepareLaunch(config: ClientConfig, policy: ExecutionPolicy, argv: readonly string[], signal?: AbortSignal): Promise<LaunchPlan>;
