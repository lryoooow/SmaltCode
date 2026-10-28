"""Real phase14 Office UI, preview isolation, candidate/recovery and chat continuity."""
from _desktop_review_harness import *
import hashlib
from fixtures.office import create
shots=root/'docs/screenshots/phase-fourteen';shots.mkdir(parents=True,exist_ok=True)
import _desktop_review_harness as harness
harness.shots=shots
def closed(page):
 if not page.is_closed():page.wait_for_event('close',timeout=30000)
engine=json.loads((root/'.qa-work/office-runtime/runtime.json').read_text(encoding='utf8'))['runtime']
with sync_playwright()as p:
 app=Desktop('OFFICE');create(app.workspace);engine_config=app.home/'office-sessions/engine.json';engine_config.parent.mkdir();engine_config.write_text(json.dumps({'path':engine}),encoding='utf8')
 checkpoint_fault=app.dir/'fail-checkpoint';app.harness.write_text('require('+json.dumps(str(root/'scripts/fixtures/office-checkpoint-fault.cjs'))+')('+json.dumps(str(checkpoint_fault))+');\n'+app.harness.read_text(encoding='utf8'),encoding='utf8')
 originals={f.name:hashlib.sha256(f.read_bytes()).hexdigest()for f in app.workspace.glob('sample.*')}
 try:
  app.launch(p);app.page.get_by_test_id('task-row').filter(has_text='远程项目对话').click();composer=app.page.get_by_label('任务输入',exact=True);composer.fill('HOLD_REMOTE Office 连续运行测试');app.nav('发送');until(lambda:len(requests)>0)
  for format in ([]if'--native-only'in sys.argv else['docx','xlsx','pptx']):
   page=review(app,'sample.'+format);assert page.evaluate('typeof window.smalt')=='undefined';assert page.evaluate('typeof window.require')=='undefined';page.get_by_test_id('office-editor').locator('summary').click();page.get_by_label('Office 编辑引擎').select_option('libreoffice');button(page,'验证本机引擎保存链')
   app.page.get_by_test_id('task-row').filter(has_text='独立浏览对话').click();other=app.page.get_by_label('任务输入',exact=True);other.fill('浏览期间保留的独立草稿');app.page.get_by_test_id('task-row').filter(has_text='远程项目对话').click();app.page.get_by_test_id('task-row').filter(has_text='独立浏览对话').click();expect(other).to_have_value('浏览期间保留的独立草稿')
   expect(page.get_by_test_id('office-validation')).to_contain_text('重开已通过',timeout=100000);assert hashlib.sha256((app.workspace/('sample.'+format)).read_bytes()).hexdigest()==originals['sample.'+format];app.shot(format+'-engine-verified.png',page);button(page,'关闭审阅窗');closed(page);checks.append(format+' actual native save/reopen validation from restricted UI; original unchanged; independent chat draft survives navigation')
  page=review(app,'sample.docx');page.get_by_test_id('office-editor').locator('summary').click();button(page,'在本机 Office 编辑副本');until(lambda:state(page)['editing'].get('office',{}).get('status')=='editing',80);page.get_by_test_id('office-editor').locator('summary').click();button(page,'收取已落盘候选');until(lambda:bool((state(page).get('draft')or{}).get('binaryVersion')),60);assert hashlib.sha256((app.workspace/'sample.docx').read_bytes()).hexdigest()==originals['sample.docx']
  # Native Office holds the working file lock on Windows. Inject one negative
  # checkpoint receipt instead; the real worker/document stay alive for retry.
  page.get_by_test_id('office-editor').locator('summary').click();assert not page.get_by_test_id('office-editor').evaluate('e=>e.open')
  checkpoint_fault.write_text('one negative checkpoint reply',encoding='utf8')
  until(lambda:'自动收取' in state(page)['editing']['office'].get('reason',''),35)
  assert not checkpoint_fault.exists();assert state(page)['editing']['office']['status']=='editing';expect(page.get_by_test_id('office-session-alert')).to_be_visible();expect(page.get_by_test_id('office-session-alert')).to_contain_text('自动收取暂未完成');expect(page.get_by_role('button',name='重试收取候选',exact=True)).to_be_visible();expect(page.get_by_role('button',name='收取已落盘候选',exact=True,include_hidden=True)).to_be_enabled();expect(page.get_by_role('button',name='结束 Office 编辑',exact=True,include_hidden=True)).to_be_enabled();assert not page.get_by_role('button',name='恢复已落盘工作副本',exact=True,include_hidden=True).count()
  app.shot('automatic-capture-retry-light.png',page)
  for theme in ['light','dark']:
   if theme=='dark':button(page,'切换主题')
   for factor in [1,1.25,1.5,2]:
    app.ack.unlink(missing_ok=True);ready=app.zoom.with_name('zoom-ready');ready.write_text(str(factor));ready.replace(app.zoom);until(lambda:app.ack.exists());expect(page.get_by_role('button',name='重试收取候选',exact=True)).to_be_in_viewport();expect(page.get_by_role('button',name='重试收取候选',exact=True)).to_be_enabled();app.shot('automatic-capture-'+theme+'-zoom-'+str(factor)+'.png',page)
  app.ack.unlink(missing_ok=True);ready=app.zoom.with_name('zoom-ready');ready.write_text('1');ready.replace(app.zoom);until(lambda:app.ack.exists());button(page,'切换主题')

  button(page,'重试收取候选');until(lambda:not state(page)['editing']['office'].get('reason'),30);expect(page.get_by_test_id('office-session-alert')).to_have_count(0);page.get_by_test_id('office-editor').locator('summary').click();assert hashlib.sha256((app.workspace/'sample.docx').read_bytes()).hexdigest()==originals['sample.docx'];checks.append('actual native editor stays usable after automatic capture failure; manual capture/close remain enabled, retry clears error and original stays unchanged')
  if not page.get_by_role('button',name='文件版本',exact=True).is_visible():button(page,'批注与版本')
  button(page,'文件版本');page.get_by_role('button',name='与当前候选对比',exact=True).last.click();expect(page.get_by_test_id('artifact-comparison')).to_be_visible();checks.append('real native working copy opens; capture creates a candidate without original writes; actual byte-version comparison is available')
  button(page,'结束 Office 编辑');until(lambda:not state(page)['editing'].get('office'),60);app.shot('candidate-comparison-light.png',page);button(page,'切换主题');app.shot('candidate-comparison-dark.png',page)
  button(page,'关闭审阅窗');closed(page);page=review(app,'sample.docx');assert state(page)['draft']['binaryVersion'];page.get_by_test_id('office-editor').locator('summary').click();button(page,'清理已结束工作副本');until(lambda:len(list((app.home/'office-sessions').glob('*/session.json')))==(0 if'--native-only'in sys.argv else 2),30);assert state(page)['draft']['binaryVersion'];checks.append('closing and reopening recovers the immutable candidate; controlled cleanup preserves candidate and other document records')
  # A damaged unrelated record cannot break current document rendering.
  damaged=app.home/'office-sessions/11111111-1111-4111-8111-111111111111';damaged.mkdir();(damaged/'session.json').write_text('{broken',encoding='utf8');assert state(page)['name']=='sample.docx';assert(damaged/'session.json').read_text()=='{broken';checks.append('damaged unrelated Office record remains preserved and does not block this document')
  button(page,'关闭审阅窗');closed(page);release.set();assert not errors
 except Exception:
  for context in app.browser.contexts:
   for page in context.pages:
    try:app.shot('failure-'+str(context.pages.index(page))+'.png',page);print(page.url,page.locator('body').inner_text()[-6000:])
    except Exception:pass
  raise
 finally:
  release.set()
  try:app.close()
  except Exception:
   if app.process and app.process.poll()is None:app.process.terminate();app.process.wait(timeout=10)
  app.log.close();server.shutdown()
 result={'phase':14,'passed':True,'checks':checks,'rendererErrors':errors,'modelRequests':len(requests),'fixture':str(run),'screenshots':str(shots),'externalModels':False,'nativeOnly':'--native-only'in sys.argv};(run/'office-result.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf8');print(json.dumps(result,ensure_ascii=False,indent=2))
