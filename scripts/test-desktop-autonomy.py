"""Phase six: real Electron/IPC/kernel and a local streaming model; synthetic profile only."""
from _desktop_control import publish
import json, os, socket, subprocess, sys, threading, time
from datetime import datetime, timezone
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

root=Path(__file__).resolve().parents[1];sys.path.insert(0,str(root/'.qa-python'))
from playwright.sync_api import sync_playwright, expect
run=root/'.qa-work'/('autonomy-ui-'+str(time.time_ns()));home=run/'home';workspace=run/'工作空间'
(home/'threads').mkdir(parents=True);workspace.mkdir();shots=root/'docs/screenshots/phase-six';shots.mkdir(parents=True,exist_ok=True)
(workspace/'notes.md').write_text('# 项目资料\n本机验收示例，所有内容均为合成资料。\n',encoding='utf8')
at=datetime.now(timezone.utc).isoformat();project_a='project_phase_six_a';project_b='project_phase_six_b'
(home/'projects.json').write_text(json.dumps([{'id':project_a,'name':'资料整理项目','cwd':str(workspace),'instructions':'按用户选中的资料完成核对。','createdAt':at,'updatedAt':at},{'id':project_b,'name':'独立项目','cwd':str(workspace),'instructions':'独立项目不读取其他项目约定。','createdAt':at,'updatedAt':at}],ensure_ascii=False),encoding='utf8')
for ident,title,project in [('th_autonomy_a','资料整理对话',project_a),('th_autonomy_b','独立对话 B',project_b)]:
 meta={'id':ident,'title':title,'cwd':str(workspace),'projectId':project,'model':'autonomy-model','provider':'openai','createdAt':at,'updatedAt':at,'turnCount':1,'lastOutcome':'completed'}
 events=[{'t':'meta','meta':meta},{'t':'turn-started','turnId':'seed','at':at},{'t':'user-msg','id':'u-'+ident,'text':'准备核对本机资料。','at':at},{'t':'agent-msg','id':'a-'+ident,'text':'可以先明确范围与完成条件。','at':at},{'t':'turn-ended','turnId':'seed','at':at}]
 (home/'threads'/(ident+'.jsonl')).write_text('\n'.join(json.dumps(v,ensure_ascii=False) for v in events)+'\n',encoding='utf8')
(home/'workspace-access.json').write_text(json.dumps([str(workspace.resolve()).lower() if os.name=='nt' else str(workspace.resolve())]),encoding='utf8')
requests=[];held=threading.Event();release=threading.Event();rounds=0
class Server(BaseHTTPRequestHandler):
 def log_message(self,*args):pass
 def do_GET(self):
  body=json.dumps({'data':[{'id':'autonomy-model','context_window':256000,'supported_parameters':['tools']}]}).encode();self.send_response(200);self.send_header('Content-Type','application/json');self.end_headers();self.wfile.write(body)
 def do_POST(self):
  global rounds
  body=json.loads(self.rfile.read(int(self.headers.get('Content-Length',0))));requests.append(body);messages=body['messages'];latest=max(i for i,m in enumerate(messages) if m['role']=='user');prompt=str(messages[latest]['content']);done=any(m['role']=='tool' for m in messages[latest+1:]);names=[v['function']['name'] for v in body.get('tools',[])];call=None
  self.send_response(200);self.send_header('Content-Type','text/event-stream');self.end_headers()
  try:
   if 'HOLD_GOAL' in prompt:
    self.wfile.write(('data: '+json.dumps({'choices':[{'delta':{'reasoning_content':'正在核对所选资料，等待本机测试节点。'},'finish_reason':None}]},ensure_ascii=False)+'\n\n').encode());self.wfile.flush();held.set();release.wait(35)
   if 'CONTINUOUS_REVIEW' in prompt and not done:
    rounds+=1;call=('task_checkpoint',{'status':'continue' if rounds==1 else 'review','summary':'已核对资料来源，准备下一节点。' if rounds==1 else '两项节点已完成，请用户核对并验收。'})
   elif 'SCHEDULE_DENY' in prompt and not done:call=('shell',{'command':'echo SHOULD_NEVER_RUN > forbidden.txt'})
   elif 'BUDGET_STOP' in prompt:call=('read',{'path':'notes.md'})
   content='本机资料已核对，等待用户审阅实际记录。'
   delta={'tool_calls':[{'index':0,'id':'call_'+str(len(requests)),'function':{'name':call[0],'arguments':json.dumps(call[1],ensure_ascii=False)}}]} if call else {'content':content}
   self.wfile.write(('data: '+json.dumps({'choices':[{'delta':delta,'finish_reason':'tool_calls' if call else 'stop'}]},ensure_ascii=False)+'\n\ndata: [DONE]\n\n').encode());self.wfile.flush()
  except (BrokenPipeError,ConnectionResetError):pass
