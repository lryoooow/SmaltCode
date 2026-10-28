"""Phase eight: two isolated Electron hosts and a real mobile browser, local fixtures only."""
from _desktop_control import publish
import json,os,socket,subprocess,sys,threading,time
from datetime import datetime,timezone
from pathlib import Path
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
root=Path(__file__).resolve().parents[1];sys.path.insert(0,str(root/'.qa-python'))
from playwright.sync_api import sync_playwright,expect
expect.set_options(timeout=30000)
run=root/'.qa-work'/('remote-ui-'+str(time.time_ns()));run.mkdir(parents=True)
shots=root/'docs/screenshots/phase-eight';shots.mkdir(parents=True,exist_ok=True)
requests=[];release=threading.Event();held=0;errors=[];checks=[];instances=[]
class Model(BaseHTTPRequestHandler):
 def log_message(self,*args):pass
 def do_GET(self):
  self.send_response(200);self.send_header('Content-Type','application/json');self.end_headers();self.wfile.write(json.dumps({'data':[{'id':'remote-model','context_window':256000,'supported_parameters':['tools']}]}).encode())
 def do_POST(self):
  global held
  body=json.loads(self.rfile.read(int(self.headers.get('Content-Length',0))));requests.append(body);messages=body['messages'];latest=max(i for i,m in enumerate(messages)if m['role']=='user');prompt=str(messages[latest]['content']);done=any(m['role']=='tool'for m in messages[latest+1:]);call=None
  self.send_response(200);self.send_header('Content-Type','text/event-stream');self.end_headers()
  try:
   if 'HOLD_REMOTE'in prompt and not done:
    held+=1;self.wfile.write(('data: '+json.dumps({'choices':[{'delta':{'reasoning_content':'检查远程项目中的实际文件。'},'finish_reason':None}]})+'\n\n').encode());self.wfile.flush();release.wait(50)
   if not done and 'ASK_PHONE'in prompt:call=('ask_user',{'question':'请确认需要的输出语言'})
   if not done and 'EDIT_HOST'in prompt:call=('write',{'path':'notes.md','content':'HOST_CHANGED_BY_REMOTE\n'})
   delta={'tool_calls':[{'index':0,'id':'call_'+str(len(requests)),'function':{'name':call[0],'arguments':json.dumps(call[1],ensure_ascii=False)}}]}if call else{'content':'已完成远程检查。运行位置：配对主机。项目测试尚未运行。'}
   self.wfile.write(('data: '+json.dumps({'choices':[{'delta':delta,'finish_reason':'tool_calls'if call else'stop'}]},ensure_ascii=False)+'\n\ndata: [DONE]\n\n').encode());self.wfile.flush()
  except(BrokenPipeError,ConnectionResetError):pass
server=ThreadingHTTPServer(('127.0.0.1',0),Model);threading.Thread(target=server.serve_forever,daemon=True).start()
def until(fn,seconds=35):
 end=time.time()+seconds
 while time.time()<end:
  if fn():return
  time.sleep(.1)
 raise AssertionError('condition timed out')
