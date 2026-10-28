"""Convert a genuine legacy workbook into independent output and keep source/cwd unchanged."""
from _desktop_review_harness import *
import _desktop_review_harness as harness
import shutil,hashlib
shots=root/'docs/screenshots/phase-seventeen';shots.mkdir(parents=True,exist_ok=True);harness.shots=shots
engine=json.loads((root/'.qa-work/office-runtime/runtime.json').read_text(encoding='utf8'))['runtime']
fixtures=list((root/'.qa-work').glob('legacy-real-*/legacy.xls'));assert fixtures,'Run office-legacy-real.test.ts first to produce a genuine native XLS fixture'
with sync_playwright()as p:
 app=Desktop('CONVERSION');shutil.copyfile(max(fixtures,key=lambda f:f.stat().st_mtime),app.workspace/'旧预算.xls');config=app.home/'office-sessions/engine.json';config.parent.mkdir();config.write_text(json.dumps({'path':engine}),encoding='utf8');original=hashlib.sha256((app.workspace/'旧预算.xls').read_bytes()).hexdigest()
 try:
  app.launch(p);app.page.get_by_test_id('task-row').filter(has_text='远程项目对话').click();app.deny.write_text('deny')
  try:app.page.evaluate('()=>window.smalt.artifacts("legacy-copy",{threadId:"th_remote_shared",path:"旧预算.xls",dark:false})');raise AssertionError('Denied conversion was accepted')
  except Exception as error:assert '取消'in str(error),str(error)
  app.deny.unlink();app.page.evaluate('()=>window.smalt.artifacts("legacy-copy",{threadId:"th_remote_shared",path:"旧预算.xls",dark:false})');until(lambda:any(v.url.endswith('/artifact.html')and not v.is_closed()for c in app.browser.contexts for v in c.pages),90);page=next(v for c in app.browser.contexts for v in c.pages if v.url.endswith('/artifact.html')and not v.is_closed());until(lambda:bool(state(page).get('model')),45);v=state(page);assert v['model']['format']=='xlsx'and'已转换'in v['name'];assert hashlib.sha256((app.workspace/'旧预算.xls').read_bytes()).hexdigest()==original;app.shot('legacy-independent-output.png',page);button(page,'关闭审阅窗');page.wait_for_event('close',timeout=30000)if not page.is_closed()else None;assert not errors;checks.append('real native XLS conversion supports cancellation; writes a new modern workbook into independent output without overwriting source or changing execution directory')
 except Exception:
  if app.browser:
   for c in app.browser.contexts:
    for page in c.pages:
     try:print(page.locator('body').inner_text()[-5000:])
     except Exception:pass
  raise
 finally:
  release.set();app.close();app.log.close();server.shutdown()
 result={'phase':17,'passed':True,'checks':checks,'rendererErrors':errors,'fixture':str(run),'externalModels':False};(run/'conversion-result.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf8');print(json.dumps(result,ensure_ascii=False,indent=2))