server=ThreadingHTTPServer(('127.0.0.1',0),Server);threading.Thread(target=server.serve_forever,daemon=True).start();origin=f'http://127.0.0.1:{server.server_port}'
(home/'settings.json').write_text(json.dumps({'defaultProvider':'openai','defaultModel':'autonomy-model','providers':{'openai':{'baseUrl':origin+'/v1','apiKey':'local-autonomy-fixture'}}}),encoding='utf8')
with socket.socket() as sock:sock.bind(('127.0.0.1',0));port=sock.getsockname()[1]
quit_file=run/'quit';deny=run/'deny';power=run/'power';zoom=run/'zoom';zoom_ack=run/'zoom-ack';harness=run/'harness.cjs';version=json.loads((root/'packages/desktop/package.json').read_text(encoding='utf8'))['version']
harness_source=r"""
const {app,dialog,powerMonitor,BrowserWindow,ipcMain}=require('electron'),fs=require('node:fs');
const paths=__PATHS__;app.getVersion=()=>__VERSION__;
dialog.showMessageBox=async()=>({response:fs.existsSync(paths.deny)?1:0});
const register=ipcMain.handle.bind(ipcMain);
ipcMain.handle=(channel,fn)=>register(channel,async(event,...args)=>{const result=await fn(event,...args);if(channel==='smalt:autonomy'&&args[0]==='template-apply'&&fs.existsSync(paths.holdApply)){fs.writeFileSync(paths.applyReady,JSON.stringify(result));await new Promise(resolve=>{const timer=setInterval(()=>{if(!fs.existsSync(paths.holdApply)){clearInterval(timer);resolve()}},25);timer.unref()})}return result});
setInterval(()=>{if(fs.existsSync(paths.quit))app.quit();let w=BrowserWindow.getAllWindows()[0];if(fs.existsSync(paths.power)){let name=fs.readFileSync(paths.power,'utf8');fs.unlinkSync(paths.power);if(name.startsWith('navigate:'))w?.webContents.send('smalt:navigate',{threadId:name.slice(9)});else powerMonitor.emit(name)}if(w&&fs.existsSync(paths.zoom)){const n=Number(fs.readFileSync(paths.zoom,'utf8'));if([1,1.25,1.5,2].includes(n)){w.webContents.setZoomFactor(n);fs.unlinkSync(paths.zoom);fs.writeFileSync(paths.zoomAck,String(w.webContents.getZoomFactor()))}}},100).unref();
require(__MAIN__);
"""
hold_apply=run/'hold-apply';apply_ready=run/'apply-ready'
harness.write_text(harness_source.replace('__PATHS__',json.dumps({'deny':str(deny),'quit':str(quit_file),'power':str(power),'zoom':str(zoom),'zoomAck':str(zoom_ack),'holdApply':str(hold_apply),'applyReady':str(apply_ready)})).replace('__VERSION__',json.dumps(version)).replace('__MAIN__',json.dumps(str(root/'packages/desktop/dist/main/index.js'))),encoding='utf8')
env={**os.environ,'SMALT_HOME':str(home)}
for key in list(env):
 if any(part in key.upper() for part in ['API_KEY','TOKEN','SECRET','PASSWORD','CREDENTIAL']) or key=='ELECTRON_RUN_AS_NODE':env.pop(key,None)
