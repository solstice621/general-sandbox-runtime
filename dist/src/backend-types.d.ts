import type { SpawnOptions, StdioOptions } from 'node:child_process';
export interface RuntimePaths {
    root: string;
    node: string;
    linuxSupervisor: string;
}
export interface BackendContext {
    argv: string[];
    env: NodeJS.ProcessEnv;
    cwd: string;
    tempDir: string;
    rootDir: string;
    stdio: StdioOptions;
    grantedTargets: number[];
    graceMs: number;
    runtimePaths: RuntimePaths;
}
export interface BackendPlan {
    command: string;
    args: string[];
    options: SpawnOptions;
    /** Private host-to-namespace signal channel. Never passed to workload. */
    controlFd?: number;
    release(): void;
}