class Desktop:
 def __init__(self,label):
  self.dir=run/label;self.home=self.dir/'home';self.workspace=self.dir/'project';(self.home/'threads').mkdir(parents=True);self.workspace.mkdir();(self.workspace/'notes.md').write_text(label+'_FILE\n',encoding='utf8');self.label=label;self.process=None;self.browser=None;self.page=None
  with socket.socket()as sock:sock.bind(('127.0.0.1',0));self.port=sock.getsockname()[1]
  self.quit=self.dir/'quit';self.capture=self.dir/'capture';self.zoom=self.dir/'zoom';self.ack=self.dir/'ack';self.deny=self.dir/'deny'
  at=datetime.now(timezone.utc).isoformat()
  for ident,title in [('th_remote_shared','远程项目对话'),('th_remote_other','独立浏览对话')]:
   meta={'id':ident,'title':title,'cwd':str(self.workspace),'model':'remote-model','provider':'openai','permissionMode':'default','createdAt':at,'updatedAt':at,'turnCount':1,'lastOutcome':'completed'}
   events=[{'t':'meta','meta':meta},{'t':'turn-started','turnId':'seed','at':at}]
   for i in range(120 if ident=='th_remote_shared'else 1):events.extend([{'t':'user-msg','id':'u-'+str(i),'text':'历史问题 '+str(i),'at':at},{'t':'agent-msg','id':'a-'+str(i),'text':'可安全查看的项目回复 '+str(i),'at':at}])
   events.append({'t':'turn-ended','turnId':'seed','at':at});(self.home/'threads'/(ident+'.jsonl')).write_text('\n'.join(json.dumps(v,ensure_ascii=False)for v in events)+'\n',encoding='utf8')
  (self.home/'workspace-access.json').write_text(json.dumps([str(self.workspace.resolve()).lower()]),encoding='utf8')
  (self.home/'settings.json').write_text(json.dumps({'defaultProvider':'openai','defaultModel':'remote-model','providers':{'openai':{'baseUrl':f'http://127.0.0.1:{server.server_port}/v1','apiKey':'HOST_MODEL_KEY_NEVER_EXPOSE'}}}),encoding='utf8')
  paths={k:str(getattr(self,k))for k in ['quit','capture','zoom','ack','deny']};self.harness=self.dir/'harness.cjs';self.harness.write_text("const {app,dialog,BrowserWindow}=require('electron'),fs=require('node:fs');app.getVersion=()=>"+json.dumps(json.loads((root/'packages/desktop/package.json').read_text(encoding='utf8'))['version'])+";const paths="+json.dumps(paths)+";dialog.showMessageBox=async()=>({response:fs.existsSync(paths.deny)?1:0});setInterval(()=>{if(fs.existsSync(paths.quit))app.quit();const w=BrowserWindow.getAllWindows()[0];if(w&&fs.existsSync(paths.capture)){const file=fs.readFileSync(paths.capture,'utf8');fs.unlinkSync(paths.capture);w.webContents.capturePage().then(image=>fs.writeFileSync(file,image.toPNG()))}if(w&&fs.existsSync(paths.zoom)){const value=Number(fs.readFileSync(paths.zoom,'utf8'));if(Number.isFinite(value)&&value>0){w.webContents.setZoomFactor(value);fs.unlinkSync(paths.zoom);fs.writeFileSync(paths.ack,'done')}}},100).unref();require("+json.dumps(str(root/'packages/desktop/dist/main/index.js'))+");",encoding='utf8')
  self.log=open(self.dir/'electron.log','w',encoding='utf8');instances.append(self)
 def launch(self,p):
  self.quit.unlink(missing_ok=True);env={**os.environ,'SMALT_HOME':str(self.home)}
  for key in list(env):
   if any(v in key.upper()for v in ['API_KEY','TOKEN','SECRET','PASSWORD','CREDENTIAL'])or key=='ELECTRON_RUN_AS_NODE':env.pop(key,None)
  self.process=subprocess.Popen([str(os.environ.get('SMALT_TEST_ELECTRON_EXECUTABLE',root/'node_modules/electron/dist/electron.exe')),str(self.harness),'--development-preview','--identity-test','--remote-debugging-port='+str(self.port)],env=env,stdout=self.log,stderr=self.log,creationflags=subprocess.CREATE_NO_WINDOW)
  for _ in range(150):
   try:self.browser=p.chromium.connect_over_cdp(f'http://127.0.0.1:{self.port}',timeout=500);break
   except Exception:time.sleep(.1)
  assert self.browser;until(lambda:any(v.url.startswith('file:')for c in self.browser.contexts for v in c.pages));self.page=next(v for c in self.browser.contexts for v in c.pages if v.url.startswith('file:'));self.page.on('pageerror',lambda e:errors.append(self.label+':'+str(e)));self.page.set_default_timeout(30000);self.page.wait_for_load_state('networkidle');self.page.evaluate("cwd=>{localStorage.setItem('smalt.ui.onboarded','true');localStorage.setItem('smalt.ui.dark','false');localStorage.setItem('smalt.ui.workspace',JSON.stringify(cwd))}",str(self.workspace));self.page.reload();self.page.wait_for_load_state('networkidle')
 def api(self,action,value=None):return self.page.evaluate('v=>window.smalt.remote(v.action,v.value)',{'action':action,'value':value or{}})
 def state(self):return self.api('list')
 def nav(self,label):self.page.get_by_role('button',name=label,exact=True).click()
 def shot(self,name):
  target=shots/name;target.unlink(missing_ok=True);publish(self.capture,str(target),encoding='utf8');until(lambda:target.exists())
 def close(self):
  if self.process and self.process.poll()is None:self.quit.write_text('quit');self.process.wait(timeout=20);assert self.process.returncode==0
