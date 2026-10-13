import { statSync } from 'node:fs';
import { posix } from 'node:path';
import { RuntimeError } from '../policy.js';
export const MACOS_HELPER = '/usr/bin/sandbox-exec';
export function checkMacos(_policy) {
    if (process.platform !== 'darwin') {
        throw new RuntimeError('BACKEND_UNAVAILABLE', 'Seatbelt requires macOS');
    }
    try {
        const info = statSync(MACOS_HELPER);
        if (!info.isFile() || (info.mode & 0o111) === 0) {
            throw new Error('not an executable regular file');
        }
    }
    catch {
        throw new RuntimeError('BACKEND_UNAVAILABLE', 'trusted /usr/bin/sandbox-exec is unavailable');
    }
}
// Policy validation forbids control characters. Quoting still matters: quotes,
// backslashes, and parentheses in an authorized filename remain literal data.
function quote(value) {
    return JSON.stringify(value);
}
function selector(rule, path) {
    return `(${rule.scope === 'tree' ? 'subpath' : 'literal'} ${quote(path)})`;
}
function paths(rule) {
    return rule.logical && rule.logical !== rule.path
        ? [rule.path, rule.logical]
        : [rule.path];
}
/** Compile an already validated policy to Seatbelt. No policy text is accepted. */
export function profile(policy, tempDir) {
    const lines = [
        '(version 1)',
        '(deny default)',
        '(allow process-exec process-fork)',
        '(allow signal (target same-sandbox))',
        '(allow process-info* (target same-sandbox))',
        '(allow file-read*)',
        '(allow sysctl-read)',
        '(allow file-write-data (require-all (literal "/dev/null") (vnode-type CHARACTER-DEVICE)))',
        '(allow system-socket (socket-domain AF_UNIX))',
    ];
    // AF_UNIX socketpair is available for local process plumbing. Named UNIX
    // endpoint bind/connect stays denied, even when Internet access is enabled.
    if (policy.network.mode === 'host') {
        lines.push('(allow system-socket (socket-domain AF_INET))', '(allow system-socket (socket-domain AF_INET6))', '(allow network-bind (local ip "*:*"))', '(allow network-inbound (local ip "*:*"))', '(allow network-outbound (remote ip "*:*"))', '(allow mach-lookup (global-name "com.apple.networkd") (global-name "com.apple.mDNSResponder"))');
    }
    const roots = [...policy.filesystem.allowWrite];
    if (tempDir !== '')
        roots.push({ path: tempDir, scope: 'tree' });
    for (const rule of roots) {
        for (const path of paths(rule))
            lines.push(`(allow file-write* ${selector(rule, path)})`);
    }
    for (const rule of policy.filesystem.denyWrite) {
        for (const path of paths(rule))
            lines.push(`(deny file-write* ${selector(rule, path)})`);
    }
    for (const rule of policy.filesystem.denyRead) {
        for (const path of paths(rule))
            lines.push(`(deny file-read* file-write* ${selector(rule, path)})`);
    }
    // Fix each grant/denial's directory anchor and every ancestor so a workload
    // cannot rename a parent and thereby move content outside its protected path.
    const anchors = new Set();
    for (const rule of [...roots, ...policy.filesystem.denyRead, ...policy.filesystem.denyWrite]) {
        for (const path of paths(rule)) {
            let current = rule.scope === 'file' ? posix.dirname(path) : path;
            for (;;) {
                anchors.add(current);
                if (current === '/')
                    break;
                current = posix.dirname(current);
            }
        }
    }
    for (const anchor of [...anchors].sort()) {
        lines.push(`(deny file-write-unlink (require-all (vnode-type DIRECTORY) (literal ${quote(anchor)})))`);
    }
    lines.push('(deny network-bind (local unix-socket))', '(deny network-outbound (remote unix-socket))', '(deny mach-lookup (xpc-service-name-prefix ""))', '(deny system-fcntl (fcntl-command 80 110))');
    return `${lines.join('\n')}\n`;
}
export function prepareMacos(policy, context) {
    checkMacos(policy);
    return {
        command: MACOS_HELPER,
        args: ['-p', profile(policy, context.tempDir), '--', ...context.argv],
        options: {
            cwd: context.cwd,
            env: context.env,
            stdio: context.stdio,
            detached: true,
        },
        release() { },
    };
}
//# sourceMappingURL=macos.js.map