#!/usr/bin/env python3
"""Real install, generated launchers, conflict refusal and safe uninstall."""
import argparse,json,os,subprocess,tempfile
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('--opencode',type=Path,required=True);p.add_argument('--cache',type=Path,required=True);p.add_argument('--work-root',type=Path,required=True);p.add_argument('--report',type=Path,required=True)
a=p.parse_args();a.work_root.mkdir(parents=True,exist_ok=True);root=Path(tempfile.mkdtemp(prefix='installer-',dir=a.work_root)).resolve();prefix=root/'installed';dsh_home=root/'existing-dsh-home';dsh_home.mkdir();(dsh_home/'cordis.patch.yml').write_text('[]\n');(dsh_home/'unrelated.txt').write_text('preserve')
repo=Path(__file__).resolve().parents[2];installer=repo/'scripts/install-plugins.py'
command=['python3',str(installer),'install','--prefix',str(prefix),'--dsh-home',str(dsh_home),'--opencode',str(a.opencode.resolve()),'--cache',str(a.cache.resolve()),'--offline']
cases=[]
def record(name,ok,detail=None):
    cases.append({'name':name,'passed':ok,'detail':detail});print(('PASS ' if ok else 'FAIL ')+name,flush=True)
    if not ok:raise AssertionError(name)
def run(args,**kw):return subprocess.run(args,text=True,capture_output=True,timeout=100,**kw)
try:
    result=run(command);record('offline install succeeds from the npm lock and three tarballs',result.returncode==0,result.stderr[-300:] if result.returncode else None)
    meta=json.loads((prefix/'installation.json').read_text());record('installation records its version and bound Node path',meta['version']==json.loads((repo/'package.json').read_text())['version'] and Path(meta['node']).is_absolute())
    config=json.loads((prefix/'config/opencode.json').read_text());record('OpenCode missing-plugin guard uses a bound Bash wrapper',config['shell'].endswith('/bin/opencode/bash'))
    env={**os.environ,'OPENCODE_CONFIG_CONTENT':json.dumps({'permissions':[{'action':'shell','resource':'*','effect':'ask'}],'plugins':['existing-plugin']})}
    merged=run([meta['node'],str(prefix/'config/opencode-config.mjs')],env=env);data=json.loads(merged.stdout)
    record('launcher preserves existing permissions and plugin entries',data['permissions'][0]['effect']=='ask' and data['plugins'][0]=='existing-plugin' and data['shell']==config['shell'])
    dump=run([str(prefix/'bin/dsh-sandbox'),'--dump-config']);record('generated DSH launcher composes custom profile',dump.returncode==0 and 'sandbox-runtime-bash' in dump.stdout)
    state=prefix/'state/keep-session';state.write_text('keep-state')
    result=run(command);record('second install refuses overwrite',result.returncode!=0 and state.read_text()=='keep-state')
    config_path=prefix/'config/opencode.json';original=config_path.read_bytes();config_path.write_bytes(original+b'\n')
    uninstall=['python3',str(installer),'uninstall','--prefix',str(prefix)]
    result=run(uninstall);record('uninstall accepts edited configuration and removes owned packages and launchers',result.returncode==0 and not (prefix/'library').exists() and not (prefix/'bin/dsh-sandbox').exists())
    record('uninstall preserves state and existing DSH home configuration',state.read_text()=='keep-state' and (dsh_home/'cordis.patch.yml').read_text()=='[]\n' and (dsh_home/'unrelated.txt').read_text()=='preserve')
finally:
    a.report.parent.mkdir(parents=True,exist_ok=True);a.report.write_text(json.dumps({'scope':'actual offline npm install and generated launcher/config checks; isolated prefix and existing-home fixture','passed':sum(x['passed'] for x in cases),'failed':sum(not x['passed'] for x in cases),'cases':cases},indent=2)+'\n')
