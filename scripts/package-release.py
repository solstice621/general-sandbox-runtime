#!/usr/bin/env python3
"""Package the verified source/build/plugins/evidence as a portable release ZIP."""
import hashlib,json,os,stat,zipfile
from pathlib import Path
root=Path(__file__).resolve().parents[1];version=json.loads((root/'package.json').read_text())['version']
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
def files():
 result=[]
 for folder,dirs,names in os.walk(root):
  dirs[:]=[name for name in dirs if name not in {'node_modules','.git','__pycache__','work'}]
  for name in names:
   p=Path(folder)/name
   if p.suffix!='.pyc' and name!='.DS_Store':result.append(p)
 return sorted(result)
e=root/'evidence/plugins';reports={}
for platform in ['macos','linux']:
 report=json.loads((e/f'{platform}-runtime-acceptance.json').read_text());assert report['passed']==52 and report['failed']==0 and not report['partial']
 for item in report['runtime_identity']['artifacts']:
  if item['role'] in ['deployed','metadata']:assert sha(root/item['artifact'])==item['sha256'],item['artifact']
 for name,count in [('dsh-profile',2),('opencode',18),('installer',9)]:
  data=json.loads((e/f'{platform}-{name}.json').read_text());assert data['passed']==count and data['failed']==0
 assert '# pass 25\n# fail 0\n' in (e/f'{platform}-dsh-tools.tap').read_text()
 identity=json.loads((e/f'{platform}-installed-identity.json').read_text());assert identity['installedCodeMatchesTarballs']
 for name,digest in identity['artifacts'].items():assert sha(root/'artifacts'/name)==digest
 reports[platform]=report
for name in ['release-manifest.json','SHA256SUMS']:(root/name).unlink(missing_ok=True)
items=[{'path':str(p.relative_to(root)),'bytes':p.stat().st_size,'mode':oct(stat.S_IMODE(p.stat().st_mode)),'sha256':sha(p)} for p in files()]
manifest={'name':'sandbox-runtime','version':version,'implementation':'TypeScript','release_date':'2026-10-14','node_requirement':'>=24.19.0','tested_node':'24.19.0','typescript':'5.9.3','hosts':{'DSH':'0.2.1-alpha.2','OpenCode':'2.0.14'},'install':'python3 scripts/install-plugins.py install --opencode /absolute/opencode','test_results':{'each_platform':{'runtime_acceptance_pass':52,'dsh_tool_pass':25,'dsh_profile_pass':2,'opencode_pass':18,'installer_pass':9},'macos_unit':{'pass':72,'not_applicable':1},'linux_unit':{'pass':71,'not_applicable':2}},'tested_runtime_closures':{k:v['runtime_identity']['closure_sha256'] for k,v in reports.items()},'plugin_artifacts':json.loads((e/'macos-installed-identity.json').read_text())['artifacts'],'personal_host_configuration_modified':False,'historical_evidence':'REPORT.md body, evidence/typescript and test-results/typescript are frozen 0.2.0 evidence','scope':'Bash-only; see PLUGINS.md and PLUGIN-VERIFICATION.md','excluded':['node_modules','Node and host executables','OS helpers','scratch fixtures','.git'],'file_list_excludes':['release-manifest.json','SHA256SUMS'],'files':items}
(root/'release-manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
(root/'SHA256SUMS').write_text(''.join(f'{sha(p)}  {p.relative_to(root)}\n' for p in files()))
paths=files();archive=root.parent/f'sandbox-runtime-{version}.zip'
with zipfile.ZipFile(archive,'w',compression=zipfile.ZIP_DEFLATED,compresslevel=9) as z:
 for p in paths:
  info=zipfile.ZipInfo('sandbox-runtime/'+str(p.relative_to(root)),date_time=(2026,10,14,0,0,0));info.create_system=3;info.external_attr=(stat.S_IFREG|stat.S_IMODE(p.stat().st_mode))<<16;info.compress_type=zipfile.ZIP_DEFLATED;z.writestr(info,p.read_bytes(),compresslevel=9)
with zipfile.ZipFile(archive) as z:
 assert z.testzip() is None and len(z.infolist())==len(paths)
 for p in paths:assert z.read('sandbox-runtime/'+str(p.relative_to(root)))==p.read_bytes()
(archive.parent/(archive.name+'.sha256')).write_text(sha(archive)+'  '+archive.name+'\n')
print(json.dumps({'archive':str(archive),'bytes':archive.stat().st_size,'files':len(paths),'sha256':sha(archive)}))
