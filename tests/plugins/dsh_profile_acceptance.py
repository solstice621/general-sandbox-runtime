#!/usr/bin/env python3
"""Boot the published DSH CLI with the packed bundle and a real profile."""
import argparse, json, os, subprocess, tempfile
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('--prefix',type=Path,required=True);p.add_argument('--work-root',type=Path,required=True);p.add_argument('--report',type=Path,required=True)
a=p.parse_args();a.prefix=a.prefix.resolve();a.work_root.mkdir(parents=True,exist_ok=True)
root=Path(tempfile.mkdtemp(prefix='dsh-profile-',dir=a.work_root)).resolve();profile=root/'home/profiles/acceptance';profile.mkdir(parents=True);workspace=root/'workspace';workspace.mkdir()
(profile/'node_modules').symlink_to(a.prefix/'node_modules',target_is_directory=True)
(profile/'package.json').write_text(json.dumps({'private':True,'type':'module','dsh':{'profile':{'bundles':['@deepseek-ai/dsh-base','@solstice621/sandbox-runtime-dsh']}}}))
probe=Path(__file__).with_name('dsh-profile-probe.mjs').resolve()
(profile/'cordis.patch.yml').write_text('- id: hmr\n  disabled: true\n- insert:\n    - id: acceptance\n      name: '+json.dumps(str(probe))+'\n')
cli=a.prefix/'node_modules/@deepseek-ai/dsh/lib/bin.js'
env={**os.environ,'DSH_HOME':str(root/'home'),'DSH_TELEMETRY_DISABLED':'1'}
results=[]
for args in [['--profile','acceptance','--dump-config'],['--profile','acceptance']]:
    r=subprocess.run(['node',str(cli),*args],cwd=workspace,env=env,capture_output=True,text=True,timeout=40)
    if '--dump-config' in args:
        ok=r.returncode==0 and 'sandbox-runtime-bash' in r.stdout
        name='published CLI composes the packed bundle'
    else:
        ok=r.returncode==0 and 'SANDBOX_PROFILE_ACCEPTANCE_OK' in r.stdout
        name='published CLI boots bundle and enforces workspace-write plus read-only'
    results.append({'name':name,'passed':ok,'exit':r.returncode})
    if not ok:print(r.stdout[-5000:]);print(r.stderr[-5000:])
    print(('PASS ' if ok else 'FAIL ')+name,flush=True)
a.report.parent.mkdir(parents=True,exist_ok=True);a.report.write_text(json.dumps({'host':'DSH 0.2.1-alpha.2','scope':'actual published CLI, profile loader and packed bundle; no model call','passed':sum(x['passed'] for x in results),'failed':sum(not x['passed'] for x in results),'cases':results},indent=2)+'\n')
raise SystemExit(0 if all(x['passed'] for x in results) else 1)
