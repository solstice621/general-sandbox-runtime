import type { Context } from '@deepseek-ai/cordis';
import { type BashPluginOptions } from './plugin.js';
import type { ClientConfig } from '../../src/client.js';
export declare const name = "sandbox-runtime-dsh-bash";
export declare const inject: string[];
export interface Config {
    readonly runtime?: Omit<ClientConfig, 'runnerPath'>;
    readonly bash?: BashPluginOptions;
}
export declare function apply(ctx: Context, config?: Config): Promise<void>;
