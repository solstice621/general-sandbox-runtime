import { type Policy } from '../policy.js';
import type { BackendContext, BackendPlan } from '../backend-types.js';
export declare const LINUX_HELPER = "/usr/bin/bwrap";
/** Checks static requirements. Bubblewrap verifies kernel capabilities before exec. */
export declare function checkLinux(policy: Policy): void;
export interface LinuxMount {
    path: string;
    kind: 'rw' | 'ro' | 'hide-dir' | 'hide-file';
}
/** Pins writable ancestors so a protected logical path cannot be renamed away. */
export declare function linuxMountPlan(policy: Policy, tempDir: string): LinuxMount[];
export interface SupervisorConfig {
    argv: string[];
    env: NodeJS.ProcessEnv;
    cwd: string;
    grantedTargets: number[];
    graceMs: number;
}
/** Allocates only private unlinked backing files. release never owns application FDs. */
export declare function prepareLinux(policy: Policy, context: BackendContext): BackendPlan;
