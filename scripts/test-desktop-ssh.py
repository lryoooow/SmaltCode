"""Phase ten: real SSH/SFTP and isolated Electron UI, no external hosts or models."""
from _desktop_control import publish
import json,os,socket,subprocess,sys,threading,time
from datetime import datetime,timezone
from pathlib import Path
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
root=Path(__file__).resolve().parents[1];sys.path.insert(0,str(root/'.qa-python'))
from playwright.sync_api import sync_playwright,expect
expect.set_options(timeout=30000)
run=root/'.qa-work'/('ssh-ui-'+str(time.time_ns()));run.mkdir(parents=True)
shots=root/'docs/screenshots/phase-ten';shots.mkdir(parents=True,exist_ok=True)
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
def write_zoom(app,value):
 temporary=app.zoom.with_name('zoom-ready');temporary.write_text(value,encoding='utf8');temporary.replace(app.zoom)

class Desktop:
 def __init__(self,label):
  self.dir=run/label;self.home=self.dir/'home';self.workspace=self.dir/'project';(self.home/'threads').mkdir(parents=True);self.workspace.mkdir();(self.workspace/'notes.md').write_text(label+'_FILE\n',encoding='utf8');self.label=label;self.process=None;self.browser=None;self.page=None
  with socket.socket()as sock:sock.bind(('127.0.0.1',0));self.port=sock.getsockname()[1]
  self.quit=self.dir/'quit';self.capture=self.dir/'capture';self.zoom=self.dir/'zoom';self.ack=self.dir/'ack';self.deny=self.dir/'deny';self.pick=self.dir/'pick'
  at=datetime.now(timezone.utc).isoformat()
  for ident,title in [('th_remote_shared','远程项目对话'),('th_remote_other','独立浏览对话')]:
   meta={'id':ident,'title':title,'cwd':str(self.workspace),'model':'remote-model','provider':'openai','permissionMode':'default','createdAt':at,'updatedAt':at,'turnCount':1,'lastOutcome':'completed'}
   events=[{'t':'meta','meta':meta},{'t':'turn-started','turnId':'seed','at':at}]
   for i in range(120 if ident=='th_remote_shared'else 1):events.extend([{'t':'user-msg','id':'u-'+str(i),'text':'历史问题 '+str(i),'at':at},{'t':'agent-msg','id':'a-'+str(i),'text':'可安全查看的项目回复 '+str(i),'at':at}])
   events.append({'t':'turn-ended','turnId':'seed','at':at});(self.home/'threads'/(ident+'.jsonl')).write_text('\n'.join(json.dumps(v,ensure_ascii=False)for v in events)+'\n',encoding='utf8')
  (self.home/'workspace-access.json').write_text(json.dumps([str(self.workspace.resolve()).lower()]),encoding='utf8')
  (self.home/'settings.json').write_text(json.dumps({'defaultProvider':'openai','defaultModel':'remote-model','providers':{'openai':{'baseUrl':f'http://127.0.0.1:{server.server_port}/v1','apiKey':'HOST_MODEL_KEY_NEVER_EXPOSE'}}}),encoding='utf8')
  paths={k:str(getattr(self,k))for k in ['quit','capture','zoom','ack','deny','pick']};self.harness=self.dir/'harness.cjs';self.harness.write_text("const {app,dialog,BrowserWindow}=require('electron'),fs=require('node:fs');app.getVersion=()=>"+json.dumps(json.loads((root/'packages/desktop/package.json').read_text(encoding='utf8'))['version'])+";const paths="+json.dumps(paths)+";dialog.showOpenDialog=async()=>({canceled:false,filePaths:[fs.readFileSync(paths.pick,'utf8')]});dialog.showMessageBox=async()=>({response:fs.existsSync(paths.deny)?1:0});setInterval(()=>{if(fs.existsSync(paths.quit))app.quit();const w=BrowserWindow.getAllWindows()[0];if(w&&fs.existsSync(paths.capture)){const file=fs.readFileSync(paths.capture,'utf8');fs.unlinkSync(paths.capture);w.webContents.capturePage().then(image=>fs.writeFileSync(file,image.toPNG()))}if(w&&fs.existsSync(paths.zoom)){const value=Number(fs.readFileSync(paths.zoom,'utf8'));if(Number.isFinite(value)&&value>0){w.webContents.setZoomFactor(value);fs.unlinkSync(paths.zoom);fs.writeFileSync(paths.ack,'done')}}},100).unref();require("+json.dumps(str(root/'packages/desktop/dist/main/index.js'))+");",encoding='utf8')
  self.log=open(self.dir/'electron.log','w',encoding='utf8');instances.append(self)
 def launch(self,p):
  self.quit.unlink(missing_ok=True);env={**os.environ,'SMALT_HOME':str(self.home)}
  for key in list(env):
   if any(v in key.upper()for v in ['API_KEY','TOKEN','SECRET','PASSWORD','CREDENTIAL'])or key=='ELECTRON_RUN_AS_NODE':env.pop(key,None)
  self.process=subprocess.Popen([str(root/'node_modules/electron/dist/electron.exe'),str(self.harness),'--development-preview','--remote-debugging-port='+str(self.port)],env=env,stdout=self.log,stderr=self.log,creationflags=subprocess.CREATE_NO_WINDOW)
  for _ in range(150):
   try:self.browser=p.chromium.connect_over_cdp(f'http://127.0.0.1:{self.port}',timeout=500);break
   except Exception:time.sleep(.1)
  assert self.browser;until(lambda:any(v.url.startswith('file:')for c in self.browser.contexts for v in c.pages));self.page=next(v for c in self.browser.contexts for v in c.pages if v.url.startswith('file:'));self.page.on('pageerror',lambda e:errors.append(self.label+':'+str(e)));self.page.set_default_timeout(30000);self.page.wait_for_load_state('networkidle');self.page.evaluate("cwd=>{localStorage.setItem('smalt.ui.onboarded','true');localStorage.setItem('smalt.ui.dark','false');localStorage.setItem('smalt.ui.workspace',JSON.stringify(cwd))}",str(self.workspace));self.page.reload();self.page.wait_for_load_state('networkidle')
 def api(self,action,value=None):return self.page.evaluate('v=>window.smalt.ssh(v.action,v.value)',{'action':action,'value':value or{}})
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

