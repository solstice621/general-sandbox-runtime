/**
 * Adapter-facing declarations for DSH commit d743267388641bc76f17c45ce8b4c231aed1d32c.
 * These are build-time projections of the pinned peers, not replacement runtime modules.
 * Interface members used across the adapter are preserved exactly. Cordis registration
 * exposes only the class/object forms used here; its unconsumed Fiber result is opaque.
 * No source imports pull the pinned DSH monorepo into this TypeScript program.
 */

declare module '@deepseek-ai/dsh-brand' {
  // packages/util/brand/src/index.ts:15-18
  const BRAND: unique symbol
  export type Branded<B extends string> = string & { readonly [BRAND]: B }
}

declare module '@deepseek-ai/dsh-session' {
  import type { Branded } from '@deepseek-ai/dsh-brand'
  // packages/core/session/src/types.ts:20
  export type SessionId = Branded<'SessionId'>
}

declare module '@deepseek-ai/cordis' {
  import type { SandboxExecutionPolicy, SandboxMode, SandboxProvider } from '@deepseek-ai/dsh-sandbox'
  import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
  import type { ShellExecutor } from '@deepseek-ai/dsh-shell'

  // vendor/cosmokit/src/volatile.ts:6-12, re-exported by cordis/src/index.ts:16
  export type VolatileSnapshot<T> = T extends object ? { readonly [K in keyof T]: VolatileSnapshot<T[K]> } : T
  export interface Volatile<T> {
    get(): VolatileSnapshot<T>
  }

  export interface PluginObject<C = void> {
    name?: string
    inject?: string[]
    apply(ctx: Context, config: C): unknown
  }

  // vendor/cordis/src/context.ts:42,71,121; reflect.ts:17; registry.ts:120-133,185
  export class Context {
    constructor()
    subprocess: SubprocessRuntime
    sandbox: SandboxProvider
    shell: ShellExecutor
    // Only the agentless policy methods needed by this integration are projected.
    sandboxPolicy: {
      readonly defaultMode: SandboxMode
      readonly workspaceRoot: string
      resolve(): SandboxExecutionPolicy
    }
    get<K extends keyof this & string>(name: K, strict?: boolean): this[K] | undefined
    get(name: string, strict?: boolean): unknown
    isolate(name: string, label?: symbol): this
    plugin<T extends object>(plugin: new (ctx: Context) => T): PromiseLike<unknown>
    plugin<I, O, T extends object>(
      plugin: { new (ctx: Context, config: O): T; Config: (input: I) => O },
      config: I,
    ): PromiseLike<unknown>
    plugin(plugin: PluginObject<void>): PromiseLike<unknown>
  }

  // vendor/cordis/src/service.ts:29,42; unused lifecycle symbols are omitted.
  export abstract class Service {
    protected ctx: Context
    name: string
    constructor(ctx: Context, name: string)
  }
}

declare module '@deepseek-ai/dsh-sandbox' {
  import { Context, Service } from '@deepseek-ai/cordis'
  import type { SessionId } from '@deepseek-ai/dsh-session'

  // packages/sandbox/sandbox/src/index.ts:30-117
  export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'
  export type ConfinedSandboxMode = Exclude<SandboxMode, 'danger-full-access'>
  export type SandboxEnforcement = 'full' | 'partial'
  export interface SandboxExecutionPolicy {
    mode: SandboxMode
    workspaceRoot: string
    sessionId?: SessionId
  }
  export interface SandboxPolicy extends SandboxExecutionPolicy {
    mode: ConfinedSandboxMode
  }
  export interface RunnerFailureRule {
    allowedExitCodes?: readonly number[]
    fatalSignatures: readonly string[]
    informationalLines?: readonly string[]
  }
  export interface ConfinedArgv {
    argv: string[]
    enforcement: SandboxEnforcement
    denialSignatures: readonly string[]
    runnerFailureRules: readonly RunnerFailureRule[]
  }

  // packages/sandbox/sandbox/src/index.ts:159-177
  export abstract class SandboxProvider extends Service {
    constructor(ctx: Context)
    abstract confine(argv: readonly string[], policy: SandboxPolicy, signal?: AbortSignal): Promise<ConfinedArgv>
  }
  export default SandboxProvider
}

declare module '@deepseek-ai/dsh-subprocess' {
  import { Context, Service } from '@deepseek-ai/cordis'
  import type { Duplex, Readable, Writable } from 'node:stream'

  // packages/subprocess/subprocess/src/types.ts:13-107
  export const DSH_ENV_PREFIX: 'DSH_'
  export type DshEnvironmentKey = `${typeof DSH_ENV_PREFIX}${string}`
  export type DshEnvironment = Readonly<Record<DshEnvironmentKey, string>>
  export interface CollectedOutput {
    text: string
    truncated: boolean
    spillPath?: string
  }
  export type SubprocessStdinMode = 'ignore' | 'pipe' | { readonly data: string }
  export interface SubprocessCollect {
    maxBytes: number
    spill?: { maxBytes: number }
  }
  export type SubprocessOutputMode = 'pipe' | 'inherit' | SubprocessCollect
  export interface SubprocessStdio {
    stdin: SubprocessStdinMode
    stdout: SubprocessOutputMode
    stderr: SubprocessOutputMode
    control?: 'pipe'
  }
  export interface SubprocessSpawnSpec {
    argv: readonly string[]
    cwd: string
    stdio: SubprocessStdio
    graceMs: number
    signal?: AbortSignal | undefined
    env?: NodeJS.ProcessEnv | undefined
  }

