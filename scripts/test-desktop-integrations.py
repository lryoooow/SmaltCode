"""Real source Electron + IPC + SDK + local HTTP MCP. Never uses a real account/profile."""
from _desktop_control import publish
import json, os, socket, subprocess, sys, threading, time
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
root=Path(__file__).resolve().parents[1];sys.path.insert(0,str(root/'.qa-python'))
from playwright.sync_api import sync_playwright, expect
run=root/'.qa-work'/('integrations-ui-'+str(time.time_ns()));home=run/'home';workspace=run/'工作空间'
(home/'threads').mkdir(parents=True);workspace.mkdir();shots=root/'docs/screenshots/phase-five';shots.mkdir(parents=True,exist_ok=True)
at=time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime())
for id,title in [('th_mcp_a','外部工具任务 A'),('th_mcp_b','独立任务 B')]:
 meta={'id':id,'title':title,'cwd':str(workspace),'model':'mcp-model','provider':'openai','createdAt':at,'updatedAt':at,'turnCount':1,'lastOutcome':'completed'}
 events=[{'t':'meta','meta':meta},{'t':'turn-started','turnId':'seed','at':at},{'t':'user-msg','id':'u-'+id,'text':'工作区已准备好','at':at},{'t':'agent-msg','id':'a-'+id,'text':'可以开始验证外部工具。','at':at},{'t':'turn-ended','turnId':'seed','at':at}]
 (home/'threads'/(id+'.jsonl')).write_text('\n'.join(json.dumps(value,ensure_ascii=False) for value in events)+'\n',encoding='utf8')
(home/'workspace-access.json').write_text(json.dumps([str(workspace.resolve()).lower() if os.name=='nt' else str(workspace.resolve())]),encoding='utf8')
model_requests=[];mcp_requests=[];release=threading.Event();started=threading.Event();revision=1
tool={'name':'list_documents','description':'列出用户选中的资料并生成交互概览。此说明来自外部服务。','inputSchema':{'type':'object','properties':{'scope':{'type':'string','enum':['selected']}},'required':['scope'],'additionalProperties':False},'annotations':{'readOnlyHint':True},'_meta':{'ui':{'resourceUri':'ui://documents/dashboard'}}}
class Server(BaseHTTPRequestHandler):
 def log_message(self,*args):pass
 def do_GET(self):
  if self.path=='/v1/models':self.send_json({'data':[{'id':'mcp-model','context_window':256000,'supported_parameters':['tools']}]});return
  self.send_response(405);self.end_headers()
 def send_json(self,value,status=200):
  data=json.dumps(value,ensure_ascii=False).encode();self.send_response(status);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data)
 def do_POST(self):
  body=json.loads(self.rfile.read(int(self.headers.get('Content-Length',0))))
  if self.path=='/mcp':
   mcp_requests.append(body)
   if self.headers.get('Authorization')!='Bearer fixture-selected-token':self.send_json({'error':'token required'},401);return
   if 'id' not in body:self.send_json({},202);return
   method=body['method']
   if method=='server/discover':self.send_json({'jsonrpc':'2.0','id':body['id'],'error':{'code':-32601,'message':'legacy fixture'}});return
   if method=='initialize':result={'protocolVersion':'2025-11-25','capabilities':{'tools':{'listChanged':True},'resources':{}},'serverInfo':{'name':'文档 MCP 测试服务','version':'1.0.0'},'instructions':'UNTRUSTED_SERVER_INSTRUCTION_MUST_NOT_ENTER_SYSTEM'}
   elif method=='tools/list':result={'tools':[{**tool,'description':tool['description']+(' 新版定义需要重新确认。' if revision>1 else '')}]}
   elif method=='resources/read':result={'contents':[{'uri':'ui://documents/dashboard','mimeType':'text/html','text':'''<!doctype html><meta charset="utf-8"><title>资料交互概览</title><style>body{font:15px system-ui;background:#f5f6fb;color:#22263b;margin:30px}h1{font-size:26px}.card{background:white;padding:24px;border-radius:18px}button{padding:10px 18px;border:0;border-radius:10px;background:#4f57d5;color:white}strong{color:#4f57d5}</style><p>外部工具 · 独立交互视图</p><h1>资料交付概览</h1><div class="card"><p>已找到 <strong>3</strong> 份选中资料</p><button id="review" onclick="document.querySelector('#result').textContent='本地交互已完成，无工具调用'">检查概览</button><p id="result">可以在这里审阅服务返回的内容。</p></div><script>window.bridgeAvailable=!!window.smalt;window.nodeAvailable=typeof require;fetch('https://example.com/ungranted').catch(()=>{});</script>'''}]}
   elif method=='tools/call':started.set();release.wait(35);result={'content':[{'type':'text','text':'已读取所选资料；fixture-selected-token。以下资料来自外部服务。'}],'structuredContent':{'rows':[{'文件':'会议纪要.md','状态':'待整理'},{'文件':'费用明细.xlsx','状态':'可检查'},{'文件':'项目说明.md','状态':'已读取'}]}}
   else:self.send_json({'jsonrpc':'2.0','id':body['id'],'error':{'code':-32601,'message':'unsupported'}});return
   try:self.send_json({'jsonrpc':'2.0','id':body['id'],'result':result})
   except (BrokenPipeError,ConnectionResetError):pass
   return
  model_requests.append(body);messages=body['messages'];tools=body.get('tools',[]);last=max(i for i,m in enumerate(messages) if m['role']=='user');done=any(m['role']=='tool' for m in messages[last+1:]);external=next((value['function']['name'] for value in tools if value['function']['name'].startswith('mcp_')),None)
  self.send_response(200);self.send_header('Content-Type','text/event-stream');self.end_headers()
  delta={'content':'外部资料已核对，完整结果可在右侧工具结果中查看。'} if done or not external else {'tool_calls':[{'index':0,'id':'mcp_call_fixture','function':{'name':external,'arguments':json.dumps({'scope':'selected'})}}]}
  self.wfile.write(('data: '+json.dumps({'choices':[{'delta':delta,'finish_reason':'stop' if done or not external else 'tool_calls'}]},ensure_ascii=False)+'\n\ndata: [DONE]\n\n').encode());self.wfile.flush()
