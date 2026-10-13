import type { BackendContext, BackendPlan } from '../backend-types.js';
import { type Policy } from '../policy.js';
export declare const MACOS_HELPER = "/usr/bin/sandbox-exec";
export declare function checkMacos(_policy: Policy): void;
/** Compile an already validated policy to Seatbelt. No policy text is accepted. */
export declare function profile(policy: Policy, tempDir: string): string;
export declare function prepareMacos(policy: Policy, context: BackendContext): BackendPlan;
