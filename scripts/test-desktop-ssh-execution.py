"""Phase ten: real SSH/SFTP and isolated Electron UI, no external hosts or models."""
from _desktop_control import publish
import json,os,socket,subprocess,sys,threading,time
from datetime import datetime,timezone
from pathlib import Path
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
root=Path(__file__).resolve().parents[1];sys.path.insert(0,str(root/'.qa-python'))
from playwright.sync_api import sync_playwright,expect
from _desktop_window_probe import WindowProbe
expect.set_options(timeout=30000)
run=root/'.qa-work'/('ssh-execution-ui-'+str(time.time_ns()));run.mkdir(parents=True)
shots=root/'docs/screenshots/phase-eleven';shots.mkdir(parents=True,exist_ok=True)
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
   if not done and 'SSH_MODEL'in prompt:call=('ssh_exec',{'command':'echo MODEL_REMOTE_START; sleep 4; echo MODEL_REMOTE_DONE'})
   delta={'tool_calls':[{'index':0,'id':'call_'+str(len(requests)),'function':{'name':call[0],'arguments':json.dumps(call[1],ensure_ascii=False)}}]}if call else{'content':'已完成远程检查。运行位置：配对主机。项目测试尚未运行。'}
   self.wfile.write(('data: '+json.dumps({'choices':[{'delta':delta,'finish_reason':'tool_calls'if call else'stop'}]},ensure_ascii=False)+'\n\ndata: [DONE]\n\n').encode());self.wfile.flush()
  except(BrokenPipeError,ConnectionResetError):pass
server=ThreadingHTTPServer(('127.0.0.1',0),Model);threading.Thread(target=server.serve_forever,daemon=True).start()
def until(fn,seconds=35):
 end=time.time()+seconds
 while time.time()<end:
  if fn():return
  if 'app'in globals()and app.page and not app.page.is_closed():app.page.wait_for_timeout(100)
  else:time.sleep(.1)
 raise AssertionError('condition timed out')
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
  self.window=WindowProbe(self.dir,root);self.harness.write_text(self.harness.read_text(encoding='utf8')+self.window.hook,encoding='utf8')
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
  self.window.restore()
  self.page.evaluate("()=>{window.__visibilityEvents=[];document.addEventListener('click',event=>{const button=event.target.closest('button');window.__visibilityEvents.push({at:Date.now(),label:button?.getAttribute('aria-label')??button?.innerText?.slice(0,100),x:event.clientX,y:event.clientY});window.__visibilityEvents=window.__visibilityEvents.slice(-120)},true)}")
 def api(self,action,value=None):return self.page.evaluate('v=>window.smalt.ssh(v.action,v.value)',{'action':action,'value':value or{}})
 def state(self):return self.api('list')
 def nav(self,label):self.page.get_by_role('button',name=label,exact=True).click()
 def shot(self,name):
  self.page.wait_for_timeout(300)
  target=shots/name;target.unlink(missing_ok=True);publish(self.capture,str(target),encoding='utf8');until(lambda:target.exists())
 def close(self):
  if self.process and self.process.poll()is None:self.quit.write_text('quit');self.process.wait(timeout=20);assert self.process.returncode==0
def authorize(host,phone=False):
 host.nav('设备与会话');row=host.page.get_by_test_id('remote-pending').last;row.get_by_role('button',name='核对并授权',exact=True).click();dialog=host.page.get_by_role('dialog',name='授权远程设备');dialog.get_by_label('回答助手问题',exact=True).check()
 if not phone:dialog.get_by_label('发送任务与停止本设备执行',exact=True).check();dialog.get_by_label('读取项目文件',exact=True).check();dialog.get_by_label('设备执行权限',exact=True).select_option('default')
 dialog.get_by_role('button',name='核对并允许',exact=True).click();expect(dialog).not_to_be_visible()


