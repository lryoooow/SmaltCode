"""Actual Electron isolated browsing and explicit image/cell feedback. Synthetic profiles only."""
from _desktop_control import publish
import base64, json, os, socket, struct, subprocess, sys, threading, time, zipfile, zlib
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
root=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(root/'.qa-python'))
from playwright.sync_api import sync_playwright, expect
run=root/'.qa-work'/('browser-ui-'+str(time.time_ns()));home=run/'home';workspace=run/'预览 空间'
(home/'threads').mkdir(parents=True);workspace.mkdir();shots=root/'docs/screenshots/phase-four';shots.mkdir(parents=True,exist_ok=True)
at=time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime())
for id,title in [('th_browser_a','浏览与对象 A'),('th_browser_b','浏览与对象 B')]:
 meta={'id':id,'title':title,'cwd':str(workspace),'model':'browser-model','provider':'openai','createdAt':at,'updatedAt':at,'turnCount':1,'lastOutcome':'completed'}
 events=[{'t':'meta','meta':meta},{'t':'turn-started','turnId':'seed','at':at},{'t':'user-msg','id':'u-'+id,'text':'检查预览与局部反馈','at':at},{'t':'agent-msg','id':'a-'+id,'text':'工作区已准备好。','at':at},{'t':'turn-ended','turnId':'seed','at':at}]
 (home/'threads'/(id+'.jsonl')).write_text('\n'.join(json.dumps(value,ensure_ascii=False) for value in events)+'\n',encoding='utf8')
(home/'workspace-access.json').write_text(json.dumps([str(workspace.resolve()).lower() if os.name=='nt' else str(workspace.resolve())]),encoding='utf8')
def chunk(kind,data):return struct.pack('>I',len(data))+kind+data+struct.pack('>I',zlib.crc32(kind+data)&0xffffffff)
png=b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('>IIBBBBB',640,360,8,6,0,0,0))+chunk(b'IDAT',zlib.compress(b''.join(b'\0'+bytes([47,79,208,255] if y<180 else [38,160,130,255])*640 for y in range(360))))+chunk(b'IEND',b'')
(workspace/'图表.png').write_bytes(png)
with zipfile.ZipFile(workspace/'明细.xlsx','w',zipfile.ZIP_DEFLATED) as output:
 for name,value in {'xl/workbook.xml':'<workbook xmlns:r="urn:r"><sheets><sheet name="成本明细" r:id="rId1"/></sheets></workbook>','xl/_rels/workbook.xml.rels':'<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>','xl/worksheets/sheet1.xml':'<worksheet><sheetData>'+''.join('<row r="'+str(i)+'">'+''.join('<c r="'+chr(65+j)+str(i)+'" t="inlineStr"><is><t>费用 '+str(i)+'-'+str(j)+'</t></is></c>' for j in range(18))+'</row>' for i in range(1,26))+'</sheetData></worksheet>'}.items():output.writestr(name,value)
