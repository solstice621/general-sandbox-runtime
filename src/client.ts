import { spawn } from 'node:child_process'
import { constants, lstatSync, realpathSync, statSync, accessSync } from 'node:fs'
import { isAbsolute, dirname } from 'node:path'
import { userInfo } from 'node:os'
import { fileURLToPath } from 'node:url'
import { MAX_POLICY_BYTES, SAFE_PATH, validatePolicy } from './policy.js'
import type { Policy, Rule } from './policy.js'
import { pathContains, pathsOverlap } from './path-trust.js'

export { SAFE_PATH } from './policy.js'

/** Public configuration uses wire rules; logical is private runtime normalization metadata. */
export type AdapterRule = Pick<Rule, 'path' | 'scope'>

export interface ClientConfig {
  readonly scope: 'bash-only'
  readonly runnerPath: string
  readonly network?: 'deny' | 'host'
  readonly denyRead?: readonly AdapterRule[]
  readonly denyWrite?: readonly AdapterRule[]
  readonly checkTimeoutMs?: number
  readonly protectedPaths?: readonly string[]
}

export interface ExecutionPolicy {
  readonly mode: 'read-only' | 'workspace-write' | 'danger-full-access'
  readonly workspaceRoot: string
  readonly sessionId?: string
}
export interface PreparedCommand {
  argv: string[]
  enforcement: 'full'
  denialSignatures: string[]
  runnerFailureRules: []
}

interface ResolvedConfig {
  readonly runnerPath: string
  readonly network: 'deny' | 'host'
  readonly denyRead: readonly Rule[]
  readonly denyWrite: readonly Rule[]
  readonly checkTimeoutMs: number
  readonly protectedPaths: readonly string[]
}

export class AdapterError extends Error {
  readonly code: 'INVALID_ADAPTER_CONFIG' | 'UNSUPPORTED_CONSUMER' | 'SANDBOX_UNAVAILABLE'
  constructor(code: AdapterError['code'], message: string) {
    super(message)
    this.name = 'AdapterError'
    this.code = code
  }
}
function invalid(message: string): never { throw new AdapterError('INVALID_ADAPTER_CONFIG', message) }
export function unsupported(message: string): never { throw new AdapterError('UNSUPPORTED_CONSUMER', message) }

function pathString(path: string): string {
  if (typeof path !== 'string' || !isAbsolute(path) || /[\x00-\x1f\x7f]/.test(path)) invalid('expected absolute literal path')
  return path
}