  // packages/subprocess/subprocess/src/types.ts:116-196
  export interface SubprocessOutcome {
    exitCode: number | null
    signal: NodeJS.Signals | null
  }
  export interface SubprocessOutputRead {
    text: string
    nextOffset: number
    lossy: boolean
    spillPath?: string
  }
  export interface SubprocessOutputReader {
    readFrom(fromByte: number): SubprocessOutputRead
  }
  export interface SubprocessCollectedOutputs {
    readonly stdout?: SubprocessOutputReader
    readonly stderr?: SubprocessOutputReader
  }
  export interface SubprocessHandle {
    readonly stdin: Writable | undefined
    readonly stdout: Readable | undefined
    readonly stderr: Readable | undefined
    readonly control: Duplex | undefined
    readonly collected: SubprocessCollectedOutputs
    readonly done: Promise<SubprocessOutcome>
    terminate(): void
    waitForExit(signal?: AbortSignal): Promise<boolean>
  }

  // packages/subprocess/subprocess/src/types.ts:203-296
  export type SubprocessTerminalSignal = 'SIGINT' | 'SIGTERM' | 'SIGKILL' | 'SIGTSTP' | 'SIGHUP'
  export interface SubprocessTerminalEnvironment {
    platform: 'posix' | 'windows'
    defaultShell?: string
  }
  export interface SubprocessTerminalSpawnSpec {
    argv: readonly string[]
    cwd: string
    env?: Record<string, string> | undefined
    rows: number
    cols: number
    terminalType: string
    shellActivity?: boolean | undefined
    graceMs: number
    signal?: AbortSignal | undefined
  }
  export interface SubprocessTerminalForeground {
    processGroupId: number
    inputWaiting: boolean
  }
  export interface SubprocessTerminalActivity {
    state: 'idle' | 'busy' | 'unknown'
    revision: number
  }
  export interface SubprocessTerminalHandle {
    readonly pid: number
    readonly output: Readable
    readonly done: Promise<SubprocessOutcome>
    write(data: string): Promise<void>
    resize(cols: number, rows: number): Promise<void>
    inspectForeground(): Promise<SubprocessTerminalForeground | undefined>
    inspectActivity(): Promise<SubprocessTerminalActivity>
    signalForeground(signal: SubprocessTerminalSignal): Promise<number>
    terminate(): Promise<void>
  }

  // packages/subprocess/subprocess/src/index.ts:66,117-162
  export function scrubbedParentEnv(): Record<string, string>
  export abstract class SubprocessRuntime extends Service {
    constructor(ctx: Context)
    abstract resolveExecutable(command: string, env?: Readonly<Record<string, string>>, signal?: AbortSignal): Promise<string>
    abstract terminalEnvironment(signal?: AbortSignal): Promise<SubprocessTerminalEnvironment>
    abstract spawn(spec: SubprocessSpawnSpec): SubprocessHandle
    abstract spawnTerminal(spec: SubprocessTerminalSpawnSpec): Promise<SubprocessTerminalHandle>
  }
  export default SubprocessRuntime
}

declare module '@deepseek-ai/dsh-subprocess-local' {
  import type { Context } from '@deepseek-ai/cordis'
  import { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
  import type {
    SubprocessHandle,
    SubprocessSpawnSpec,
    SubprocessTerminalEnvironment,
    SubprocessTerminalHandle,
    SubprocessTerminalSpawnSpec,
  } from '@deepseek-ai/dsh-subprocess'

  // packages/subprocess/subprocess-local/src/index.ts:59,75,140,182
  export class LocalSubprocessRuntime extends SubprocessRuntime {
    constructor(ctx: Context)
    resolveExecutable(command: string, env?: Readonly<Record<string, string>>, signal?: AbortSignal): Promise<string>
    terminalEnvironment(signal?: AbortSignal): Promise<SubprocessTerminalEnvironment>
    spawn(spec: SubprocessSpawnSpec): SubprocessHandle
    spawnTerminal(spec: SubprocessTerminalSpawnSpec): Promise<SubprocessTerminalHandle>
  }
  export default LocalSubprocessRuntime
}

declare module '@deepseek-ai/dsh-shell' {
  import { Context, Service } from '@deepseek-ai/cordis'
  import type { SandboxEnforcement, SandboxExecutionPolicy, SandboxMode } from '@deepseek-ai/dsh-sandbox'
  import type { CollectedOutput, DshEnvironment, SubprocessOutputReader } from '@deepseek-ai/dsh-subprocess'
  export { DSH_ENV_PREFIX } from '@deepseek-ai/dsh-subprocess'
  export type { CollectedOutput, DshEnvironment, DshEnvironmentKey, SubprocessOutputRead, SubprocessOutputReader } from '@deepseek-ai/dsh-subprocess'

