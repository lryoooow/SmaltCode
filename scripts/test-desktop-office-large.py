"""Large actual deck through the complete host/renderer working-copy path."""
from _desktop_review_harness import *
import _desktop_review_harness as harness
shots=root/'docs/screenshots/phase-seventeen';shots.mkdir(parents=True,exist_ok=True);harness.shots=shots
engine=json.loads((root/'.qa-work/office-runtime/runtime.json').read_text(encoding='utf8'))['runtime']
with sync_playwright()as p:
 app=Desktop('LARGE');subprocess.run([sys.executable,str(root/'scripts/fixtures/impress_large.py'),str(app.workspace)],check=True);config=app.home/'office-sessions/engine.json';config.parent.mkdir();config.write_text(json.dumps({'path':engine}),encoding='utf8')
 try:
  app.launch(p);page=review(app,'working.pptx');page.get_by_test_id('office-editor').locator('summary').click();button(page,'在工作台编辑副本');expect(page.get_by_label('当前幻灯片')).to_be_visible(timeout=120000);expect(page.get_by_test_id('impress-workbench')).to_contain_text('摘要');assert page.get_by_label('当前幻灯片').locator('option').count()==500;assert state(page)['draft']['binaryVersion'];page.get_by_label('当前幻灯片').select_option('499');expect(page.get_by_test_id('impress-workbench')).to_contain_text('500 / 500',timeout=60000);expect(page.get_by_role('button',name='刷新幻灯片',exact=True)).to_be_enabled();app.shot('large-deck-last-page.png',page);app.page.get_by_test_id('task-row').filter(has_text='独立浏览对话').click();expect(app.page.get_by_label('任务输入',exact=True)).to_be_editable();button(page,'关闭审阅窗');page.wait_for_event('close',timeout=60000)if not page.is_closed()else None;assert not errors;checks.append('real 500-page/150-object document passes package policy, private capture, bounded renderer and final-page navigation while another chat remains browsable')
 except Exception:
  if app.browser:
   for c in app.browser.contexts:
    for page in c.pages:
     try:print(page.locator('body').inner_text()[-6000:])
     except Exception:pass
  raise
 finally:
  release.set();app.close();app.log.close();server.shutdown()
 result={'passed':True,'checks':checks,'rendererErrors':errors,'fixture':str(run),'externalModels':False};(run/'large-result.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf8');print(json.dumps(result,ensure_ascii=False,indent=2))
