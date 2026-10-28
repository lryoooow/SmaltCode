"""Phase twelve: approved local Docker Engine + isolated native Electron. Never pulls images or starts Docker."""
from _desktop_control import publish
import json,os,socket,subprocess,sys,threading,time,faulthandler
faulthandler.dump_traceback_later(90,repeat=True)
from datetime import datetime,timezone
from pathlib import Path
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
root=Path(__file__).resolve().parents[1];sys.path.insert(0,str(root/'.qa-python'))
from playwright.sync_api import sync_playwright,expect
expect.set_options(timeout=30000)
run=root/'.qa-work'/('container-ui-'+str(time.time_ns()));run.mkdir(parents=True)
shots=root/'docs/screenshots/phase-twelve';shots.mkdir(parents=True,exist_ok=True)
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
   if not done and 'CONTAINER_MODEL'in prompt:call=('container_exec',{'command':'echo MODEL_CONTAINER_START; sleep 4; echo MODEL_CONTAINER_DONE'})
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
  self.minimize=self.dir/'minimize';self.show=self.dir/'show';self.quit=self.dir/'quit';self.capture=self.dir/'capture';self.zoom=self.dir/'zoom';self.ack=self.dir/'ack';self.deny=self.dir/'deny';self.pick=self.dir/'pick'
  at=datetime.now(timezone.utc).isoformat()
  for ident,title in [('th_remote_shared','远程项目对话'),('th_remote_other','独立浏览对话')]:
   meta={'id':ident,'title':title,'cwd':str(self.workspace),'model':'remote-model','provider':'openai','permissionMode':'default','createdAt':at,'updatedAt':at,'turnCount':1,'lastOutcome':'completed'}
   events=[{'t':'meta','meta':meta},{'t':'turn-started','turnId':'seed','at':at}]
   for i in range(120 if ident=='th_remote_shared'else 1):events.extend([{'t':'user-msg','id':'u-'+str(i),'text':'历史问题 '+str(i),'at':at},{'t':'agent-msg','id':'a-'+str(i),'text':'可安全查看的项目回复 '+str(i),'at':at}])
   events.append({'t':'turn-ended','turnId':'seed','at':at});(self.home/'threads'/(ident+'.jsonl')).write_text('\n'.join(json.dumps(v,ensure_ascii=False)for v in events)+'\n',encoding='utf8')
  (self.home/'workspace-access.json').write_text(json.dumps([str(self.workspace.resolve()).lower()]),encoding='utf8')
  (self.home/'settings.json').write_text(json.dumps({'defaultProvider':'openai','defaultModel':'remote-model','providers':{'openai':{'baseUrl':f'http://127.0.0.1:{server.server_port}/v1','apiKey':'HOST_MODEL_KEY_NEVER_EXPOSE'}}}),encoding='utf8')
  paths={k:str(getattr(self,k))for k in ['quit','capture','zoom','ack','deny','pick','show','minimize']};self.harness=self.dir/'harness.cjs';self.harness.write_text("const {app,dialog,BrowserWindow}=require('electron'),fs=require('node:fs');app.getVersion=()=>"+json.dumps(json.loads((root/'packages/desktop/package.json').read_text(encoding='utf8'))['version'])+";const paths="+json.dumps(paths)+";dialog.showOpenDialog=async()=>({canceled:false,filePaths:[fs.readFileSync(paths.pick,'utf8')]});dialog.showMessageBox=async()=>({response:fs.existsSync(paths.deny)?1:0});setInterval(()=>{if(fs.existsSync(paths.quit))app.quit();const w=BrowserWindow.getAllWindows()[0];if(w&&fs.existsSync(paths.minimize)){fs.unlinkSync(paths.minimize);w.minimize();fs.writeFileSync(paths.ack,'minimized')}if(w&&fs.existsSync(paths.show)){fs.unlinkSync(paths.show);if(w.isMinimized())w.restore();w.show();w.focus();setTimeout(()=>fs.writeFileSync(paths.ack,JSON.stringify({shown:w.isVisible()&&!w.isMinimized()&&w.getContentSize()[0]>40})),100)}if(w&&fs.existsSync(paths.capture)){const file=fs.readFileSync(paths.capture,'utf8');fs.unlinkSync(paths.capture);fs.appendFileSync(paths.capture+'.windows',JSON.stringify({file,visible:w.isVisible(),minimized:w.isMinimized(),bounds:w.getBounds(),content:w.getContentBounds(),size:w.getContentSize()})+'\\n');w.webContents.capturePage().then(image=>fs.writeFileSync(file,image.toPNG()))}if(w&&fs.existsSync(paths.zoom)){const value=Number(fs.readFileSync(paths.zoom,'utf8'));if(Number.isFinite(value)&&value>0){w.webContents.setZoomFactor(value);fs.unlinkSync(paths.zoom);fs.writeFileSync(paths.ack,'done')}}},100).unref();require("+json.dumps(str(root/'packages/desktop/dist/main/index.js'))+");",encoding='utf8')
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
 def api(self,action,value=None):return self.page.evaluate('v=>window.smalt.containers(v.action,v.value)',{'action':action,'value':value or{}})
 def state(self):return self.api('list')
 def nav(self,label):self.page.get_by_role('button',name=label,exact=True).click()
 def ensure_shown(self):
  self.ack.unlink(missing_ok=True);self.show.write_text('show');until(lambda:self.ack.exists()and json.loads(self.ack.read_text()).get('shown'));self.page.wait_for_timeout(150)
 def shot(self,name):
  self.page.wait_for_timeout(300)
  self.ensure_shown();self.page.wait_for_timeout(250);target=shots/name;target.unlink(missing_ok=True);publish(self.capture,str(target),encoding='utf8');until(lambda:target.exists());print('Captured '+name,flush=True)
 def close(self):
  if self.process and self.process.poll()is None:self.quit.write_text('quit');self.process.wait(timeout=20);assert self.process.returncode==0

