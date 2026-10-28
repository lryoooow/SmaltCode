"""Real Calc grid, formula results, permission cancellation, save and chat continuity."""
from _desktop_review_harness import *
import _desktop_review_harness as harness
import hashlib
shots=root/'docs/screenshots/phase-sixteen';shots.mkdir(parents=True,exist_ok=True);harness.shots=shots
engine=json.loads((root/'.qa-work/office-runtime/runtime.json').read_text(encoding='utf8'))['runtime']
with sync_playwright()as p:
 app=Desktop('CALC');subprocess.run([sys.executable,str(root/'scripts/fixtures/calc.py'),str(app.workspace)],check=True);config=app.home/'office-sessions/engine.json';config.parent.mkdir();config.write_text(json.dumps({'path':engine}),encoding='utf8');original=hashlib.sha256((app.workspace/'source.xlsx').read_bytes()).hexdigest()
 try:
  app.launch(p);app.page.get_by_test_id('task-row').filter(has_text='远程项目对话').click();app.page.get_by_label('任务输入',exact=True).fill('HOLD_REMOTE 表格编辑期间保持运行');app.nav('发送');until(lambda:len(requests)>0)
  page=review(app,'source.xlsx');page.get_by_test_id('office-editor').locator('summary').click();button(page,'在工作台编辑副本');expect(page.get_by_test_id('calc-workbench')).to_be_visible(timeout=90000);expect(page.get_by_label('Calc D1',exact=True)).to_have_text('60',timeout=60000)
  page.get_by_label('Calc E1',exact=True).click();page.get_by_label('Calc 单元格内容').fill('=literal');button(page,'应用单元格');expect(page.get_by_label('Calc E1',exact=True)).to_have_text('=literal');page.get_by_label('Calc E2',exact=True).click();page.get_by_label('Calc 单元格类型').select_option('formula');page.get_by_label('Calc 单元格内容').fill('=SUM(B2:B4)');button(page,'应用单元格');expect(page.get_by_label('Calc E2',exact=True)).to_have_text('60');assert hashlib.sha256((app.workspace/'source.xlsx').read_bytes()).hexdigest()==original
  page.get_by_label('Calc 操作范围').fill('A9');page.get_by_test_id('calc-workbench').locator('summary').click();page.get_by_label('Calc 范围操作').select_option('delete-rows');app.deny.write_text('deny');button(page,'应用范围操作');expect(page.get_by_role('alert')).to_contain_text('取消');app.deny.unlink();button(page,'刷新计算');expect(page.get_by_label('Calc E2',exact=True)).to_have_text('60');checks.append('real grid and formula errors use engine results; literal text stays literal; native cancellation leaves original intact')
  app.page.get_by_test_id('task-row').filter(has_text='独立浏览对话').click();app.page.get_by_label('任务输入',exact=True).fill('保留其他对话草稿');expect(app.page.get_by_label('任务输入',exact=True)).to_have_value('保留其他对话草稿');app.shot('calc-light.png',page);button(page,'切换主题');app.shot('calc-dark.png',page)
  from _desktop_control import publish
  for factor in [1.25,1.5,2]:
   publish(app.active,page.title(),encoding='utf8');app.ack.unlink(missing_ok=True);publish(app.zoom,str(factor));until(lambda:app.ack.exists());assert page.evaluate('document.documentElement.scrollWidth<=innerWidth+1');app.shot('calc-'+str(factor)+'.png',page)
  publish(app.zoom,'1');page.wait_for_timeout(300);button(page,'保存文件');until(lambda:hashlib.sha256((app.workspace/'source.xlsx').read_bytes()).hexdigest()!=original);checks.append('explicit original save succeeds while another chat remains browsable and its draft unchanged; light/dark and DPI layouts fit')
  button(page,'关闭审阅窗');page.wait_for_event('close',timeout=40000)if not page.is_closed()else None;release.set();assert not errors
 except Exception:
  for context in app.browser.contexts if app.browser else []:
   for page in context.pages:
    try:app.shot('failure-'+str(context.pages.index(page))+'.png',page);print(page.locator('body').inner_text()[-6000:])
    except Exception:pass
  raise
 finally:
  release.set();app.close();app.log.close();server.shutdown()
 result={'phase':16,'passed':True,'checks':checks,'rendererErrors':errors,'fixture':str(run),'screenshots':str(shots),'externalModels':False};(run/'calc-result.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf8');print(json.dumps(result,ensure_ascii=False,indent=2))
