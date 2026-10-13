"""Capture README images from the packaged desktop and a local demo model."""
import json, os, socket, subprocess, sys, threading, time
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
root = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(root / '.qa-python'))
from playwright.sync_api import sync_playwright, expect
run = root / '.qa-work' / ('readme-demo-' + str(time.time_ns()))
home = run / 'home'
workspace = run / '示例项目'
home.mkdir(parents=True)
workspace.mkdir()
(workspace / '设计说明.md').write_text('# 项目目标\n\n清爽的智能体编程工作区：项目组织、可控权限、后台执行。\n', encoding='utf-8')
(workspace / 'progress-probe.cjs').write_text("const fs=require('node:fs'); console.log('环境检查完成'); const t=setInterval(()=>{if(fs.existsSync('progress-continue')){clearInterval(t);console.log('检查通过');}},50);",encoding='utf-8')
shots = root / 'docs/images'
shots.mkdir(parents=True, exist_ok=True)
class DemoModel(BaseHTTPRequestHandler):
    def log_message(self, *args): pass
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        n = sum(m['role'] == 'tool' for m in body['messages'])
        self.send_response(200)
        self.send_header('Content-Type','text/event-stream')
        self.end_headers()
        def emit(delta, finish=None):
            data = {'choices':[{'delta':delta,'finish_reason':finish}]}
            self.wfile.write(('data: '+json.dumps(data,ensure_ascii=False)+'\n\n').encode())
            self.wfile.flush()
        def tools(items):
            emit({'tool_calls':[{'index':i,'id':'demo_'+str(n)+'_'+str(i),'function':{'name':name,'arguments':json.dumps(args,ensure_ascii=False)}} for i,(name,args) in enumerate(items)]},'tool_calls')
        try:
            if n == 0:
                emit({'content':'我会先核对项目资料与执行环境，再整理开发计划和验收清单。'})
                emit({'reasoning_content':'先读取项目说明，确认文档的目标与范围。'})
                tools([('read',{'path':'设计说明.md'})])
            elif n == 1:
                tools([('shell',{'command':'node progress-probe.cjs'})])
            elif n == 2:
                emit({'content':'项目资料与执行环境已经核对，开始保存三份文档。'})
                tools([
                    ('write',{'path':'README.md','content':'# SmaltCode 示例项目\n\n把任务、思考与执行放在一个工作区。\n\n## 已整理的内容\n\n- 开发计划：界面、权限、项目管理与托盘驻留。\n- 验收清单：运行中浏览、批量审批、文件产物。\n\n## 使用方式\n\n配置模型，选择文件夹，然后描述你要完成的任务。\n'}),
                    ('write',{'path':'docs/开发计划.md','content':'# 开发计划\n\n1. 整理项目结构与说明。\n2. 实现功能并检查真实输出。\n3. 验收界面、权限与后台任务。\n'}),
                    ('write',{'path':'docs/验收清单.md','content':'# 验收清单\n\n- [x] 读取项目资料\n- [x] 核对执行环境\n- [x] 保存文档\n- [ ] 由用户检查产物\n'})
                ])
            else:
                answer = '已完成 **项目文档整理**，三份文件已保存。\n\n| 文件 | 内容 |\n| --- | --- |\n| README.md | 项目介绍与使用方式 |\n| 开发计划.md | 开发顺序与任务范围 |\n| 验收清单.md | 可核验的检查项目 |\n\n可以在右侧查看文件内容与变更差异，继续补充说明或开始下一个任务。'
                for i in range(0,len(answer),10):
                    emit({'content':answer[i:i+10]})
                    time.sleep(.015)
                emit({},'stop')
            self.wfile.write(b'data: [DONE]\n\n')
        except (BrokenPipeError,ConnectionResetError): pass
server = ThreadingHTTPServer(('127.0.0.1',0),DemoModel)
threading.Thread(target=server.serve_forever,daemon=True).start()
(home / 'settings.json').write_text(json.dumps({'defaultProvider':'openai','defaultModel':'demo-model','providers':{'openai':{'baseUrl':'http://127.0.0.1:'+str(server.server_port)+'/v1','apiKey':'local-demo-key'}}}),encoding='utf-8')
with socket.socket() as s:
    s.bind(('127.0.0.1',0))
    port = s.getsockname()[1]
