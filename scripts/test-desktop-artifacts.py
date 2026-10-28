"""Phase nine: actual restricted review windows, original Office parts, conflicts and task continuity."""
from _desktop_control import publish
import json,os,socket,subprocess,sys,threading,time
from datetime import datetime,timezone
from pathlib import Path
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
root=Path(__file__).resolve().parents[1];sys.path.insert(0,str(root/'.qa-python'))
from playwright.sync_api import sync_playwright,expect
expect.set_options(timeout=30000)
run=root/'.qa-work'/('artifact-ui-'+str(time.time_ns()));run.mkdir(parents=True)
shots=root/'docs/screenshots/phase-nine';shots.mkdir(parents=True,exist_ok=True)
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
 end=time.time()+seconds;last=None
 while time.time()<end:
  try:
   if fn():return
  except PermissionError as error:last=error
  time.sleep(.1)
 raise AssertionError('condition timed out')from last
class Desktop:
 def __init__(self,label):
  self.dir=run/label;self.home=self.dir/'home';self.workspace=self.dir/'project';(self.home/'threads').mkdir(parents=True);self.workspace.mkdir();(self.workspace/'notes.md').write_text(label+'_FILE\n',encoding='utf8');self.label=label;self.process=None;self.browser=None;self.page=None
  with socket.socket()as sock:sock.bind(('127.0.0.1',0));self.port=sock.getsockname()[1]
  self.quit=self.dir/'quit';self.capture=self.dir/'capture';self.zoom=self.dir/'zoom';self.ack=self.dir/'ack';self.deny=self.dir/'deny';self.export=self.dir/'export-target';self.active=self.dir/'active-window'
  at=datetime.now(timezone.utc).isoformat()
  for ident,title in [('th_remote_shared','远程项目对话'),('th_remote_other','独立浏览对话')]:
   meta={'id':ident,'title':title,'cwd':str(self.workspace),'model':'remote-model','provider':'openai','permissionMode':'default','createdAt':at,'updatedAt':at,'turnCount':1,'lastOutcome':'completed'}
   events=[{'t':'meta','meta':meta},{'t':'turn-started','turnId':'seed','at':at}]
   for i in range(120 if ident=='th_remote_shared'else 1):events.extend([{'t':'user-msg','id':'u-'+str(i),'text':'历史问题 '+str(i),'at':at},{'t':'agent-msg','id':'a-'+str(i),'text':'可安全查看的项目回复 '+str(i),'at':at}])
   events.append({'t':'turn-ended','turnId':'seed','at':at});(self.home/'threads'/(ident+'.jsonl')).write_text('\n'.join(json.dumps(v,ensure_ascii=False)for v in events)+'\n',encoding='utf8')
  (self.home/'workspace-access.json').write_text(json.dumps([str(self.workspace.resolve()).lower()]),encoding='utf8')
  (self.home/'settings.json').write_text(json.dumps({'defaultProvider':'openai','defaultModel':'remote-model','providers':{'openai':{'baseUrl':f'http://127.0.0.1:{server.server_port}/v1','apiKey':'HOST_MODEL_KEY_NEVER_EXPOSE'}}}),encoding='utf8')
  paths={k:str(getattr(self,k))for k in ['quit','capture','zoom','ack','deny','export','active']};self.harness=self.dir/'harness.cjs';self.harness.write_text("const {app,dialog,BrowserWindow}=require('electron'),fs=require('node:fs');app.getVersion=()=>"+json.dumps(json.loads((root/'packages/desktop/package.json').read_text(encoding='utf8'))['version'])+";const paths="+json.dumps(paths)+";dialog.showMessageBox=async()=>({response:fs.existsSync(paths.deny)?1:0});dialog.showSaveDialog=async()=>fs.existsSync(paths.export)?({canceled:false,filePath:fs.readFileSync(paths.export,'utf8')}):({canceled:true});setInterval(()=>{if(fs.existsSync(paths.quit))app.quit();const windows=BrowserWindow.getAllWindows(),selected=fs.existsSync(paths.active)?fs.readFileSync(paths.active,'utf8'):'';const w=windows.find(w=>w.webContents.getTitle()===selected)||windows[0];if(w&&fs.existsSync(paths.capture)){const file=fs.readFileSync(paths.capture,'utf8');fs.unlinkSync(paths.capture);w.webContents.capturePage().then(image=>fs.writeFileSync(file,image.toPNG()))}if(w&&fs.existsSync(paths.zoom)){const value=Number(fs.readFileSync(paths.zoom,'utf8'));if(Number.isFinite(value)&&value>0){w.webContents.setZoomFactor(value);fs.unlinkSync(paths.zoom);fs.writeFileSync(paths.ack,'done')}}},100).unref();require("+json.dumps(str(root/'packages/desktop/dist/main/index.js'))+");",encoding='utf8')
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
 def api(self,action,value=None):return self.page.evaluate('v=>window.smalt.remote(v.action,v.value)',{'action':action,'value':value or{}})
 def state(self):return self.api('list')
 def nav(self,label):self.page.get_by_role('button',name=label,exact=True).click()
 def shot(self,name,page=None):
  publish(self.active,page.title()if page else self.page.title(),encoding='utf8')
  target=shots/name;target.unlink(missing_ok=True);publish(self.capture,str(target),encoding='utf8');until(lambda:target.exists())
 def close(self):
  if self.process and self.process.poll()is None:self.quit.write_text('quit');self.process.wait(timeout=20);assert self.process.returncode==0

