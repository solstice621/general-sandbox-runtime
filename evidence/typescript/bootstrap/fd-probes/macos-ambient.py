import os,socket,subprocess,json,pathlib,fcntl,shutil
base=pathlib.Path(__file__).resolve().parent
(base/'probe-secret').write_text('fixture-only')
f=os.open(base/'probe-secret',os.O_RDONLY);hi=fcntl.fcntl(f,fcntl.F_DUPFD,192)
a,b=socket.socketpair();r,w=os.pipe();fds=(f,hi,a.fileno(),r)
node=os.environ.get('SANDBOX_TEST_NODE') or shutil.which('node')
p=subprocess.run([node,str(base/'async-inspect.mjs')],pass_fds=fds,capture_output=True,text=True,check=True)
obj=json.loads(p.stdout)
ids={str(fd):{'dev':str(os.fstat(fd).st_dev&((1<<64)-1)),'ino':str(os.fstat(fd).st_ino&((1<<64)-1))} for fd in fds}
assert obj['status']==0
for c in obj['child']:
 assert all((c['dev'],c['ino'])!=(i['dev'],i['ino']) for i in ids.values())
obj['inherited']=ids;obj['passed']=True
print(json.dumps(obj,indent=2))
