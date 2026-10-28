"""Phase seven: actual Electron, IPC, finite kernel turns and real disposable Git worktrees."""
from _desktop_control import publish
import json,os,socket,subprocess,sys,threading,time
from datetime import datetime,timezone
from pathlib import Path
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
root=Path(__file__).resolve().parents[1];sys.path.insert(0,str(root/'.qa-python'))
from playwright.sync_api import sync_playwright,expect
run=root/'.qa-work'/('collaboration-ui-'+str(time.time_ns()));home=run/'home';workspace=run/'协作项目';(home/'threads').mkdir(parents=True);(workspace/'src').mkdir(parents=True)
shots=root/'docs/screenshots/phase-seven';shots.mkdir(parents=True,exist_ok=True)
def git(*args):return subprocess.check_output(['git',*args],cwd=workspace,creationflags=subprocess.CREATE_NO_WINDOW).decode('utf8').strip()
(workspace/'src/a.txt').write_text('shared base A\n',encoding='utf8');(workspace/'src/b.txt').write_text('shared base B\n',encoding='utf8');git('init','-q');git('config','user.name','fixture');git('config','user.email','fixture@example.invalid');git('config','core.autocrlf','false');git('add','.');git('commit','-qm','fixture')
head=git('rev-parse','HEAD');index=(workspace/'.git/index').read_bytes();at=datetime.now(timezone.utc).isoformat()
for ident,title in [('th_team_parent','协作项目对话'),('th_team_other','独立浏览对话')]:
 meta={'id':ident,'title':title,'cwd':str(workspace),'model':'team-model','provider':'openai','createdAt':at,'updatedAt':at,'turnCount':1,'lastOutcome':'completed'}
 events=[{'t':'meta','meta':meta},{'t':'turn-started','turnId':'seed','at':at},{'t':'user-msg','id':'u-'+ident,'text':'准备拆分项目任务。','at':at},{'t':'agent-msg','id':'a-'+ident,'text':'先明确每项职责和写入范围，完成后一起审查。','at':at},{'t':'turn-ended','turnId':'seed','at':at}]
 (home/'threads'/(ident+'.jsonl')).write_text('\n'.join(json.dumps(v,ensure_ascii=False)for v in events)+'\n',encoding='utf8')
(home/'workspace-access.json').write_text(json.dumps([str(workspace.resolve()).lower()if os.name=='nt'else str(workspace.resolve())]),encoding='utf8')
requests=[];release=threading.Event();hold_count=0
class Server(BaseHTTPRequestHandler):
 def log_message(self,*args):pass
 def do_GET(self):
  self.send_response(200);self.send_header('Content-Type','application/json');self.end_headers();self.wfile.write(json.dumps({'data':[{'id':'team-model','context_window':256000,'supported_parameters':['tools']}]}).encode())
 def do_POST(self):
  global hold_count
  body=json.loads(self.rfile.read(int(self.headers.get('Content-Length',0))));requests.append(body);messages=body['messages'];latest=max(i for i,m in enumerate(messages)if m['role']=='user');prompt=str(messages[latest]['content']);done=any(m['role']=='tool'for m in messages[latest+1:]);call=None
  self.send_response(200);self.send_header('Content-Type','text/event-stream');self.end_headers()
  try:
   if 'HOLD_'in prompt and not done:
    hold_count+=1;self.wfile.write(('data: '+json.dumps({'choices':[{'delta':{'reasoning_content':'正在检查独立项目快照。'},'finish_reason':None}]},ensure_ascii=False)+'\n\n').encode());self.wfile.flush();release.wait(45)
   if not done and ('EDIT_'in prompt or 'HOLD_'in prompt):
    a='EDIT_A'in prompt or 'HOLD_A'in prompt;path='src/a.txt'if a or 'CONFLICT'in prompt else 'src/b.txt';call=('write',{'path':path,'content':('冲突 A 的新修改\n'if a else '冲突 B 的新修改\n')if 'CONFLICT'in prompt else('协作 A 的修改\n'if a else '协作 B 的修改\n')})
   delta={'tool_calls':[{'index':0,'id':'call_'+str(len(requests)),'function':{'name':call[0],'arguments':json.dumps(call[1],ensure_ascii=False)}}]}if call else{'content':'独立节点已完成文件修改。未运行项目测试，等待人工审查。'}
   self.wfile.write(('data: '+json.dumps({'choices':[{'delta':delta,'finish_reason':'tool_calls'if call else'stop'}]},ensure_ascii=False)+'\n\ndata: [DONE]\n\n').encode());self.wfile.flush()
  except(BrokenPipeError,ConnectionResetError):pass
