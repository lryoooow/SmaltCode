"""Local Electron window/zoom acceptance. Run test-desktop-ui.py first.

Reuses only that successful test's synthetic conversation and workspace; creates
its own profile. Zoom is controlled by the test harness, never production IPC.
"""
from _desktop_control import publish
import json, os, shutil, socket, subprocess, sys, time
from pathlib import Path

root = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(root / '.qa-python'))
from playwright.sync_api import sync_playwright, expect

evidence = json.loads((root / 'docs/screenshots/ui-test-results.json').read_text(encoding='utf8'))
assert evidence['passed']
source = Path(evidence['fixture']).resolve()
assert source.is_relative_to((root / '.qa-work').resolve()) and source.name.startswith('desktop-')
thread_file = next(p for p in (source / 'home/threads').glob('*.jsonl') if '前端验收任务' in p.read_text(encoding='utf8'))
run = root / '.qa-work' / ('layout-' + str(time.time_ns()))
home = run / 'home'; (home / 'threads').mkdir(parents=True)
shutil.copyfile(thread_file, home / 'threads' / thread_file.name)
(home / 'settings.json').write_text(json.dumps({'defaultProvider':'openai','defaultModel':'ui-test-model','providers':{'openai':{'baseUrl':'http://127.0.0.1:9/v1','apiKey':'local-fixture-key'}}}), encoding='utf8')
zoom, ack = run / 'zoom.txt', run / 'zoom-ack.txt'; publish(zoom,'1', encoding='utf8')
version = json.loads((root / 'packages/desktop/package.json').read_text(encoding='utf8'))['version']
harness = run / 'harness.cjs'
harness.write_text("const {app,dialog,BrowserWindow}=require('electron');const fs=require('node:fs');app.getVersion=()=>" + json.dumps(version) + ";dialog.showMessageBox=async()=>({response:0});let previous;setInterval(()=>{const win=BrowserWindow.getAllWindows()[0];if(!win)return;const next=Number(fs.readFileSync(" + json.dumps(str(zoom)) + ",'utf8'));if([1,1.25,1.5,2].includes(next)&&next!==previous){win.webContents.setZoomFactor(next);previous=next;fs.writeFileSync(" + json.dumps(str(ack)) + ",String(win.webContents.getZoomFactor()))}},50).unref();require(" + json.dumps(str(root / 'packages/desktop/dist/main/index.js')) + ");", encoding='utf8')
with socket.socket() as sock:
    sock.bind(('127.0.0.1',0)); port = sock.getsockname()[1]
env = {**os.environ, 'SMALT_HOME':str(home)}
for key in ['ELECTRON_RUN_AS_NODE','OPENAI_API_KEY','ANTHROPIC_API_KEY','DEEPSEEK_API_KEY','ZHIPU_API_KEY','MOONSHOT_API_KEY','DASHSCOPE_API_KEY','OPENROUTER_API_KEY']: env.pop(key,None)
shots = root / 'docs/screenshots/phase-one-layout'; shots.mkdir(parents=True, exist_ok=True)
log = open(run / 'electron.log','w',encoding='utf8')
process = subprocess.Popen([str(root / 'node_modules/electron/dist/electron.exe'),str(harness),'--ui-test','--remote-debugging-port='+str(port)], cwd=root, env=env, stdout=log, stderr=log)
p = sync_playwright().start(); errors = []; browser = None
try:
    for attempt in range(80):
        try: browser=p.chromium.connect_over_cdp('http://127.0.0.1:'+str(port), timeout=1000); break
        except Exception:
            if process.poll() is not None: raise RuntimeError('Layout test Electron exited')
            time.sleep(.1)
    assert browser
    for attempt in range(100):
        if browser.contexts and browser.contexts[0].pages: break
        if process.poll() is not None: raise RuntimeError('Layout test Electron exited before creating a page')
        time.sleep(.1)
    page=browser.contexts[0].pages[0]; page.on('pageerror',lambda error:errors.append(str(error)))
    page.wait_for_load_state('networkidle')
    page.get_by_role('button',name='跳过，稍后在设置中配置').click()
    page.get_by_test_id('task-row').filter(has_text='前端验收任务').click()
    page.get_by_test_id('delivery-summary').get_by_role('button',name='周报说明.md',exact=False).click()
    expect(page.get_by_test_id('file-preview')).to_contain_text('本周工作说明')
    for width in [900,1100,1280,1440,1920]:
        page.set_viewport_size({'width':width,'height':1000})
        page.wait_for_timeout(100)
        assert page.evaluate('document.body.scrollWidth<=innerWidth+1')
        assert page.get_by_test_id('artifact-panel').evaluate('e=>e.clientWidth>=360')
        mode=page.get_by_test_id('workspace-split').get_attribute('data-mode')
        if mode=='focus': expect(page.get_by_test_id('task-view')).not_to_be_visible()
        else: expect(page.get_by_test_id('task-view')).to_be_visible()
        page.screenshot(animations='disabled',path=str(shots / ('width-'+str(width)+'.png')))
    page.set_viewport_size({'width':1440,'height':1000})
    measured=[]
    for theme in ['light','dark']:
        if page.evaluate("document.documentElement.classList.contains('dark')") != (theme=='dark'):
            page.get_by_role('button',name='切换主题',exact=True).click()
        for factor in [1,1.25,1.5,2]:
            publish(zoom,str(factor),encoding='utf8')
            for attempt in range(100):
                try:
                    if float(ack.read_text())==factor: break
                except (OSError,ValueError): pass
                time.sleep(.03)
            else: raise AssertionError('Native Electron zoom did not apply')
            page.wait_for_timeout(100)
            assert page.evaluate('document.body.scrollWidth<=innerWidth+1')
            box=page.get_by_test_id('artifact-panel').bounding_box()
            viewport=page.evaluate('({width:innerWidth,height:innerHeight})')
            assert box['x']>=0 and box['y']>=0 and box['x']+box['width']<=viewport['width']+2
            expect(page.get_by_role('button',name='收起面板',exact=True)).to_be_visible()
            measured.append({'theme':theme,'nativeZoomFactor':factor,'viewport':viewport,'mode':page.get_by_test_id('workspace-split').get_attribute('data-mode')})
            page.screenshot(animations='disabled',path=str(shots / (theme+'-zoom-'+str(factor)+'.png')))
    publish(zoom,'1',encoding='utf8')
    assert not errors,errors
    result={'passed':True,'windowWidths':[900,1100,1280,1440,1920],'nativeElectronZoom':[1,1.25,1.5,2],'measurements':measured,'rendererErrors':errors,'modelGenerationRequests':0,'systemDPIChanged':False,'fixture':str(run)}
    (shots / 'results.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf8')
    print(json.dumps(result,ensure_ascii=True,indent=2))
except Exception:
    if browser:
        try: page.screenshot(path=str(shots/'failure.png'),timeout=3000)
        except Exception: pass
    raise
finally:
    if browser: browser.close()
    subprocess.run(['taskkill','/PID',str(process.pid),'/T','/F'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    log.close(); p.stop()
