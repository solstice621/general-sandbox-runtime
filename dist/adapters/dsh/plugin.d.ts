import type { Context } from '@deepseek-ai/cordis';
import type { AdapterConfig } from './provider.js';
/** Raw supported settings; Cordis validates these into upstream volatile references. */
export interface BashPluginOptions {
    readonly cwd?: string;
    readonly timeoutMs?: number;
    readonly maxTimeoutMs?: number;
    readonly maxOutputBytes?: number;
    readonly maxSpillBytes?: number;
    readonly graceMs?: number;
}
export interface BashOnlyPlugin {
    readonly name: 'sandbox-runtime-bash-only';
    readonly inject: ['subprocess', 'sandboxPolicy'];
    apply(ctx: Context): Promise<void>;
}
/**
 * Replace only the Bash executor, leaving shared sandbox/subprocess services intact.
 * PTC and PTY cannot obtain this provider or its private launch authorization.
 * The trusted DSH composition must supply the pinned source's local subprocess.
 */
export declare function createBashOnlyPlugin(config: AdapterConfig, bashConfig?: BashPluginOptions): BashOnlyPlugin;
