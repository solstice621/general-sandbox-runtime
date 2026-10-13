import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
const node = realpathSync(process.execPath);
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 24 || (major === 24 && minor < 19))
    throw new Error('Node >=24.19.0 is required');
rmSync(join(root, 'dist'), { recursive: true, force: true });
const compiler = join(root, 'node_modules/typescript/bin/tsc');
const compile = spawnSync(node, [compiler, '--project', join(root, 'tsconfig.json')], { cwd: root, stdio: 'inherit' });
if (compile.error)
    throw compile.error;
if (compile.status !== 0)
    process.exit(compile.status ?? 1);
const shellQuote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const template = readFileSync(join(root, 'scripts/launcher.sh'), 'utf8');
if (!template.includes('exec __NODE__'))
    throw new Error('launcher template lacks Node binding');
mkdirSync(join(root, 'bin'), { recursive: true });
writeFileSync(join(root, 'bin/sandbox-runner'), template.replace('exec __NODE__', `exec ${shellQuote(node)}`), { mode: 0o755 });
process.stdout.write(`Built TypeScript runtime; launcher binds ${node}\n`);
//# sourceMappingURL=build.js.map