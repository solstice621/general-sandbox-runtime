import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { userInfo } from 'node:os';
/**
 * The transport runs under Node OR Bun; policy parsing and filesystem audits
 * always run in the bound Node CLI. Bun's fs.Dirent encoding differs from
 * Node, so importing and calling the in-process policy engine is unsupported.
 */
export async function prepareLaunch(config, policy, argv, signal) {
    const request = JSON.stringify({ config, policy, argv });
    if (Buffer.byteLength(request) > 131072)
        throw new Error('runtime prepare request exceeds 128 KiB');
    const child = spawn(config.runnerPath, ['prepare', '--request-json', request], {
        env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: realpathSync(userInfo().homedir), LANG: 'C', LC_ALL: 'C', TERM: 'dumb' },
        stdio: ['ignore', 'pipe', 'pipe'], signal, timeout: 65000, killSignal: 'SIGKILL',
    });
    let output = '', errorOutput = '', size = 0;
    const collect = (stderr) => (chunk) => {
        size += chunk.length;
        if (size > 131072)
            child.kill('SIGKILL');
        else if (stderr)
            errorOutput += chunk.toString('utf8');
        else
            output += chunk.toString('utf8');
    };
    child.stdout.on('data', collect(false));
    child.stderr.on('data', collect(true));
    await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (code, sig) => {
            if (signal?.aborted)
                return reject(signal.reason);
            if (code !== 0 || sig || size > 131072)
                return reject(new Error(`sandbox prepare failed (code=${code}, signal=${sig ?? 'none'}): ${errorOutput.slice(0, 4096)}`));
            resolve();
        });
    });
    const result = JSON.parse(output);
    if (typeof result !== 'object' || result === null || !('version' in result) || result.version !== 1 || !('policyJSON' in result) || typeof result.policyJSON !== 'string' || !('environment' in result) || typeof result.environment !== 'object' || result.environment === null)
        throw new Error('invalid sandbox prepare response');
    const environment = result.environment;
    if (Object.keys(environment).some(key => !['PATH', 'HOME', 'LANG', 'LC_ALL', 'TERM'].includes(key)) || Object.values(environment).some(value => typeof value !== 'string' || value.includes('\0')))
        throw new Error('invalid sandbox prepare environment');
    return Object.freeze({ version: 1, policyJSON: result.policyJSON, environment: Object.freeze(environment) });
}
//# sourceMappingURL=transport.js.map