def make_office(app):
 import zipfile
 def zipdoc(name,parts):
  with zipfile.ZipFile(app.workspace/name,'w',zipfile.ZIP_DEFLATED)as archive:
   for path,value in parts.items():archive.writestr(path,value)
 zipdoc('项目说明.docx',{'[Content_Types].xml':'<Types/>','word/document.xml':'<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:rPr><w:b/></w:rPr><w:t>项目说明</w:t></w:r></w:p><w:p><w:r><w:t>原始项目结论，等待核对。</w:t></w:r></w:p></w:body></w:document>','word/header1.xml':'<w:hdr xmlns:w="urn:w">HEADER_UNCHANGED</w:hdr>','word/styles.xml':'<styles>STYLE_UNCHANGED</styles>'})
 zipdoc('项目数据.xlsx',{'[Content_Types].xml':'<Types/>','xl/workbook.xml':'<workbook xmlns:r="urn:r"><sheets><sheet name="成本" r:id="r1"/></sheets></workbook>','xl/_rels/workbook.xml.rels':'<Relationships><Relationship Id="r1" Target="worksheets/sheet1.xml"/></Relationships>','xl/worksheets/sheet1.xml':'<worksheet><sheetData><row r="1"><c r="A1" s="1"><v>12</v></c><c r="B1"><f>A1*2</f><v>24</v></c><c r="C1" t="inlineStr"><is><t>备注</t></is></c></row></sheetData></worksheet>','xl/styles.xml':'<styleSheet><cellXfs><xf numFmtId="0"/><xf numFmtId="0"/></cellXfs></styleSheet>'})
 # Create standards-complete Office fixtures with independent libraries too.
 from docx import Document
 from docx.shared import Pt
 doc=Document();doc.add_heading('项目说明',level=1);doc.add_paragraph('原始项目结论，等待核对。');doc.sections[0].header.paragraphs[0].text='HEADER_UNCHANGED';doc.save(str(app.workspace/'项目说明.docx'))
 from openpyxl import Workbook
 from openpyxl.styles import Font
 wb=Workbook();ws=wb.active;ws.title='成本';ws['A1']=12;ws['A1'].font=Font(bold=True);ws['B1']='=A1*2';ws['C1']='备注';other=wb.create_sheet('进度');other['A1']='保留另一张表';wb.save(str(app.workspace/'项目数据.xlsx'))
 from reportlab.pdfgen import canvas
 output=canvas.Canvas(str(app.workspace/'审阅说明.pdf'),pagesize=(400,500))
 for i in range(2):output.drawString(30,450,'Review document page '+str(i+1));output.showPage()
 output.save()