docker=r'C:\Program Files\Docker\Docker\resources\bin\docker.exe'
def docker_json(*args):return json.loads(subprocess.check_output([docker,*args],text=True,encoding='utf8'))
app=None;ids=[];owner=None
try:
 with sync_playwright()as p:
  app=Desktop('containers');project=app.dir/'container-project';project.mkdir();(project/'notes.md').write_text('CONTAINER_PROJECT_ONLY\n',encoding='utf8');(project/'index.html').write_text('<h1>CONTAINER_PREVIEW_OK</h1>',encoding='utf8')
  app.launch(p);app.ack.unlink(missing_ok=True);app.show.write_text('show');until(lambda:app.ack.exists());app.nav('远程连接');app.nav('容器工作区');app.nav('检测本机引擎');until(lambda:app.state().get('selected'));assert any('python:3.12-slim'in i['tags']for i in app.state()['images']);app.shot('engine-discovery-light.png')
  app.nav('新建容器项目');dialog=app.page.get_by_role('dialog',name='新建容器项目');dialog.get_by_label('容器项目名称',exact=True).fill('容器设计回归');app.pick.write_text(str(project),encoding='utf8');dialog.get_by_role('button',name='选择宿主文件夹',exact=True).click();expect(dialog.get_by_label('容器宿主项目文件夹',exact=True)).to_have_value(str(project));dialog.get_by_role('checkbox').uncheck();dialog.get_by_role('button',name='核对配置并继续',exact=True).click();expect(dialog).not_to_be_visible();until(lambda:app.state()['profiles']and app.state()['profiles'][0]['status']!='creating');profile=app.state()['profiles'][0];assert profile.get('containerId'),profile.get('notice','Missing container identity');ident=profile['id'];ids.append(profile['containerId']);owner=json.loads((app.home/'containers.json').read_text(encoding='utf8'))['namespace'];app.nav('核验并连接');until(lambda:app.state()['profiles'][0]['status']=='running');app.page.get_by_role('button',name='notes.md',exact=True).click();expect(app.page.get_by_test_id('container-file-preview')).to_contain_text('CONTAINER_PROJECT_ONLY');app.shot('container-files-light.png');checks.append('real Docker Engine discovery, approved immutable local image, native container creation/start and bounded UTF-8 file browser')
  app.nav('执行与终端');app.page.get_by_label('容器执行所属对话',exact=True).select_option('th_remote_shared');app.nav('绑定此容器项目');until(lambda:app.state()['bindings']and app.state()['bindings'][0]['active']);app.page.get_by_label('容器命令',exact=True).fill('printf "实际容器退出码\\n"; exit 7');app.nav('运行容器命令');until(lambda:app.state()['runs']);rid=app.state()['runs'][-1]['id'];until(lambda:app.api('run-read',{'threadId':'th_remote_shared','runId':rid})['run']['status']=='failed');expect(app.page.get_by_test_id('container-workbench')).to_contain_text('退出码 7');app.shot('container-exit-failure-light.png');checks.append('actual failing command exposes exit code and verified cleanup in the independent process workbench')
  app.nav('新建容器终端');until(lambda:app.state()['runs'][-1]['kind']=='terminal'and app.state()['runs'][-1]['status']=='running');terminal_id=app.state()['runs'][-1]['id'];screen=app.page.get_by_test_id('container-terminal');expect(screen).to_have_attribute('data-run-id',terminal_id);expect(screen).to_have_attribute('data-input-enabled','true');app.page.bring_to_front();terminal=screen.locator('textarea');terminal.focus();expect(terminal).to_be_focused();app.page.keyboard.insert_text('printf "CONTAINER_PTY_UI_OK\\n"');app.page.keyboard.press('Enter');until(lambda:'CONTAINER_PTY_UI_OK'in app.api('run-read',{'threadId':'th_remote_shared','runId':terminal_id})['output']['data']);app.shot('container-terminal-light.png')
  app.page.get_by_test_id('task-row').filter(has_text='独立浏览对话').click();app.page.get_by_test_id('composer').locator('textarea').fill('容器运行中仍可编辑的独立草稿');app.nav('远程连接');expect(app.page.get_by_test_id('container-workbench')).to_be_visible();expect(app.page.get_by_test_id('container-terminal')).to_have_attribute('data-run-id',terminal_id);checks.append('real interactive PTY stays running and preserves screen while another conversation remains editable')
  app.nav('项目文件');app.page.get_by_role('button',name='notes.md',exact=True).click();app.nav('编辑容器文件');editor=app.page.get_by_role('dialog',name='编辑容器文件');editor.get_by_label('容器文件编辑内容',exact=True).fill('CONTAINER_EDIT_ONLY\n');editor.get_by_role('button',name='核对版本后保存',exact=True).click();expect(editor).not_to_be_visible(timeout=30000);expect(app.page.get_by_test_id('container-file-preview')).to_contain_text('CONTAINER_EDIT_ONLY');assert(app.workspace/'notes.md').read_text(encoding='utf8')=='containers_FILE\n';checks.append('digest-checked atomic editor writes to the selected container workspace and leaves same-name chat-local file unchanged')
  app.page.get_by_test_id('task-row').filter(has_text='远程项目对话').click();expect(app.page.get_by_test_id('container-target-badge')).to_contain_text('容器 / Linux');expect(app.page.get_by_test_id('composer-work-location')).to_contain_text('容器');assert str(app.workspace) not in app.page.get_by_test_id('composer-work-location').get_attribute('title');app.page.get_by_test_id('composer').locator('textarea').fill('CONTAINER_MODEL 请运行容器检查');app.page.get_by_test_id('composer').locator('textarea').press('Enter');app.page.get_by_role('button',name='允许',exact=True).click();until(lambda:any(r['command'].startswith('echo MODEL_CONTAINER_START')for r in app.state()['runs']));app.page.get_by_test_id('task-row').filter(has_text='独立浏览对话').click();expect(app.page.get_by_test_id('composer').locator('textarea')).to_have_value('容器运行中仍可编辑的独立草稿');until(lambda:len(requests)>=2);specs=[t['function']['name']for t in requests[0].get('tools',[])];assert 'container_exec'in specs and 'shell'not in specs and 'read'not in specs and 'ssh_exec'not in specs;assert 'Host-selected execution target: container'in json.dumps(requests[0]);assert 'HOST_MODEL_KEY_NEVER_EXPOSE'not in json.dumps(requests);checks.append('model tools are scoped exclusively to the host-bound container and normal task approval does not block other conversation browsing')
  server_run=app.api('run',{'threadId':'th_remote_shared','input':{'requestId':__import__('uuid').uuid4().__str__(),'kind':'command','command':'python3 -m http.server 18761 --bind 127.0.0.1'}});until(lambda:app.api('run-read',{'threadId':'th_remote_shared','runId':server_run['id']})['run']['status']=='running');app.nav('远程连接');app.nav('端口预览');app.page.get_by_label('容器内服务端口',exact=True).fill('18761');app.nav('授权并建立转发');until(lambda:app.state()['forwards']and app.state()['forwards'][-1]['status']=='open');forward=app.state()['forwards'][-1];app.nav('打开开发页预览');expect(app.page.get_by_test_id('browser-panel')).to_be_visible();until(lambda:any(v.url.startswith(forward['url'])for c in app.browser.contexts for v in c.pages));native=next(v for c in app.browser.contexts for v in c.pages if v.url.startswith(forward['url']));app.ensure_shown();expect(native.get_by_role('heading',name='CONTAINER_PREVIEW_OK')).to_be_visible();assert native.evaluate('typeof window.smalt')=='undefined';native.screenshot(path=str(shots/'container-preview-native.png'));app.shot('container-isolated-preview-light.png');app.ack.unlink(missing_ok=True);app.minimize.write_text('minimize');until(lambda:app.ack.exists());app.ack.unlink(missing_ok=True);app.show.write_text('show');until(lambda:app.ack.exists());app.ensure_shown();expect(native.get_by_role('heading',name='CONTAINER_PREVIEW_OK')).to_be_visible();checks.append('actual container loopback HTTP preview opens in a side browser with no desktop bridge')
  app.nav('远程连接');app.nav('执行与终端');app.page.evaluate("()=>window.smalt.call('thread/settings/update',{threadId:'th_remote_shared',permissionMode:'plan'})");until(lambda:next(r for r in app.state()['runs']if r['id']==terminal_id)['inputAllowed']is False);until(lambda:app.state()['forwards'][-1]['status']=='closed');blocked=app.page.evaluate("id=>window.smalt.containers('terminal-write',{threadId:'th_remote_shared',runId:id,data:'echo FORBIDDEN\\r'}).then(()=>false,()=>true)",terminal_id);assert blocked;app.page.evaluate("()=>window.smalt.call('thread/settings/update',{threadId:'th_remote_shared',permissionMode:'default'})");checks.append('live plan-mode switch revokes terminal input and closes all owned container forwards and browser previews')
  for theme in ['dark','light']:
   app.page.evaluate("theme=>{document.documentElement.classList.toggle('dark',theme==='dark');document.documentElement.dataset.theme=theme}",theme)
   for factor in [1,1.25,1.5,2]:
    app.ack.unlink(missing_ok=True);publish(app.zoom,str(factor));until(lambda:app.ack.exists());app.page.get_by_test_id('container-workbench').scroll_into_view_if_needed();assert app.page.evaluate('document.documentElement.scrollWidth<=innerWidth+1');app.shot(f'container-workbench-{theme}-zoom-{factor}.png')
  checks.append('container workbench has no horizontal page overflow in light/dark at native 100/125/150/200 percent zoom')
  app.ack.unlink(missing_ok=True);publish(app.zoom,'1');until(lambda:app.ack.exists());app.nav('新建容器项目');form=app.page.get_by_role('dialog',name='新建容器项目')
  for theme in ['light','dark']:
   app.page.evaluate("theme=>document.documentElement.classList.toggle('dark',theme==='dark')",theme)
   for factor in [1,1.25,1.5,2]:
    app.ack.unlink(missing_ok=True);publish(app.zoom,str(factor));until(lambda:app.ack.exists());form.get_by_role('button',name='核对配置并继续',exact=True).scroll_into_view_if_needed();expect(form.get_by_role('button',name='取消',exact=True)).to_be_visible();assert form.evaluate('e=>e.scrollWidth<=e.clientWidth+1');app.shot(f'container-create-{theme}-zoom-{factor}.png')
  form.get_by_role('button',name='取消',exact=True).click();checks.append('create dialog and native preview minimize/restore remain usable at 100/125/150/200 percent with both themes')
  app.close();info=docker_json('inspect',ids[0])[0];assert not info['State']['Running'];assert(project/'notes.md').read_text(encoding='utf8')=='CONTAINER_EDIT_ONLY\n';checks.append('actual full application quit stops its managed container, retains project files and leaves the container available for later restart')
 assert not errors,errors
finally:
 for instance in instances:
  try:instance.close()
  except Exception:pass
 for ident in ids:
  info=docker_json('inspect',ident)[0]
  if info['Id']!=ident or info['Config']['Labels'].get('io.smaltcode.owner')!=owner:raise AssertionError('refuse unrelated fixture cleanup')
  subprocess.run([docker,'rm','-f',ident],check=True,stdout=subprocess.DEVNULL)
 server.shutdown()
record={'checks':checks,'rendererErrors':errors,'modelRequests':len(requests),'directory':str(run),'screenshots':str(shots)};print(json.dumps(record,ensure_ascii=False,indent=2));(root/'.qa-work/phase-twelve-container-ui.json').write_text(json.dumps(record,ensure_ascii=False,indent=2),encoding='utf8')
