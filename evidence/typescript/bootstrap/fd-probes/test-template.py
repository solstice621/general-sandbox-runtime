import os, subprocess, socket, pathlib, json, shlex, shutil
base=pathlib.Path(__file__).resolve().parent
node_binary=os.environ.get('SANDBOX_TEST_NODE') or shutil.which('node')
assert node_binary, 'Node is required'
node_version=subprocess.check_output([node_binary,'--version'],text=True).strip()
(base/'probe-secret').write_text('fixture-only')
root=base/"template runtime's root"
(root/'bin').mkdir(parents=True,exist_ok=True)
(root/'dist'/'src').mkdir(parents=True,exist_ok=True)
(root/'package.json').write_text('{"type":"commonjs"}')
launcher=root/'bin'/'sandbox-runner'
launcher.write_text((base.parent/'launcher-template.sh').read_text().replace('__NODE__',shlex.quote(node_binary)))
launcher.chmod(0o755)
(root/'dist'/'src'/'cli.js').write_text('''const fs=require('node:fs');
const sources=(process.env.SANDBOX_RUNTIME_SOURCE_SNAPSHOT||'').split(',').filter(Boolean);
console.log(JSON.stringify({args:process.argv.slice(2),snapshot:process.env.SANDBOX_RUNTIME_SOURCE_SNAPSHOT,nodeOptions:process.env.NODE_OPTIONS??null,nodePath:process.env.NODE_PATH??null,sources:sources.map(fd=>{const s=fs.fstatSync(Number(fd),{bigint:true});return {fd,dev:BigInt.asUintN(64,s.dev).toString(),ino:BigInt.asUintN(64,s.ino).toString(),type:s.isSocket()?'socket':s.isFIFO()?'pipe':'other'}})}));
''')
results=[]
external=base/'external npm bin';external.mkdir(exist_ok=True)
def run(name,args,passed=(),expected=0,entry=None):
 env={**os.environ,'SANDBOX_RUNTIME_SOURCE_SNAPSHOT':'3,4,192,1024','NODE_OPTIONS':'--require=/not-present/should-never-load','NODE_PATH':'/not-present','PATH':str(external)+os.pathsep+os.environ.get('PATH','')}
 p=subprocess.run([str(entry or launcher),*args],capture_output=True,text=True,pass_fds=passed,env=env)
 assert p.returncode==expected,(name,p.returncode,p.stderr)
 record=dict(name=name,status=p.returncode,stderr=p.stderr.strip())
 if expected==0:
  got=json.loads(p.stdout);record['observed']=got
  assert got['nodeOptions'] is None and got['nodePath'] is None
  record['callerIdentities']={str(fd):dict(dev=str(os.fstat(fd).st_dev&((1<<64)-1)),ino=str(os.fstat(fd).st_ino&((1<<64)-1))) for fd in passed}
  for source in got['sources']:
   assert source['fd'] in record['callerIdentities']
   assert (source['dev'],source['ino'])==tuple(record['callerIdentities'][source['fd']].values())
  if not passed: assert got['snapshot']==''
 results.append(record)
for fd in [*range(3,33),192,1024]:
 run(f'absent-source-{fd}',['run','--grant-fd',f'{fd}:7','--','payload'],expected=125)
for spec in ['',':7','2:7','0:7','03:7','+3:7','3x:7','3/../4:7','1025:7','99999999999999999999999:7','3']:
 run('bad-source-'+spec,['run','--grant-fd='+spec,'--','payload'],expected=125)
run('missing-value',['run','--grant-fd'],expected=125)
run('untrusted-manifest-reset',['run','--','payload'])
run('delimiter-not-parsed',['run','--','payload','--grant-fd','3:7'])
run('policy-value-not-parsed',['run','--policy-json','--grant-fd=3:7','--','payload'])
run('timeout-value-not-parsed',['run','--timeout','--grant-fd=3:7','--','payload'])
run('implicit-payload-boundary',['run','--policy-json','{}','payload','--grant-fd','3:7'])
a,b=socket.socketpair();r,w=os.pipe();os.dup2(r,192)
run('socket-preserved',['run','--grant-fd',f'{a.fileno()}:7','--','payload'],(a.fileno(),))
run('pipe-preserved',['run','--grant-fd='+f'{r}:8','--','payload'],(r,))
run('high-pipe-preserved',['run','--grant-fd','192:9','--','payload'],(192,))
run('all-preserved',['run','--grant-fd',f'{a.fileno()}:7','--grant-fd='+f'{r}:8','--grant-fd','192:9','--','payload'],(a.fileno(),r,192))
run('later-invalid-source',['run','--grant-fd',f'{a.fileno()}:7','--grant-fd','4:8','--','payload'],(a.fileno(),),125)
f=os.open(base/'probe-secret',os.O_RDONLY);run('regular-file-rejected',['run','--grant-fd',f'{f}:7','--','payload'],(f,),125)
d=os.open(base,os.O_RDONLY);run('directory-rejected',['run','--grant-fd',f'{d}:7','--','payload'],(d,),125)
absolute=external/'runner-absolute';relative=external/'runner-relative';chain=external/'runner-chain'
for link in [absolute,relative,chain]:
 if link.is_symlink(): link.unlink()
absolute.symlink_to(launcher)
relative.symlink_to(os.path.relpath(launcher,external))
chain.symlink_to(relative.name)
run('external-absolute-link',['run','--','payload'],entry=absolute)
run('external-relative-link',['run','--grant-fd',f'{a.fileno()}:7','--','payload'],(a.fileno(),),entry=relative)
run('external-link-chain',['run','--grant-fd','192:9','--','payload'],(192,),entry=chain)
run('external-path-lookup',['run','--','payload'],entry=relative.name)
print(json.dumps(dict(platform=os.uname().sysname,node=node_version,passed=len(results),cases=results),indent=2))