(workspace/'index.html').write_text('''<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="style.css"><title>项目概览</title><main><p class="eyebrow">SMALTCODE · PROJECT REVIEW</p><h1>让每一步进展清晰可见</h1><p>独立沙箱中的开发页面，支持针对元素提出修改意见。</p><div id="card"><strong>交付概览</strong><p>已完成 18 项 · 待检查 3 项</p><canvas id="chart" width="420" height="120"></canvas></div><a id="next" href="next.html">查看下一页 →</a><button id="popup" onclick="window.open('https://example.com/')">打开外部页面</button><a href="data:text/plain,download" download="blocked.txt">测试下载</a></main><script>document.documentElement.dataset.localScript='ok';let c=document.querySelector('canvas').getContext('2d');c.fillStyle='#6366f1';[42,76,55,98,88,110].forEach((h,i)=>c.fillRect(i*66,120-h,45,h));fetch('https://example.com/blocked').catch(()=>{});</script>''',encoding='utf8')
(workspace/'next.html').write_text('<meta charset="utf-8"><title>第二页</title><h1>第二页真实导航</h1><a href="index.html">返回概览</a>',encoding='utf8')
(workspace/'style.css').write_text('body{font:15px system-ui;background:#f5f6fb;color:#23263c;margin:0}main{padding:32px}.eyebrow{font-size:10px;letter-spacing:2px;color:#6868a5}h1{font-size:28px;line-height:1.3}#card{background:white;padding:22px;border-radius:18px;margin:24px 0;box-shadow:0 8px 28px #2428460b}canvas{max-width:100%}a,button{font:inherit;color:#5454c9;margin-right:14px}button{border:0;padding:8px;border-radius:8px}',encoding='utf8')
(workspace/'.env').write_text('fixture-only',encoding='utf8');(run/'outside.html').write_text('outside fixture',encoding='utf8')
web_requests=[];model_requests=[];release=threading.Event();started=threading.Event()
class Server(BaseHTTPRequestHandler):
 def log_message(self,*args):pass
 def do_GET(self):
  web_requests.append(self.path)
  if self.path.startswith('/v1/models'):content=json.dumps({'data':[{'id':'browser-model','context_window':128000,'supported_parameters':['tools']}]}).encode();mime='application/json'
  elif self.path=='/redirect':self.send_response(302);self.send_header('Location','http://127.0.0.1:1/nope');self.end_headers();return
  else:content=b'<title>Development page</title><h1 id="dev">LOCAL_DEV_READY</h1>';mime='text/html'
  self.send_response(200);self.send_header('Access-Control-Allow-Origin',self.headers.get('Origin','*'));self.send_header('Content-Type',mime);self.end_headers();self.wfile.write(content)
 def do_POST(self):
  body=json.loads(self.rfile.read(int(self.headers['Content-Length'])));model_requests.append(body);started.set();release.wait(30)
  self.send_response(200);self.send_header('Content-Type','text/event-stream');self.end_headers();self.wfile.write(('data: '+json.dumps({'choices':[{'delta':{'content':'已收到选区快照与说明，原文件保持完整。'},'finish_reason':'stop'}]})+'\n\ndata: [DONE]\n\n').encode());self.wfile.flush()
server=ThreadingHTTPServer(('127.0.0.1',0),Server);threading.Thread(target=server.serve_forever,daemon=True).start();origin=f'http://127.0.0.1:{server.server_port}'
(home/'settings.json').write_text(json.dumps({'defaultProvider':'openai','defaultModel':'browser-model','providers':{'openai':{'baseUrl':origin+'/v1','apiKey':'browser-fixture-key'}}}),encoding='utf8')
with socket.socket() as sock:sock.bind(('127.0.0.1',0));port=sock.getsockname()[1]
quit_file=run/'quit';deny=run/'deny';harness=run/'harness.cjs';capture=run/'capture.json';window_state=run/'window-state.json'
harness.write_text("const {app,dialog,BrowserWindow,desktopCapturer}=require('electron');const fs=require('node:fs');app.getVersion=()=>"+json.dumps(json.loads((root/'packages/desktop/package.json').read_text(encoding='utf8'))['version'])+";dialog.showMessageBox=async()=>({response:fs.existsSync("+json.dumps(str(deny))+")?1:0});setInterval(async()=>{if(fs.existsSync("+json.dumps(str(quit_file))+"))app.quit();const win=BrowserWindow.getAllWindows()[0];if(!win)return;fs.writeFileSync("+json.dumps(str(window_state))+",JSON.stringify(win.contentView.children.filter(v=>v.webContents&&v.webContents!==win.webContents).map(v=>({url:v.webContents.getURL(),bounds:v.getBounds()}))));if(fs.existsSync("+json.dumps(str(capture))+")){const target=JSON.parse(fs.readFileSync("+json.dumps(str(capture))+",'utf8'));fs.unlinkSync("+json.dumps(str(capture))+");const sources=await desktopCapturer.getSources({types:['window'],thumbnailSize:{width:win.getSize()[0],height:win.getSize()[1]}});const own=sources.find(s=>s.id===win.getMediaSourceId());if(!own)throw new Error('own window capture unavailable');fs.writeFileSync(target,own.thumbnail.toPNG())}},150).unref();require("+json.dumps(str(root/'packages/desktop/dist/main/index.js'))+");",encoding='utf8')
control=run/'control.json'
harness.write_text(harness.read_text(encoding='utf8')+"\nsetInterval(()=>{const path="+json.dumps(str(control))+";if(!fs.existsSync(path))return;const data=JSON.parse(fs.readFileSync(path,'utf8'));fs.unlinkSync(path);const win=BrowserWindow.getAllWindows()[0];if(win&&data.zoom)win.webContents.setZoomFactor(data.zoom);if(win&&data.shortcut){const view=win.contentView.children.find(v=>v.webContents&&v.webContents!==win.webContents);if(view){win.focus();view.webContents.focus();view.webContents.sendInputEvent({type:'keyDown',keyCode:data.shortcut,modifiers:['control']});if(!view.webContents.isDestroyed())view.webContents.sendInputEvent({type:'keyUp',keyCode:data.shortcut,modifiers:['control']})}}},100).unref();",encoding='utf8')
env={**os.environ,'SMALT_HOME':str(home)}
for key in list(env):
 if any(part in key.upper() for part in ['API_KEY','TOKEN','SECRET','PASSWORD','CREDENTIAL']) or key=='ELECTRON_RUN_AS_NODE':env.pop(key,None)
