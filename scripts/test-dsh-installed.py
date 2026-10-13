#!/usr/bin/env python3
"""Run the real DSH suites against an installed, published host."""
import argparse,os,shutil,subprocess
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('--prefix',type=Path,required=True);p.add_argument('--report',type=Path,required=True);a=p.parse_args()
repo=Path(__file__).resolve().parents[1];runtime=a.prefix.resolve()/'node_modules/@solstice621/sandbox-runtime';target=runtime/'adapters/dsh/test'
if target.exists():raise SystemExit('Refusing to overwrite existing test directory: '+str(target))
target.mkdir(parents=True)
try:
    for source in (repo/'adapters/dsh/test').glob('*.js'):
        shutil.copy2(source,target/source.name)
    env={**os.environ,'SANDBOX_RUNNER':str(runtime/'bin/sandbox-runner')}
    a.report.parent.mkdir(parents=True,exist_ok=True)
    with a.report.open('w') as stream:
        result=subprocess.run(['node','--test','--test-reporter=tap',*[str(target/name) for name in ['provider.test.js','upstream.test.js','real-runner.test.js','tools.test.js']]],env=env,stdout=stream,stderr=subprocess.STDOUT)
    print(a.report)
finally:
    shutil.rmtree(target)
    for directory in [target.parent,target.parent.parent]:
        try:directory.rmdir()
        except OSError:pass
raise SystemExit(result.returncode)