server=ThreadingHTTPServer(('127.0.0.1',0),Server);threading.Thread(target=server.serve_forever,daemon=True).start();origin=f'http://127.0.0.1:{server.server_port}'
(home/'settings.json').write_text(json.dumps({'defaultProvider':'openai','defaultModel':'team-model','providers':{'openai':{'baseUrl':origin+'/v1','apiKey':'local-team-fixture'}}}),encoding='utf8')
with socket.socket()as s:s.bind(('127.0.0.1',0));port=s.getsockname()[1]
capture=run/'capture';quit_file=run/'quit';deny=run/'deny';zoom=run/'zoom';ack=run/'zoom-ack';harness=run/'harness.cjs'
harness.write_text("const {app,dialog,BrowserWindow}=require('electron'),fs=require('node:fs');app.getVersion=()=>"+json.dumps(json.loads((root/'packages/desktop/package.json').read_text(encoding='utf8'))['version'])+";const paths="+json.dumps({'deny':str(deny),'quit':str(quit_file),'zoom':str(zoom),'ack':str(ack),'capture':str(capture)})+";dialog.showMessageBox=async()=>({response:fs.existsSync(paths.deny)?1:0});setInterval(()=>{if(fs.existsSync(paths.quit))app.quit();const w=BrowserWindow.getAllWindows()[0];if(w&&fs.existsSync(paths.capture)){const file=fs.readFileSync(paths.capture,'utf8');fs.unlinkSync(paths.capture);w.webContents.capturePage().then(image=>fs.writeFileSync(file,image.toPNG()))}if(w&&fs.existsSync(paths.zoom)){const n=Number(fs.readFileSync(paths.zoom,'utf8'));w.webContents.setZoomFactor(n);fs.unlinkSync(paths.zoom);fs.writeFileSync(paths.ack,String(n))}},100).unref();require("+json.dumps(str(root/'packages/desktop/dist/main/index.js'))+");",encoding='utf8')
env={**os.environ,'SMALT_HOME':str(home)}
for key in list(env):
 if any(v in key.upper()for v in ['API_KEY','TOKEN','SECRET','PASSWORD','CREDENTIAL'])or key=='ELECTRON_RUN_AS_NODE':env.pop(key,None)
log=open(run/'electron.log','w',encoding='utf8');process=None;checks=[];errors=[]
def launch():
 global process
 quit_file.unlink(missing_ok=True);process=subprocess.Popen([str(root/'node_modules/electron/dist/electron.exe'),str(harness),'--development-preview','--remote-debugging-port='+str(port)],env=env,stdout=log,stderr=log,creationflags=subprocess.CREATE_NO_WINDOW)
def until(fn,seconds=30):
 end=time.time()+seconds
 while time.time()<end:
  if fn():return
  time.sleep(.1)
 raise AssertionError('condition timed out')
def connect(p):
 browser=None
 for _ in range(100):
  try:browser=p.chromium.connect_over_cdp(f'http://127.0.0.1:{port}',timeout=500);break
  except Exception:time.sleep(.1)
 assert browser;until(lambda:any(v.url.startswith('file:')for c in browser.contexts for v in c.pages));page=next(v for c in browser.contexts for v in c.pages if v.url.startswith('file:'));page.on('pageerror',lambda e:errors.append(str(e)));page.wait_for_load_state('networkidle');page.set_default_timeout(45000);page.set_default_navigation_timeout(45000);expect.set_options(timeout=45000);return browser,page