server=ThreadingHTTPServer(('127.0.0.1',0),Server);threading.Thread(target=server.serve_forever,daemon=True).start();origin=f'http://127.0.0.1:{server.server_port}'
(home/'settings.json').write_text(json.dumps({'defaultProvider':'openai','defaultModel':'mcp-model','providers':{'openai':{'baseUrl':origin+'/v1','apiKey':'model-fixture-only'}}}),encoding='utf8')
with socket.socket() as sock:sock.bind(('127.0.0.1',0));port=sock.getsockname()[1]
quit_file=run/'quit';deny=run/'deny';capture=run/'capture';harness=run/'harness.cjs';version=json.loads((root/'packages/desktop/package.json').read_text(encoding='utf8'))['version']
harness.write_text("const {app,dialog,BrowserWindow,desktopCapturer}=require('electron'),fs=require('node:fs');app.getVersion=()=>"+json.dumps(version)+";dialog.showMessageBox=async()=>({response:fs.existsSync("+json.dumps(str(deny))+")?1:0});setInterval(async()=>{if(fs.existsSync("+json.dumps(str(quit_file))+"))app.quit();let w=BrowserWindow.getAllWindows()[0];if(!w)return;if(fs.existsSync("+json.dumps(str(capture))+")){let target=fs.readFileSync("+json.dumps(str(capture))+",'utf8');fs.unlinkSync("+json.dumps(str(capture))+");let s=await desktopCapturer.getSources({types:['window'],thumbnailSize:{width:w.getSize()[0],height:w.getSize()[1]}});let own=s.find(v=>v.id===w.getMediaSourceId());if(own)fs.writeFileSync(target,own.thumbnail.toPNG())}},100).unref();require("+json.dumps(str(root/'packages/desktop/dist/main/index.js'))+");",encoding='utf8')
env={**os.environ,'SMALT_HOME':str(home)}
for key in list(env):
 if any(part in key.upper() for part in ['API_KEY','TOKEN','SECRET','PASSWORD','CREDENTIAL']) or key=='ELECTRON_RUN_AS_NODE':env.pop(key,None)
