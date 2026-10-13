import { spawnSync } from 'node:child_process';
import { copyFileSync, realpathSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
const node = realpathSync(process.execPath);
rmSync(join(root, 'dist'), { recursive: true, force: true });
const compiler = join(root, 'node_modules/typescript/bin/tsc');
const compile = spawnSync(node, [compiler, '--project', join(root, 'tsconfig.json')], { cwd: root, stdio: 'inherit' });
if (compile.error)
    throw compile.error;
if (compile.status !== 0)
    process.exit(compile.status ?? 1);
for (const host of ['dsh', 'opencode']) {
    for (const extension of ['js', 'd.ts'])
        copyFileSync(join(root, `dist/packages/${host}/index.${extension}`), join(root, `packages/${host}/index.${extension}`));
}
const bind = spawnSync(node, [join(root, 'dist/scripts/bind-launchers.js')], { cwd: root, stdio: 'inherit' });
if (bind.error)
    throw bind.error;
if (bind.status !== 0)
    process.exit(bind.status ?? 1);
//# sourceMappingURL=build.js.map