"""Visible source-preview and packaged window identities, including a real review window."""
from _desktop_review_harness import *
import _desktop_review_harness as harness
import argparse
parser=argparse.ArgumentParser();parser.add_argument('--release-dir',type=Path);parser.add_argument('--preview-executable',type=Path);args=parser.parse_args()
shots=root/'docs/screenshots/taskbar-identity';shots.mkdir(parents=True,exist_ok=True);harness.shots=shots
checks=[];results=[]
def audit(app,mode,executable,icon):
 target=app.dir/(mode+'-windows.json')
 output=subprocess.run(['powershell.exe','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',str(root/'scripts/test-desktop-window-identity.ps1'),'-ProcessId',str(app.process.pid),'-ExpectedAppId','app.smaltcode.desktop.test','-ExpectedExecutable',str(executable),'-ExpectedIconPath',str(icon),'-RequireWindowIcon','-MinimumWindows','2','-ReportPath',str(target)],cwd=root,stdout=subprocess.PIPE,stderr=subprocess.PIPE,encoding='utf8',errors='replace',timeout=40,creationflags=subprocess.CREATE_NO_WINDOW)
 assert output.returncode==0,output.stdout+'\n'+output.stderr
 result=json.loads(target.read_text(encoding='utf-8-sig'));results.append({'mode':mode,'result':result});checks.append(mode+': main and review windows have real icons, matching AUMID and valid relaunch properties')
with sync_playwright()as p:
 app=Desktop('TASKBAR_WINDOWS')
 if args.preview_executable:app.runtime_executable=args.preview_executable.resolve()
 try:
  preview_executable=Path(app.runtime_executable)if args.preview_executable else root/'node_modules/electron/dist/electron.exe'
  preview_icon=preview_executable if preview_executable.name.lower()=='smaltcode preview.exe' else root/'packages/desktop/dist/main/smalt.ico'
  app.launch(p);page=review(app,'notes.md');audit(app,'preview',preview_executable,preview_icon);app.shot('preview-main.png');app.shot('preview-review.png',page);button(page,'关闭审阅窗');page.wait_for_event('close',timeout=30000)if not page.is_closed()else None;app.close()
  if args.release_dir:
   executable=args.release_dir.resolve()/'win-unpacked/SmaltCode.exe';assert executable.is_file();app.quit.unlink(missing_ok=True);env={**os.environ,'SMALT_HOME':str(app.home)}
   for key in list(env):
    if any(v in key.upper()for v in ['API_KEY','TOKEN','SECRET','PASSWORD','CREDENTIAL'])or key=='ELECTRON_RUN_AS_NODE':env.pop(key,None)
   app.process=subprocess.Popen([str(executable),'--identity-test','--remote-debugging-port='+str(app.port)],env=env,cwd=executable.parent,stdout=app.log,stderr=app.log,creationflags=subprocess.CREATE_NO_WINDOW);app.browser=None
   for _ in range(150):
    try:app.browser=p.chromium.connect_over_cdp(f'http://127.0.0.1:{app.port}',timeout=500);break
    except Exception:time.sleep(.1)
   assert app.browser;until(lambda:any(v.url.startswith('file:')for c in app.browser.contexts for v in c.pages));app.page=next(v for c in app.browser.contexts for v in c.pages if v.url.startswith('file:'));app.page.on('pageerror',lambda e:errors.append(str(e)));app.page.wait_for_load_state('networkidle');page=review(app,'notes.md');audit(app,'packaged',executable,executable);app.page.screenshot(path=str(shots/'packaged-main.png'),animations='disabled');page.screenshot(path=str(shots/'packaged-review.png'),animations='disabled');button(page,'关闭审阅窗');page.wait_for_event('close',timeout=30000)if not page.is_closed()else None
   # This isolated fixture has no task/native editor. Lifecycle quit is covered separately.
   subprocess.run(['taskkill','/PID',str(app.process.pid),'/T','/F'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,check=False);app.process.wait(timeout=20)
  assert not errors
 finally:
  release.set()
  try:
   if app.process and app.process.poll()is None:
    subprocess.run(['taskkill','/PID',str(app.process.pid),'/T','/F'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,check=False);app.process.wait(timeout=20)
  finally:app.log.close();server.shutdown()
 result={'passed':True,'checks':checks,'windows':results,'rendererErrors':errors,'fixture':str(run),'taskbarPaintedPixelsVerified':False,'note':'This verifies normal visible windows, real shell properties and icon handles; it does not substitute for native taskbar visual inspection.'};(run/'taskbar-result.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf8');print(json.dumps(result,ensure_ascii=False,indent=2))
