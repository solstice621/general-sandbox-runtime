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
  readonly runnerPath: string
  readonly network?: 'deny' | 'host'
  readonly denyRead?: readonly AdapterRule[]
  readonly denyWrite?: readonly AdapterRule[]
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
  readonly protectedPaths: readonly string[]
}

export class AdapterError extends Error {
  readonly code: 'INVALID_ADAPTER_CONFIG' | 'UNSUPPORTED_CONSUMER'
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

  constructor(config: ClientConfig) {
    if (Object.keys(config).some(key => !['runnerPath', 'network', 'denyRead', 'denyWrite', 'protectedPaths'].includes(key))) invalid('unknown adapter configuration field')
    const runnerPath = pathString(config.runnerPath)
    if (!['deny', 'host'].includes(config.network ?? 'deny')) invalid('network must be deny or host')
    for (const rules of [config.denyRead, config.denyWrite]) {
      if (Array.isArray(rules) && rules.some(rule => typeof rule === 'object' && rule !== null && 'logical' in rule)) invalid('logical is private runtime metadata, not an adapter configuration field')
    }
    const normalized = runtimePolicy({ network: config.network ?? 'deny', denyRead: config.denyRead ?? [], denyWrite: config.denyWrite ?? [] })
    if (config.protectedPaths !== undefined && !Array.isArray(config.protectedPaths)) invalid('protectedPaths must be an array')
    this.#config = Object.freeze({ runnerPath, network: normalized.network.mode, denyRead: normalized.filesystem.denyRead, denyWrite: normalized.filesystem.denyWrite, protectedPaths: Object.freeze((config.protectedPaths ?? []).map(p => realpathSync(pathString(p)))) })
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
    // Upstream PreparedCommand declares a mutable string[] but never mutates it.
    // Keep that peer contract while enforcing immutability at runtime.
    const wrapped = [this.#config.runnerPath, 'run', '--policy-json', json, '--', ...snapshot]
    Object.freeze(wrapped)
    return { argv: wrapped, enforcement: 'full', denialSignatures: process.platform === 'darwin' ? ['operation not permitted'] : ['read-only file system', 'permission denied', 'operation not permitted'], runnerFailureRules: [] }
  }

}
