import fs from 'node:fs';
import path from 'node:path';
import type { StdioOptions } from 'node:child_process';
import { RuntimeError, type Policy, type Rule } from '../policy.js';
import type { BackendContext, BackendPlan } from '../backend-types.js';
import { seccompProgram } from './seccomp.js';

export const LINUX_HELPER = '/usr/bin/bwrap';
const inside = (candidate: string, root: string): boolean => candidate === root || candidate.startsWith(`${root.replace(/\/$/u, '')}/`);
const matches = (candidate: string, rule: Rule): boolean => candidate === rule.path || rule.scope === 'tree' && inside(candidate, rule.path);
const systemRoots = ['/proc', '/dev', '/sys', '/usr', '/bin', '/sbin', '/lib', '/lib64', '/etc/ld.so.preload', '/etc/ld.so.cache', '/etc/ld.so.conf', '/etc/ld.so.conf.d'];

/** Checks static requirements. Bubblewrap verifies kernel capabilities before exec. */
export function checkLinux(policy: Policy): void {
  if (process.platform !== 'linux') throw new RuntimeError('BACKEND_UNAVAILABLE', 'Linux backend requires Linux');
  seccompProgram(process.arch, policy.network.mode);
  let info: fs.Stats;
  try { info = fs.statSync(LINUX_HELPER); }
  catch (cause) { throw new RuntimeError('BACKEND_UNAVAILABLE', 'trusted /usr/bin/bwrap is missing', { cause }); }
  if (!info.isFile() || (info.mode & 0o111) === 0 || (info.mode & 0o4022) !== 0) {
    throw new RuntimeError('BACKEND_UNAVAILABLE', 'bubblewrap must be executable, non-setuid and not group/world writable');
  }
  for (const rule of policy.filesystem.allowWrite) {
    for (const reserved of systemRoots) {
      if (inside(rule.path, reserved) || inside(reserved, rule.path)) {
        throw new RuntimeError('UNSUPPORTED_POLICY', `writable rules may not overlap trusted Linux system mounts or loader installations: ${rule.path}`);
      }
    }
  }
  for (const rule of [...policy.filesystem.denyRead, ...policy.filesystem.denyWrite]) {
    for (const reserved of ['/proc', '/dev', '/sys']) {
      if (inside(rule.path, reserved) || inside(reserved, rule.path)) {
        throw new RuntimeError('UNSUPPORTED_POLICY', `protection rules may not overlap Linux system mounts: ${rule.path}`);
      }
    }
  }
}

export interface LinuxMount { path: string; kind: 'rw' | 'ro' | 'hide-dir' | 'hide-file' }
/** Pins writable ancestors so a protected logical path cannot be renamed away. */
export function linuxMountPlan(policy: Policy, tempDir: string): LinuxMount[] {
  const entries = new Map<string, LinuxMount['kind']>();
  for (const rule of policy.filesystem.allowWrite) entries.set(rule.path, 'rw');
  if (tempDir !== '') entries.set(tempDir, 'rw');
  for (const rule of [...policy.filesystem.denyWrite, ...policy.filesystem.denyRead]) {
    for (let ancestor = path.dirname(rule.path); ancestor !== '/'; ancestor = path.dirname(ancestor)) {
      if (policy.filesystem.allowWrite.some((allow) => allow.scope === 'tree' && inside(ancestor, allow.path)) && !entries.has(ancestor)) entries.set(ancestor, 'rw');
    }
  }
  for (const rule of policy.filesystem.denyWrite) entries.set(rule.path, 'ro');
  for (const rule of policy.filesystem.denyRead) entries.set(rule.path, rule.scope === 'tree' ? 'hide-dir' : 'hide-file');
  const result: LinuxMount[] = [];
  for (const [entry, original] of entries) {
    if (policy.filesystem.denyRead.some((rule) => entry !== rule.path && matches(entry, rule))) continue;
    const kind = original === 'rw' && policy.filesystem.denyWrite.some((rule) => matches(entry, rule)) ? 'ro' : original;
    result.push({ path: entry, kind });
  }
  return result.sort((a, b) => a.path.split('/').length - b.path.split('/').length || a.path.localeCompare(b.path, 'en'));
}