def api(page,action,value=None):return page.evaluate('v=>window.smalt.collaborations(v.action,v.value)',{'action':action,'value':value or{}})
def groups(page):return api(page,'list')['groups']
def group(page,id):return next(g for g in groups(page)if g['id']==id)
def nav(page,label):page.get_by_role('button',name=label,exact=True).click()
def shot(page,name):
 target=shots/name;target.unlink(missing_ok=True);publish(capture,str(target),encoding='utf8');until(lambda:target.exists())
def cfg(title='冲突审查演示',hold=False,conflict=False):return{'parentThreadId':'th_team_parent','title':title,'context':'共同目标：统一项目输出；所有资料均为本机合成夹具。','concurrency':2,'budget':{'requests':8,'tools':20,'tokens':120000,'minutes':2},'tasks':[{'key':'a','title':'界面模块改进','instructions':('HOLD_A'if hold else'EDIT_A')+(' CONFLICT'if conflict else''),'model':'openai/team-model','role':'edit','paths':['src/a.txt'],'dependsOn':[]},{'key':'b','title':'文档内容完善','instructions':('HOLD_B'if hold else'EDIT_B')+(' CONFLICT'if conflict else''),'model':'openai/team-model','role':'edit','paths':['src/a.txt'if conflict else'src/b.txt'],'dependsOn':[]}]}
launch()
with sync_playwright()as p:
 browser=None
 try:
  browser,page=connect(p);page.evaluate("cwd=>{localStorage.setItem('smalt.ui.onboarded','true');localStorage.setItem('smalt.ui.dark','false');localStorage.setItem('smalt.ui.workspace',JSON.stringify(cwd))}",str(workspace));page.reload();page.wait_for_load_state('networkidle');page.get_by_test_id('task-row').filter(has_text='协作项目对话').click();nav(page,'协作任务');nav(page,'新建协作');dialog=page.get_by_role('dialog',name='配置协作任务');dialog.get_by_label('协作标题',exact=True).fill('项目功能并行改进');dialog.get_by_label('协作共享资料',exact=True).fill('共同目标：清晰展示工作进程，保持交互独立。');
  for i,label,code,path in [(1,'界面模块改进','HOLD_A','src/a.txt'),(2,'文档内容完善','HOLD_B','src/b.txt')]:
   dialog.get_by_label('子任务名称 '+str(i),exact=True).fill(label);dialog.get_by_label('子任务说明 '+str(i),exact=True).fill(code);dialog.get_by_label('子任务权限 '+str(i),exact=True).select_option('edit');dialog.get_by_label('子任务写入路径 '+str(i),exact=True).fill(path)
  shot(page,'plan-editor-light.png');dialog.get_by_role('button',name='保存计划',exact=True).click();expect(dialog).not_to_be_visible();g=groups(page)[-1];assert not requests;deny.write_text('deny');nav(page,'开始协作');expect(page.get_by_role('alert')).to_contain_text('取消');deny.unlink();nav(page,'开始协作');until(lambda:hold_count>=2);g=group(page,g['id']);assert len({t['threadId']for t in g['tasks']})==2;assert(workspace/'src/a.txt').read_text()=='shared base A\n';shot(page,'parallel-running-light.png');checks.append('real editor saves an inactive 2-worker plan; native denial prevents calls; two real model requests run concurrently in distinct detached Git worktrees with original files unchanged')
  page.get_by_test_id('task-row').filter(has_text='独立浏览对话').click();draft='执行中也可以编辑另一个对话的草稿。';page.get_by_label('任务输入',exact=True).fill(draft);nav(page,'连接器与插件');nav(page,'协作任务');assert group(page,g['id'])['status']=='running';page.get_by_test_id('task-row').filter(has_text='独立浏览对话').click();expect(page.get_by_label('任务输入',exact=True)).to_have_value(draft);nav(page,'协作任务');page.get_by_role('button',name='打开执行记录',exact=True).first.click();expect(page.get_by_text('独立协作子任务 · 权限与写入范围由计划固定')).to_be_visible();expect(page.get_by_role('button',name='发送补充说明',exact=True)).to_be_disabled();shot(page,'child-conversation-light.png')
  denied=page.evaluate("async id=>{const out=[];for(const [method,params]of [['turn/start',{threadId:id,input:'bypass'}],['thread/settings/update',{threadId:id,permissionMode:'bypassPermissions'}],['checkpoint/restore',{threadId:id,checkpointId:'fake'}]]){try{await window.smalt.call(method,params);out.push(false)}catch{out.push(true)}}try{await window.smalt.processes('terminal',{threadId:id});out.push(false)}catch{out.push(true)}return out}",g['tasks'][0]['threadId']);assert all(denied);checks.append('running workers survive navigation and other-chat draft edits; owned child input stays blocked; public send, permission escalation, checkpoint restore and terminal IPC cannot bypass child ownership')
  release.set();until(lambda:group(page,g['id'])['status']=='review');nav(page,'查看协作与结果');expect(page.get_by_test_id('collaboration-task')).to_have_count(2)
  for label in ['界面模块改进','文档内容完善']:page.get_by_label('选择结果 '+label,exact=True).check()
  nav(page,'汇总并审查');expect(page.get_by_label('协作验证记录',exact=True)).to_be_visible(timeout=45000);shot(page,'merge-review-light.png');page.get_by_label('协作验证记录',exact=True).fill('未运行项目测试；本轮检查了两个文件的修改范围与实际内容。');nav(page,'核对并保存记录');expect(page.get_by_test_id('collaboration-validation')).to_contain_text('未运行');nav(page,'确认合并到项目');until(lambda:group(page,g['id'])['status']=='applied');assert(workspace/'src/a.txt').read_text(encoding='utf8')=='协作 A 的修改\n';assert(workspace/'src/b.txt').read_text(encoding='utf8')=='协作 B 的修改\n';assert git('rev-parse','HEAD')==head;assert(workspace/'.git/index').read_bytes()==index;checks.append('selected completed nodes produce a separate review worktree; exact candidate checks and honest manual validation record precede native merge confirmation; working files change once while Git HEAD and index remain unchanged')
  conflict=api(page,'save',{'config':cfg(conflict=True)});api(page,'start',{'id':conflict['id'],'revision':conflict['revision']});until(lambda:group(page,conflict['id'])['status']=='review');conflict=group(page,conflict['id']);api(page,'review',{'id':conflict['id'],'revision':conflict['revision'],'selected':['a','b']});page.get_by_test_id('collaboration-row').filter(has_text=conflict['title']).click();nav(page,'合并审查 1');expect(page.get_by_text('需要处理冲突',exact=True)).to_be_visible();shot(page,'conflict-review-light.png');nav(page,'编辑拟合并内容');page.get_by_label('冲突解决内容',exact=True).fill('已人工核对的合并内容\n');nav(page,'保存解决结果');expect(page.get_by_text('冲突已处理',exact=True)).to_be_visible();nav(page,'切换主题');shot(page,'conflict-review-dark.png');checks.append('same-file changes show real 3-way conflict markers; all source nodes remain visible; edited resolution removes markers and invalidates prior verification rather than silently choosing one result')
  # Source or candidate changes fail closed. Do not discard original user edits.
  conflict=group(page,conflict['id']);(workspace/'src/a.txt').write_text('user edit after review\n',encoding='utf8');page.get_by_label('协作验证记录',exact=True).fill('检查并发编辑');nav(page,'核对并保存记录');expect(page.get_by_role('alert')).to_contain_text('原项目');assert(workspace/'src/a.txt').read_text()=='user edit after review\n';shot(page,'stale-source-dark.png');checks.append('new original-project edits invalidate review and prevent overwrite with a visible reason outside execution folds')
  for theme in ['dark','light']:
   if theme=='light':nav(page,'切换主题')
   for factor in [1,1.25,1.5,2]:
    ack.unlink(missing_ok=True);publish(zoom,str(factor));until(lambda:ack.exists());assert page.evaluate('document.body.scrollWidth<=innerWidth+1');nav(page,'新建协作');dialog=page.get_by_role('dialog',name='配置协作任务');dialog.get_by_role('button',name='保存计划',exact=True).scroll_into_view_if_needed();expect(dialog.get_by_role('button',name='保存计划',exact=True)).to_be_visible();shot(page,f'editor-{theme}-zoom-{factor}.png');dialog.get_by_role('button',name='取消',exact=True).click()
  ack.unlink(missing_ok=True);publish(zoom,'1');until(lambda:ack.exists());page.set_viewport_size({'width':960,'height':720});assert page.evaluate('document.body.scrollWidth<=innerWidth+1');shot(page,'review-narrow-light.png');page.set_viewport_size({'width':1440,'height':1000});checks.append('review and long plan editor fit dark/light native Electron zoom 100/125/150/200 percent and a narrow window with reachable actions and no page overflow')
  # A second held group proves group cancellation and owned cleanup without deleting the project.
  release.clear();before=hold_count;cancelled=api(page,'save',{'config':cfg('取消与退出清理',hold=True)});api(page,'start',{'id':cancelled['id'],'revision':cancelled['revision']});until(lambda:hold_count>=before+2);api(page,'cancel',{'id':cancelled['id']});release.set();cancelled=group(page,cancelled['id']);assert all(t['status']=='cancelled'for t in cancelled['tasks']);page.get_by_test_id('collaboration-row').filter(has_text=cancelled['title']).click();shot(page,'cancelled-results-light.png');api(page,'cleanup',{'id':cancelled['id'],'revision':cancelled['revision']});assert group(page,cancelled['id'])['status']=='cleaned';assert(workspace/'src/a.txt').exists();checks.append('group cancel aborts both in-flight child requests and leaves drafts/worktree edits inspectable; explicit cleanup removes only owned worktrees, preserving the project, history and baseline')
  release.clear();before=hold_count;shutdown=api(page,'save',{'config':cfg('退出不重放',hold=True)});api(page,'start',{'id':shutdown['id'],'revision':shutdown['revision']});until(lambda:hold_count>=before+2);quit_file.write_text('quit');process.wait(timeout=20);assert process.returncode==0;count=len(requests);release.set();saved=json.loads((home/'collaborations.json').read_text(encoding='utf8'));assert next(g for g in saved['groups']if g['id']==shutdown['id'])['status']=='cancelled';launch();browser,page=connect(p);page.wait_for_timeout(1200);assert len(requests)==count;assert group(page,shutdown['id'])['status']=='cancelled';quit_file.write_text('quit');process.wait(timeout=20);assert process.returncode==0;assert not errors,errors;checks.append('real app quit cancels all owned model turns and keeps worktrees; restarting never resumes or replays interrupted child requests')
 except Exception:
  if browser:
   try:shot(page,'failure.png');print(page.locator('body').inner_text()[-10000:])
   except Exception:pass
  raise
 finally:
  release.set()
  if process and process.poll()is None:quit_file.write_text('quit')
  if process:
   try:process.wait(timeout=15)
   except subprocess.TimeoutExpired:process.terminate();process.wait(timeout=10)
  log.close();server.shutdown()
evidence={'passed':True,'checks':checks,'rendererErrors':errors,'modelRequests':len(requests),'fixture':str(run),'screenshots':[str(v)for v in shots.glob('*.png')if v.name!='failure.png']};(shots/'results.json').write_text(json.dumps(evidence,ensure_ascii=False,indent=2),encoding='utf8');print(json.dumps(evidence,ensure_ascii=False,indent=2))