log=open(run/'electron.log','w',encoding='utf8');process=None;checks=[];errors=[]
def launch():
 global process
 quit_file.unlink(missing_ok=True)
 process=subprocess.Popen([str(root/'node_modules/electron/dist/electron.exe'),str(harness),'--development-preview','--remote-debugging-port='+str(port)],env=env,stdout=log,stderr=log,creationflags=subprocess.CREATE_NO_WINDOW)
def until(check,seconds=20):
 end=time.time()+seconds
 while time.time()<end:
  if check():return
  time.sleep(.1)
 raise AssertionError('condition timed out')
def connect(p):
 browser=None
 for _ in range(100):
  try:browser=p.chromium.connect_over_cdp(f'http://127.0.0.1:{port}',timeout=500);break
  except Exception:time.sleep(.1)
 assert browser
 until(lambda:any(v.url.startswith('file:') for c in browser.contexts for v in c.pages));page=next(v for c in browser.contexts for v in c.pages if v.url.startswith('file:'));page.on('pageerror',lambda e:errors.append(str(e)));page.wait_for_load_state('networkidle');return browser,page
def api(page,action,value=None):return page.evaluate('v=>window.smalt.autonomy(v.action,v.value)',{'action':action,'value':value or {}})
def state(page):return api(page,'list')
def shot(page,name):page.screenshot(path=str(shots/name),animations='disabled')
def navigation(page,label):page.get_by_role('button',name=label,exact=True).click()
def tab(page,label):page.get_by_role('button',name=label,exact=False).filter(has_text=label).first.click()
def card(page,testid,title):return page.get_by_test_id(testid).filter(has_text=title)
def goal_config(title,instructions,**extra):return {'cwd':str(workspace),'projectId':project_a,'title':title,'instructions':instructions,'model':'openai/autonomy-model','mode':'plan','completion':{'kind':'review'},'stopOnIssue':True,'budget':{'turns':4,'requests':12,'tools':24,'tokens':120000,'minutes':10},**extra}