env = {**os.environ,'SMALT_HOME':str(home)}
env.pop('ELECTRON_RUN_AS_NODE',None)
log = open(run / 'electron.log','w',encoding='utf-8')
exe = root / 'packages/desktop/release/win-unpacked/SmaltCode.exe'
proc = subprocess.Popen([str(exe),'--ui-test','--remote-debugging-port='+str(port)],env=env,stdout=log,stderr=log,creationflags=subprocess.CREATE_NO_WINDOW)
p = sync_playwright().start()
try:
    browser = None
    for _ in range(100):
        try:
            browser=p.chromium.connect_over_cdp('http://127.0.0.1:'+str(port),timeout=1000)
            break
        except Exception:
            if proc.poll() is not None: raise RuntimeError('Desktop exited; see '+str(run))
            time.sleep(.1)
    assert browser
    page = browser.contexts[0].pages[0]
    errors=[]
    page.on('pageerror',lambda e: errors.append(str(e)))
    page.wait_for_load_state('networkidle')
    page.get_by_role('button',name='跳过，稍后在设置中配置').click()
    page.evaluate("dir=>{localStorage.setItem('smalt.ui.dark','false');localStorage.setItem('smalt.ui.workspace',JSON.stringify(dir));localStorage.setItem('smalt.ui.workspaces',JSON.stringify([dir]));}",str(workspace))
    page.reload()
    page.wait_for_load_state('networkidle')
    page.screenshot(animations='disabled',path=str(shots / 'home.png'))
    page.get_by_role('button',name='切换主题',exact=True).click()
    page.get_by_role('button',name='创建项目',exact=True).click()
    dialog=page.get_by_role('dialog',name='创建项目',exact=True)
    dialog.get_by_label('项目名称',exact=True).fill('SmaltCode 示例项目')
    dialog.get_by_label('项目说明',exact=True).fill('使用中文说明改动，保留清晰的项目文档与验收记录。')
    dialog.get_by_role('button',name='创建项目',exact=True).click()
    expect(page.get_by_role('heading',name='SmaltCode 示例项目',exact=True)).to_be_visible()
    page.screenshot(animations='disabled',path=str(shots / 'projects.png'))
    page.get_by_label('任务输入',exact=True).fill('整理项目资料，生成项目介绍、开发计划与验收清单。')
    page.get_by_role('button',name='发送',exact=True).click()
    expect(page.get_by_test_id('approval')).to_be_visible(timeout=15000)
    page.get_by_test_id('approval').get_by_role('button',name='允许',exact=True).click()
    expect(page.get_by_test_id('activity-stage')).to_contain_text('正在执行操作')
    page.keyboard.press('Control+j')
    page.screenshot(animations='disabled',path=str(shots / 'activity.png'))
    (workspace / 'progress-continue').write_text('continue',encoding='utf-8')
    expect(page.get_by_test_id('approval')).to_contain_text('同组 文件编辑 · 3 项',timeout=15000)
    page.screenshot(animations='disabled',path=str(shots / 'permissions.png'))
    page.get_by_role('button',name='允许本组 3 项',exact=True).click()
    expect(page.get_by_test_id('item-agentMessage').filter(has_text='三份文件已保存')).to_be_visible(timeout=15000)
    expect(page.get_by_role('button',name='停止',exact=True)).to_have_count(0,timeout=15000)
    page.keyboard.press('Control+j')
    page.get_by_test_id('artifact-panel').get_by_role('button',name='README.md',exact=False).click()
    page.get_by_role('button',name='文件内容',exact=True).click()
    expect(page.get_by_test_id('file-preview')).to_contain_text('SmaltCode 示例项目')
    page.screenshot(animations='disabled',path=str(shots / 'conversation.png'))
    assert (workspace / 'docs/验收清单.md').exists()
    assert not errors, errors
    print('PASS: README images captured from packaged SmaltCode with real IPC, tools and workspace files.')
    browser.close()
finally:
    subprocess.run(['taskkill','/PID',str(proc.pid),'/T','/F'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    server.shutdown()
    log.close()
    p.stop()
