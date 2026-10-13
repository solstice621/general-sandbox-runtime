#!/usr/bin/env python3
"""Linux-only adversarial checks for the trusted TypeScript namespace supervisor."""
import argparse
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import tempfile
import time

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from runtime_identity import capture_runtime_identity


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--runner', required=True)
    parser.add_argument('--node', required=True)
    parser.add_argument('--report', required=True)
    args = parser.parse_args()
    if sys.platform != 'linux' or os.getuid() == 0:
        raise RuntimeError('run on Linux as an ordinary user')
    runner = str(Path(args.runner).resolve(strict=True))
    identity = capture_runtime_identity(runner, args.node, None)
    results = []
    with tempfile.TemporaryDirectory(prefix='ts-supervisor-acceptance-') as directory:
        root = Path(directory)
        workspace = root / 'workspace'
        workspace.mkdir()
        secret = root / 'secret'
        secret.write_text('unapproved-host-descriptor-marker')
        policy = {'version': 1, 'filesystem': {'read': 'host', 'denyRead': [{'path': str(secret), 'scope': 'file'}],
                  'allowWrite': [{'path': str(workspace), 'scope': 'tree'}], 'denyWrite': [], 'temp': 'private'},
                  'network': {'mode': 'host'}, 'ipc': {'hostUnixSockets': 'deny'}, 'environment': {'inherit': []}}

        def run(code, extra=(), pass_fds=()):
            return subprocess.run([runner, 'run', '--policy-json', json.dumps(policy), *extra,
                                   '--', '/usr/bin/python3', '-c', code], cwd=workspace, pass_fds=pass_fds,
                                  stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=12)

        def stable_heartbeat(file):
            assert file.exists(), 'detached descendant did not start'
            first = file.stat().st_size
            time.sleep(.2)
            second = file.stat().st_size
            assert first == second, f'detached descendant still writes: {first} -> {second}'
            return second

        child_program = '''
import os, signal, time
r,w=os.pipe()
pid=os.fork()
if pid == 0:
 os.close(r); os.setsid(); signal.signal(signal.SIGTERM, signal.SIG_IGN)
 f=os.open(HEARTBEAT, os.O_WRONLY|os.O_CREAT|os.O_APPEND, 0o600)
 os.write(f,b'x'); os.write(w,b'1'); os.close(w)
 while True:
  os.write(f,b'x'); time.sleep(.01)
os.close(w); assert os.read(r,1)==b'1'; os.close(r)
LEADER
'''
        heartbeat = workspace / 'leader-heartbeat'
        outcome = run(child_program.replace('HEARTBEAT', repr(str(heartbeat))).replace('LEADER', 'raise SystemExit(23)'))
        assert outcome.returncode == 23, (outcome.returncode, outcome.stderr.decode())
        results.append({'name': 'setsid-descendant-after-leader-exit', 'status': 'pass', 'exit': 23,
                        'stable_heartbeat_bytes': stable_heartbeat(heartbeat)})

        heartbeat = workspace / 'timeout-heartbeat'
        outcome = run(child_program.replace('HEARTBEAT', repr(str(heartbeat))).replace('LEADER', 'signal.signal(signal.SIGTERM,signal.SIG_IGN)\nwhile True: time.sleep(1)'),
                      ('--timeout', '300ms', '--grace', '100ms'))
        assert outcome.returncode == 124, (outcome.returncode, outcome.stderr.decode())
        results.append({'name': 'setsid-descendant-after-timeout-escalation', 'status': 'pass', 'exit': 124,
                        'stable_heartbeat_bytes': stable_heartbeat(heartbeat)})

        # Port 9229 must be unused before sending SIGUSR1 to the trusted helper.
        baseline = socket.socket()
        try: assert baseline.connect_ex(('127.0.0.1', 9229)) != 0, 'fixture already has an inspector-port listener'
        finally: baseline.close()
        source = os.open(secret, os.O_RDONLY)
        incoming_read, incoming_write = os.pipe()
        try:
            os.dup2(source, 25, inheritable=True)
            os.dup2(source, 192, inheritable=True)
            os.dup2(incoming_write, 194, inheritable=True)
            info = os.fstat(source)
            probe = '''
import glob,json,os,signal,socket,stat,time
matches=[]; control_reopened=[]; supervisor=None
for proc in glob.glob('/proc/[0-9]*'):
 try:
  argv=open(proc+'/cmdline','rb').read().split(b'\\0')
  if len(argv)>2 and argv[0].endswith(b'/node') and argv[2].endswith(b'/linux-supervisor.js'): supervisor=int(proc.rsplit('/',1)[1])
 except OSError: pass
 for fdpath in glob.glob(proc+'/fd/*'):
  try:
   info=os.stat(fdpath)
   if (info.st_dev,info.st_ino)==SECRET_ID: matches.append(fdpath)
   if stat.S_ISSOCK(info.st_mode):
    try:
     fd=os.open(fdpath,os.O_RDWR|os.O_NONBLOCK); os.close(fd); control_reopened.append(fdpath)
    except OSError: pass
  except OSError: pass
assert not matches,matches
assert not control_reopened,control_reopened
assert supervisor is not None,'trusted supervisor not found in private proc'
os.kill(supervisor,signal.SIGUSR1); time.sleep(.1); os.kill(supervisor,0)
s=socket.socket(); result=s.connect_ex(('127.0.0.1',9229)); s.close(); assert result!=0,'SIGUSR1 opened inspector'
os.write(64,b'approved-channel-ok')
print(json.dumps({'supervisor_pid':supervisor,'unapproved_secret_descriptors':matches,'reopened_socket_descriptors':control_reopened,'inspector_connection_result':result,'granted_target':64}))
'''.replace('SECRET_ID', repr((info.st_dev, info.st_ino)))
            outcome = run(probe, ('--grant-fd', '194:64'), (25, 192, 194))
            assert outcome.returncode == 0, (outcome.returncode, outcome.stderr.decode())
            assert os.read(incoming_read, 100) == b'approved-channel-ok'
            results.append({'name': 'supervisor-peer-fds-and-inspector', 'status': 'pass', 'detail': json.loads(outcome.stdout)})
        finally:
            for fd in [source, incoming_read, incoming_write, 25, 192, 194]:
                try: os.close(fd)
                except OSError: pass
    report = {'platform': sys.platform, 'effective_uid': os.geteuid(), 'runtime_identity': identity,
              'tests': results, 'passed': len(results), 'failed': 0,
              'scope': 'Linux TS supervisor; separate from portable acceptance matrix'}
    output = Path(args.report)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps({'passed': len(results), 'failed': 0, 'tests': results}, indent=2))


if __name__ == '__main__':
    main()
