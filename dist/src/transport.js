import { execFile } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { userInfo } from 'node:os';
import { promisify } from 'node:util';
const execute = promisify(execFile);
/** Bun delegates filesystem policy preparation to the same installed Node runtime. */
export async function prepareLaunch(config, policy, signal) {
    const { stdout } = await execute(config.runnerPath, ['prepare', '--request-json', JSON.stringify({ config, policy })], {
        env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: realpathSync(userInfo().homedir), LANG: 'C', LC_ALL: 'C', TERM: 'dumb' },
        encoding: 'utf8', maxBuffer: 131072, signal,
    });
    return JSON.parse(stdout);
}
//# sourceMappingURL=transport.js.map