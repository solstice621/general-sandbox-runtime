#!/usr/bin/env python3
"""Install the three packed artifacts into a private host tree. No global config edits."""
import argparse, hashlib, json, os, re, shlex, shutil, subprocess, sys, time
from pathlib import Path

VERSION='0.3.0'
DSH_VERSION='0.2.1-alpha.2'
OPENCODE_VERSION='2.0.14'
PACKAGES=['sandbox-runtime','sandbox-runtime-dsh','sandbox-runtime-opencode']
PROFILE='sandbox-runtime-web'

def digest(path): return hashlib.sha256(path.read_bytes()).hexdigest()
def write(path, text, mode=0o644):
    path.parent.mkdir(parents=True,exist_ok=True);path.write_text(text);path.chmod(mode)
def node_path():
    node=shutil.which('node')
    if not node: raise ValueError('Node >=24.19.0 is required')
    node=Path(node).resolve()
    version=subprocess.check_output([str(node),'-p','process.versions.node'],text=True).strip()
    parts=tuple(map(int,version.split('.')))
    if parts<(24,19,0):raise ValueError('Node >=24.19.0 is required; found '+version)
    return node

def install(args):
    prefix=args.prefix.expanduser().resolve()
    if prefix.exists():raise ValueError('Installation prefix already exists: '+str(prefix))
    artifacts=args.artifacts.expanduser().resolve()
    sums={line.split()[1]:line.split()[0] for line in (artifacts/'SHA256SUMS').read_text().splitlines() if line.strip()}
    archives=[artifacts/f'solstice621-{name}-{VERSION}.tgz' for name in PACKAGES]
    for archive in archives:
        if sums.get(archive.name)!=digest(archive):raise ValueError('Artifact checksum mismatch: '+str(archive))
    template=artifacts.parent/'installation'
    for filename in ['package.json','package-lock.json']:
        if sums.get('../installation/'+filename)!=digest(template/filename):raise ValueError('Host lock checksum mismatch: '+filename)
    node=node_path();npm=shutil.which('npm')
    if not npm:raise ValueError('npm is required')
    opencode=Path(args.opencode or shutil.which('opencode') or '').expanduser().resolve()
    if not opencode.is_file() or not os.access(opencode,os.X_OK):raise ValueError('Pass --opencode with the OpenCode 2.0.14 executable')
    home=(args.dsh_home.expanduser().resolve() if args.dsh_home else prefix/'state/dsh')
    profile=home/'profiles'/PROFILE
    if profile.exists():raise ValueError('Dedicated DSH profile already exists: '+str(profile))
    prefix.mkdir(parents=True,mode=0o700)
    created_profile=False
    try:
        state=prefix/'state/opencode-version';state.mkdir(parents=True)
        env={**os.environ,'XDG_DATA_HOME':str(state),'XDG_CACHE_HOME':str(state),'XDG_STATE_HOME':str(state),'OPENCODE_TEST_HOME':str(state)}
        version=subprocess.check_output([str(opencode),'--version'],text=True,env=env,timeout=15).strip()
        version=re.sub(r'^(?:opencode\s+)?v?', '', version)
        if version!=OPENCODE_VERSION:raise ValueError(f'OpenCode {OPENCODE_VERSION} required; found {version}')
        library=prefix/'library';library.mkdir()
        for archive in archives:
            (prefix/'artifacts').mkdir(exist_ok=True);shutil.copy2(archive,prefix/'artifacts'/archive.name)
        for filename in ['package.json','package-lock.json']:shutil.copy2(template/filename,library/filename)
        command=[npm,'ci','--prefix',str(library),'--ignore-scripts','--no-audit','--no-fund','--registry','https://registry.npmjs.org']
        if args.cache:command+=['--cache',str(args.cache.expanduser().resolve())]
        if args.proxy:command+=['--proxy',args.proxy]
        if args.offline:command+=['--offline']
        subprocess.run(command,check=True)
        runtime=library/'node_modules/@solstice621/sandbox-runtime'
        subprocess.run([str(node),str(runtime/'dist/scripts/bind-launchers.js')],check=True)
        profile.mkdir(parents=True);created_profile=True
        (profile/'node_modules').symlink_to(library/'node_modules',target_is_directory=True)
        manifest={'private':True,'type':'module','dsh':{'profile':{'bundles':['@deepseek-ai/dsh-base','@deepseek-ai/dsh-web-app','@solstice621/sandbox-runtime-dsh']}}}
        write(profile/'package.json',json.dumps(manifest,indent=2)+'\n')
        # DSH patches replace a whole config row. Keep all owned values explicit.
        protected=[str(prefix),str(home)]
        patch=[{'id':'sandbox-policy','config':{'mode':args.mode}}, {'id':'sandbox-runtime-bash','config':{'runtime':{'network':args.network,'protectedPaths':protected}}}]
        write(profile/'cordis.patch.yml',json.dumps(patch,indent=2)+'\n') # JSON is valid YAML.
        plugin=library/'node_modules/@solstice621/sandbox-runtime-opencode'
        options={'mode':args.mode,'network':args.network,'protectedPaths':protected}
        wrapper=runtime/'bin/opencode/bash'
        config={'shell':str(wrapper),'plugins':[{'package':str(plugin),'options':options}]}
        write(prefix/'config/opencode.json',json.dumps(config,indent=2)+'\n')
        # Inline configuration augments normal global/project configuration; it does not edit it.
        merge="""import { readFileSync } from 'node:fs';
const config = JSON.parse(readFileSync(new URL('./opencode.json', import.meta.url), 'utf8'));
const existing = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT || '{}');
if (!existing || typeof existing !== 'object' || Array.isArray(existing)) throw new Error('OPENCODE_CONFIG_CONTENT must be an object');
if (existing.plugins !== undefined && !Array.isArray(existing.plugins)) throw new Error('plugins must be an array');
const ours = config.plugins[0];
const plugins = (existing.plugins || []).filter(p => (typeof p === 'string' ? p : p.package) !== ours.package);
process.stdout.write(JSON.stringify({ ...existing, shell: config.shell, plugins: [...plugins, ours] }));
"""
        write(prefix/'config/opencode-config.mjs',merge)
        quote=shlex.quote
        write(prefix/'bin/dsh-sandbox',f'#!/bin/sh\nexport DSH_HOME={quote(str(home))}\nexec {quote(str(node))} {quote(str(library/"node_modules/@deepseek-ai/dsh/lib/bin.js"))} --profile {PROFILE} "$@"\n',0o755)
        write(prefix/'bin/opencode-sandbox',f'#!/bin/sh\nOPENCODE_CONFIG_CONTENT=$({quote(str(node))} {quote(str(prefix/"config/opencode-config.mjs"))}) || exit $?\nexport OPENCODE_CONFIG_CONTENT\nexport SHELL={quote(str(wrapper))}\nexec {quote(str(opencode))} "$@"\n',0o755)
        managed=[profile/'package.json',profile/'cordis.patch.yml',prefix/'config/opencode.json',prefix/'config/opencode-config.mjs',prefix/'bin/dsh-sandbox',prefix/'bin/opencode-sandbox']
        record={'format':1,'version':VERSION,'prefix':str(prefix),'profile':str(profile),'node':str(node),'opencode':str(opencode),'mode':args.mode,'network':args.network,'files':{str(p):digest(p) for p in managed},'artifacts':{p.name:digest(p) for p in archives}}
        write(prefix/'installation.json',json.dumps(record,indent=2)+'\n')
        # Validate the installed command's actual DSH config composition before declaring success.
        subprocess.run([str(prefix/'bin/dsh-sandbox'),'--dump-config'],stdout=subprocess.DEVNULL,check=True,timeout=30)
        print('Installed '+VERSION+'\n'+str(prefix/'bin/dsh-sandbox')+'\n'+str(prefix/'bin/opencode-sandbox'))
    except BaseException:
        if created_profile:shutil.rmtree(profile)
        shutil.rmtree(prefix)
        raise

