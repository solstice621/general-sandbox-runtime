#!/usr/bin/env python3
"""Real installed OpenCode + packed plugin acceptance; no model or user credentials."""
import argparse, base64, concurrent.futures, json, os, re, shutil, socket, subprocess, tempfile, time
import urllib.request, urllib.parse, urllib.error
from pathlib import Path

class Host:
    def __init__(self, binary, prefix, root, mode='workspace-write', plugin_enabled=True):
        self.binary, self.prefix, self.root = binary, prefix, root
        self.workspace = root/'workspace'
        self.other = root/'outside'
        for p in [self.workspace, self.other, root/'config', root/'probe']: p.mkdir(parents=True,exist_ok=True)
        shutil.copyfile(Path(__file__).with_name('opencode-probe.mjs'),root/'probe/index.js')
        (root/'probe/package.json').write_text('{"type":"module","exports":"./index.js"}')
        package = prefix/'node_modules/@solstice621/sandbox-runtime-opencode'
        wrapper=prefix/'node_modules/@solstice621/sandbox-runtime/bin/opencode/bash'
        plugins=([{'package':str(package),'options':{'mode':mode}}] if plugin_enabled else [])+[str(root/'probe')]
        (root/'config/opencode.json').write_text(json.dumps({'shell':str(wrapper),'plugins':plugins}))
        self.preload_marker=root/'loader-injection'
        (root/'untrusted.cjs').write_text(f"require('fs').writeFileSync({json.dumps(str(self.preload_marker))},'injected')")
        (root/'untrusted.sh').write_text(f"printf injected > '{self.preload_marker}'\n")
        env={'PATH':os.environ['PATH'],'HOME':str(root),'LANG':'C','TERM':'dumb','SHELL':str(wrapper),
             'OPENCODE_CONFIG_DIR':str(root/'config'),'OPENCODE_CONFIG_CONTENT':'{}','OPENCODE_DB':str(root/'opencode.db'),
             'OPENCODE_TEST_HOME':str(root),'XDG_CACHE_HOME':str(root/'cache'),'XDG_CONFIG_HOME':str(root/'xdg-config'),
             'XDG_DATA_HOME':str(root/'data'),'XDG_STATE_HOME':str(root/'state'),'OPENCODE_DISABLE_MODELS_FETCH':'true',
             'OPENCODE_DISABLE_FILEWATCHER':'true','NODE_OPTIONS':'--require='+str(root/'untrusted.cjs'),
             'BASH_ENV':str(root/'untrusted.sh'),'SANDBOX_TEST_SECRET':'must-not-inherit'}
        with socket.socket() as s: s.bind(('127.0.0.1',0)); port=s.getsockname()[1]
        self.url=f'http://127.0.0.1:{port}'
        self.log=open(root/'server.log','w')
        self.process=subprocess.Popen([str(binary),'serve','--hostname','127.0.0.1','--port',str(port)],cwd=self.workspace,env=env,stdout=self.log,stderr=self.log)
        self.opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
        self.credential=None
        try:
            self.until(lambda:self._ready(),15)
            if plugin_enabled:self.until(lambda:any(p.get('id')=='sandbox-runtime.bash' and p.get('state',{}).get('status')=='active' for p in self.req('/api/plugin')['data']),15)
            self.until(lambda:any(p.get('id')=='sandbox-runtime.acceptance-driver' and p.get('state',{}).get('status')=='active' for p in self.req('/api/plugin')['data']),15)
        except BaseException: self.close(); raise
        self.sequence=0
    def _ready(self):
        if self.process.poll() is not None: raise RuntimeError('OpenCode exited before readiness')
        match=re.search(r'server password (\S+)',(self.root/'server.log').read_text())
        if not match:return False
        self.credential=base64.b64encode(('opencode:'+match[1]).encode()).decode()
        try:return bool(self.req('/api/info').get('version'))
        except (OSError,urllib.error.URLError):return False
    def req(self,path,body=None,method=None,location=None):
        path+='?'+urllib.parse.urlencode({'location[directory]':str(location or self.workspace)})
        request=urllib.request.Request(self.url+path,data=json.dumps(body).encode() if body is not None else None,method=method,headers={'Content-Type':'application/json','Authorization':'Basic '+str(self.credential)})
        try:
            with self.opener.open(request,timeout=15) as r:
                raw=r.read();return json.loads(raw) if raw else None
        except urllib.error.HTTPError as e: raise RuntimeError(f'HTTP {e.code}: {e.read().decode()[:2000]}') from e
    def until(self,fn,seconds=10):
        end=time.monotonic()+seconds
        while time.monotonic()<end:
            result=fn()
            if result:return result
            time.sleep(.025)
        raise TimeoutError('condition did not become true')
    def shell(self,command,timeout=5000,cwd=None):
        data={'command':command,'timeout':timeout}
        if cwd is not None:data['cwd']=str(cwd)
        item=self.req('/api/shell',data)['data']
        assert item['shell']==str(self.prefix/'node_modules/@solstice621/sandbox-runtime/bin/opencode/bash'),item
        assert item['command']==command,item
        return item
    def settled(self,item):
        final=self.until(lambda: self._terminal(item['id']))
        output=self.req('/api/shell/'+item['id']+'/output')['data']
        return final,output
    def _terminal(self,id):
        info=self.req('/api/shell/'+id)['data']
        return info if info['status']!='running' else None
    def session(self,permissions=None):
        return self.req('/api/session',{'location':{'directory':str(self.workspace)},'permissions':permissions or [{'action':'*','resource':'*','effect':'allow'}]})['data']
    def rpc(self,method,data):return self.req('/api/rpc/sandbox-acceptance/'+method,{'input':data})['output']
    def tool(self,session,command,**kwargs):
        self.sequence+=1;id='sandbox-case-'+str(self.sequence)
        self.rpc('start',{'id':id,'sessionID':session['id'],'agent':session.get('agent') or 'build','args':{'command':command,**kwargs}})
        return id
    def tool_done(self,id):return self.until(lambda:self._tool_terminal(id),15)
    def _tool_terminal(self,id):
        info=self.rpc('status',{'id':id});return info if info['status']!='running' else None
    def close(self):
        if self.process.poll() is None:
            self.process.terminate()
            try:self.process.wait(timeout=8)
            except subprocess.TimeoutExpired:self.process.kill();self.process.wait()
        self.log.close()
        # Never persist the temporary API credential in deliverable evidence.
        p=self.root/'server.log'
        p.write_text(re.sub(r'(server password )\S+',r'\1[redacted]',p.read_text()))


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--opencode',type=Path,required=True);parser.add_argument('--prefix',type=Path,required=True);parser.add_argument('--report',type=Path,required=True);parser.add_argument('--work-root',type=Path,required=True)
    args=parser.parse_args();args.prefix=args.prefix.resolve();args.work_root.mkdir(parents=True,exist_ok=True)
    root=Path(tempfile.mkdtemp(prefix='opencode-',dir=args.work_root)).resolve()
    cases=[];host=None
    def check(name,fn):
        started=time.monotonic()
        try:detail=fn();cases.append({'name':name,'passed':True,'detail':detail,'milliseconds':round((time.monotonic()-started)*1000)})
        except BaseException as e:cases.append({'name':name,'passed':False,'error':str(e)});raise
        print('PASS '+name,flush=True)
    try:
        host=Host(args.opencode,args.prefix,root/'write')
        check('packed plugin is active in actual OpenCode 2.0.14',lambda:True)
        def foreground():
            command='printf "quoted \' value\\n"; printf error >&2; printf allowed > inside; exit 7'
            done,output=host.settled(host.shell(command))
            assert done.get('exit')==7 and "quoted ' value" in output['output'] and 'error' in output['output'],(done,output)
            assert (host.workspace/'inside').read_text()=='allowed'
            return {'exit':done['exit'],'commandPreserved':done['command']==command}
        check('argv quoting, stdout, stderr, exit and allowed write',foreground)
        def denied():
            target=host.other/'forbidden'
            done,_=host.settled(host.shell(f'/bin/bash -c "printf forbidden > {target}"'))
            assert done.get('exit')!=0 and not target.exists(),done
        check('outside write denied through a child Bash',denied)
        def cwd():
            done,_=host.settled(host.shell('printf forbidden > outside-cwd',cwd=host.other))
            assert done.get('exit')!=0 and not (host.other/'outside-cwd').exists(),done
        check('changing cwd cannot expand writable root',cwd)
        def environment():
            done,out=host.settled(host.shell('printf "%s|%s|%s|%s" "$NODE_OPTIONS" "$BASH_ENV" "$SANDBOX_TEST_SECRET" "$SANDBOX_RUNTIME_POLICY"'))
            assert done.get('exit')==0 and out['output']=='|||',(done,out)
            assert not host.preload_marker.exists()
        check('Bun-to-Node preparation and payload scrub hostile environment',environment)
        def network():
            done,_=host.settled(host.shell(f'/usr/bin/curl --noproxy "*" --max-time 2 {host.url}/api/info'))
            assert done.get('exit')!=0,done
        check('network deny blocks loopback TCP',network)
        def timeout():
            done,_=host.settled(host.shell('printf ready > deadline-started; sleep 2; printf late > deadline-late',timeout=120))
            assert done['status']=='timeout',done
            time.sleep(.2);assert not (host.workspace/'deadline-late').exists()
        check('native OpenCode timeout terminates sandbox command',timeout)
        def cancel():
            item=host.shell('printf ready > cancel-started; sleep 30; printf late > cancel-late',timeout=0)
            host.until(lambda:(host.workspace/'cancel-started').exists())
            host.req('/api/shell/'+item['id'],method='DELETE')
            assert not (host.workspace/'cancel-late').exists()
        check('native shell removal cancels sandbox command',cancel)
        session=host.session()
        def native_tool():
            result=host.tool_done(host.tool(session,'printf native-tool; printf yes > tool-file'))
            assert result['status']=='completed',result
            assert result['result']['output']['exit']==0,result
            assert (host.workspace/'tool-file').read_text()=='yes'
            return result['result']['output']
        check('real registered ShellTool executes through sandbox plugin',native_tool)
        def permission_denied():
            s=host.session([{'action':'*','resource':'*','effect':'allow'},{'action':'shell','resource':'*','effect':'deny'}])
            result=host.tool_done(host.tool(s,'printf denied > permission-denied'))
            assert result['status']=='failed' and not (host.workspace/'permission-denied').exists(),result
        check('real native shell permission denial blocks side effects',permission_denied)
        def permission_once():
            s=host.session([{'action':'*','resource':'*','effect':'allow'},{'action':'shell','resource':'*','effect':'ask'}])
            id=host.tool(s,'printf approved > approval-once')
            requests=host.until(lambda:host.req('/api/session/'+s['id']+'/permission')['data'])
            request=requests[0]
            assert request['action']=='shell' and any('printf approved' in x for x in request['resources']),request
            assert not any('sandbox-runner' in x for x in request['resources']),request
            assert not (host.workspace/'approval-once').exists()
            host.req('/api/session/'+s['id']+'/permission/'+request['id']+'/reply',{'decision':'once'})
            result=host.tool_done(id);assert result['status']=='completed',result
            id2=host.tool(s,'printf denied > approval-next')
            next_request=host.until(lambda:host.req('/api/session/'+s['id']+'/permission')['data'])[0]
            host.req('/api/session/'+s['id']+'/permission/'+next_request['id']+'/reply',{'decision':'reject'})
            assert host.tool_done(id2)['status']=='failed' and not (host.workspace/'approval-next').exists()
            return {'resources':request['resources'],'nextCallPrompted':True}
        check('native approval sees original command and once grant stays one-shot',permission_once)
        def background():
            result=host.tool_done(host.tool(session,'printf begin > background-started; sleep 1; printf finished > background-done; printf background-output',background=True))
            assert result['status']=='completed',result
            output=result['result']['output'];assert output['status']=='running' and output.get('shellID'),result
            info,out=host.settled({'id':output['shellID']})
            assert info['exit']==0 and 'background-output' in out['output'] and (host.workspace/'background-done').exists(),(info,out)
            return {'returnedRunning':True,'exit':info['exit']}
        check('native ShellTool background job retains output and completion',background)
        def tool_cancel():
            id=host.tool(session,'printf start > tool-cancel-started; sleep 30; printf late > tool-cancel-late')
            host.until(lambda:(host.workspace/'tool-cancel-started').exists())
            host.rpc('cancel',{'id':id})
            result=host.tool_done(id);assert result['status']=='failed',result
            assert not (host.workspace/'tool-cancel-late').exists()
        check('native tool AbortSignal cancels its sandbox job',tool_cancel)
        def large_output():
            result=host.tool_done(host.tool(session,"head -c 250000 /dev/zero | tr '\\0' x"))
            assert result['status']=='completed' and result['result']['output']['truncated'] is True,result
        check('native ShellTool output truncation remains available',large_output)
        def concurrent():
            a=host.shell('sleep 0.1; printf A > concurrent-a; printf A')
            b=host.shell('printf B > concurrent-b; printf B')
            ad,ao=host.settled(a);bd,bo=host.settled(b)
            assert ad['exit']==bd['exit']==0 and ao['output']=='A' and bo['output']=='B'
        check('concurrent host shells keep independent output and execution',concurrent)
        host.close();host=None
        host=Host(args.opencode,args.prefix,root/'readonly','read-only')
        def readonly():
            done,_=host.settled(host.shell('/bin/bash -c "printf denied > readonly-file"'))
            assert done.get('exit')!=0 and not (host.workspace/'readonly-file').exists(),done
            done,out=host.settled(host.shell('printf readable'))
            assert done.get('exit')==0 and out['output']=='readable'
        check('read-only plugin policy denies writes while allowing reads and output',readonly)
        host.close();host=None
        host=Host(args.opencode,args.prefix,root/'invalid','invalid-mode')
        def invalid_options():
            try:
                item=host.req('/api/shell',{'command':'printf escaped > invalid-escape','timeout':3000})['data']
                done,_=host.settled(item)
                assert done.get('exit')!=0,done
            except RuntimeError as e:
                assert str(e).startswith('HTTP 500:'),str(e)
            assert not (host.workspace/'invalid-escape').exists()
        check('invalid plugin options cannot fall back to an ordinary shell',invalid_options)
        host.close();host=None
        host=Host(args.opencode,args.prefix,root/'missing-plugin',plugin_enabled=False)
        def missing_plugin():
            done,_=host.settled(host.shell('printf escaped > missing-plugin-escape'))
            assert done.get('exit')==125 and not (host.workspace/'missing-plugin-escape').exists(),done
        check('installer default shell guard denies execution when plugin is absent',missing_plugin)

    finally:
        if host:host.close()
        report={'version':1,'host':'OpenCode 2.0.14',
                'scope':'actual installed CLI, packed plugin, native shell service and registered ShellTool; test RPC supplies tool calls and simulated permission replies; no LLM or human UI',
                'workRoot':str(root),'passed':sum(x['passed'] for x in cases),'failed':sum(not x['passed'] for x in cases),'cases':cases}
        args.report.parent.mkdir(parents=True,exist_ok=True);args.report.write_text(json.dumps(report,indent=2)+'\n')
if __name__=='__main__':main()
