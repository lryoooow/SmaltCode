"""Actual Electron PTY, project commands, ownership and awaited-quit acceptance. Synthetic profiles only."""
import json, os, time, socket, subprocess, threading, hashlib, ctypes
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
root=Path(__file__).resolve().parents[1]
import sys
sys.path.insert(0,str(root/'.qa-python'))
from playwright.sync_api import sync_playwright, expect

run=root/'.qa-work'/('process-ui-'+str(time.time_ns()));home=run/'home';workspace=run/'项目 空间'
(home/'threads').mkdir(parents=True);workspace.mkdir()
(workspace/'server.cjs').write_text("const fs=require('node:fs');const c=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',detached:true,windowsHide:true});fs.writeFileSync('owned-child.json',JSON.stringify({pid:c.pid}));console.log('BACKGROUND_READY');setInterval(()=>{},1000)",encoding='utf8')
(workspace/'foreground.cjs').write_text((workspace/'server.cjs').read_text().replace('owned-child.json','foreground-child.json').replace('BACKGROUND_READY','FOREGROUND_READY'),encoding='utf8')
(workspace/'package.json').write_text(json.dumps({'scripts':{'hello':"node -e \"console.log('PROJECT_SCRIPT_OK')\""}}),encoding='utf8')
at=time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime())
for id,title in [('th_process_a','进程工作区 A'),('th_process_b','进程工作区 B')]:
 meta={'id':id,'title':title,'cwd':str(workspace),'model':'process-model','provider':'openai','createdAt':at,'updatedAt':at,'turnCount':1,'lastOutcome':'completed'}
 events=[{'t':'meta','meta':meta},{'t':'turn-started','turnId':'seed','at':at},{'t':'user-msg','id':'u-'+id,'text':'核对运行中的进程','at':at},{'t':'agent-msg','id':'a-'+id,'text':'进程与对话分别管理。','at':at},{'t':'turn-ended','turnId':'seed','at':at}]
 (home/'threads'/(id+'.jsonl')).write_text('\n'.join(json.dumps(value,ensure_ascii=False) for value in events)+'\n',encoding='utf8')
(home/'workspace-access.json').write_text(json.dumps([str(workspace.resolve()).lower() if os.name=='nt' else str(workspace.resolve())]),encoding='utf8')
requests=[]
class Model(BaseHTTPRequestHandler):
 def log_message(self,*args):pass
 def do_GET(self):
  self.send_response(200);self.send_header('Content-Type','application/json');self.end_headers();self.wfile.write(json.dumps({'data':[{'id':'process-model','context_window':128000,'supported_parameters':['tools']}]}).encode())
 def do_POST(self):
  body=json.loads(self.rfile.read(int(self.headers['Content-Length'])));requests.append(body);messages=body['messages'];tools=[value for value in messages if value['role']=='tool']
  self.send_response(200);self.send_header('Content-Type','text/event-stream');self.end_headers()
  foreground=any('前台退出清理' in str(value.get('content')) for value in messages if value['role']=='user')
  delta={'tool_calls':[{'index':0,'id':'background-start','function':{'name':'shell','arguments':json.dumps({'program':'node','args':['foreground.cjs' if foreground else 'server.cjs'],'background':not foreground,'title':'测试后台服务'})}}]} if not tools else {'content':'后台服务已经登记，运行结果请在终端面板核对。'}
  self.wfile.write(('data: '+json.dumps({'choices':[{'delta':delta,'finish_reason':'tool_calls' if not tools else 'stop'}]})+'\n\ndata: [DONE]\n\n').encode());self.wfile.flush()