fixture_file=run/'linux-fixture.json';fixture_log=open(run/'linux-server.log','w',encoding='utf8');fixture=subprocess.Popen(['node',str(root/'scripts/fixtures/ssh-execution-server.cjs'),str(fixture_file)],cwd=root,stdout=fixture_log,stderr=fixture_log,creationflags=subprocess.CREATE_NO_WINDOW);until(lambda:fixture_file.exists(),50);remote=json.loads(fixture_file.read_text(encoding='utf8'));app=Desktop('ssh-execution')
class Dev(BaseHTTPRequestHandler):
 def log_message(self,*args):pass
 def do_GET(self):
  self.send_response(200);self.send_header('Content-Type','text/html; charset=utf-8');self.end_headers();self.wfile.write(b'<h1>SSH_FORWARDED_PREVIEW</h1><p>Actual TCP tunnel, isolated renderer.</p>')
dev=ThreadingHTTPServer(('127.0.0.1',0),Dev);threading.Thread(target=dev.serve_forever,daemon=True).start()
def execution():return app.api('execution-state')
def last_run():return execution()['runs'][-1]
def finished(ident):return next(r for r in execution()['runs']if r['id']==ident)['status']not in ['claimed','running','stopping']
with sync_playwright()as p:
 try:
  app.launch(p);app.nav('远程连接');app.nav('SSH 项目');app.nav('添加 SSH 项目');dialog=app.page.get_by_role('dialog',name='添加 SSH 项目');expect(dialog.get_by_label('SSH 用户名',exact=True)).to_be_visible();expect(dialog.get_by_label('SSH 连接密码',exact=True)).to_be_visible();assert dialog.get_by_label('SSH 认证方式',exact=True).input_value()=='password';dialog.get_by_label('SSH 连接备注',exact=True).fill('Linux 开发主机');dialog.get_by_label('SSH 主机地址',exact=True).fill('127.0.0.1');dialog.get_by_label('SSH 用户名',exact=True).fill('tester');dialog.get_by_label('SSH 端口',exact=True).fill(str(remote['port']));dialog.get_by_label('SSH 项目路径',exact=True).fill(remote['roots'][0]);dialog.get_by_label('SSH 连接密码',exact=True).fill('fixture-password');app.shot('username-password-form-light.png');dialog.get_by_role('button',name='保存并连接',exact=True).click();until(lambda:app.state()['connections']and app.state()['connections'][0]['status']=='connected');ident=app.state()['connections'][0]['profile']['id'];assert 'fixture-password'not in app.page.content();checks.append('username and password have explicit positions in the default connection form; optional connection remark is separate and secrets do not appear in public state')
  app.nav('执行与终端');app.page.get_by_label('SSH 执行所属对话',exact=True).select_option('th_remote_shared');app.nav('绑定此 SSH 项目');until(lambda:execution()['bindings']and execution()['bindings'][0]['active']);app.page.get_by_label('SSH 远程命令',exact=True).fill('printf "实际远程退出码\\n"; exit 7');app.nav('运行远程命令');until(lambda:execution()['runs']);rid=last_run()['id'];until(lambda:finished(rid));assert last_run()['exitCode']==7 and last_run()['cleanup']=='confirmed';expect(app.page.get_by_test_id('ssh-workbench')).to_contain_text('退出码 7');app.shot('command-exit-failure-light.png');checks.append('actual Linux command output and nonzero exit/cleanup receipt are visible outside folded conversation logs')
  app.nav('新建 SSH 终端');until(lambda:last_run()['kind']=='terminal'and last_run()['status']=='running');terminal_id=last_run()['id'];screen=app.page.get_by_test_id('ssh-terminal');expect(screen).to_have_attribute('data-run-id',terminal_id);expect(screen).to_have_attribute('data-input-enabled','true');app.page.bring_to_front();terminal=screen.locator('textarea');terminal.focus();expect(terminal).to_be_focused();app.page.keyboard.insert_text('printf "PTY_UI_中文_OK\\n"');app.page.keyboard.press('Enter');until(lambda:'PTY_UI_中文_OK'in app.api('run-read',{'threadId':'th_remote_shared','runId':terminal_id})['output']['data']);app.shot('interactive-terminal-light.png');app.page.get_by_test_id('task-row').filter(has_text='独立浏览对话').click();app.page.get_by_test_id('composer').locator('textarea').fill('不受远程运行影响的草稿');app.nav('远程连接');expect(app.page.get_by_test_id('ssh-workbench')).to_be_visible();assert next(r for r in execution()['runs']if r['id']==terminal_id)['status']=='running';app.shot('terminal-restored-after-navigation-light.png');checks.append('real PTY input and preserved terminal screen survive page/conversation switches; unrelated draft remains editable')
  app.nav('项目文件');app.page.get_by_role('button',name='notes.md',exact=True).click();app.nav('编辑远程文件');editor=app.page.get_by_role('dialog',name='编辑远程文件');editor.get_by_label('远程文件编辑内容',exact=True).fill('UI_EDIT_REMOTE_ONLY\n');editor.get_by_role('button',name='核对版本后保存',exact=True).click();expect(editor).not_to_be_visible(timeout=30000);expect(app.page.get_by_test_id('ssh-file-preview')).to_contain_text('UI_EDIT_REMOTE_ONLY');assert(app.workspace/'notes.md').read_text(encoding='utf8')=='ssh-execution_FILE\n';checks.append('actual remote file editor saves via versioned Linux atomic write and leaves same-name local file untouched')
  app.page.get_by_test_id('task-row').filter(has_text='远程项目对话').click();expect(app.page.get_by_test_id('ssh-target-badge')).to_contain_text('Linux');expect(app.page.get_by_test_id('composer-work-location')).to_contain_text('SSH');assert str(app.workspace) not in app.page.get_by_test_id('composer-work-location').get_attribute('title');app.page.get_by_test_id('composer').locator('textarea').fill('SSH_MODEL 请运行远程检查');app.page.get_by_test_id('composer').locator('textarea').press('Enter');app.page.get_by_role('button',name='允许',exact=True).click();until(lambda:any(r['command'].startswith('echo MODEL_REMOTE_START')for r in execution()['runs']));app.page.get_by_test_id('task-row').filter(has_text='独立浏览对话').click();expect(app.page.get_by_test_id('composer').locator('textarea')).to_have_value('不受远程运行影响的草稿');until(lambda:len(requests)>=2);specs=[t['function']['name']for t in requests[0].get('tools',[])];assert 'ssh_exec'in specs and 'shell'not in specs and 'read'not in specs;assert 'Host-selected execution target: SSH'in json.dumps(requests[0]);assert 'fixture-password'not in json.dumps(requests);checks.append('ordinary conversation approval starts the actual remote model tool; only SSH target tools are advertised and streaming leaves another conversation draft usable')
  app.nav('远程连接');app.nav('端口转发');app.page.get_by_label('SSH 执行所属对话',exact=True).select_option('th_remote_shared');app.page.get_by_label('SSH 远端服务端口',exact=True).fill(str(dev.server_port));app.nav('授权并建立转发');until(lambda:execution()['forwards']and execution()['forwards'][-1]['status']=='open');forward=execution()['forwards'][-1];import urllib.request;assert b'SSH_FORWARDED_PREVIEW'in urllib.request.urlopen(forward['url'],timeout=5).read();app.shot('controlled-forward-light.png');app.window.restore();app.window.command('minimize');app.window.wait(lambda value:value['minimized']);app.nav('打开开发页预览');expect(app.page.get_by_test_id('browser-panel')).to_be_visible();until(lambda:any(v.url.startswith(forward['url'])for c in app.browser.contexts for v in c.pages));native=next(v for c in app.browser.contexts for v in c.pages if v.url.startswith(forward['url']));until(lambda:native.locator('h1').count()==1);assert app.window.read()['minimized'];minimized_snapshot={'window':app.window.read(),'page':native.evaluate('({width:innerWidth,height:innerHeight})')};(run/'minimized-first-open.json').write_text(json.dumps(minimized_snapshot),encoding='utf8');app.window.restore();expect(native.get_by_role('heading',name='SSH_FORWARDED_PREVIEW')).to_be_visible();app.window.wait(lambda value:any(view['url'].startswith(forward['url'])and min(view['bounds']['width'],view['bounds']['height'])>40 for view in value['views']));assert native.evaluate('typeof window.smalt')=='undefined';native.screenshot(path=str(shots/'forwarded-page-native.png'));app.shot('isolated-forward-preview-light.png');checks.append('actual localhost TCP forwarding serves a development page through a bridge-free browser preview and opens the visible side panel')
  checks.append('first open while minimized records native geometry, then the same loaded page becomes visible on restore without reconnecting or reopening the tab')
  forward_before=execution()['forwards'][-1]['id'];launches_before=json.loads((run/'linux-fixture.json.stats').read_text())['launches']
  for cycle in range(12):
   app.window.restore();app.nav('站点权限 · 1');expect(app.page.get_by_test_id('browser-permissions')).to_be_visible();app.window.wait(lambda value:not value['views']);app.page.keyboard.press('Escape');app.window.wait(lambda value:len(value['views'])==1)
   app.nav('收起面板');app.window.wait(lambda value:not value['views']);app.page.get_by_test_id('task-row').filter(has_text='独立浏览对话').click();expect(app.page.get_by_test_id('composer').locator('textarea')).to_have_value('不受远程运行影响的草稿');app.page.get_by_test_id('task-row').filter(has_text='远程项目对话').click();app.nav('打开浏览与网页预览');app.window.wait(lambda value:len(value['views'])==1);expect(native.get_by_role('heading',name='SSH_FORWARDED_PREVIEW')).to_be_visible()
   action='hide'if cycle%2 else'minimize';app.window.command(action);app.window.wait(lambda value:not value['visible']);app.window.restore();expect(native.get_by_role('heading',name='SSH_FORWARDED_PREVIEW')).to_be_visible()
   app.window.command('resize',width=1180);app.window.wait(lambda value:value['size'][0]==1180);app.window.command('resize',width=1240);app.window.wait(lambda value:value['size'][0]==1240);app.window.wait(lambda value:len(value['views'])==1 and abs(value['views'][0]['bounds']['width']-app.page.get_by_test_id('browser-viewport').bounding_box()['width'])<=2)
   assert execution()['forwards'][-1]['id']==forward_before and execution()['forwards'][-1]['status']=='open';assert next(value for value in execution()['runs']if value['id']==terminal_id)['status']=='running'
  assert json.loads((run/'linux-fixture.json.stats').read_text())['launches']==launches_before
  app.shot('preview-restored-after-12-cycles-light.png');checks.append('12 native overlay/panel/chat/hide/minimize/restore/resize cycles preserve the page, independent draft, running terminal and original forwarding; no SSH command replay')
  app.nav('远程连接');app.nav('执行与终端');app.api('terminal-authorize',{'threadId':'th_remote_shared','runId':terminal_id});app.page.evaluate("()=>window.smalt.call('thread/settings/update',{threadId:'th_remote_shared',permissionMode:'plan'})");until(lambda:next(r for r in execution()['runs']if r['id']==terminal_id)['inputAllowed']is False);until(lambda:execution()['forwards'][-1]['status']=='closed');until(lambda:app.page.evaluate("()=>window.smalt.browser('list',{threadId:'th_remote_shared'}).then(v=>v.tabs.length)")==0);try_result=app.page.evaluate("v=>window.smalt.ssh('terminal-write',{threadId:'th_remote_shared',runId:v,data:'echo BLOCKED\\r'}).then(()=>false,()=>true)",terminal_id);assert try_result;app.page.evaluate("()=>window.smalt.call('thread/settings/update',{threadId:'th_remote_shared',permissionMode:'default'})");checks.append('live permission changes revoke terminal input and immediately close forwarding without stopping unrelated conversation browsing')
  for theme in ['dark','light']:
   app.page.evaluate("theme=>{document.documentElement.classList.toggle('dark',theme==='dark');document.documentElement.dataset.theme=theme}",theme)
   for factor in [1,1.25,1.5,2]:
    app.ack.unlink(missing_ok=True);publish(app.zoom,str(factor));until(lambda:app.ack.exists());app.page.get_by_test_id('ssh-workbench').scroll_into_view_if_needed();assert app.page.evaluate('document.documentElement.scrollWidth<=innerWidth+1');app.shot(f'workbench-{theme}-zoom-{factor}.png')
   app.ack.unlink(missing_ok=True);publish(app.zoom,'1');until(lambda:app.ack.exists())
  checks.append('light/dark execution and terminal pages fit real Electron zoom 100/125/150/200 percent without horizontal page overflow')
  before=json.loads((run/'linux-fixture.json.stats').read_text())['launches'];(run/'linux-fixture.json.drop').write_text('drop');until(lambda:next(r for r in execution()['runs']if r['id']==terminal_id)['status']=='unknown');expect(app.page.get_by_test_id('ssh-workbench')).to_contain_text('清理');until(lambda:app.state()['connections'][0]['status']=='connected');app.api('run-reconcile',{'threadId':'th_remote_shared','runId':terminal_id,'cleanup':True});until(lambda:next(r for r in execution()['runs']if r['id']==terminal_id)['cleanup']=='confirmed');assert json.loads((run/'linux-fixture.json.stats').read_text())['launches']==before;checks.append('disconnect shows unconfirmed cleanup, reconnect never repeats a command, and explicit receipt verification confirms original run cleanup')
  app.page.get_by_label('SSH 远程命令',exact=True).fill('echo QUIT_CLEANUP; sleep 300');app.nav('运行远程命令');until(lambda:last_run()['status']=='running');last=last_run()['id'];app.close();saved=json.loads((app.home/'ssh-runs.json').read_text(encoding='utf8'));assert next(r for r in saved['runs']if r['meta']['id']==last)['meta']['cleanup']=='confirmed';count=json.loads((run/'linux-fixture.json.stats').read_text())['launches'];app.launch(p);assert all(not b['active']for b in execution()['bindings']);assert app.state()['connections'][0]['status']=='disconnected';assert json.loads((run/'linux-fixture.json.stats').read_text())['launches']==count;app.close();assert not errors,errors;checks.append('normal application quit obtains Linux cleanup receipts and restart restores history with no SSH reconnection or command replay')
 except Exception:
  try:app.shot('failure.png');print(app.page.locator('body').inner_text()[-6000:])
  except Exception:pass
  try:
   diagnostic={'window':app.window.read(),'parent':app.page.evaluate("()=>({hidden:document.hidden,rect:document.querySelector('[data-testid=browser-viewport]')?.getBoundingClientRect().toJSON(),overlays:[...document.querySelectorAll('.popover-surface,[role=dialog],[data-testid=file-mentions]')].map(e=>({role:e.getAttribute('role'),rect:e.getBoundingClientRect().toJSON()})),events:window.__visibilityEvents})")}
   if 'native'in locals()and not native.is_closed():diagnostic['child']=native.evaluate("()=>({hidden:document.hidden,width:innerWidth,height:innerHeight,heading:document.querySelector('h1')?.getBoundingClientRect().toJSON()})")
   (run/'failure-visibility.json').write_text(json.dumps(diagnostic,ensure_ascii=False,indent=2),encoding='utf8');print('NATIVE_VISIBILITY_FAILURE',json.dumps(diagnostic,ensure_ascii=False),flush=True)
  except Exception as diagnostic_error:print('Visibility diagnostic unavailable:',str(diagnostic_error),flush=True)
  raise
 finally:
  try:app.close()
  except Exception:
   if app.process and app.process.poll()is None:app.process.terminate();app.process.wait(timeout=10)
  app.log.close();(run/'linux-fixture.json.stop').write_text('stop');fixture.wait(timeout=25);fixture_log.close();server.shutdown();dev.shutdown()
result={'phase':11,'checks':checks,'rendererErrors':errors,'modelRequests':len(requests),'fixture':str(run),'screenshots':str(shots),'actualLinux':True,'sshStats':json.loads((run/'linux-fixture.json.stats').read_text())};(run/'result.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf8');print(json.dumps(result,ensure_ascii=False,indent=2))