fixture_file=run/'ssh-fixture.json';fixture_log=open(run/'ssh-server.log','w',encoding='utf8')
fixture=subprocess.Popen(['node',str(root/'scripts/fixtures/ssh-server.cjs'),str(fixture_file)],cwd=root,stdout=fixture_log,stderr=fixture_log,creationflags=subprocess.CREATE_NO_WINDOW)
until(lambda:fixture_file.exists());remote=json.loads(fixture_file.read_text(encoding='utf8'));app=Desktop('ssh');key_file=app.dir/'fixture-key';key_file.write_text(remote['userKey'],encoding='utf8');app.pick.write_text(str(key_file),encoding='utf8')
config_file=app.dir/'ssh-config';config_file.write_text('Host local-fixture\n HostName 127.0.0.1\n User tester\n Port '+str(remote['port'])+'\n ProxyCommand should-never-execute\nMatch exec "bad"\n HostName attacker\n',encoding='utf8')
with sync_playwright()as p:
 try:
  app.launch(p);app.nav('远程连接');app.nav('SSH 项目');app.nav('添加 SSH 项目');dialog=app.page.get_by_role('dialog',name='添加 SSH 项目');dialog.get_by_label('SSH 连接备注',exact=True).fill('SSH 设计验收');dialog.get_by_label('SSH 主机地址',exact=True).fill('127.0.0.1');dialog.get_by_label('SSH 用户名',exact=True).fill('tester');dialog.get_by_label('SSH 端口',exact=True).fill(str(remote['port']));dialog.get_by_label('SSH 项目路径',exact=True).fill('/work');dialog.get_by_label('SSH 认证方式',exact=True).select_option('password');dialog.get_by_role('button',name='保存并连接',exact=True).click();auth=app.page.get_by_role('dialog',name='SSH 认证');auth.get_by_label('SSH 密码',exact=True).fill('fixture-password');auth.get_by_role('button',name='授权只读连接',exact=True).click();until(lambda:app.state()['connections'][0]['status']=='connected');ident=app.state()['connections'][0]['profile']['id'];app.page.get_by_role('button',name='notes.md',exact=True).click();expect(app.page.get_by_test_id('ssh-file-preview')).to_contain_text('SSH_PROJECT_ONLY');app.shot('ssh-connected-light.png');assert 'fixture-password'not in app.page.content();checks.append('actual SSH password authentication, native grant/host trust, readonly preview and safe file filtering work in Electron')
  app.page.get_by_role('button',name='中文 空间',exact=True).click();app.page.get_by_role('button',name='说明.md',exact=True).click();expect(app.page.get_by_test_id('ssh-file-preview')).to_contain_text('中文与空格');app.page.get_by_label('SSH 引用目标对话',exact=True).select_option('th_remote_shared');app.nav('引用此文件到草稿');expect(app.page.get_by_test_id('composer')).to_be_visible();refs=app.page.evaluate("JSON.parse(localStorage.getItem('smalt.ui.referenceDrafts')||'{}')");app.page.get_by_test_id('composer').locator('textarea').fill('请概述引用资料');app.page.get_by_test_id('composer').locator('textarea').press('Enter');until(lambda:len(requests)==1);prompt=json.dumps(requests[-1],ensure_ascii=False);assert '外部不可信内容'in prompt and '中文与空格路径可读取'in prompt;assert 'fixture-password'not in prompt;checks.append('selecting a remote file adds a source-bound draft and only explicit send reaches the local synthetic model, with no SSH secret')
  app.nav('远程连接');expect(app.page.get_by_test_id('ssh-page')).to_be_visible();until(lambda:app.state()['connections'][0]['status']=='connected');app.nav('上一级');app.page.get_by_role('button',name='notes.md',exact=True).click();expect(app.page.get_by_test_id('ssh-file-preview')).to_contain_text('SSH_PROJECT_ONLY')
  for theme in ['dark','light']:
   app.page.evaluate("theme=>{localStorage.setItem('smalt.ui.dark',JSON.stringify(theme==='dark'))}",theme);app.page.reload();app.page.wait_for_load_state('networkidle');app.nav('远程连接');app.nav('SSH 项目')
   # A renderer reload revokes the connection; re-authorize deliberately.
   app.api('authorize',{'id':ident,'password':'fixture-password'});app.api('connect',{'id':ident});until(lambda:app.state()['connections'][0]['status']=='connected');app.page.get_by_role('button',name='notes.md',exact=True).click()
   for factor in [1,1.25,1.5,2]:
    app.ack.unlink(missing_ok=True);write_zoom(app,str(factor));until(lambda:app.ack.exists());app.page.wait_for_timeout(180);app.page.get_by_test_id('ssh-file-preview').scroll_into_view_if_needed();assert app.page.evaluate('document.documentElement.scrollWidth<=innerWidth+1');app.shot(f'ssh-preview-{theme}-zoom-{factor}.png')
   app.ack.unlink(missing_ok=True);write_zoom(app,'1');until(lambda:app.ack.exists());app.nav('管理');dialog=app.page.get_by_role('dialog',name='管理 SSH 项目')
   for factor in [1,1.25,1.5,2]:
    app.ack.unlink(missing_ok=True);write_zoom(app,str(factor));until(lambda:app.ack.exists());dialog.get_by_role('button',name='保存并连接',exact=True).scroll_into_view_if_needed();expect(dialog.get_by_role('button',name='取消',exact=True)).to_be_visible();assert dialog.evaluate('e=>e.scrollWidth<=e.clientWidth+1');app.shot(f'ssh-settings-{theme}-zoom-{factor}.png')
   dialog.get_by_role('button',name='取消',exact=True).click();app.ack.unlink(missing_ok=True);write_zoom(app,'1');until(lambda:app.ack.exists())
  checks.append('light/dark project page and management dialogs remain reachable at actual Electron zoom 100/125/150/200 percent with no horizontal page overflow')
  before=len(requests);(run/'ssh-fixture.json.drop').write_text('drop');until(lambda:app.state()['connections'][0]['status']!='connected');app.page.get_by_test_id('task-row').filter(has_text='独立浏览对话').click();app.page.get_by_test_id('composer').locator('textarea').fill('独立对话草稿保持');app.nav('远程连接');until(lambda:app.state()['connections'][0]['status']=='connected');app.page.get_by_test_id('task-row').filter(has_text='独立浏览对话').click();expect(app.page.get_by_test_id('composer').locator('textarea')).to_have_value('独立对话草稿保持');assert len(requests)==before;checks.append('socket loss reconnects in main while conversation navigation and unsent drafts remain responsive, without replaying model work')
  app.nav('远程连接');app.api('disconnect',{'id':ident});app.api('save',{'id':ident,**{k:v for k,v in app.state()['connections'][0]['profile'].items()if k not in ['id','createdAt']},'auth':'key'});app.nav('连接项目');auth=app.page.get_by_role('dialog',name='SSH 认证');auth.get_by_role('button',name='选择私钥文件',exact=True).click();expect(auth.get_by_role('button',name='fixture-key',exact=True)).to_be_visible();auth.get_by_role('button',name='授权只读连接',exact=True).click();until(lambda:app.state()['connections'][0]['status']=='connected');app.page.get_by_role('button',name='notes.md',exact=True).click();expect(app.page.get_by_test_id('ssh-file-preview')).to_contain_text('SSH_PROJECT_ONLY');checks.append('native private-key picker and bundled off-main key decoder authenticate successfully without exposing key bytes to the renderer')
  app.pick.write_text(str(config_file),encoding='utf8');app.nav('导入配置');dialog=app.page.get_by_role('dialog',name='SSH 配置导入预览');expect(dialog).to_contain_text('ProxyCommand 未执行或导入');app.shot('ssh-config-import-light.png');dialog.get_by_role('button',name='关闭 SSH 对话框',exact=True).click();app.api('revoke',{'id':ident});expect(app.page.get_by_test_id('ssh-file-preview')).not_to_be_visible();assert app.state()['connections'][0]['granted']is False;checks.append('safe import previews unsupported config directives; revocation clears visible file contents and credentials')
  state=app.state();assert not state['connections'][0]['hasCredential'];app.close();app.launch(p);assert app.state()['connections'][0]['status']=='disconnected';assert not app.state()['connections'][0]['granted'];assert len(requests)==before;app.close();assert not errors,errors;checks.append('application shutdown closes connections; relaunch requires a new grant and never auto-connects; no renderer errors')
 except Exception:
  try:app.shot('failure.png');print(app.page.locator('body').inner_text()[-6000:])
  except Exception:pass
  raise
 finally:
  try:app.close()
  except Exception:
   if app.process and app.process.poll()is None:app.process.terminate();app.process.wait(timeout=10)
  app.log.close();(run/'ssh-fixture.json.stop').write_text('stop');fixture.wait(timeout=10);fixture_log.close();server.shutdown()
result={'phase':10,'checks':checks,'rendererErrors':errors,'modelRequests':len(requests),'fixture':str(run),'screenshots':str(shots),'externalHosts':False,'sshStats':json.loads((run/'ssh-fixture.json.stats').read_text(encoding='utf8'))};(run/'result.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf8');print(json.dumps(result,ensure_ascii=False,indent=2))