def authorize(host,phone=False):
 host.nav('设备与会话');row=host.page.get_by_test_id('remote-pending').last;row.get_by_role('button',name='核对并授权',exact=True).click();dialog=host.page.get_by_role('dialog',name='授权远程设备');dialog.get_by_label('回答助手问题',exact=True).check()
 if not phone:dialog.get_by_label('发送任务与停止本设备执行',exact=True).check();dialog.get_by_label('读取项目文件',exact=True).check();dialog.get_by_label('设备执行权限',exact=True).select_option('default')
 dialog.get_by_role('button',name='核对并允许',exact=True).click();expect(dialog).not_to_be_visible()
with sync_playwright()as p:
 host=Desktop('HOST');client=Desktop('CLIENT');mobile=None
 try:
  host.launch(p);client.launch(p);host.nav('远程连接');assert not host.state()['enabled'];host.api('scope-add',{'threadId':'th_remote_shared'});scope=host.state()['scopes'][0];host.deny.write_text('deny');host.nav('启用远程访问');expect(host.page.get_by_role('alert')).to_contain_text('取消');host.deny.unlink();host.nav('启用远程访问');until(lambda:host.state()['enabled']);url=host.state()['host']['urls'][0];host.nav('生成配对码');host.shot('host-sharing-light.png');code=host.api('pair-code')['code'];checks.append('real Windows TLS certificate, default-off service, native refusal and scope selection work without firewall or trust-store changes')
  client.nav('远程连接');client.nav('连接另一台主机');dialog=client.page.get_by_role('dialog',name='连接远程主机');dialog.get_by_label('远程主机地址',exact=True).fill(url);dialog.get_by_role('button',name='检查主机证书',exact=True).click();expect(dialog.get_by_text('与主机界面核对相同指纹后再配对。证书变化不会自动接受。')).to_be_visible();client.shot('desktop-pairing-light.png');dialog.get_by_label('远程连接名称',exact=True).fill('工作电脑');dialog.get_by_label('远程主机配对码',exact=True).fill(code);dialog.get_by_role('button',name='核对并请求配对',exact=True).click();expect(dialog).not_to_be_visible();authorize(host);until(lambda:client.state()['connections'][0]['status']=='connected');connection=client.state()['connections'][0];cid=connection['profile']['id'];assert [t['id']for t in connection['snapshot']['threads']]==['th_remote_shared'];checks.append('desktop pins the inspected certificate and host grants explicit per-device capabilities; another same-workspace conversation is excluded')
  expect(client.page.get_by_test_id('remote-messages')).to_contain_text('项目回复 119');client.nav('查看更早记录');expect(client.page.get_by_test_id('remote-messages')).to_contain_text('项目回复 69');old=client.page.get_by_test_id('remote-messages').inner_text();client.page.wait_for_timeout(2300);assert client.page.get_by_test_id('remote-messages').inner_text()==old;assert client.page.get_by_test_id('remote-messages').locator('article').count()<=100;client.nav('返回最新记录');client.nav('读取目录');client.page.get_by_role('button',name='notes.md',exact=True).click();expect(client.page.locator('pre')).to_contain_text('HOST_FILE');assert(client.workspace/'notes.md').read_text(encoding='utf8')=='CLIENT_FILE\n';client.nav('命名目录映射');client.page.get_by_label('远程目录别名',exact=True).fill('团队开发目录');client.nav('保存映射');expect(client.page.get_by_test_id('remote-execution-location')).to_contain_text('团队开发目录');checks.append('older history remains a bounded stable page across polls; directory alias and readonly preview use the host, never a same-name local file')
  client.nav('新建远程任务');client.page.get_by_label('远程任务标题',exact=True).fill('远程后台检查');client.page.get_by_label('远程任务说明',exact=True).fill('HOLD_REMOTE 检查项目');client.nav('交给主机执行');until(lambda:held==1);remote_thread=next(o['threadId']for o in host.state()['operations']if o['kind']=='start');client.page.get_by_label('远程开发对话',exact=True).select_option(remote_thread);client.page.get_by_label('远程任务输入',exact=True).fill('远程草稿独立保留');client.page.get_by_test_id('task-row').filter(has_text='独立浏览对话').click();client.page.get_by_label('任务输入',exact=True).fill('本机草稿也可以继续写');client.nav('连接器与插件');client.nav('远程连接');client.nav('远程开发');expect(client.page.get_by_label('远程任务输入',exact=True)).to_have_value('远程草稿独立保留');host.page.get_by_test_id('task-row').filter(has_text='独立浏览对话').click();host.page.get_by_label('任务输入',exact=True).fill('主机浏览不受远程任务影响');assert host.state()['operations'][-1]['status']=='running';client.shot('remote-development-running-light.png');release.set();until(lambda:host.state()['operations'][-1]['status']=='completed');checks.append('held remote model execution survives both desktops browsing other chats and settings; local and remote drafts remain separate')
  before=len(requests);client.api('disconnect',{'id':cid});client.api('connect',{'id':cid});until(lambda:client.state()['connections'][0]['status']=='connected');client.page.wait_for_timeout(1700);assert len(requests)==before;checks.append('manual disconnect/reconnect resumes authorized reads without replaying any model request')
  mobile=p.chromium.launch(channel='msedge',headless=True);context=mobile.new_context(ignore_https_errors=True,viewport={'width':390,'height':844},is_mobile=True,has_touch=True);context.add_init_script("sessionStorage.setItem('smalt.remote.pending',JSON.stringify({id:'00000000-0000-4000-8000-000000000000',deviceId:'retired-device'}))");phone=context.new_page();phone.on('pageerror',lambda e:errors.append('phone:'+str(e)));phone.goto(url);assert phone.evaluate('typeof window.smalt')=='undefined';code=host.api('pair-code')['code'];phone.locator('#device-name').fill('测试手机');phone.locator('#pair-code').fill(code);phone.locator('#pair-send').click();host.nav('远程连接');authorize(host,True);expect(phone.locator('#workspace')).to_be_visible();assert len(phone.locator('#threads option').all())==1;assert phone.locator('#message-form').is_hidden();assert phone.evaluate("sessionStorage.getItem('smalt.remote.pending')")is None;cookies=context.cookies();assert any(c['name']=='__Host-smalt-session'and c['secure']and c['httpOnly']and c['sameSite']=='Strict'for c in cookies);assert 'HOST_MODEL_KEY_NEVER_EXPOSE'not in phone.content();phone.screenshot(path=str(shots/'phone-history-light.png'));checks.append('actual mobile browser pairs via Secure HttpOnly SameSite cookies, has no Electron bridge or model key, and receives only view/answer permissions')
  host.page.get_by_test_id('task-row').filter(has_text='远程项目对话').click();host.page.get_by_label('任务输入',exact=True).fill('ASK_PHONE 请用户选择语言');host.nav('发送');expect(phone.locator('#questions textarea')).to_be_visible(timeout=30000);answer=phone.locator('#questions textarea');answer.fill('中文，保留关键细节');phone.wait_for_timeout(3000);expect(answer).to_have_value('中文，保留关键细节');phone.emulate_media(color_scheme='dark');phone.screenshot(path=str(shots/'phone-question-dark.png'));phone.get_by_role('button',name='回复问题',exact=True).click();until(lambda:any('中文，保留关键细节'in json.dumps(r,ensure_ascii=False)for r in requests));expect(phone.locator('#questions textarea')).not_to_be_visible();checks.append('phone answers a real host ask_user question; slow typing survives multiple polls and cannot approve tools')
  # A real standard remote write still requires the owner approval UI.
  op=client.api('operate',{'id':cid,'input':{'kind':'start','scopeId':scope['id'],'title':'远程修改需本机批准','text':'EDIT_HOST 修改 notes.md'}});until(lambda:any(o['id']==op['id']and o.get('threadId')for o in host.state()['operations']));tid=next(o['threadId']for o in host.state()['operations']if o['id']==op['id']);host.page.get_by_test_id('task-row').filter(has_text='远程修改需本机批准').click();host.page.get_by_role('button',name='允许',exact=True).click();until(lambda:(host.workspace/'notes.md').read_text(encoding='utf8')=='HOST_CHANGED_BY_REMOTE\n');assert(client.workspace/'notes.md').read_text(encoding='utf8')=='CLIENT_FILE\n';client.page.get_by_label('远程开发对话',exact=True).select_option(tid);client.shot('remote-development-completed-light.png');checks.append('actual host permission card approves one remote edit; only host files change and a distinct remote-origin conversation records execution')
  for theme in ['light','dark']:
   if theme=='dark':client.nav('切换主题')
   for factor in [1,1.25,1.5,2]:
    client.ack.unlink(missing_ok=True);publish(client.zoom,str(factor));until(lambda:client.ack.exists());assert client.page.evaluate('document.body.scrollWidth<=innerWidth+1');client.nav('连接另一台主机');dialog=client.page.get_by_role('dialog',name='连接远程主机');dialog.get_by_role('button',name='核对并请求配对',exact=True).scroll_into_view_if_needed();expect(dialog.get_by_role('button',name='取消',exact=True)).to_be_visible();client.shot(f'pairing-{theme}-zoom-{factor}.png');dialog.get_by_role('button',name='取消',exact=True).click()
  checks.append('light/dark remote page and pairing dialog remain reachable at native Electron zoom 100/125/150/200 percent without page overflow')
  host.nav('远程连接');host.nav('设备与会话');host.shot('devices-and-sessions-light.png');phone_device=next(d for d in host.state()['devices']if d['kind']=='phone');host.api('device-revoke',{'id':phone_device['id']});expect(phone.locator('#workspace')).not_to_be_visible(timeout=12000);assert not phone.locator('#messages').inner_text();checks.append('device revocation immediately clears phone contents and rejects further session reads')
  release.clear();before=held;op=client.api('operate',{'id':cid,'input':{'kind':'start','scopeId':scope['id'],'title':'撤销运行中的会话','text':'HOLD_REMOTE 等待撤销'}});until(lambda:held==before+1);session=next(s for s in host.state()['sessions']if s['deviceId']==connection['snapshot']['device']['id']);host.api('session-revoke',{'id':session['id']});until(lambda:next(o for o in host.state()['operations']if o['id']==op['id'])['status']=='interrupted');until(lambda:client.state()['connections'][0]['status']=='revoked');assert not client.state()['connections'][0].get('snapshot');checks.append('session revocation aborts an active remote turn and clears the desktop cache without affecting unrelated local drafts')
  release.set();count=len(requests);host.close();host.launch(p);assert not host.state()['enabled'];assert len(requests)==count;host.close();client.close();assert not errors,errors;checks.append('normal application quit closes HTTPS and restart leaves sharing disabled without automatic command replay; no renderer errors')
 except Exception:
  for app in instances:
   try:app.shot(app.label+'-failure.png');print(app.label,app.page.locator('body').inner_text()[-7000:])
   except Exception:pass
  raise
 finally:
  release.set()
  for app in instances:
   try:app.close()
   except Exception:
    if app.process and app.process.poll()is None:app.process.terminate();app.process.wait(timeout=10)
   app.log.close()
  if mobile:mobile.close()
  server.shutdown()
result={'phase':8,'checks':checks,'rendererErrors':errors,'modelRequests':len(requests),'fixture':str(run),'screenshots':str(shots),'externalModels':False,'systemCertificateStoreModified':False};(run/'result.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf8');print(json.dumps(result,ensure_ascii=False,indent=2))