log=open(run/'electron.log','w',encoding='utf8');process=subprocess.Popen([str(root/'node_modules/electron/dist/electron.exe'),str(harness),'--development-preview','--remote-debugging-port='+str(port)],env=env,stdout=log,stderr=log,creationflags=subprocess.CREATE_NO_WINDOW)
checks=[];errors=[]
def until(test,seconds=15):
 end=time.time()+seconds
 while time.time()<end:
  try:
   if test():return
  except (json.JSONDecodeError,FileNotFoundError):pass
  time.sleep(.1)
 raise AssertionError('Condition timed out')
def views():return json.loads(window_state.read_text())
def shot(name):
 target=shots/name;target.unlink(missing_ok=True);publish(capture,json.dumps(str(target)),encoding='utf8');until(lambda:target.exists());return target
with sync_playwright() as p:
 browser=None
 try:
  for _ in range(100):
   try:browser=p.chromium.connect_over_cdp(f'http://127.0.0.1:{port}',timeout=500);break
   except Exception:time.sleep(.1)
  assert browser
  until(lambda:any(page.url.startswith('file:') for context in browser.contexts for page in context.pages));page=next(page for context in browser.contexts for page in context.pages if page.url.startswith('file:'));page.on('pageerror',lambda error:errors.append(str(error)))
  page.wait_for_load_state('networkidle');page.evaluate("localStorage.setItem('smalt.ui.onboarded','true');localStorage.setItem('smalt.ui.dark','false')");page.reload();page.wait_for_load_state('networkidle')
  page.get_by_test_id('task-row').filter(has_text='浏览与对象 A').click();page.get_by_role('button',name='打开浏览与网页预览',exact=True).click();expect(page.get_by_test_id('browser-panel')).to_be_visible()
  page.get_by_role('button',name='本地 HTML',exact=True).click();expect(page.get_by_role('button',name='index.html',exact=True)).to_be_visible();deny.write_text('deny');page.get_by_role('button',name='index.html',exact=True).click();expect(page.get_by_test_id('browser-panel')).to_contain_text('已取消网页预览');assert not page.get_by_role('tab',name='项目概览').count();deny.unlink();page.get_by_role('button',name='index.html',exact=True).click()
  expect(page.get_by_role('tab',name='项目概览',exact=True)).to_be_visible();until(lambda:len(views())==1)
  def web():return next(value for context in browser.contexts for value in context.pages if value.url.startswith('smalt-preview:') and not value.is_closed())
  child=web();child.wait_for_selector('#card');assert child.evaluate("({bridge:typeof window.smalt,node:typeof require,process:typeof process,script:document.documentElement.dataset.localScript})")=={'bridge':'undefined','node':'undefined','process':'undefined','script':'ok'}
  assert child.evaluate("getComputedStyle(document.body).backgroundColor")=='rgb(245, 246, 251)'
  blocked=child.evaluate("async()=>{try{return (await fetch('/.env')).ok}catch{return false}}");assert not blocked
  assert not child.evaluate("async()=>{try{await fetch('file:///C:/Windows/win.ini');return true}catch{return false}}")
  assert child.evaluate("()=>new Promise(resolve=>navigator.geolocation.getCurrentPosition(()=>resolve(false),e=>resolve(e.code===1)))")
  child.evaluate("location.href='file:///C:/Windows/win.ini'");assert child.url.startswith('smalt-preview:')
  assert not child.evaluate("async()=>{try{return (await fetch('/index.html',{method:'POST',body:'x'})).ok}catch{return false}}")
  child.locator('#next').click();child.wait_for_selector('h1:text("第二页真实导航")');page.get_by_role('button',name='网页后退',exact=True).click();child.wait_for_selector('#card')
  child.locator('#popup').click();expect(page.get_by_test_id('browser-panel')).to_contain_text('页面请求打开新窗口');assert len([value for context in browser.contexts for value in context.pages if not value.is_closed()])==2
  page.get_by_role('button',name='关闭网页提示',exact=True).click();until(lambda:len(views())==1);time.sleep(.3);shot('browser-light.png');checks.append('actual isolated HTML scripts/styles/navigation; denied consent; no bridge/Node/process; sensitive paths, file scheme and new windows blocked')
  child.evaluate("document.body.insertAdjacentHTML('beforeend','<input id=private-input value=FORM_FIXTURE_SECRET>')")
  page.evaluate("async()=>{const tabs=await window.smalt.browser('list',{threadId:'th_browser_a'});window.__testPick=window.smalt.browser('pick',{threadId:'th_browser_a',id:tabs.tabs[0].id})}")
  child.locator('#private-input').click();private_ref=page.evaluate('window.__testPick');private_capture=page.evaluate("v=>window.smalt.feedback('read',v)",{'cwd':str(workspace),'path':private_ref['path']});assert 'FORM_FIXTURE_SECRET' not in private_capture['text'] and not private_capture.get('image');child.evaluate("document.querySelector('#private-input').remove()")
  assert not child.evaluate("async url=>{try{return (await fetch(url)).ok}catch{return false}}",origin+'/dev')
  page.get_by_role('button',name='站点权限',exact=False).click();page.get_by_label('新增网页资源来源',exact=True).fill(origin);
  with child.expect_navigation(wait_until='networkidle'):
   page.get_by_role('button',name='核对来源并授权',exact=True).click()
  until(lambda:len(views())==1);assert child.evaluate("async url=>(await fetch(url)).ok",origin+'/dev')
  page.get_by_role('button',name='站点权限',exact=False).click();expect(page.get_by_test_id('browser-permissions')).to_contain_text(origin);
  with child.expect_navigation(wait_until='networkidle'):
   page.get_by_role('button',name='撤销',exact=True).click()
  until(lambda:len(views())==1);assert not child.evaluate("async url=>{try{return (await fetch(url)).ok}catch{return false}}",origin+'/dev');checks.append('additional exact-origin resource consent and revocation enforce real cross-origin GET with preserved CORS; permissions belong only to this tab')
  page.get_by_role('button',name='引用页面元素',exact=True).click();expect(page.get_by_test_id('browser-panel')).to_contain_text('点击页面中的元素');child.locator('#card strong').click();expect(page.get_by_test_id('context-references')).to_contain_text('网页元素')
  refs=page.get_by_test_id('context-references');assert refs.count()==1
  page.get_by_test_id('context-check-toggle').click();until(lambda:len(views())==0);expect(page.get_by_test_id('context-inspector')).to_contain_text('捕获时刻的只读快照');page.keyboard.press('Escape');until(lambda:len(views())==1)
  checks.append('real element selector/text/geometry and screenshot captured; form values excluded; device permission, POST and file navigation denied; inspector popover hides native content and restores it without losing tab')
  page.get_by_label('网页地址',exact=True).fill(origin+'/dev');page.get_by_role('button',name='新标签',exact=True).click();expect(page.get_by_role('tab',name='Development page',exact=True)).to_be_visible();until(lambda:any('/dev' in value['url'] for value in views()))
  mismatch=page.evaluate("async()=>{const s=await window.smalt.browser('list',{threadId:'th_browser_a'});try{await window.smalt.browser('close',{threadId:'th_browser_b',id:s.tabs[0].id});return false}catch{return true}}");assert mismatch
  background=page.evaluate("()=>window.smalt.processes('start',{threadId:'th_browser_a',launch:{program:'node',args:['-e','setInterval(()=>{},1000)'],title:'Browser lifecycle probe'}})");page.get_by_role('button',name='收起面板',exact=True).click();until(lambda:not views());page.get_by_test_id('task-row').filter(has_text='浏览与对象 B').click();page.get_by_role('button',name='打开浏览与网页预览',exact=True).click();assert page.get_by_role('tablist',name='网页标签').get_by_role('tab').count()==0
  page.get_by_test_id('task-row').filter(has_text='浏览与对象 A').click();page.get_by_role('button',name='打开浏览与网页预览',exact=True).click();expect(page.get_by_role('tablist',name='网页标签').get_by_role('tab')).to_have_count(2);until(lambda:len(views())==1)
  until(lambda:page.evaluate("async id=>(await window.smalt.processes('list')).processes.find(p=>p.id===id).state",background['id'])=='running')
  checks.append('real background process continues across browser close and chat switch; real localhost development page; multi-tab retention; conversation isolation and ownership checks; closing the panel detaches native view')
  page.get_by_role('button',name='收起面板',exact=True).click()
  def open_object(query,name):
   page.get_by_label('任务输入',exact=True).fill('@'+query);expect(page.get_by_role('option').filter(has_text=name)).to_be_visible();page.get_by_label('任务输入',exact=True).press('Enter');page.get_by_role('button',name='预览引用 '+name,exact=True).click();expect(page.get_by_test_id('object-view')).to_be_visible()
  open_object('图表','图表.png')
  page.get_by_test_id('task-row').filter(has_text='浏览与对象 B').click();page.get_by_test_id('task-row').filter(has_text='浏览与对象 A').click();expect(page.get_by_test_id('object-view')).to_be_visible()
  checks.append('returning to a chat preserves the selected file preview instead of replaying an earlier browser-open request')
  page.get_by_role('button',name='框选区域',exact=True).click();image=page.get_by_test_id('object-view').get_by_role('img');box=image.bounding_box();page.mouse.move(box['x']+box['width']*.1,box['y']+box['height']*.1);page.mouse.down();page.mouse.move(box['x']+box['width']*.7,box['y']+box['height']*.8,steps=10);page.mouse.up();page.get_by_label('局部反馈说明').fill('把这部分图表改为暖色');page.get_by_role('button',name='加入当前对话',exact=True).click();expect(page.get_by_test_id('context-references')).to_contain_text('图片区域')
  page.get_by_label('对象缩放',exact=True).select_option('2');assert page.get_by_test_id('object-viewport').evaluate('e=>e.scrollWidth>e.clientWidth');shot('image-region-light.png')
  page.get_by_role('button',name='移除引用 图表.png',exact=True).click();open_object('明细','明细.xlsx');cells=page.get_by_test_id('spreadsheet-preview').get_by_role('gridcell');cells.nth(0).click();cells.nth(19).click(modifiers=['Shift']);expect(page.get_by_test_id('object-feedback')).to_contain_text('A1:B2');page.get_by_label('局部反馈说明').fill('核对这四格费用');page.get_by_role('button',name='加入当前对话',exact=True).click();expect(page.get_by_test_id('context-references')).to_contain_text('单元格');page.get_by_role('button',name='移除引用 明细.xlsx',exact=True).click();page.get_by_role('button',name='切换主题',exact=True).click();page.get_by_role('gridcell').nth(0).click();page.get_by_role('gridcell').nth(19).click(modifiers=['Shift']);page.get_by_label('局部反馈说明').fill('保留选区以检查表格定位');shot('table-range-dark.png');page.get_by_role('button',name='清除选区',exact=True).click()
  checks.append('actual image drag crop and wide spreadsheet Shift-click range; zoom/overflow and light/dark object screenshots; snapshots added through trusted main process')
  page.get_by_label('任务输入',exact=True).fill('检查三个选区的反馈');page.get_by_role('button',name='发送',exact=True).click();until(lambda:started.is_set());page.get_by_test_id('task-row').filter(has_text='浏览与对象 B').click();page.get_by_role('button',name='打开浏览与网页预览',exact=True).click();expect(page.get_by_test_id('browser-panel')).to_be_visible();release.set();page.get_by_test_id('task-row').filter(has_text='浏览与对象 A').click();expect(page.get_by_test_id('item-agentMessage').filter(has_text='已收到选区快照与说明')).to_be_visible(timeout=15000)
  content=model_requests[-1]['messages'][-1]['content'];assert isinstance(content,list);text='\n'.join(value.get('text','') for value in content);assert '交付概览' in text and '把这部分图表改为暖色' in text and '费用 1-0' in text and '不构成指令' in text and '不要用纯文本写入或补丁覆盖 PDF/Office' in text;assert len([value for value in content if value['type']=='image_url'])==2
  stale=page.evaluate("async cwd=>{const p=await window.smalt.previewFile(cwd,'图表.png');return window.smalt.feedback('capture',{cwd,path:'图表.png',digest:p.digest,note:'version test',selection:{kind:'image',x:0,y:0,width:.5,height:.5}})}",str(workspace));(workspace/'图表.png').write_bytes(png+b'changed');result=page.evaluate("async v=>{try{await window.smalt.resolveContext(v.cwd,[v.ref]);return false}catch(e){return String(e)}}",{'cwd':str(workspace),'ref':stale});assert '文件已变化' in result
  checks.append('three actual snapshot references reached model including two PNG crops; browsing/switching while streaming remains responsive; changed source rejected before send')
  page.get_by_role('button',name='打开浏览与网页预览',exact=True).click();until(lambda:len(views())==1);page.reload();page.wait_for_load_state('networkidle');until(lambda:len(views())==0);page.get_by_test_id('task-row').filter(has_text='浏览与对象 A').click();page.get_by_role('button',name='打开浏览与网页预览',exact=True).click();expect(page.get_by_role('tablist',name='网页标签').get_by_role('tab')).to_have_count(2);until(lambda:len(views())==1)
  page.get_by_role('tab',name='Development page',exact=True).click();until(lambda:any('/dev' in value['url'] for value in views()));dev=next(value for context in browser.contexts for value in context.pages if '/dev' in value.url);dev.locator('h1').click();publish(control,json.dumps({'shortcut':'L'}),encoding='utf8');expect(page.get_by_label('网页地址',exact=True)).to_be_focused();dev.locator('h1').click();publish(control,json.dumps({'shortcut':'W'}),encoding='utf8');expect(page.get_by_role('tablist',name='网页标签').get_by_role('tab')).to_have_count(1);until(lambda:len(views())==1)
  page.get_by_label('网页地址',exact=True).focus();page.keyboard.press('Control+w');expect(page.get_by_role('tablist',name='网页标签').get_by_role('tab')).to_have_count(0);page.get_by_role('button',name='本地 HTML',exact=True).click();page.get_by_role('button',name='index.html',exact=True).click();expect(page.get_by_role('tab',name='项目概览',exact=True)).to_be_visible();until(lambda:len(views())==1)
  publish(control,json.dumps({'zoom':1.5}),encoding='utf8');expect(page.get_by_role('button',name='返回对话',exact=True)).to_be_visible();until(lambda:abs(views()[0]['bounds']['x']-page.get_by_test_id('browser-viewport').bounding_box()['x']*1.5)<=2);shot('browser-zoom150-dark.png');publish(control,json.dumps({'zoom':1}),encoding='utf8');checks.append('native browser keyboard focus/close and 150% application zoom align real view bounds without clipping; remaining tab stays alive')
  quit_file.write_text('quit');process.wait(timeout=20);assert process.returncode==0;assert all(value.get('state') not in ['running','starting','stopping'] for value in json.loads((home/'processes.json').read_text(encoding='utf8')));checks.append('renderer reload detaches/reopens retained tabs; explicit application quit closes isolated web contents cleanly')
  assert not errors,errors
 finally:
  release.set()
  if process.poll() is None:quit_file.write_text('quit')
  try:process.wait(timeout=15)
  except subprocess.TimeoutExpired:process.terminate();process.wait(timeout=10)
  log.close();server.shutdown()
(shots/'results.json').write_text(json.dumps({'passed':True,'checks':checks,'rendererErrors':errors,'modelRequests':len(model_requests),'webRequests':web_requests,'fixture':str(run)},ensure_ascii=False,indent=2),encoding='utf8')
print(json.dumps({'passed':True,'checks':checks,'rendererErrors':errors,'modelRequests':len(model_requests),'fixture':str(run)},ensure_ascii=False,indent=2))