log=open(run/'electron.log','w',encoding='utf8');process=subprocess.Popen([str(root/'node_modules/electron/dist/electron.exe'),str(harness),'--development-preview','--remote-debugging-port='+str(port)],env=env,stdout=log,stderr=log,creationflags=subprocess.CREATE_NO_WINDOW)
checks=[];errors=[]
def until(test,seconds=15):
 end=time.time()+seconds
 while time.time()<end:
  if test():return
  time.sleep(.1)
 raise AssertionError('condition timed out')
def shot(page,name,native=False):
 target=shots/name
 if native:target.unlink(missing_ok=True);publish(capture,str(target),encoding='utf8');until(lambda:target.exists())
 else:page.screenshot(path=str(target),animations='disabled')
with sync_playwright() as p:
 browser=None
 try:
  for _ in range(100):
   try:browser=p.chromium.connect_over_cdp(f'http://127.0.0.1:{port}',timeout=500);break
   except Exception:time.sleep(.1)
  assert browser
  until(lambda:any(v.url.startswith('file:') for c in browser.contexts for v in c.pages));page=next(v for c in browser.contexts for v in c.pages if v.url.startswith('file:'));page.on('pageerror',lambda e:errors.append(str(e)));page.wait_for_load_state('networkidle')
  page.evaluate("cwd=>{localStorage.setItem('smalt.ui.onboarded','true');localStorage.setItem('smalt.ui.dark','false');localStorage.setItem('smalt.ui.workspace',JSON.stringify(cwd))}",str(workspace));page.reload();page.wait_for_load_state('networkidle')
  page.get_by_test_id('task-row').filter(has_text='外部工具任务 A').click();page.get_by_role('button',name='连接器与插件',exact=True).click();page.get_by_role('button',name='添加 MCP 服务',exact=True).click();dialog=page.get_by_role('dialog',name='添加 MCP 服务');dialog.get_by_label('名称',exact=True).fill('本地文档工具');dialog.get_by_label('服务地址',exact=True).fill(origin+'/mcp');dialog.get_by_label('认证方式',exact=True).select_option('bearer');dialog.get_by_role('button',name='保存配置',exact=True).click();expect(dialog).not_to_be_visible()
  card=page.get_by_test_id('mcp-card').filter(has_text='本地文档工具');expect(card).to_contain_text('已停用');assert not mcp_requests
  deny.write_text('deny');card.get_by_role('button',name='连接',exact=True).click();expect(card).to_contain_text('已取消连接');deny.unlink();card.get_by_role('button',name='工具与诊断',exact=True).click();detail=page.get_by_role('dialog',name='MCP 工具与诊断');detail.get_by_role('button',name='认证',exact=True).click();page.get_by_label('访问令牌',exact=True).fill('fixture-selected-token');page.get_by_role('button',name='保存凭据',exact=True).click();expect(page.get_by_role('dialog')).to_have_count(0);card.get_by_role('button',name='连接',exact=True).click();expect(card).to_contain_text('已连接');card.get_by_role('button',name='工具与诊断',exact=True).click();detail=page.get_by_role('dialog',name='MCP 工具与诊断');expect(detail.get_by_label('启用 MCP 工具 list_documents',exact=True)).not_to_be_checked();detail.get_by_label('启用 MCP 工具 list_documents',exact=True).click();expect(detail.get_by_label('启用 MCP 工具 list_documents',exact=True)).to_be_checked();shot(page,'mcp-tools-light.png');detail.get_by_role('button',name='完成',exact=True).click();shot(page,'connectors-light.png');page.get_by_role('button',name='切换主题',exact=True).click();shot(page,'connectors-dark.png')
  state=page.evaluate("()=>window.smalt.integrations('list')");assert 'fixture-selected-token' not in json.dumps(state);assert 'fixture-selected-token' not in (home/'integration-secrets.json').read_text();assert state['servers'][0]['secretStorage']=='encrypted'
  checks.append('actual UI adds service without execution, refuses native consent, saves OS-encrypted bearer, connects and explicitly enables discovered tool; provenance and light/dark states visible')
  page.get_by_test_id('task-row').filter(has_text='外部工具任务 A').click();page.get_by_label('任务输入',exact=True).fill('使用外部工具检查所选资料');page.get_by_role('button',name='发送',exact=True).click();approval=page.get_by_test_id('approval');expect(approval).to_contain_text('本地文档工具');expect(approval).to_contain_text(origin);approval.get_by_role('button',name='允许',exact=True).click();until(lambda:started.is_set());page.get_by_test_id('task-row').filter(has_text='独立任务 B').click();expect(page.get_by_label('任务输入',exact=True)).to_be_enabled();page.get_by_role('button',name='连接器与插件',exact=True).click();expect(page.get_by_test_id('mcp-card')).to_contain_text('1 项执行中');page.get_by_role('button',name='用量与诊断',exact=True).click();page.get_by_test_id('task-row').filter(has_text='外部工具任务 A').click();release.set();expect(page.get_by_test_id('item-agentMessage').filter(has_text='外部资料已核对')).to_be_visible(timeout=15000)
  page.get_by_role('button',name='切换右侧面板 (Ctrl+J)',exact=True).click();page.get_by_role('button',name='工具结果',exact=True).click();results=page.get_by_test_id('mcp-results');expect(results).to_contain_text('会议纪要.md');expect(results).not_to_contain_text('fixture-selected-token');results.get_by_label('筛选外部结果',exact=True).fill('费用');expect(results.get_by_role('cell',name='费用明细.xlsx',exact=True)).to_be_visible();shot(page,'external-results-dark.png');results.get_by_role('button',name='在隔离视图中打开交互内容',exact=True).click();expect(page.get_by_role('tab',name='资料交互概览',exact=True)).to_be_visible();until(lambda:any(v.url.startswith('smalt-preview:') for c in browser.contexts for v in c.pages));child=next(v for c in browser.contexts for v in c.pages if v.url.startswith('smalt-preview:'));assert child.evaluate('window.bridgeAvailable===false && window.nodeAvailable==="undefined"');child.get_by_role('button',name='检查概览',exact=True).click();expect(child.locator('#result')).to_contain_text('本地交互已完成');expect(page.get_by_test_id('external-source')).to_contain_text(origin);shot(page,'external-interactive-dark.png',True)
  checks.append('real model receives scoped tool, kernel approval includes source; pending MCP call survives chat/page browsing; sanitized persisted result and filtered table open isolated interactive HTML with no Node or application bridge')
  system='\n'.join(str(m.get('content')) for r in model_requests for m in r['messages'] if m['role']=='system');assert 'UNTRUSTED_SERVER_INSTRUCTION_MUST_NOT_ENTER_SYSTEM' not in system;assert 'fixture-selected-token' not in json.dumps(model_requests);assert len([v for v in mcp_requests if v.get('method')=='tools/call'])==1
  page.get_by_role('button',name='连接器与插件',exact=True).click();revision=2;server_id=state['servers'][0]['id'];page.evaluate("id=>window.smalt.integrations('refresh',{id})",server_id);card=page.get_by_test_id('mcp-card').filter(has_text='本地文档工具');expect(card).to_contain_text('0/1 工具');card.get_by_role('button',name='工具与诊断',exact=True).click();detail=page.get_by_role('dialog',name='MCP 工具与诊断');expect(detail.get_by_label('启用 MCP 工具 list_documents',exact=True)).not_to_be_checked();detail.get_by_role('button',name='完成',exact=True).click()
  manifest={'format':'smalt-plugin/1','id':'example.documents','name':'资料整理插件','version':'1.0.0','description':'把选中资料工具与审阅工作方法放在一起。','author':'本机验收示例（未经签名）','dependencies':[{'name':'document-service','version':'1.0.0','source':origin}],'services':[{'name':'插件文档服务','transport':'http','protocol':'auto','auth':'none','url':origin+'/mcp'}],'skills':['---\nname: 资料核对\ndescription: 核对用户选中的资料与来源\n---\n只依据选中资料核对来源。']}
  page.get_by_role('button',name='导入插件',exact=True).click();page.get_by_role('button',name='粘贴 JSON',exact=True).click();page.get_by_label('插件清单 JSON',exact=True).fill(json.dumps(manifest,ensure_ascii=False));page.get_by_role('button',name='读取并预览',exact=True).click();preview=page.get_by_role('dialog',name='插件来源与权限');expect(preview).to_contain_text('不会自动安装');shot(page,'plugin-preview-dark.png');preview.get_by_role('button',name='确认安装，保持停用',exact=True).click();expect(page.get_by_role('button',name='资料整理插件1.0.0',exact=True)).to_be_visible();state=page.evaluate("()=>window.smalt.integrations('list')");plugin=state['plugins'][0];assert not plugin['enabled'];assert all(v['status']=='disabled' for v in state['servers'] if v.get('pluginId'));page.evaluate("id=>window.smalt.integrations('plugin-configure',{id,enabled:true})",plugin['id']);manifest['version']='1.1.0';preview=page.evaluate("v=>window.smalt.integrations('plugin-preview',v)",{'cwd':str(workspace),'source':'text','text':json.dumps(manifest,ensure_ascii=False),'updating':plugin['id']});page.evaluate("token=>window.smalt.integrations('plugin-install',{token})",preview['token']);updated=page.evaluate("()=>window.smalt.integrations('list')");assert updated['plugins'][0]['manifest']['version']=='1.1.0' and not updated['plugins'][0]['enabled'];page.evaluate("id=>window.smalt.integrations('remove',{id})",plugin['id']);assert not page.evaluate("()=>window.smalt.integrations('list')")['plugins']
  checks.append('catalog refresh revokes prior selection; actual plugin preview shows source/dependencies/version; install disabled, explicit enable, update disables again and uninstall removes owned children')
  # A native stdio descendant is owned by the same application lifetime on quit.
  child_script=workspace/'mcp-child.cjs';child_pid=workspace/'child.pid';child_script.write_text("const fs=require('node:fs'),cp=require('node:child_process'),rl=require('node:readline');let c=cp.spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});fs.writeFileSync("+json.dumps(str(child_pid))+",String(c.pid));rl.createInterface({input:process.stdin}).on('line',line=>{let q=JSON.parse(line);if(q.id===undefined)return;let result=q.method==='initialize'?{protocolVersion:'2025-11-25',serverInfo:{name:'stdio',version:'1.0.0'},capabilities:{tools:{}}}:{tools:[]};console.log(JSON.stringify({jsonrpc:'2.0',id:q.id,result}))});",encoding='utf8')
  node=subprocess.check_output(['node','-p','process.execPath'],text=True).strip();local=page.evaluate("v=>window.smalt.integrations('add',v)",{'cwd':str(workspace),'config':{'name':'退出清理测试','transport':'stdio','program':node,'args':[str(child_script)],'protocol':'legacy','auth':'none'}});page.evaluate("id=>window.smalt.integrations('connect',{id})",local['id']);pid=int(child_pid.read_text());quit_file.write_text('quit');process.wait(timeout=20);assert process.returncode==0
  def alive_pid():
   output=subprocess.run(['powershell','-NoProfile','-Command',f'Get-Process -Id {pid} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id'],text=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE,creationflags=subprocess.CREATE_NO_WINDOW);return str(pid) in output.stdout
  until(lambda:not alive_pid());checks.append('explicit application quit waits for supervised stdio descendant cleanup; no plugin/process replay or credential leakage')
  assert not errors,errors
 finally:
  release.set()
  if process.poll() is None:quit_file.write_text('quit')
  try:process.wait(timeout=15)
  except subprocess.TimeoutExpired:process.terminate();process.wait(timeout=10)
  log.close();server.shutdown()
evidence={'passed':True,'checks':checks,'rendererErrors':errors,'modelRequests':len(model_requests),'mcpRequests':len(mcp_requests),'fixture':str(run),'screenshots':[str(v) for v in shots.glob('*.png')]};(shots/'results.json').write_text(json.dumps(evidence,ensure_ascii=False,indent=2),encoding='utf8');print(json.dumps(evidence,ensure_ascii=False,indent=2))
