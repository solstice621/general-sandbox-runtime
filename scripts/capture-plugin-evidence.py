#!/usr/bin/env python3
"""Hash the exact installed code and assert it matches the shipped tarballs."""
import argparse,datetime,hashlib,json,platform,shutil,subprocess,tarfile
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('--prefix',type=Path,required=True);p.add_argument('--opencode',type=Path,required=True);p.add_argument('--report',type=Path,required=True);a=p.parse_args()
repo=Path(__file__).resolve().parents[1];prefix=a.prefix.resolve();nm=prefix/'node_modules'
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
code=[];archives={}
for name in ['sandbox-runtime','sandbox-runtime-dsh','sandbox-runtime-opencode']:
 archive=repo/'artifacts'/f'solstice621-{name}-0.3.0.tgz';archives[archive.name]=sha(archive);installed=nm/'@solstice621'/name
 with tarfile.open(archive) as t:
  for m in t.getmembers():
   if not m.isfile():continue
   rel=Path(m.name).relative_to('package')
   if str(rel).startswith('bin/'):continue # Install-time absolute bindings.
   expected=t.extractfile(m).read();actual=(installed/rel).read_bytes()
   assert actual==expected,(name,str(rel))
   code.append({'path':name+'/'+str(rel),'sha256':hashlib.sha256(actual).hexdigest()})
node=Path(shutil.which('node')).resolve();runtime=nm/'@solstice621/sandbox-runtime'
for rel in ['bin/sandbox-runner','bin/opencode/bash']:
 code.append({'path':'sandbox-runtime/'+rel,'sha256':sha(runtime/rel)})
assert (prefix/'package-lock.json').read_bytes()==(repo/'installation/package-lock.json').read_bytes(),'host lock differs'
dsh=nm/'@deepseek-ai/dsh/package.json'
report={'version':'0.3.0','recordedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'platform':platform.system(),'architecture':platform.machine(),'node':{'version':subprocess.check_output([str(node),'--version'],text=True).strip(),'sha256':sha(node)},'dsh':{'version':json.loads(dsh.read_text())['version'],'packageSHA256':sha(dsh)},'opencode':{'version':'2.0.14','sha256':sha(a.opencode.resolve())},'artifacts':archives,'hostDependencyLockSHA256':sha(prefix/'package-lock.json'),'installedCodeMatchesTarballs':True,'installedFiles':code}
a.report.parent.mkdir(parents=True,exist_ok=True);a.report.write_text(json.dumps(report,indent=2)+'\n');print(a.report)
