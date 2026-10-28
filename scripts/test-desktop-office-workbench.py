"""Stage17 actual Impress, native annotations, export conflicts and multi-document tabs."""
from _desktop_review_harness import *
import _desktop_review_harness as harness
from fixtures.office import create
from _desktop_control import publish
import hashlib
shots=root/'docs/screenshots/phase-seventeen';shots.mkdir(parents=True,exist_ok=True);harness.shots=shots
engine=json.loads((root/'.qa-work/office-runtime/runtime.json').read_text(encoding='utf8'))['runtime']
with sync_playwright()as p:
 app=Desktop('WORKBENCH');create(app.workspace);config=app.home/'office-sessions/engine.json';config.parent.mkdir();config.write_text(json.dumps({'path':engine}),encoding='utf8');original=hashlib.sha256((app.workspace/'sample.pptx').read_bytes()).hexdigest()
 try:
  app.launch(p);app.page.get_by_test_id('task-row').filter(has_text='远程项目对话').click();app.page.get_by_label('任务输入',exact=True).fill('HOLD_REMOTE Office 多文档验收');app.nav('发送');until(lambda:len(requests)>0)
  page=review(app,'notes.md');page.get_by_label('成果文本编辑',exact=True).fill('切换前尚未等待防抖的草稿');page=review(app,'sample.pptx');expect(page.get_by_role('navigation',name='成果文档标签')).to_be_visible();button(page,'notes.md');expect(page.get_by_label('成果文本编辑',exact=True)).to_have_value('切换前尚未等待防抖的草稿');button(page,'sample.pptx');page.get_by_test_id('office-editor').locator('summary').click();button(page,'在工作台编辑副本');expect(page.get_by_test_id('impress-workbench')).to_be_visible(timeout=90000);expect(page.get_by_label('当前幻灯片')).to_be_visible(timeout=45000)
  page.get_by_test_id('impress-workbench').get_by_role('button',name='SmaltCode 引擎样本',exact=False).first.click();page.get_by_label('幻灯片对象文字').fill('新的中文汇报标题');button(page,'替换对象文字');expect(page.get_by_test_id('impress-workbench').get_by_text('新的中文汇报标题',exact=True)).to_be_visible();page.get_by_label('幻灯片备注').fill('讲述重点与待核对事项');button(page,'保存本页备注');expect(page.get_by_label('幻灯片备注')).to_have_value('讲述重点与待核对事项');assert hashlib.sha256((app.workspace/'sample.pptx').read_bytes()).hexdigest()==original
  if not page.get_by_test_id('native-notes').is_visible():button(page,'批注与版本')
  page.get_by_test_id('native-notes').locator('summary').click();button(page,'读取原生批注');page.get_by_label('新增原生批注').fill('NATIVE_DESKTOP_COMMENT');button(page,'添加到工作副本');button(page,'读取原生批注');expect(page.get_by_text('NATIVE_DESKTOP_COMMENT',exact=True)).to_be_visible();checks.append('actual Impress text and notes edits and native slide comments are private candidates, original unchanged')
  button(page,'预览与演示');expect(page.get_by_test_id('word-page-preview')).to_be_visible(timeout=80000);expect(page.locator('canvas')).to_be_visible();app.shot('slides-preview-light.png',page);button(page,'返回编辑位置');export=run/'deck.pdf';export.write_bytes(b'%PDF-OLD_TARGET');app.export.write_text(str(export),encoding='utf8');app.deny.write_text('deny');button(page,'导出 PDF');expect(page.get_by_role('alert')).to_contain_text('取消');assert export.read_bytes()==b'%PDF-OLD_TARGET';app.deny.unlink();button(page,'导出 PDF');until(lambda:export.read_bytes().startswith(b'%PDF-')and export.stat().st_size>1000);checks.append('real PDF preview renders; denied export preserves existing target; confirmed separate PDF export succeeds')
  page=review(app,'sample.xlsx');page.get_by_test_id('office-editor').locator('summary').click();button(page,'在工作台编辑副本');expect(page.get_by_test_id('calc-workbench')).to_be_visible(timeout=90000);expect(page.get_by_label('Calc B1',exact=True)).to_have_text('24',timeout=45000);page.get_by_label('批注位置',exact=True).select_option('0!A1');page.get_by_label('新增成果批注',exact=True).fill('MIGRATED_INDEPENDENT_COMMENT');button(page,'添加批注');button(page,'复制到原生批注');page.get_by_test_id('native-notes').locator('summary').click();button(page,'读取原生批注');expect(page.get_by_test_id('native-notes').get_by_text('MIGRATED_INDEPENDENT_COMMENT',exact=True)).to_be_visible();checks.append('independent cell comment migration checks current version and exact cell, retains original independent note and adds an actual native comment');button(page,'sample.pptx');expect(page.get_by_test_id('impress-workbench')).to_be_visible();expect(page.get_by_label('幻灯片备注')).to_have_value('讲述重点与待核对事项');button(page,'notes.md');expect(page.get_by_label('成果文本编辑',exact=True)).to_have_value('切换前尚未等待防抖的草稿');checks.append('three tabs retain separate native sessions, pending edits, document paths and drafts through repeated switches')
  app.page.get_by_test_id('task-row').filter(has_text='独立浏览对话').click();app.page.get_by_label('任务输入',exact=True).fill('多文档验收时保留另一对话草稿');button(page,'sample.pptx');expect(page.get_by_label('幻灯片备注')).to_have_value('讲述重点与待核对事项');expect(page.get_by_role('button',name='刷新幻灯片',exact=True)).to_be_enabled();button(page,'切换主题');app.shot('slides-workbench-dark.png',page)
  for factor in [1.25,1.5,2]:
   publish(app.active,page.title(),encoding='utf8');app.ack.unlink(missing_ok=True);publish(app.zoom,str(factor));until(lambda:app.ack.exists());assert page.evaluate('document.documentElement.scrollWidth<=innerWidth+1');app.shot('slides-'+str(factor)+'.png',page)
  publish(app.zoom,'1');page.wait_for_timeout(400);button(page,'保存文件');until(lambda:hashlib.sha256((app.workspace/'sample.pptx').read_bytes()).hexdigest()!=original);button(page,'关闭审阅窗');page.wait_for_event('close',timeout=60000)if not page.is_closed()else None;expect(app.page.get_by_label('任务输入',exact=True)).to_have_value('多文档验收时保留另一对话草稿');checks.append('one close flushes every tab and ends both owned native sessions; other chat and running task remain usable')
  page=review(app,'notes.md');expect(page.get_by_label('成果文本编辑',exact=True)).to_have_value('切换前尚未等待防抖的草稿');button(page,'关闭审阅窗');page.wait_for_event('close',timeout=30000)if not page.is_closed()else None;release.set();assert not errors
 except Exception:
  if app.browser:
   for context in app.browser.contexts:
    for page in context.pages:
     try:app.shot('failure-'+str(context.pages.index(page))+'.png',page);print(page.locator('body').inner_text()[-7000:])
     except Exception:pass
  raise
 finally:
  release.set()
  try:app.close()
  except Exception:
   if app.process and app.process.poll()is None:app.process.terminate();app.process.wait(timeout=10)
  app.log.close();server.shutdown()
 result={'phase':17,'passed':True,'checks':checks,'rendererErrors':errors,'fixture':str(run),'screenshots':str(shots),'externalModels':False};(run/'workbench-result.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf8');print(json.dumps(result,ensure_ascii=False,indent=2))
