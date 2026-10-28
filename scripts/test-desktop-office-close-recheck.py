"""Real native final-close edit, delayed exit confirmation, retry and tab retention."""
from _desktop_review_harness import *
import _desktop_review_harness as harness
from fixtures.office import create
import hashlib
shots=root/'docs/screenshots/recheck-2026-10-28';shots.mkdir(parents=True,exist_ok=True);harness.shots=shots
engine=json.loads((root/'.qa-work/office-runtime/runtime.json').read_text(encoding='utf8'))['runtime']
with sync_playwright()as p:
 app=Desktop('OFFICE_CLOSE_RECHECK');create(app.workspace);config=app.home/'office-sessions/engine.json';config.parent.mkdir();config.write_text(json.dumps({'path':engine}),encoding='utf8');original=hashlib.sha256((app.workspace/'sample.docx').read_bytes()).hexdigest();controls={k:str(app.dir/k)for k in ['inject','hold','ready','count']};app.harness.write_text('require('+json.dumps(str(root/'scripts/fixtures/office-close-race.cjs'))+')('+json.dumps(controls)+');\n'+app.harness.read_text(encoding='utf8'),encoding='utf8')
 try:
  app.launch(p);page=review(app,'notes.md');page.get_by_label('成果文本编辑',exact=True).fill('关闭失败和标签切换不能丢掉的草稿');page=review(app,'sample.docx');page.get_by_test_id('office-editor').locator('summary').click();button(page,'在本机 Office 编辑副本');until(lambda:state(page)['editing'].get('office',{}).get('status')=='editing',90);Path(controls['inject']).write_text('edit');Path(controls['hold']).write_text('hold');button(page,'关闭审阅窗');until(lambda:Path(controls['ready']).exists(),45);expect(page.get_by_test_id('office-session-alert')).to_contain_text('退出',timeout=30000);expect(page.get_by_role('button',name='重试结束编辑',exact=True)).to_be_visible();assert not page.is_closed();assert hashlib.sha256((app.workspace/'sample.docx').read_bytes()).hexdigest()==original;app.shot('office-close-unconfirmed.png',page);Path(controls['hold']).unlink();button(page,'重试结束编辑');until(lambda:not state(page)['editing'].get('office'),40);assert 'SMALT_OFFICE_ROUNDTRIP'in' '.join(f['text']for f in state(page)['model']['fields']);assert Path(controls['count']).read_text().splitlines()==['close'];checks.append('native final-close edit is collected only after real process exit; retry waits for the same close, preserves original and keeps the review window usable')
  button(page,'notes.md');expect(page.get_by_label('成果文本编辑',exact=True)).to_have_value('关闭失败和标签切换不能丢掉的草稿');button(page,'sample.docx');button(page,'保存文件');until(lambda:hashlib.sha256((app.workspace/'sample.docx').read_bytes()).hexdigest()!=original);button(page,'关闭审阅窗');page.wait_for_event('close',timeout=40000)if not page.is_closed()else None;page=review(app,'notes.md');expect(page.get_by_label('成果文本编辑',exact=True)).to_have_value('关闭失败和标签切换不能丢掉的草稿');checks.append('close failure and retry preserve other document drafts; final candidate writes original only after explicit save consent');button(page,'关闭审阅窗');page.wait_for_event('close',timeout=40000)if not page.is_closed()else None;assert not errors
 finally:
  Path(controls['hold']).unlink(missing_ok=True);release.set()
  try:app.close()
  finally:app.log.close();server.shutdown()
 result={'passed':True,'checks':checks,'rendererErrors':errors,'fixture':str(run),'externalModels':False};(run/'office-close-recheck-result.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf8');print(json.dumps(result,ensure_ascii=False,indent=2))