server=ThreadingHTTPServer(('127.0.0.1',0),Model);threading.Thread(target=server.serve_forever,daemon=True).start()
(home/'settings.json').write_text(json.dumps({'defaultProvider':'openai','defaultModel':'process-model','providers':{'openai':{'baseUrl':f'http://127.0.0.1:{server.server_port}/v1','apiKey':'process-fixture-key'}}}),encoding='utf8')
with socket.socket() as sock:sock.bind(('127.0.0.1',0));port=sock.getsockname()[1]
quit_file=run/'quit';deny_file=run/'deny-terminal';harness=run/'harness.cjs'
harness.write_text("const {app,dialog}=require('electron');const fs=require('node:fs');app.getVersion=()=>"+json.dumps(json.loads((root/'packages/desktop/package.json').read_text(encoding='utf8'))['version'])+";dialog.showMessageBox=async options=>({response:options.title==='授权手动终端'&&fs.existsSync("+json.dumps(str(deny_file))+")?1:0});setInterval(()=>{if(fs.existsSync("+json.dumps(str(quit_file))+"))app.quit()},100).unref();require("+json.dumps(str(root/'packages/desktop/dist/main/index.js'))+");",encoding='utf8')
env={**os.environ,'SMALT_HOME':str(home)}
for key in list(env):
 if any(part in key.upper() for part in ['API_KEY','TOKEN','SECRET','PASSWORD','CREDENTIAL']) or key=='ELECTRON_RUN_AS_NODE':env.pop(key,None)
log=open(run/'electron.log','w',encoding='utf8');process=subprocess.Popen([str(root/'node_modules/electron/dist/electron.exe'),str(harness),'--ui-test','--remote-debugging-port='+str(port)],env=env,stdout=log,stderr=log,creationflags=subprocess.CREATE_NO_WINDOW)
shots=root/'docs/screenshots/phase-three';shots.mkdir(parents=True,exist_ok=True);checks=[];errors=[]
runtime=root/'packages/desktop/dist/main/native';baseline={str(path.relative_to(runtime)):hashlib.sha256(path.read_bytes()).hexdigest() for path in runtime.rglob('*') if path.is_file()}
def alive(pid):
 kernel=ctypes.WinDLL('kernel32',use_last_error=True);kernel.OpenProcess.restype=ctypes.c_void_p;kernel.OpenProcess.argtypes=[ctypes.c_ulong,ctypes.c_int,ctypes.c_ulong];kernel.CloseHandle.argtypes=[ctypes.c_void_p];kernel.GetExitCodeProcess.argtypes=[ctypes.c_void_p,ctypes.POINTER(ctypes.c_ulong)]
 handle=kernel.OpenProcess(0x1000,False,pid)
 if not handle:return False
 code=ctypes.c_ulong();kernel.GetExitCodeProcess(handle,ctypes.byref(code));kernel.CloseHandle(handle);return code.value==259
def until(test,seconds=15):
 end=time.time()+seconds
 while time.time()<end:
  if test():return
  time.sleep(.1)
 raise AssertionError('Condition timed out')