function runtimePolicy(config: Pick<ResolvedConfig, 'network' | 'denyRead' | 'denyWrite'>, workspace?: string): Policy {
  // The runtime owns the schema, canonicalization, validation, and immutable snapshot.
  return validatePolicy({
    version: 1,
    filesystem: {
      read: 'host', denyRead: config.denyRead,
      allowWrite: workspace === undefined ? [] : [{ path: workspace, scope: 'tree' }],
      denyWrite: config.denyWrite, temp: workspace === undefined ? 'none' : 'private',
    },
    network: { mode: config.network }, ipc: { hostUnixSockets: 'deny' },
    environment: { inherit: ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TERM'] },
  })
}

/** Host-neutral preparation. Launch only with safeEnvironment(); argv alone does not secure a loader. */
export class RuntimeClient {
  readonly #config: ResolvedConfig
  readonly #prepared = new WeakSet<readonly string[]>()

  constructor(config: ClientConfig) {
    if (!config || config.scope !== 'bash-only') unsupported('only the bash-only installation scope is supported; shared/PTC/PTY providers are refused')
    if (Object.keys(config).some(key => !['scope', 'runnerPath', 'network', 'denyRead', 'denyWrite', 'checkTimeoutMs', 'protectedPaths'].includes(key))) invalid('unknown adapter configuration field')
    const runnerPath = pathString(config.runnerPath)
    if (!['deny', 'host'].includes(config.network ?? 'deny')) invalid('network must be deny or host')
    const checkTimeoutMs = config.checkTimeoutMs ?? 10_000
    if (!Number.isSafeInteger(checkTimeoutMs) || checkTimeoutMs < 1 || checkTimeoutMs > 60_000) invalid('checkTimeoutMs must be 1..60000')
    for (const rules of [config.denyRead, config.denyWrite]) {
      if (Array.isArray(rules) && rules.some(rule => typeof rule === 'object' && rule !== null && 'logical' in rule)) invalid('logical is private runtime metadata, not an adapter configuration field')
    }
    const normalized = runtimePolicy({ network: config.network ?? 'deny', denyRead: config.denyRead ?? [], denyWrite: config.denyWrite ?? [] })
    if (config.protectedPaths !== undefined && !Array.isArray(config.protectedPaths)) invalid('protectedPaths must be an array')
    this.#config = Object.freeze({ runnerPath, network: normalized.network.mode, denyRead: normalized.filesystem.denyRead, denyWrite: normalized.filesystem.denyWrite, checkTimeoutMs, protectedPaths: Object.freeze((config.protectedPaths ?? []).map(p => realpathSync(pathString(p)))) })
    this.#validateRunner()
  }

  #validateRunner(workspace?: string): void {
    for (const protectedPath of this.#config.protectedPaths) {
      if (workspace && pathsOverlap(workspace, protectedPath)) invalid('trusted installation overlaps writable workspace')
    }
    const path = this.#config.runnerPath
    if (realpathSync(path) !== path || lstatSync(path).isSymbolicLink()) invalid('runnerPath must be its canonical absolute path, without symlinks')
    const info = statSync(path)
    if (!info.isFile() || (info.mode & 0o022) || info.nlink !== 1) invalid('runner must be a regular executable with one link, not writable by group or others')
    accessSync(path, constants.X_OK)
    // An allowed tree may rename a trusted runner ancestor even if the file is read-only.
    if (workspace && pathContains(workspace, path)) invalid('runner installation overlaps writable workspace; install it outside the workspace')
    const adapterFile = fileURLToPath(import.meta.url)
    if (workspace && (pathsOverlap(workspace, dirname(adapterFile)) || pathsOverlap(workspace, dirname(realpathSync(adapterFile))))) invalid('adapter installation overlaps writable workspace; install it outside the workspace')
    let current = dirname(path)
    while (current !== dirname(current)) {
      const ancestor = statSync(current)
      if ((ancestor.mode & 0o022) && !(ancestor.mode & 0o1000)) invalid('runner ancestor is writable by group or others')
      current = dirname(current)
    }
  }

  safeEnvironment(): NodeJS.ProcessEnv {
    return { PATH: SAFE_PATH, HOME: realpathSync(userInfo().homedir), LANG: 'C', LC_ALL: 'C', TERM: 'dumb' }
  }

  policyFor(policy: ExecutionPolicy): Policy {
    if (!policy || !['read-only', 'workspace-write'].includes(policy.mode)) unsupported('provider accepts only read-only and workspace-write; full access bypass belongs to the Bash executor')
    if (Object.keys(policy).some(key => !['mode', 'workspaceRoot', 'sessionId'].includes(key))) invalid('unknown execution policy field')
    const root = realpathSync(pathString(policy.workspaceRoot))
    if (!statSync(root).isDirectory()) invalid('workspaceRoot must be an existing directory')
    this.#validateRunner(policy.mode === 'workspace-write' ? root : undefined)
    return runtimePolicy(this.#config, policy.mode === 'workspace-write' ? root : undefined)
  }

  async confine(argv: readonly string[], policy: ExecutionPolicy, signal?: AbortSignal): Promise<PreparedCommand> {
    signal?.throwIfAborted()
    if (!Array.isArray(argv) || argv.length === 0 || !argv[0] || argv.some(value => typeof value !== 'string' || value.includes('\0'))) invalid('argv must contain a program and NUL-free string arguments')
    const snapshot = [...argv]
    const runtimePolicy = this.policyFor(policy)
    const json = JSON.stringify(runtimePolicy)
    if (Buffer.byteLength(json) > MAX_POLICY_BYTES) invalid('policy exceeds 64 KiB')
    await this.#check(json, signal)
    signal?.throwIfAborted()
    this.#validateRunner(policy.mode === 'workspace-write' ? runtimePolicy.filesystem.allowWrite[0]?.path : undefined)
    // Upstream PreparedCommand declares a mutable string[] but never mutates it.
    // Keep that peer contract while enforcing immutability at runtime.
    const wrapped = [this.#config.runnerPath, 'run', '--policy-json', json, '--', ...snapshot]
    Object.freeze(wrapped)
    this.#prepared.add(wrapped)
    return { argv: wrapped, enforcement: 'full', denialSignatures: process.platform === 'darwin' ? ['operation not permitted'] : ['read-only file system', 'permission denied', 'operation not permitted'], runnerFailureRules: [] }
  }

  /** One-shot, identity-based authorization, never a command-prefix heuristic. */
  consumePrepared(argv: readonly string[]): void {
    if (!this.#prepared.delete(argv)) unsupported('spawn is not the exact one-shot argv prepared for this Bash invocation')
    this.#validateRunner()
  }

  async #check(json: string, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted()
    const child = spawn(this.#config.runnerPath, ['check', '--policy-json', json], { env: this.safeEnvironment(), stdio: ['ignore', 'pipe', 'pipe'], signal, timeout: this.#config.checkTimeoutMs, killSignal: 'SIGKILL' })
    let stdout = '', bytes = 0
    const collect = (target: 'stdout' | 'stderr') => (data: Buffer): void => {
      bytes += data.length
      if (bytes > MAX_POLICY_BYTES) child.kill('SIGKILL')
      else if (target === 'stdout') stdout += data.toString('utf8')
    }
    child.stdout.on('data', collect('stdout'))
    child.stderr.on('data', collect('stderr'))
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject)
      child.once('close', (code, sig) => {
        if (signal?.aborted) return reject(signal.reason)
        if (bytes > MAX_POLICY_BYTES || code !== 0 || sig) return reject(new AdapterError('SANDBOX_UNAVAILABLE', `runner preflight failed (code=${code}, signal=${sig ?? 'none'})`))
        try {
          const result: unknown = JSON.parse(stdout)
          if (typeof result !== 'object' || result === null || !('ok' in result) || result.ok !== true || !('version' in result) || result.version !== 1 || !('platform' in result) || result.platform !== process.platform || !('network' in result) || result.network !== this.#config.network) throw new Error('invalid check result')
          resolve()
        } catch { reject(new AdapterError('SANDBOX_UNAVAILABLE', 'runner returned an invalid preflight report')) }
      })
    })
    signal?.throwIfAborted()
  }
}
