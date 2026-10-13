import os,socket,json,subprocess,pathlib
base=pathlib.Path(__file__).resolve().parent
f=os.open(base/'linux-secret',os.O_RDWR|os.O_CREAT,0o600);os.write(f,b'secret')
os.dup2(f,25);os.dup2(f,192)
a,b=socket.socketpair()
passed=(25,192,a.fileno())
results=[]
for mode in ['baseline','cover']:
 p=subprocess.run(['/usr/local/bin/node',str(base/'linux-cover.mjs'),mode,str(a.fileno())],pass_fds=passed,capture_output=True,text=True,check=True)
 data=json.loads(p.stdout); data['grantMessage']=b.recv(8).decode()
 assert data['status']==0 and data['grantMessage']=='grant-ok',data
 assert data['before']==data['after'],'parent handles were modified'
 identity=(str(os.fstat(f).st_dev),str(os.fstat(f).st_ino))
 data['leakedSecretFDs']=[row['fd'] for row in data['child'] if (row['dev'],row['ino'])==identity]
 if mode=='baseline': assert data['leakedSecretFDs']==[25,192],data['leakedSecretFDs']
 else: assert data['leakedSecretFDs']==[],data['leakedSecretFDs']
 results.append(data)
print(json.dumps(dict(passed=True,cases=results),indent=2))