launch()
with sync_playwright() as p:
 browser=None
 try:
  browser,page=connect(p);page.evaluate("cwd=>{localStorage.setItem('smalt.ui.onboarded','true');localStorage.setItem('smalt.ui.dark','false');localStorage.setItem('smalt.ui.workspace',JSON.stringify(cwd))}",str(workspace));page.reload();page.wait_for_load_state('networkidle')
  page.get_by_test_id('task-row').filter(has_text='资料整理对话').click();navigation(page,'持续任务');expect(page.get_by_test_id('autonomy-page')).to_be_visible();navigation(page,'新建持续任务');dialog=page.get_by_role('dialog',name='持续任务设置');dialog.get_by_label('名称',exact=True).fill('项目资料持续核对');dialog.get_by_label('任务说明',exact=True).fill('CONTINUOUS_REVIEW：核对两项节点并申请用户验收。');shot(page,'goal-settings-light.png');dialog.get_by_role('button',name='保存',exact=True).click();expect(dialog).not_to_be_visible();gcard=card(page,'goal-card','项目资料持续核对');expect(gcard).to_contain_text('待开始');assert not requests
  deny.write_text('deny');gcard.get_by_role('button',name='开始',exact=True).click();expect(page.get_by_role('alert')).to_contain_text('已取消开始');deny.unlink();gcard.get_by_role('button',name='开始',exact=True).click();expect(gcard).to_contain_text('等待验收',timeout=20000);assert rounds==2;assert len(requests)==4;shot(page,'goals-light.png');gcard.get_by_role('button',name='运行记录',exact=True).click();history=page.get_by_role('dialog',name='托管运行记录');expect(history.get_by_role('button',name='打开本次对话与证据')).to_have_count(2);shot(page,'goal-history-light.png');history.get_by_role('button',name='关闭',exact=True).click();gcard.get_by_role('button',name='验收通过',exact=True).click();expect(gcard).to_contain_text('已完成')
  checks.append('actual goal editor creates inactive config; native refusal causes no model call; two scoped checkpoint rounds request human review; two real conversation records; only explicit user acceptance completes goal')

  hold=api(page,'goal-save',{'config':goal_config('运行中可自由浏览','HOLD_GOAL：核对所选资料。')});api(page,'goal-start',{'id':hold['id']});until(lambda:held.is_set());page.get_by_test_id('task-row').filter(has_text='独立对话 B').click();draft='独立项目的草稿应始终保留。';page.get_by_label('任务输入',exact=True).fill(draft);navigation(page,'持续任务');navigation(page,'连接器与插件');navigation(page,'持续任务');expect(card(page,'goal-card','运行中可自由浏览')).to_have_count(0);page.get_by_label('显示所有工作区',exact=True).check();hcard=card(page,'goal-card','运行中可自由浏览');expect(hcard).to_contain_text('运行中');hcard.get_by_role('button',name='打开对话',exact=True).click();expect(page.get_by_test_id('managed-task-badge')).to_contain_text('运行中可自由浏览');expect(page.get_by_label('任务输入',exact=True)).to_have_attribute('placeholder','可以先写草稿，暂停托管任务后发送…');page.get_by_label('任务输入',exact=True).fill('暂停后补充检查');expect(page.get_by_role('button',name='发送补充说明',exact=True)).to_be_disabled();shot(page,'managed-conversation-light.png');page.get_by_test_id('managed-task-badge').get_by_role('button',name='暂停',exact=True).click();until(lambda:next(g for g in state(page)['goals'] if g['id']==hold['id'])['status']=='paused');release.set();page.get_by_test_id('task-row').filter(has_text='独立对话 B').click();expect(page.get_by_label('任务输入',exact=True)).to_have_value(draft)
  checks.append('held real streaming turn survives other chat/navigation; independent draft remains editable; scoped list hides another project until explicitly showing all; owning chat displays budget controls and pause cancels original task')

  page.get_by_test_id('task-row').filter(has_text='资料整理对话').click();navigation(page,'持续任务');tab(page,'项目记忆');navigation(page,'新建记忆');dialog=page.get_by_role('dialog',name='记忆设置');dialog.get_by_label('名称',exact=True).fill('资料引用约定');dialog.get_by_label('记忆正文',exact=True).fill('MEMORY_PROJECT_A_ONLY：输出中的每条结论都应能核对到所选资料。');dialog.get_by_label('记忆来源说明',exact=True).fill('资料整理项目 · 用户确认的核对方法');dialog.get_by_label('匹配此范围的后续手动任务自动引用',exact=True).check();dialog.get_by_role('button',name='保存',exact=True).click();expect(dialog).not_to_be_visible();mcard=card(page,'memory-card','资料引用约定');expect(mcard).to_contain_text('自动引用');shot(page,'memories-light.png');mcard.get_by_role('button',name='加入当前任务',exact=True).click();expect(page.get_by_label('任务输入',exact=True)).to_be_enabled();page.get_by_label('任务输入',exact=True).fill('请依据约定检查资料。');before=len(requests);navigation(page,'发送');until(lambda:len(requests)>before);expect(page.get_by_test_id('item-agentMessage').filter(has_text='本机资料已核对')).to_be_visible();assert 'MEMORY_PROJECT_A_ONLY' in json.dumps(requests[-1],ensure_ascii=False);assert 'MEMORY_PROJECT_A_ONLY' not in '\n'.join(str(m['content']) for m in requests[-1]['messages'] if m['role']=='system')
  navigation(page,'持续任务');tab(page,'项目记忆');card(page,'memory-card','资料引用约定').get_by_role('button',name='查看与使用记录',exact=True).click();detail=page.get_by_role('dialog',name='记忆详情与使用记录');expect(detail).to_contain_text('手动消息');shot(page,'memory-provenance-light.png');detail.get_by_role('button',name='关闭',exact=True).click();page.get_by_test_id('task-row').filter(has_text='独立对话 B').click();navigation(page,'发送');until(lambda:'独立项目的草稿' in json.dumps(requests[-1],ensure_ascii=False));expect(page.get_by_label('任务输入',exact=True)).to_have_value('');assert 'MEMORY_PROJECT_A_ONLY' not in json.dumps(requests[-1],ensure_ascii=False)
  checks.append('memory editor records user provenance and extra automatic consent; explicit reference and automatic selection deduplicate; user message gets versioned context without system promotion; usage record links to owning chat; another project receives none')

  page.get_by_test_id('task-row').filter(has_text='资料整理对话').click();navigation(page,'持续任务');tab(page,'任务模板');navigation(page,'新建模板');dialog=page.get_by_role('dialog',name='任务模板设置');dialog.get_by_label('名称',exact=True).fill('资料审阅模板');dialog.get_by_label('任务说明',exact=True).fill('检查 {{topic}}，范围为 {{scope}}。');dialog.get_by_label('输出标准',exact=True).fill('按结论、依据、待确认事项编写。');dialog.get_by_label('固定引用资料',exact=True).fill('notes.md');dialog.get_by_role('button',name='保存',exact=True).click();expect(dialog).not_to_be_visible();shot(page,'templates-light.png');before=len(requests);tcard=card(page,'template-card','资料审阅模板');tcard.get_by_role('button',name='套用为任务草稿',exact=True).click();dialog=page.get_by_role('dialog',name='套用任务模板');dialog.get_by_label('模板变量 topic',exact=True).fill('每周项目记录');dialog.get_by_label('模板变量 scope',exact=True).fill('本周选中的资料');shot(page,'template-apply-light.png');dialog.get_by_role('button',name='生成任务草稿',exact=True).click();expect(page.get_by_label('任务输入',exact=True)).to_have_value('检查 每周项目记录，范围为 本周选中的资料。\n\n输出标准：\n按结论、依据、待确认事项编写。');assert len(requests)==before
  checks.append('template UI fixes a local reference, previews two variables and output standards, creates a separate draft with no model call; existing conversation and draft are not overwritten')

  page.get_by_test_id('task-row').filter(has_text='独立对话 B').click();page.get_by_label('任务输入',exact=True).fill('其他对话的草稿仍保留。');page.get_by_test_id('task-row').filter(has_text='资料整理对话').click();navigation(page,'持续任务');tab(page,'任务模板');hold_apply.write_text('hold');card(page,'template-card','资料审阅模板').get_by_role('button',name='套用为任务草稿',exact=True).click();dialog=page.get_by_role('dialog',name='套用任务模板');dialog.get_by_label('模板变量 topic',exact=True).fill('后台完成也应保留');dialog.get_by_label('模板变量 scope',exact=True).fill('独立草稿');dialog.get_by_role('button',name='生成任务草稿',exact=True).click();until(lambda:apply_ready.exists());power.write_text('navigate:th_autonomy_b');expect(page.get_by_label('任务输入',exact=True)).to_have_value('其他对话的草稿仍保留。');hold_apply.unlink();background_draft=json.loads(apply_ready.read_text(encoding='utf8'));page.wait_for_timeout(200);expect(page.get_by_label('任务输入',exact=True)).to_have_value('其他对话的草稿仍保留。');power.write_text('navigate:'+background_draft['threadId']);expect(page.get_by_label('任务输入',exact=True)).to_have_value(background_draft['text']);checks.append('a delayed template response survives native conversation navigation: result is saved as its own draft without reopening it, current draft remains intact and later opening the new chat restores substituted text and references')

  navigation(page,'持续任务');tab(page,'定时任务');navigation(page,'新建定时任务');dialog=page.get_by_role('dialog',name='定时任务设置');dialog.get_by_label('名称',exact=True).fill('只读资料巡检');dialog.get_by_label('任务说明',exact=True).fill('SCHEDULE_DENY：核对资料并展示权限拒绝记录。');dialog.get_by_label('执行方式',exact=True).select_option('interval');dialog.get_by_label('间隔分钟',exact=True).fill('5');dialog.get_by_label('最多执行次数',exact=True).fill('2');dialog.get_by_label('固定引用资料',exact=True).fill('notes.md');shot(page,'schedule-settings-light.png');dialog.get_by_role('button',name='保存并保持停用',exact=True).click();expect(dialog).not_to_be_visible();scard=card(page,'schedule-card','只读资料巡检');expect(scard).to_contain_text('已停用');before=len(requests);scard.get_by_role('button',name='核对并启用',exact=True).click();expect(scard).to_contain_text('已启用');scard.get_by_role('button',name='立即运行',exact=True).click();until(lambda:len(requests)>=before+2);until(lambda:any(r['kind']=='schedule' and r['status']!='running' for r in state(page)['runs']));assert not (workspace/'forbidden.txt').exists();assert '此工具未获授权' in json.dumps(requests[-1],ensure_ascii=False);assert 'MEMORY_PROJECT_A_ONLY' not in json.dumps(requests[-1],ensure_ascii=False);assert sorted(v['function']['name'] for v in requests[-2]['tools'])==['glob','grep','plan','read'];expect(scard).to_contain_text('本次运行需核对');expect(scard).to_contain_text('此工具未获授权');shot(page,'schedules-light.png');navigation(page,'切换主题');shot(page,'schedules-dark.png');scard.get_by_role('button',name='运行记录',exact=True).click();history=page.get_by_role('dialog',name='托管运行记录');expect(history).to_contain_text('此工具未获授权');shot(page,'schedule-history-dark.png');history.get_by_role('button',name='关闭',exact=True).click();scard.get_by_role('button',name='停用调度',exact=True).click();expect(scard).to_contain_text('已停用')
  checks.append('schedule editor saves disabled; explicit native enable grants bounded read-only execution; manual run cannot use shell even if model invents it; no file created, tool denial stays visible, no unrelated automatic memory injection; disabling prevents future dispatch')

  once=api(page,'schedule-save',{'config':{'cwd':str(workspace),'title':'一次性后台核对','instructions':'核对本机资料，不修改。','model':'openai/autonomy-model','timing':{'kind':'once','at':datetime.fromtimestamp(time.time()+5,timezone.utc).isoformat()},'budget':{'requests':2,'tools':2,'tokens':60000,'minutes':1},'maxRuns':1,'references':[],'memoryIds':[]}});api(page,'schedule-enable',{'id':once['id'],'enabled':True});page.get_by_test_id('task-row').filter(has_text='独立对话 B').click();page.get_by_label('任务输入',exact=True).fill('计时运行也不能抢走当前草稿。');until(lambda:any(r['ownerId']==once['id'] and r['status']=='completed' for r in state(page)['runs']));expect(page.get_by_label('任务输入',exact=True)).to_have_value('计时运行也不能抢走当前草稿。');assert next(s for s in state(page)['schedules'] if s['id']==once['id'])['executions']==1
  checks.append('actual main-process timer executes a future once slot while another chat is open, leaves active draft and selection unchanged, consumes one claim and disables itself')
  sleep_job=api(page,'schedule-save',{'config':{'cwd':str(workspace),'title':'休眠错过时段不补跑','instructions':'只读检查','model':'openai/autonomy-model','timing':{'kind':'once','at':datetime.fromtimestamp(time.time()+3,timezone.utc).isoformat()},'budget':{'requests':2,'tools':2,'tokens':60000,'minutes':1},'maxRuns':1,'references':[],'memoryIds':[]}});api(page,'schedule-enable',{'id':sleep_job['id'],'enabled':True});before=len(requests);power.write_text('suspend');until(lambda:state(page)['suspended']);page.wait_for_timeout(3500);power.write_text('resume');until(lambda:any(r['ownerId']==sleep_job['id'] and r['status']=='skipped' for r in state(page)['runs']));assert len(requests)==before;assert not state(page)['suspended'];checks.append('actual main-process suspend/resume event bridge skips a once slot missed by seconds; no catch-up call or OS sleep/display setting change')


  page.get_by_test_id('task-row').filter(has_text='资料整理对话').click();navigation(page,'持续任务');budget=api(page,'goal-save',{'config':goal_config('达到预算可定位原因','BUDGET_STOP：读取工作区资料。',budget={'turns':3,'requests':1,'tools':4,'tokens':60000,'minutes':2})});api(page,'goal-start',{'id':budget['id']});until(lambda:next(g for g in state(page)['goals'] if g['id']==budget['id'])['status']=='budget');bcard=card(page,'goal-card','达到预算可定位原因');expect(bcard).to_contain_text('预算已用完');expect(bcard).to_contain_text('模型请求预算');bcard.scroll_into_view_if_needed();shot(page,'budget-stop-dark.png')
  for label,name in [('项目记忆','memories-dark.png'),('任务模板','templates-dark.png'),('持续目标','goals-dark.png')]:tab(page,label);shot(page,name)
  page.set_viewport_size({'width':960,'height':720});navigation(page,'新建持续任务');dialog=page.get_by_role('dialog',name='持续任务设置');dialog.get_by_label('任务说明',exact=True).fill('窄窗口表单检查');dialog.get_by_role('button',name='保存',exact=True).scroll_into_view_if_needed();expect(dialog.get_by_role('button',name='保存',exact=True)).to_be_visible();assert page.evaluate('document.body.scrollWidth<=innerWidth+1');shot(page,'goal-settings-narrow-dark.png');dialog.get_by_role('button',name='取消',exact=True).click();page.set_viewport_size({'width':1440,'height':1000})
  checks.append('budget stops show reason and counters outside execution fold; all four pages inspected in dark and light; long editor scrolls to reachable controls in a narrow window without page overflow')

  for theme in ['dark','light']:
   if theme=='light':navigation(page,'切换主题')
   for factor in [1,1.25,1.5,2]:
    zoom_ack.unlink(missing_ok=True);publish(zoom,str(factor));until(lambda:zoom_ack.exists());assert float(zoom_ack.read_text())==factor;assert page.evaluate('document.body.scrollWidth<=innerWidth+1');navigation(page,'新建持续任务');dialog=page.get_by_role('dialog',name='持续任务设置');dialog.get_by_role('button',name='保存',exact=True).scroll_into_view_if_needed();expect(dialog.get_by_role('button',name='保存',exact=True)).to_be_visible();shot(page,f'goal-settings-{theme}-zoom-{factor}.png');dialog.get_by_role('button',name='取消',exact=True).click()
  zoom_ack.unlink(missing_ok=True);publish(zoom,'1');until(lambda:zoom_ack.exists());checks.append('phase-six pages and long editor fit actual native Electron zoom 100/125/150/200 percent in both themes; dark native checkbox/select/date controls use matching color scheme')

  # A real application quit interrupts the source-owned turn and restart never replays it.
  release.clear();held.clear();shutdown_goal=api(page,'goal-save',{'config':goal_config('退出后不自动重跑','HOLD_GOAL：退出清理验收。')});api(page,'goal-start',{'id':shutdown_goal['id']});until(lambda:held.is_set());quit_file.write_text('quit');process.wait(timeout=20);assert process.returncode==0;count=len(requests);release.set();saved=json.loads((home/'autonomy.json').read_text(encoding='utf8'));assert next(g for g in saved['goals'] if g['id']==shutdown_goal['id'])['status']=='paused';assert not any(r['status']=='running' for r in saved['runs']);launch();browser,page=connect(p);time.sleep(1.5);assert len(requests)==count;assert next(g for g in state(page)['goals'] if g['id']==shutdown_goal['id'])['status']=='paused';quit_file.write_text('quit');process.wait(timeout=20);assert process.returncode==0;assert not errors,errors
  checks.append('real application quit aborts a held request and records paused/interrupted state before exit; source app restarts without automatic goal replay or duplicate once-slot model calls')
 except Exception:
  if browser:
   try:shot(page,'failure.png');print(page.locator('body').inner_text()[-10000:])
   except Exception:pass
  raise
 finally:
  release.set()
  if process and process.poll() is None:quit_file.write_text('quit')
  if process:
   try:process.wait(timeout=15)
   except subprocess.TimeoutExpired:process.terminate();process.wait(timeout=10)
  log.close();server.shutdown()
evidence={'passed':True,'checks':checks,'rendererErrors':errors,'modelRequests':len(requests),'fixture':str(run),'screenshots':[str(v) for v in shots.glob('*.png') if v.name!='failure.png']};(shots/'results.json').write_text(json.dumps(evidence,ensure_ascii=False,indent=2),encoding='utf8');print(json.dumps(evidence,ensure_ascii=False,indent=2))