def review(app,name):
 app.page.evaluate('(name)=>window.smalt.artifacts("open",{threadId:"th_remote_shared",path:name,dark:false})',name)
 until(lambda:any(v.url.endswith('/artifact.html')and not v.is_closed()and v.title()==name+' · SmaltCode 审阅'for c in app.browser.contexts for v in c.pages))
 result=next(v for c in app.browser.contexts for v in c.pages if v.url.endswith('/artifact.html')and not v.is_closed()and v.title()==name+' · SmaltCode 审阅');result.on('pageerror',lambda e:errors.append(str(e)));result.set_default_timeout(30000);return result
def state(page):return page.evaluate('()=>window.smaltArtifact.invoke("view")')
def button(page,label):page.get_by_role('button',name=label,exact=True).click()
with sync_playwright()as p:
 app=Desktop('REVIEW');make_office(app);office_original={name:(app.workspace/name).read_bytes()for name in ['项目说明.docx','项目数据.xlsx']}
 # Seed actual kernel artifact events so the normal preview toolbar can open the editor.
 file=app.home/'threads/th_remote_shared.jsonl';events=[json.loads(line)for line in file.read_text(encoding='utf8').splitlines()];at=events[-1]['at'];events[-1:-1]=[{'t':'tool-call','id':'seed-file','tool':'write','input':{'path':'notes.md','content':'REVIEW_FILE\n'},'at':at},{'t':'tool-result','id':'seed-file','tool':'write','output':'Updated notes.md','isError':False,'at':at}];file.write_text('\n'.join(json.dumps(e,ensure_ascii=False)for e in events)+'\n',encoding='utf8')
 try:
  app.launch(p);app.page.get_by_test_id('task-row').filter(has_text='远程项目对话').click();app.page.get_by_role('button',name='notes.md',exact=False).last.click();button(app.page,'独立编辑与批注');text=review(app,'notes.md');assert text.evaluate('typeof window.smalt')=='undefined';assert text.evaluate('typeof window.require')=='undefined';assert len([v for c in app.browser.contexts for v in c.pages if v.url.endswith('/artifact.html')])==1;checks.append('normal artifact toolbar opens an independent restricted window; opening it again reuses the same document window without creating a second editor or an execution bridge')
  text.get_by_label('成果文本编辑',exact=True).fill('# 项目总结\n\n草稿保留，原文件尚未修改。');expect(text.get_by_role('status')).to_contain_text('草稿已保存');assert(app.workspace/'notes.md').read_text(encoding='utf8')=='REVIEW_FILE\n';text.get_by_label('新增成果批注',exact=True).fill('补充验证结果与来源。');button(text,'添加批注');expect(text.get_by_text('补充验证结果与来源。',exact=True)).to_be_visible();app.shot('text-editor-comment-light.png',text);app.deny.write_text('deny');button(text,'保存文件');expect(text.get_by_role('alert')).to_contain_text('取消');assert(app.workspace/'notes.md').read_text(encoding='utf8')=='REVIEW_FILE\n';app.deny.unlink();app.page.get_by_test_id('task-row').filter(has_text='独立浏览对话').click();button(text,'保存文件');until(lambda:(app.workspace/'notes.md').read_text(encoding='utf8').startswith('# 项目总结'));app.page.get_by_test_id('task-row').filter(has_text='远程项目对话').click();expect(app.page.get_by_test_id('file-preview')).to_be_visible();expect(app.page.get_by_role('status').filter(has_text='文件有新的变更')).to_be_visible();checks.append('real editor persists a draft without touching the original; source-bound comment is saved separately; native denial blocks writes and explicit confirmation saves a version')
  text.get_by_label('成果文本编辑',exact=True).fill('# 未写回草稿\n导出副本保留当前编辑。');expect(text.get_by_role('status')).to_contain_text('草稿已保存');(app.workspace/'notes.md').write_text('外部软件的新内容\n',encoding='utf8');expect(text.get_by_role('alert')).to_contain_text('文件已在外部修改');expect(text.get_by_role('button',name='保存文件',exact=True)).to_be_disabled();app.export.write_text(str(run/'草稿副本.md'),encoding='utf8');button(text,'导出副本');until(lambda:(run/'草稿副本.md').exists());assert'未写回草稿'in(run/'草稿副本.md').read_text(encoding='utf8');assert'外部软件'in(app.workspace/'notes.md').read_text(encoding='utf8');app.shot('external-conflict-light.png',text);button(text,'重新载入');expect(text.get_by_label('成果文本编辑',exact=True)).to_have_value('外部软件的新内容\n');button(text,'文件版本');text.get_by_role('button',name='载入为草稿',exact=True).last.click();expect(text.get_by_label('成果文本编辑',exact=True)).to_have_value('REVIEW_FILE\n');assert'外部软件'in(app.workspace/'notes.md').read_text(encoding='utf8');checks.append('real external edit remains untouched; save is disabled; draft exports under the correct format; historical bytes load only into a draft after explicit selection')
  # Closing and app quit flush even text typed immediately before close.
  text.get_by_label('成果文本编辑',exact=True).fill('关闭前立即输入的草稿');
  with text.expect_event('close'):text.get_by_label('关闭审阅窗',exact=True).click()
  text=review(app,'notes.md');expect(text.get_by_label('成果文本编辑',exact=True)).to_have_value('关闭前立即输入的草稿');checks.append('native review close flushes an un-debounced last keystroke; reopening restores the exact draft and leaves the source file unchanged')
  word=review(app,'项目说明.docx');word.get_by_label('编辑 p:1',exact=True).fill('已核对项目结论，并保留原始样式和页眉。');expect(word.get_by_role('status')).to_contain_text('草稿已保存');button(word,'保存文件');until(lambda:bool(state(word)['editing'].get('receipt'))and not state(word).get('draft'));import zipfile
  with zipfile.ZipFile(app.workspace/'项目说明.docx')as archive:
   assert'已核对项目结论'in archive.read('word/document.xml').decode();assert b'HEADER_UNCHANGED'in archive.read('word/header1.xml');assert archive.read('word/styles.xml')==zipfile.ZipFile(__import__('io').BytesIO(office_original['项目说明.docx'])).read('word/styles.xml')
  from docx import Document
  independent_doc=Document(str(app.workspace/'项目说明.docx'));assert independent_doc.paragraphs[1].text=='已核对项目结论，并保留原始样式和页眉。';assert independent_doc.sections[0].header.paragraphs[0].text=='HEADER_UNCHANGED'
  app.shot('word-paragraph-editor-light.png',word);sheet=review(app,'项目数据.xlsx');expect(sheet.get_by_label('编辑 0!B1',exact=True)).to_have_attribute('readonly','');sheet.get_by_label('编辑 0!A1',exact=True).fill('30');expect(sheet.get_by_role('status')).to_contain_text('草稿已保存');button(sheet,'保存文件');until(lambda:bool(state(sheet)['editing'].get('receipt'))and not state(sheet).get('draft'))
  with zipfile.ZipFile(app.workspace/'项目数据.xlsx')as archive:
   xml=archive.read('xl/worksheets/sheet1.xml').decode();assert'<v>30</v>'in xml and'<f>A1*2</f>'in xml and'<v>24</v>'not in xml;assert'fullCalcOnLoad="1"'in archive.read('xl/workbook.xml').decode()
  from openpyxl import load_workbook
  independent_book=load_workbook(str(app.workspace/'项目数据.xlsx'),data_only=False);assert independent_book['成本']['A1'].value==30;assert independent_book['成本']['B1'].value=='=A1*2';assert independent_book['成本']['A1'].font.bold;assert load_workbook(str(app.workspace/'项目数据.xlsx'),data_only=True)['成本']['B1'].value is None
  sheet.get_by_label('编辑工作表',exact=True).select_option('进度');expect(sheet.get_by_label('编辑 1!A1',exact=True)).to_have_value('保留另一张表');sheet.get_by_label('编辑工作表',exact=True).select_option('成本');app.shot('spreadsheet-editor-light.png',sheet);checks.append('actual worker-backed DOCX paragraph edit preserves header/styles; XLSX ordinary cell edit preserves formulas and clears cached values instead of reporting them recalculated')
  pdf=review(app,'审阅说明.pdf');expect(pdf.locator('canvas')).to_be_visible();pdf.get_by_label('批注位置',exact=True).select_option('pdf-page');pdf.get_by_label('PDF 批注页码',exact=True).fill('2');pdf.get_by_label('新增成果批注',exact=True).fill('第二页需要复核');button(pdf,'添加批注');expect(pdf.get_by_text('PDF 第 2 页',exact=True)).to_be_visible();app.export.write_text(str(run/'批注.md'),encoding='utf8');button(pdf,'导出批注');until(lambda:(run/'批注.md').exists());assert'第二页需要复核'in(run/'批注.md').read_text(encoding='utf8');app.shot('pdf-page-comment-light.png',pdf);checks.append('actual PDF page canvas and page-bounded independent annotation render; Markdown review export has original digest and does not alter PDF page contents')
  # A held host turn remains usable in the original chat and survives all review windows closing.
  app.page.get_by_label('任务输入',exact=True).fill('HOLD_REMOTE 本轮检查持续运行');app.nav('发送');until(lambda:held==1);app.page.get_by_test_id('task-row').filter(has_text='独立浏览对话').click();app.page.get_by_label('任务输入',exact=True).fill('后台执行中继续编辑另一对话草稿');button(text,'切换主题');app.shot('review-running-dark.png',text)
  for theme in ['light','dark']:
   for name,label in [('项目说明.docx','word'),('项目数据.xlsx','sheet')]:
    editor=review(app,name)
    if theme=='dark':button(editor,'切换主题')
    for factor in [1,1.25,1.5,2]:
     publish(app.active,editor.title(),encoding='utf8');app.ack.unlink(missing_ok=True);publish(app.zoom,str(factor));until(lambda:app.ack.exists());assert editor.evaluate('document.body.scrollWidth<=innerWidth+1');expect(editor.get_by_role('button',name='保存文件',exact=True)).to_be_visible();app.shot(label+'-'+theme+'-zoom-'+str(factor)+'.png',editor)
    publish(app.zoom,'1');editor.wait_for_timeout(250)
  with editor.expect_event('close'):editor.get_by_label('关闭审阅窗',exact=True).click()
  assert app.process.poll()is None;expect(app.page.get_by_label('任务输入',exact=True)).to_have_value('后台执行中继续编辑另一对话草稿');release.set();until(lambda:any(json.loads(line).get('t')=='agent-msg'and'已完成远程检查'in str(json.loads(line).get('text',''))for line in(app.home/'threads/th_remote_shared.jsonl').read_text(encoding='utf8').splitlines()));checks.append('closing all independent review windows neither interrupts the held model request nor steals another conversation draft; native zoom 100/125/150/200 percent retains reachable editor controls')
  text=review(app,'notes.md');text.get_by_label('成果文本编辑',exact=True).fill('应用退出前最后的输入');app.close();app.launch(p);text=review(app,'notes.md');expect(text.get_by_label('成果文本编辑',exact=True)).to_have_value('应用退出前最后的输入');app.close();assert not errors,errors;checks.append('normal application quit flushes every remaining review before exit; restart restores final input and never replays a source task; no renderer errors')
 except Exception:
  if app.browser:
   for context in app.browser.contexts:
    for page in context.pages:
     try:app.shot('failure-'+str(context.pages.index(page))+'.png',page);print(page.url,page.locator('body').inner_text()[-5000:])
     except Exception:pass
  raise
 finally:
  release.set()
  try:app.close()
  except Exception:
   if app.process and app.process.poll()is None:app.process.terminate();app.process.wait(timeout=10)
  app.log.close();server.shutdown()
 result={'phase':9,'passed':True,'checks':checks,'rendererErrors':errors,'modelRequests':len(requests),'fixture':str(run),'screenshots':str(shots),'externalModels':False,'independentParsers':{'python-docx':True,'openpyxl':True}};(run/'result.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf8');print(json.dumps(result,ensure_ascii=False,indent=2))