with sync_playwright() as p:
 browser=None
 try:
  for _ in range(100):
   try:browser=p.chromium.connect_over_cdp(f'http://127.0.0.1:{port}',timeout=500);break
   except Exception:time.sleep(.1)
  assert browser
  page=browser.contexts[0].pages[0];page.on('pageerror',lambda error:errors.append(str(error)))
  page.wait_for_load_state('networkidle');page.evaluate("localStorage.setItem('smalt.ui.onboarded','true');localStorage.setItem('smalt.ui.dark','false')");page.reload();page.wait_for_load_state('networkidle')
  page.get_by_test_id('task-row').filter(has_text='进程工作区 A').click()
  page.get_by_role('button',name='打开终端与后台进程',exact=True).click()
  deny_file.write_text('deny');page.get_by_role('button',name='新建终端',exact=True).click();expect(page.get_by_test_id('process-manager')).to_contain_text('已取消终端授权');assert not page.get_by_test_id('managed-process').count();deny_file.unlink()
  page.get_by_role('button',name='新建终端',exact=True).click();expect(page.get_by_test_id('process-terminal')).to_be_visible(timeout=15000)
  def processes():return page.evaluate("window.smalt.processes('list')")['processes']
  until(lambda:any(value['kind']=='terminal' and value['state']=='running' for value in processes()))
  terminal=next(value for value in processes() if value['kind']=='terminal')
  textarea=page.get_by_test_id('process-terminal').locator('textarea.xterm-helper-textarea');textarea.focus();page.keyboard.type("Write-Output ('DESKTOP_' + 'INPUT_OK')",delay=10);page.keyboard.press('Enter')
  def output(id,thread='th_process_a'):return page.evaluate("value=>window.smalt.processes('read',value)",{'threadId':thread,'id':id})['output']['data']
  until(lambda:'DESKTOP_INPUT_OK' in output(terminal['id']))
  textarea.focus();page.keyboard.type("Write-Output ('中文_' + '界面输入成功')",delay=10);page.keyboard.press('Enter');until(lambda:'中文_界面输入成功' in output(terminal['id']))
  page.screenshot(path=str(shots/'terminal-light.png'),animations='disabled')
  page.set_viewport_size({'width':920,'height':500});page.get_by_test_id('process-terminal').scroll_into_view_if_needed();assert page.get_by_test_id('process-manager').evaluate('e=>e.scrollWidth<=e.clientWidth+1');page.screenshot(path=str(shots/'terminal-short-window.png'),animations='disabled');page.set_viewport_size({'width':1240,'height':820})
  page.get_by_role('button',name='收起面板',exact=True).click();assert next(value for value in processes() if value['id']==terminal['id'])['state']=='running'
  page.get_by_test_id('task-row').filter(has_text='进程工作区 B').click();page.get_by_role('button',name='打开终端与后台进程',exact=True).click();expect(page.get_by_test_id('managed-process')).to_have_count(0)
  mismatch=page.evaluate("async id=>{try{await window.smalt.processes('write',{threadId:'th_process_b',id,data:'BAD'});return false}catch{return true}}",terminal['id']);assert mismatch
  page.get_by_label('进程会话范围').select_option('all');expect(page.get_by_test_id('managed-process')).to_contain_text('进程工作区 A');page.get_by_test_id('managed-process').click();expect(page.get_by_test_id('process-terminal')).to_be_visible()
  until(lambda:'DESKTOP_INPUT_OK' in output(terminal['id']))
  textarea.focus();page.keyboard.type("Write-Output ('中文_' + '界面输入成功')",delay=10);page.keyboard.press('Enter');until(lambda:'中文_界面输入成功' in output(terminal['id']))
  checks.append('actual Electron PTY keyboard input, declined native consent, view close/reopen and multi-conversation ownership passed')
  page.evaluate("window.smalt.call('thread/settings/update',{threadId:'th_process_a',permissionMode:'plan'})");expect(page.get_by_test_id('process-manager')).to_contain_text('只读')
  denied=page.evaluate("async id=>{try{await window.smalt.processes('write',{threadId:'th_process_a',id,data:'BAD'});return false}catch{return true}}",terminal['id']);assert denied
  page.evaluate("window.smalt.call('thread/settings/update',{threadId:'th_process_a',permissionMode:'default'})");page.get_by_role('button',name='重新授权输入',exact=True).click();expect(page.get_by_test_id('process-manager')).to_contain_text('输入已授权')
  page.get_by_role('button',name='项目操作',exact=True).click();operation=page.get_by_test_id('project-operation').filter(has_text='hello');operation.get_by_role('button',name='运行',exact=True).click()
  until(lambda:any(value.get('actionId')=='package:hello' and value['state']=='exited' for value in processes()))
  script=next(value for value in processes() if value.get('actionId')=='package:hello');assert script['exitCode']==0 and 'PROJECT_SCRIPT_OK' in output(script['id'])
  page.get_by_role('button',name='项目操作',exact=True).click();page.get_by_role('button',name='添加常用操作',exact=True).click();page.get_by_label('项目操作名称').fill('Node 版本');page.get_by_label('项目操作程序').fill('node');page.get_by_label('项目操作参数').fill('["--version"]');page.get_by_role('button',name='保存操作',exact=True).click();expect(page.get_by_test_id('project-operations')).to_contain_text('Node 版本')
  page.screenshot(path=str(shots/'project-operations.png'),animations='disabled')
  checks.append('live permission changes revoke terminal input; fresh consent restores it; actual npm script exit/output and saved custom operations passed')
  page.get_by_role('button',name='收起面板',exact=True).click();page.get_by_label('任务输入',exact=True).fill('验证后台进程');page.get_by_role('button',name='发送',exact=True).click();expect(page.get_by_test_id('approval')).to_be_visible(timeout=15000);page.get_by_test_id('approval').get_by_role('button',name='允许',exact=True).click()
  expect(page.get_by_test_id('item-agentMessage').filter(has_text='后台服务已经登记')).to_be_visible(timeout=15000);until(lambda:(workspace/'owned-child.json').exists())
  background=next(value for value in processes() if value['title']=='测试后台服务');child=json.loads((workspace/'owned-child.json').read_text())['pid'];assert alive(child)
  page.get_by_role('button',name='打开终端与后台进程',exact=True).click();page.get_by_test_id('managed-process').filter(has_text='测试后台服务').click();expect(page.get_by_test_id('process-terminal')).to_be_visible();until(lambda:'BACKGROUND_READY' in output(background['id']))
  page.get_by_role('button',name='切换主题',exact=True).click();page.set_viewport_size({'width':920,'height':660});expect(page.get_by_role('button',name='返回对话',exact=True)).to_be_visible();page.screenshot(path=str(shots/'background-dark-narrow.png'),animations='disabled');page.set_viewport_size({'width':1240,'height':820})
  page.get_by_role('button',name='收起面板',exact=True).click();page.get_by_text('任务中心',exact=True).click();page.get_by_test_id('task-center').get_by_role('button',name='运行中',exact=True).click();expect(page.get_by_test_id('activity-row').filter(has_text='进程工作区 A')).to_contain_text('后台进程')
  page.get_by_test_id('task-row').filter(has_text='进程工作区 B').click();assert alive(child);page.reload();page.wait_for_load_state('networkidle');page.get_by_test_id('task-row').filter(has_text='进程工作区 A').click();page.get_by_role('button',name='打开终端与后台进程',exact=True).click();page.get_by_test_id('managed-process').filter(has_text='测试后台服务').click();until(lambda:'BACKGROUND_READY' in output(background['id']))
  checks.append('model background shell retains ordinary approval; its real child continues after model completion, browsing, chat switch, renderer reload and narrow-theme preview')
  page.get_by_test_id('task-row').filter(has_text='进程工作区 B').click();page.get_by_label('任务输入',exact=True).fill('前台退出清理');page.get_by_role('button',name='发送',exact=True).click();expect(page.get_by_test_id('approval')).to_be_visible(timeout=15000);page.get_by_test_id('approval').get_by_role('button',name='允许',exact=True).click();until(lambda:(workspace/'foreground-child.json').exists());foreground_child=json.loads((workspace/'foreground-child.json').read_text())['pid'];assert alive(foreground_child)
  assert not errors,errors
  quit_file.write_text('quit');assert process.wait(timeout=20)==0;until(lambda:not alive(child) and not alive(foreground_child),seconds=5)
  for name,digest in baseline.items():assert hashlib.sha256((runtime/name).read_bytes()).hexdigest()==digest,name
  checks.append('normal application quit awaits managed and foreground tool process trees and stopped-turn persistence; actual descendant dead and native runtime files unchanged')
  result={'passed':True,'checks':checks,'modelRequests':len(requests),'rendererErrors':errors,'nativeFilesUnchanged':len(baseline),'fixture':str(run)};(shots/'results.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf8');print(json.dumps(result,ensure_ascii=True,indent=2))
 except Exception:
  try:page.screenshot(path=str(shots/'failure.png'),animations='disabled');(run/'failure.json').write_text(json.dumps({'body':page.locator('body').inner_text(),'errors':errors},ensure_ascii=False),encoding='utf8')
  except Exception:pass
  raise
 finally:
  if browser:browser.close()
  if process.poll() is None:subprocess.run(['taskkill','/PID',str(process.pid),'/T','/F'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
  server.shutdown();log.close()
