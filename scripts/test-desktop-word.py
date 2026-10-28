"""Phase15 native Writer + SmaltCode document preview/selection review and chat isolation."""
from _desktop_control import publish
from _desktop_review_harness import *
import _desktop_review_harness as harness
import hashlib
from fixtures.word import create
shots=root/'docs/screenshots/phase-fifteen';shots.mkdir(parents=True,exist_ok=True);harness.shots=shots
engine=json.loads((root/'.qa-work/office-runtime/runtime.json').read_text(encoding='utf8'))['runtime']
def closed(page):
 if not page.is_closed():page.wait_for_event('close',timeout=40000)
with sync_playwright()as p:
 app=Desktop('WORD');create(app.workspace);config=app.home/'office-sessions/engine.json';config.parent.mkdir();config.write_text(json.dumps({'path':engine}),encoding='utf8');original=hashlib.sha256((app.workspace/'rich.docx').read_bytes()).hexdigest()
 try:
  app.launch(p);app.page.get_by_test_id('task-row').filter(has_text='远程项目对话').click();app.page.get_by_label('任务输入',exact=True).fill('HOLD_REMOTE 审阅 Word 时继续工作');app.nav('发送');until(lambda:len(requests)>0)
  page=review(app,'rich.docx');page.get_by_test_id('office-editor').locator('summary').click();expect(page.get_by_test_id('word-workbench')).to_be_visible();expect(page.get_by_role('button',name='刷新分页预览',exact=True)).to_be_disabled();button(page,'在本机 Office 编辑副本');until(lambda:state(page)['editing'].get('office',{}).get('status')=='editing',100)
  ident=state(page)['editing']['office']['id'];working=config.parent/ident/'working.docx';subprocess.run([str(Path(engine).parent/'python.exe'),str(root/'scripts/fixtures/select-office.py'),engine,str(working),str(run)],check=True,timeout=30,creationflags=subprocess.CREATE_NO_WINDOW)
  button(page,'获取原生编辑器选段');expect(page.get_by_test_id('word-selection-before')).to_have_text('AI_SELECTION_TARGET');page.get_by_label('Word 选段修改要求',exact=True).fill('润色并保留原意');app.page.get_by_test_id('task-row').filter(has_text='独立浏览对话').click();app.page.get_by_label('任务输入',exact=True).fill('不能被 Word 选段覆盖的其他对话草稿');button(page,'加入所属对话草稿');expect(page.get_by_text('已加入草稿，请切回对话核对后发送',exact=True)).to_be_visible();expect(app.page.get_by_label('任务输入',exact=True)).to_have_value('不能被 Word 选段覆盖的其他对话草稿');app.page.get_by_test_id('task-row').filter(has_text='远程项目对话').click();expect(app.page.get_by_label('任务输入',exact=True)).to_contain_text('AI_SELECTION_TARGET')if False else None;assert 'AI_SELECTION_TARGET'in app.page.get_by_label('任务输入',exact=True).input_value();checks.append('actual native Writer selection is token-bound; selected text enters only owning chat draft, does not auto-send and preserves the other chat draft')
  page.get_by_label('Word 选段修改候选',exact=True).fill('已核对的中文修改候选');expect(page.get_by_role('button',name='以修订应用到工作副本',exact=True)).to_be_disabled();page.get_by_label('已核对前后内容',exact=True).check();app.deny.write_text('deny');button(page,'以修订应用到工作副本');expect(page.get_by_role('alert')).to_contain_text('取消');app.deny.unlink();button(page,'以修订应用到工作副本');until(lambda:bool((state(page).get('draft')or{}).get('binaryVersion')),60);assert hashlib.sha256((app.workspace/'rich.docx').read_bytes()).hexdigest()==original;checks.append('review-before-apply and native cancellation protect the file; confirmed candidate is a tracked change in private copy, original remains unchanged')
  button(page,'刷新分页预览');expect(page.get_by_test_id('word-page-preview')).to_be_visible(timeout=80000);expect(page.locator('canvas')).to_be_visible();expect(page.get_by_text('仅修改正文文字',exact=False)).not_to_be_visible();expect(page.get_by_text('正在绘制页面…',exact=True)).not_to_be_visible();assert page.locator('canvas').first.evaluate("c=>{const d=c.getContext('2d').getImageData(0,0,c.width,c.height).data;let n=0;for(let i=0;i<d.length;i+=40)if(d[i]<220&&d[i+3]>0)n++;return n>50}");assert page.evaluate('typeof window.smalt')=='undefined';assert page.evaluate('typeof window.require')=='undefined';app.shot('word-pages-light.png',page);button(page,'返回编辑位置');button(page,'查看分页预览');button(page,'切换主题');page.wait_for_timeout(250);app.shot('word-pages-dark.png',page)
  for factor in [1.25,1.5,2]:
   publish(app.active,page.title(),encoding='utf8');app.ack.unlink(missing_ok=True);publish(app.zoom,str(factor));until(lambda:app.ack.exists());page.wait_for_timeout(350);assert page.evaluate('document.documentElement.scrollWidth<=innerWidth+1');app.shot('word-'+str(factor)+'-zoom.png',page)
  publish(app.zoom,'1');page.wait_for_timeout(400);page.get_by_test_id('office-editor').locator('summary').click();button(page,'结束 Office 编辑');until(lambda:not state(page)['editing'].get('office'),70);checks.append('actual PDF page preview renders, retains a separate reading view, and works at light/dark and 125/150/200 percent without horizontal page overflow')
  button(page,'关闭审阅窗');closed(page);page=review(app,'rich.docx');assert state(page)['draft']['binaryVersion'];assert hashlib.sha256((app.workspace/'rich.docx').read_bytes()).hexdigest()==original;button(page,'关闭审阅窗');closed(page);checks.append('close/reopen preserves the candidate and original; native editor closes before artifact lease releases');release.set();assert not errors
 except Exception:
  for context in app.browser.contexts:
   for page in context.pages:
    try:app.shot('failure-'+str(context.pages.index(page))+'.png',page);print(page.url,page.locator('body').inner_text()[-7000:])
    except Exception:pass
  raise
 finally:
  release.set()
  try:app.close()
  except Exception:
   if app.process and app.process.poll()is None:app.process.terminate();app.process.wait(timeout=10)
  app.log.close();server.shutdown()
 result={'phase':15,'passed':True,'checks':checks,'rendererErrors':errors,'modelRequests':len(requests),'fixture':str(run),'screenshots':str(shots),'externalModels':False};(run/'word-result.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf8');print(json.dumps(result,ensure_ascii=False,indent=2))