def uninstall(args):
    prefix=args.prefix.expanduser().resolve();record=json.loads((prefix/'installation.json').read_text())
    if record.get('format')!=1 or record.get('prefix')!=str(prefix):raise ValueError('Not an owned installation')
    profile=Path(record['profile'])
    # Refuse unexpected manifest paths before any mutation.
    expected={str(profile/'package.json'),str(profile/'cordis.patch.yml'),*(str(prefix/p) for p in ['config/opencode.json','config/opencode-config.mjs','bin/dsh-sandbox','bin/opencode-sandbox'])}
    if set(record['files'])!=expected or profile.name!=PROFILE:raise ValueError('Invalid installation manifest')
    modified=[path for path,sha in record['files'].items() if not Path(path).is_file() or digest(Path(path))!=sha]
    if modified:raise ValueError('Configuration changed; preserving everything. Review before uninstall: '+', '.join(modified))
    link=profile/'node_modules'
    if not link.is_symlink() or link.resolve()!=prefix/'library/node_modules':raise ValueError('Profile dependency link changed; preserving installation')
    for path in record['files']:Path(path).unlink()
    link.unlink()
    # DSH writes its empty root during boot. Only remove the known empty scaffold.
    root=profile/'cordis.yml'
    if root.exists() and '[]' in root.read_text() and all(not x.strip() or x.strip().startswith('#') or x.strip()=='[]' for x in root.read_text().splitlines()):root.unlink()
    shutil.rmtree(prefix/'library')
    shutil.rmtree(prefix/'artifacts')
    for directory in [profile,prefix/'config',prefix/'bin']:
        try:directory.rmdir()
        except OSError:pass
    (prefix/'installation.json').rename(prefix/'uninstalled.json')
    print('Uninstalled launchers, plugin packages and unchanged generated configuration. Retained state: '+str(prefix/'state'))

def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('action',choices=['install','uninstall'])
    default=Path.home()/('Library/Application Support' if sys.platform=='darwin' else '.local/share')/'sandbox-runtime'/VERSION
    p.add_argument('--prefix',type=Path,default=default);p.add_argument('--artifacts',type=Path,default=Path(__file__).resolve().parents[1]/'artifacts')
    p.add_argument('--opencode');p.add_argument('--dsh-home',type=Path);p.add_argument('--cache',type=Path);p.add_argument('--proxy');p.add_argument('--offline',action='store_true')
    p.add_argument('--mode',choices=['read-only','workspace-write'],default='workspace-write');p.add_argument('--network',choices=['deny','host'],default='deny')
    a=p.parse_args()
    try:(install if a.action=='install' else uninstall)(a)
    except (ValueError,OSError,subprocess.SubprocessError) as e:print('ERROR: '+str(e),file=sys.stderr);return 1
    return 0
if __name__=='__main__':raise SystemExit(main())
