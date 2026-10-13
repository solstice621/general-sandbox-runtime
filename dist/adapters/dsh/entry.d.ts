import type { Context } from '@deepseek-ai/cordis';
import { type BashPluginOptions } from './plugin.js';
import type { AdapterConfig } from './provider.js';
export declare const name = "sandbox-runtime-dsh-bash";
export declare const inject: string[];
export declare const DSH_VERSION = "0.2.1-alpha.2";
export interface Config {
    readonly runtime?: Omit<AdapterConfig, 'scope' | 'runnerPath'>;
    readonly bash?: BashPluginOptions;
}
export declare function apply(ctx: Context, config?: Config): Promise<void>;
