import fs from 'node:fs';
import { spawn } from 'node:child_process';
const infos=[]; for(let fd=0; fd<256; ++fd) {try {const s=fs.fstatSync(fd,{bigint:true}); infos.push({fd,dev:BigInt.asUintN(64,s.dev).toString(),ino:BigInt.asUintN(64,s.ino).toString(),type:s.isFIFO()?'pipe':s.isSocket()?'socket':s.isFile()?'file':s.isCharacterDevice()?'char':'other'});} catch{}}
const child=spawn('/Library/Frameworks/Python.framework/Versions/3.12/bin/python3',['-c',`import os,json
out=[]
for fd in range(256):
 try:
  s=os.fstat(fd);out.append(dict(fd=fd,dev=str(s.st_dev&((1<<64)-1)),ino=str(s.st_ino&((1<<64)-1))))
 except OSError: pass
print(json.dumps(out))`],{detached:true});
let stdout='',stderr='';child.stdout.on('data',d=>stdout+=d);child.stderr.on('data',d=>stderr+=d);
child.on('close',status=>console.log(JSON.stringify({self:infos,child:JSON.parse(stdout),status,stderr})));
