#!/usr/bin/env python3
"""Build and pack the runtime and both adapters as local npm artifacts."""
import base64,hashlib,json,subprocess
from pathlib import Path
root=Path(__file__).resolve().parents[1]
subprocess.run(['npm','run','build'],cwd=root,check=True)
artifacts=root/'artifacts';artifacts.mkdir(exist_ok=True)
rows=[]
for source in [root,root/'packages/dsh',root/'packages/opencode']:
    result=subprocess.run(['npm','pack',str(source),'--pack-destination',str(artifacts),'--ignore-scripts','--json','--cache',str(root/'node_modules/.cache/npm-pack')],capture_output=True,text=True,check=True)
    info=json.loads(result.stdout)[0];path=artifacts/info['filename']
    rows.append(hashlib.sha256(path.read_bytes()).hexdigest()+'  '+path.name)
    print(path.name,info['size'])
lock_path=root/'installation/package-lock.json'
lock=json.loads(lock_path.read_text())
for name in ['sandbox-runtime','sandbox-runtime-dsh','sandbox-runtime-opencode']:
    path=artifacts/f'solstice621-{name}-0.3.0.tgz'
    lock['packages']['node_modules/@solstice621/'+name]['integrity']='sha512-'+base64.b64encode(hashlib.sha512(path.read_bytes()).digest()).decode()
lock_path.write_text(json.dumps(lock,indent=2)+'\n')
for path in [root/'installation/package.json',lock_path]:
    rows.append(hashlib.sha256(path.read_bytes()).hexdigest()+'  ../installation/'+path.name)
(artifacts/'SHA256SUMS').write_text('\n'.join(rows)+'\n')