  // packages/shell/shell/src/types.ts:23-137
  export interface ShellObservedStreams {
    stdout: SubprocessOutputReader
    stderr: SubprocessOutputReader
  }
  export interface ShellSandboxInfo {
    mode: SandboxMode
    denied: boolean
    enforcement?: SandboxEnforcement
    runnerFailed?: boolean
  }
  export type ShellExpiryPolicy = 'kill' | 'none'
  export interface ShellExecRequest {
    command: string
    workdir?: string | undefined
    timeoutMs?: number | undefined
    onExpiry?: ShellExpiryPolicy | undefined
    stdoutMaxBytes?: number | undefined
    signal?: AbortSignal | undefined
    stdin?: string | undefined
    env?: Record<string, string> | undefined
    dshEnv?: DshEnvironment | undefined
    sandboxPolicy?: SandboxExecutionPolicy | undefined
  }
  export interface ShellExecSpec {
    command: string
    workdir: string
    timeoutMs: number
    onExpiry: ShellExpiryPolicy
    stdoutMaxBytes: number
    signal?: AbortSignal | undefined
    stdin?: string | undefined
    env?: Record<string, string> | undefined
    dshEnv?: DshEnvironment | undefined
    sandboxPolicy: SandboxExecutionPolicy | undefined
  }

  // packages/shell/shell/src/types.ts:140-237
  export interface ShellRunResult {
    exitCode: number | null
    signal: NodeJS.Signals | null
    timedOut: boolean
    aborted: boolean
    timeoutMs: number
    stdout: CollectedOutput
    stderr: CollectedOutput
    sandbox?: ShellSandboxInfo
  }
  export type ShellProcessStatus = 'running' | 'completed' | 'killed'
  export interface ShellProcessRead {
    delta: string
    lossy: boolean
    stdoutSpillPath?: string
    stderrSpillPath?: string
  }
  export interface ShellProcess {
    status: ShellProcessStatus
    exitCode: number | null
    signal: NodeJS.Signals | null
    readonly done: Promise<void>
    sandbox?: ShellSandboxInfo
    readOutput(): ShellProcessRead
    observed: ShellObservedStreams
    kill(): boolean
  }
  export interface ShellExecution extends ShellProcess {
    result(): Promise<ShellRunResult>
  }

  // packages/shell/shell/src/index.ts:64-93
  export abstract class ShellExecutor extends Service {
    constructor(ctx: Context)
    get sandboxMode(): SandboxMode | undefined
    abstract resolve(request: ShellExecRequest): ShellExecSpec
    abstract execute(spec: ShellExecSpec): Promise<ShellExecution>
  }
  export default ShellExecutor
}

declare module '@deepseek-ai/dsh-bash-local' {
  import type { Context, Volatile } from '@deepseek-ai/cordis'
  import { ShellExecutor } from '@deepseek-ai/dsh-shell'
  import type { ShellExecRequest, ShellExecSpec, ShellExecution } from '@deepseek-ai/dsh-shell'

  // packages/shell/bash-local/src/index.ts:41-54: constructor config, after schema validation.
  export interface Config {
    cwd: Volatile<string | undefined>
    timeoutMs: Volatile<number>
    maxTimeoutMs: Volatile<number>
    maxOutputBytes: Volatile<number>
    maxSpillBytes: Volatile<number>
    graceMs: Volatile<number>
  }
  /** Adapter-facing name for the raw knobs accepted by the inherited Config schema. */
  export interface ConfigInput {
    cwd?: string | null
    timeoutMs?: number | null
    maxTimeoutMs?: number | null
    maxOutputBytes?: number | null
    maxSpillBytes?: number | null
    graceMs?: number | null
  }

  // packages/shell/bash-local/src/index.ts:97-120; callable schema input is distinct from output.
  export class LocalBashExecutor extends ShellExecutor {
    static inject: string[]
    static Config: (input: ConfigInput) => Config
    readonly config: Config
    constructor(ctx: Context, config: Config)
    resolve(request: ShellExecRequest): ShellExecSpec
    execute(spec: ShellExecSpec): Promise<ShellExecution>
  }
  export default LocalBashExecutor
}

declare module '@deepseek-ai/dsh-bash-sandbox' {
  import type { Context } from '@deepseek-ai/cordis'
  import { LocalBashExecutor } from '@deepseek-ai/dsh-bash-local'
  import type { Config as LocalConfig } from '@deepseek-ai/dsh-bash-local'
  import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'
  import type { ShellExecRequest, ShellExecSpec, ShellExecution } from '@deepseek-ai/dsh-shell'

  // packages/shell/bash-sandbox/src/index.ts:36,45-89
  export type Config = LocalConfig
  export class SandboxBashExecutor extends LocalBashExecutor {
    static inject: string[]
    constructor(ctx: Context, config: Config)
    get sandboxMode(): SandboxMode
    resolve(request: ShellExecRequest): ShellExecSpec
    execute(spec: ShellExecSpec): Promise<ShellExecution>
  }
  export default SandboxBashExecutor
}