export interface SupervisorConfig { argv: string[]; env: NodeJS.ProcessEnv; cwd: string; grantedTargets: number[]; graceMs: number }

/** Allocates only private unlinked backing files. release never owns application FDs. */
export function prepareLinux(policy: Policy, context: BackendContext): BackendPlan {
  checkLinux(policy);
  if (context.argv.length === 0 || !context.argv[0]) throw new RuntimeError('INVALID_POLICY', 'empty command');
  if (!path.isAbsolute(context.cwd)) throw new RuntimeError('INVALID_POLICY', 'Linux cwd must be absolute');
  if ((policy.filesystem.temp === 'private') !== (context.tempDir !== '')) throw new RuntimeError('SANDBOX_SETUP_FAILED', 'private temporary directory allocation does not match policy');
  if (!Array.isArray(context.stdio)) throw new RuntimeError('INVALID_POLICY', 'Linux stdio must be an explicit descriptor array');
  const stdio: Exclude<StdioOptions, string> = [...context.stdio];
  const owned: number[] = [];
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    for (const fd of owned) { try { fs.closeSync(fd); } catch { /* Preserve the primary failure. */ } }
  };
  const rawFD = (bytes: Uint8Array): number => {
    const directory = fs.mkdtempSync('/tmp/sandbox-runtime-input-');
    fs.chmodSync(directory, 0o700);
    const name = path.join(directory, 'data');
    try {
      const fd = fs.openSync(name, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_RDWR, 0o600);
      owned.push(fd);
      fs.unlinkSync(name);
      // Positional writes preserve offset zero for bwrap/the supervisor reader.
      let written = 0;
      while (written < bytes.byteLength) written += fs.writeSync(fd, bytes, written, bytes.byteLength - written, written);
      const target = stdio.length;
      stdio.push(fd);
      return target;
    } finally {
      try { fs.unlinkSync(name); } catch { /* File is normally already unlinked. */ }
      fs.rmdirSync(directory);
    }
  };
  try {
    const controlFd = stdio.length;
    stdio.push('pipe');
    const args = ['--unshare-user', '--unshare-pid', '--unshare-ipc', '--unshare-uts', '--die-with-parent', '--new-session', '--cap-drop', 'ALL', '--ro-bind', '/', '/', '--proc', '/proc', '--dev', '/dev'];
    if (policy.network.mode === 'deny') args.push('--unshare-net');
    for (const mount of linuxMountPlan(policy, context.tempDir)) {
      switch (mount.kind) {
        case 'rw': args.push('--bind', mount.path, mount.path); break;
        case 'ro': args.push('--ro-bind', mount.path, mount.path); break;
        case 'hide-dir': args.push('--perms', '0000', '--tmpfs', mount.path, '--remount-ro', mount.path); break;
        case 'hide-file': args.push('--perms', '0000', '--ro-bind-data', String(rawFD(new Uint8Array())), mount.path); break;
      }
    }
    args.push('--seccomp', String(rawFD(seccompProgram(process.arch, policy.network.mode))));
    const config: SupervisorConfig = { argv: [...context.argv], env: { ...context.env }, cwd: context.cwd, grantedTargets: [...context.grantedTargets], graceMs: context.graceMs };
    const configFd = rawFD(Buffer.from(JSON.stringify(config)));
    args.push('--clearenv', '--setenv', 'PATH', '/usr/bin:/bin', '--setenv', 'LANG', 'C', '--chdir', '/', '--', context.runtimePaths.node, '--disable-sigusr1', context.runtimePaths.linuxSupervisor, String(configFd), String(controlFd));
    return { command: LINUX_HELPER, args, options: { cwd: '/', env: { PATH: '/usr/bin:/bin', LANG: 'C' }, stdio, detached: true }, controlFd, release };
  } catch (cause) {
    release();
    if (cause instanceof RuntimeError) throw cause;
    throw new RuntimeError('SANDBOX_SETUP_FAILED', 'could not prepare Linux sandbox inputs', { cause });
  }
}
