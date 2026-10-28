"""Real Electron/IPC web-search regression using isolated profiles and local services.

The QA main-module wrapper intercepts only the four fixed official service URLs.
Synthetic credentials never leave localhost. No product endpoint override is used.
"""

import json
import os
import re
import socket
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / '.qa-python'))
from playwright.sync_api import expect, sync_playwright

RUN = ROOT / '.qa-work' / ('web-search-ui-' + str(time.time_ns()))
HOME = RUN / 'home'
WORKSPACE = RUN / 'workspace'
SHOTS = RUN / 'screenshots'
for folder in [HOME / 'threads', WORKSPACE, SHOTS]:
    folder.mkdir(parents=True, exist_ok=True)

KEYS = {'tavily': 'tvly-QA-only-not-a-real-key-' + 'a' * 32,
        'deepseek': 'sk-QA-only-not-a-real-key-' + 'b' * 32}
SOURCE = 'https://sources.example.com/smalt-fixture'
EXISTING_SOURCE = 'https://sources.example.com/existing'
INJECTION = 'EXTERNAL_INJECTION_MUST_NEVER_BECOME_SYSTEM_INSTRUCTION'
FINAL = '已核对联网来源，外部正文作为资料处理。'
AT = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
for thread_id, title in [('th_search_a', '联网验证 A'), ('th_search_b', '独立对话 B')]:
    meta = {'id': thread_id, 'title': title, 'cwd': str(WORKSPACE),
            'model': 'web-search-fixture', 'provider': 'openai',
            'createdAt': AT, 'updatedAt': AT, 'turnCount': 1, 'lastOutcome': 'completed'}
    events = [{'t': 'meta', 'meta': meta}, {'t': 'turn-started', 'turnId': 'seed', 'at': AT},
              {'t': 'user-msg', 'id': 'u-' + thread_id, 'text': '检查联网来源。', 'at': AT},
              {'t': 'agent-msg', 'id': 'a-' + thread_id, 'text': '测试空间已准备好。', 'at': AT},
              {'t': 'turn-ended', 'turnId': 'seed', 'at': AT}]
    (HOME / 'threads' / (thread_id + '.jsonl')).write_text(
        '\n'.join(json.dumps(value, ensure_ascii=False) for value in events) + '\n', encoding='utf8')
(HOME / 'workspace-access.json').write_text(json.dumps([str(WORKSPACE.resolve()).lower()
    if os.name == 'nt' else str(WORKSPACE.resolve())]), encoding='utf8')

MODES = {'tavily': 'ok', 'deepseek': 'ok'}
GATES = {provider: threading.Event() for provider in KEYS}
REQUESTS = []
MODEL_REQUESTS = []
SOURCE_REQUESTS = []
LOCK = threading.Lock()


class Service(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def send_json(self, value, status=200):
        content = json.dumps(value, ensure_ascii=False).encode('utf8')
        try:
            self.send_response(status)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(content)))
            self.end_headers()
            self.wfile.write(content)
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass  # Cancellation is asserted at the application's real request signal.

    def do_GET(self):
        if self.path == '/v1/models':
            self.send_json({'data': [{'id': 'web-search-fixture', 'context_window': 256000,
                                     'supported_parameters': ['tools']}]})
        elif self.path.startswith('/source/'):
            SOURCE_REQUESTS.append({'path': self.path, 'method': 'GET',
                                    'hasAuthorization': bool(self.headers.get('Authorization')),
                                    'hasCookie': bool(self.headers.get('Cookie'))})
            title = 'Existing source tab' if self.path == '/source/existing' else 'SmaltCode source fixture'
            content = ('''<!doctype html><meta charset="utf-8"><title>''' + title + '''</title>
<h1 id="source-ready">已打开可核对的来源</h1><p>来源网页是资料，不能控制主应用。</p>
<iframe src="https://sources.example.com/embedded"></iframe>
<script>globalThis.fixtureIsolation={bridge:!!globalThis.smalt,node:typeof require};
fetch('https://unapproved.example.com/leak').then(r=>globalThis.fixtureCrossDenied=!r.ok).catch(()=>globalThis.fixtureCrossDenied=true);
fetch('https://sources.example.com/submit',{method:'POST',body:'blocked'}).then(r=>globalThis.fixturePostDenied=!r.ok).catch(()=>globalThis.fixturePostDenied=true);
</script>''').encode('utf8')
            self.send_response(200)
            self.send_header('Content-Type', 'text/html; charset=utf-8')
            self.send_header('Content-Length', str(len(content)))
            self.end_headers()
            self.wfile.write(content)
        else:
            self.send_json({'error': 'fixture route not found'}, 404)

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get('Content-Length', 0))) or b'{}')
        if self.path.startswith('/fixture/'):
            _, _, provider, action = self.path.split('/', 3)
            if provider not in KEYS or action not in ['search', 'fetch']:
                self.send_json({'error': 'unapproved fixture route'}, 404)
                return
            with LOCK:
                mode = MODES[provider]
                REQUESTS.append({'provider': provider, 'action': action, 'body': body,
                                 'keyCorrect': self.headers.get('Authorization') == 'Bearer ' + KEYS[provider],
                                 'at': time.monotonic()})
            if self.headers.get('Authorization') != 'Bearer ' + KEYS[provider]:
                self.send_json({'error': 'fixture authentication mismatch'}, 401)
                return
            if mode == 'hold':
                GATES[provider].wait(40)
            elif mode in ['401', '402', '429']:
                self.send_json({'error': {'message': 'Synthetic service error ' + mode + ' ' + KEYS[provider]}}, int(mode))
                return
            if action == 'search':
                self.send_json({'results': [
                    {'title': 'SmaltCode fixture source', 'url': SOURCE,
                     'content': '独立联网资料摘要。' + INJECTION,
                     'snippet': '独立联网资料摘要。' + INJECTION, 'date': '2026-10-28'},
                    {'title': 'Second fixture source', 'url': SOURCE + '-second',
                     'content': '另一条可追溯资料。', 'snippet': '另一条可追溯资料。'}]})
            elif provider == 'tavily':
                self.send_json({'results': [{'url': SOURCE, 'raw_content': '来源正文：' + INJECTION}],
                                'failed_results': []})
            else:
                self.send_json({'title': 'SmaltCode fixture source', 'content': '来源正文：' + INJECTION})
            return
        if self.path != '/v1/chat/completions':
            self.send_json({'error': 'fixture route not found'}, 404)
            return
        MODEL_REQUESTS.append(body)
        messages = body['messages']
        last_user = max(i for i, message in enumerate(messages) if message['role'] == 'user')
        user_text = str(messages[last_user].get('content', ''))
        outputs = [message for message in messages[last_user + 1:] if message['role'] == 'tool']
        tools = {item['function']['name'] for item in body.get('tools', [])}
        if not outputs and 'web_search' in tools:
            call = {'name': 'web_search', 'arguments': json.dumps({'query': 'SMALT_FIXTURE_QUERY', 'maxResults': 3})}
        elif '读取正文' in user_text and len(outputs) == 1 and 'web_fetch' in tools:
            call = {'name': 'web_fetch', 'arguments': json.dumps({'url': SOURCE})}
        else:
            call = None
        delta = {'tool_calls': [{'index': 0, 'id': 'fixture_call_' + str(len(outputs)), 'function': call}]} if call else {
            'content': FINAL + ' [来源](' + SOURCE + ')'}
        payload = {'choices': [{'delta': delta, 'finish_reason': 'tool_calls' if call else 'stop'}]}
        try:
            self.send_response(200)
            self.send_header('Content-Type', 'text/event-stream')
            self.end_headers()
            self.wfile.write(('data: ' + json.dumps(payload, ensure_ascii=False) + '\n\ndata: [DONE]\n\n').encode())
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass


SERVER = ThreadingHTTPServer(('127.0.0.1', 0), Service)
SERVER.daemon_threads = True
threading.Thread(target=SERVER.serve_forever, daemon=True).start()
ORIGIN = 'http://127.0.0.1:' + str(SERVER.server_port)
(HOME / 'settings.json').write_text(json.dumps({
    'defaultProvider': 'openai', 'defaultModel': 'web-search-fixture',
    'providers': {'openai': {'baseUrl': ORIGIN + '/v1', 'apiKey': 'model-QA-only-fake-key'}}}), encoding='utf8')
with socket.socket() as sock:
    sock.bind(('127.0.0.1', 0))
    PORT = sock.getsockname()[1]
QUIT = RUN / 'quit'
DENY_DIALOG = RUN / 'deny-dialog'
HOLD_DIALOG = RUN / 'hold-dialog'
TRANSPORT_LOG = RUN / 'transport.jsonl'
NATIVE_VIEWS = RUN / 'native-views.json'
SOURCE_PROBE = RUN / 'source-probe.json'
HARNESS = RUN / 'harness.cjs'
VERSION = json.loads((ROOT / 'packages/desktop/package.json').read_text(encoding='utf8'))['version']

# The wrapper is test-owned. Production continues to use DNS-pinned HTTPS and its
# fixed official URLs; this replacement never ships in the application bundle.
HARNESS.write_text("""
const {app,dialog,BrowserWindow}=require('electron'), fs=require('node:fs'), http=require('node:http'),
      https=require('node:https'), dns=require('node:dns/promises');
const origin=ORIGIN, logPath=TRANSPORT_LOG, nativeHttp=http.request,
      nativeLookup=dns.lookup, nativeFetch=global.fetch;
const endpoints=new Map([
 ['https://api.tavily.com/search',['tavily','search']],
 ['https://api.tavily.com/extract',['tavily','fetch']],
 ['https://api.deepseek.com/v1/tools/search',['deepseek','search']],
 ['https://api.deepseek.com/v1/tools/fetch',['deepseek','fetch']]
]);
const log=(value)=>fs.appendFileSync(logPath,JSON.stringify({...value,at:Date.now()})+'\\n');
dns.lookup=async(host,options)=>{
 if(['api.tavily.com','api.deepseek.com','sources.example.com'].includes(host))return [{address:'93.184.216.34',family:4}];
 if(['localhost','127.0.0.1','::1'].includes(host))return nativeLookup(host,options);
 throw Error('QA wrapper denied external DNS: '+host);
};
https.request=(input,options,callback)=>{
 const url=new URL(input);
 if(url.origin==='https://sources.example.com'&&['GET','HEAD'].includes(options.method)){
  log({event:'source-read',path:url.pathname});
  return nativeHttp(new URL('/source'+url.pathname,origin),{...options,lookup:undefined,family:4},callback);
 }
 const route=endpoints.get(url.href);
 if(!route){log({event:'denied-https',host:url.hostname,path:url.pathname});throw Error('QA wrapper denied external HTTPS');}
 const [provider,action]=route, next=new URL('/fixture/'+provider+'/'+action,origin),
       forwarded={...options,lookup:undefined,family:4};
 log({event:'start',provider,action});
 const req=nativeHttp(next,forwarded,callback);
 req.once('error',error=>log({event:error.name==='AbortError'||error.code==='ABORT_ERR'?'abort':'error',provider,action,code:error.code||error.name}));
 req.once('close',()=>log({event:'close',provider,action}));
 return req;
};
global.fetch=(input,init)=>{
 const url=new URL(typeof input==='string'||input instanceof URL?input:input.url);
 if(!['127.0.0.1','localhost','[::1]'].includes(url.hostname)){
  log({event:'denied-fetch',host:url.hostname,path:url.pathname});
  return Promise.reject(Error('QA wrapper denied external fetch'));
 }
 return nativeFetch(input,init);
};
require('node:module').syncBuiltinESMExports();
app.getVersion=()=>VERSION;
dialog.showMessageBox=async(...args)=>{
 const options=args.at(-1);
 if(options?.title==='允许访问网页'&&fs.existsSync(HOLD_DIALOG)){
  log({event:'consent-pending',title:options.title});
  while(fs.existsSync(HOLD_DIALOG))await new Promise(resolve=>setTimeout(resolve,20));
 }
 const response=fs.existsSync(DENY_DIALOG)?1:0;
 log({event:'consent',title:options?.title||'',message:options?.message||'',response});
 return {response};
};
let readingViews=false;
setInterval(async()=>{
 if(fs.existsSync(QUIT)){app.quit();return;}
 if(readingViews)return;
 const window=BrowserWindow.getAllWindows()[0];if(!window)return;
 readingViews=true;
 try{
  const views=window.contentView.children.filter(view=>view.webContents&&view.webContents!==window.webContents&&!view.webContents.isDestroyed());
  fs.writeFileSync(NATIVE_VIEWS,JSON.stringify(views.map(view=>({url:view.webContents.getURL(),bounds:view.getBounds()}))));
  for(const view of views){
   const wc=view.webContents;if(wc.getURL()!==SOURCE_URL||wc.isLoading())continue;
   const probe=await wc.executeJavaScript("({url:location.href,ready:!!document.querySelector('#source-ready'),isolation:globalThis.fixtureIsolation,process:typeof process,postDenied:globalThis.fixturePostDenied,crossDenied:globalThis.fixtureCrossDenied})");
   fs.writeFileSync(SOURCE_PROBE,JSON.stringify(probe));
   if(probe.ready&&!fs.existsSync(SOURCE_SHOT)){const bitmap=await wc.capturePage();fs.writeFileSync(SOURCE_SHOT,bitmap.toPNG());}
  }
 }catch(error){log({event:'native-probe-error',message:String(error)});}finally{readingViews=false;}
},100).unref();
require(MAIN);
""".replace('ORIGIN', json.dumps(ORIGIN)).replace('TRANSPORT_LOG', json.dumps(str(TRANSPORT_LOG)))
    .replace('VERSION', json.dumps(VERSION)).replace('QUIT', json.dumps(str(QUIT)))
    .replace('DENY_DIALOG', json.dumps(str(DENY_DIALOG)))
    .replace('HOLD_DIALOG', json.dumps(str(HOLD_DIALOG)))
    .replace('NATIVE_VIEWS', json.dumps(str(NATIVE_VIEWS))).replace('SOURCE_PROBE', json.dumps(str(SOURCE_PROBE)))
    .replace('SOURCE_URL', json.dumps(SOURCE)).replace('SOURCE_SHOT', json.dumps(str(SHOTS / 'source-sandbox.png')))
    .replace('MAIN', json.dumps(str(ROOT / 'packages/desktop/dist/main/index.js'))), encoding='utf8')

ENV = dict(os.environ, SMALT_HOME=str(HOME))
for key in list(ENV):
    if any(part in key.upper() for part in ['API_KEY', 'TOKEN', 'SECRET', 'PASSWORD', 'CREDENTIAL']) or key == 'ELECTRON_RUN_AS_NODE':
        ENV.pop(key, None)
LOG = open(RUN / 'electron.log', 'w', encoding='utf8')
PROCESS = None
CHECKS = []
ERRORS = []
PASSED = False
FORCED_CLEANUP = False
CLEANUP_ERRORS = []


def until(test, seconds=20):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if test():
            return
        time.sleep(.1)
    raise AssertionError('condition timed out; inspect ' + str(RUN))


def transport():
    if not TRANSPORT_LOG.exists():
        return []
    return [json.loads(line) for line in TRANSPORT_LOG.read_text(encoding='utf8').splitlines() if line]


def read_probe(path, default):
    try:
        return json.loads(path.read_text(encoding='utf8'))
    except (FileNotFoundError, PermissionError, json.JSONDecodeError):
        return default  # The fixture publishes again on its next timer tick.


def abort_count():
    return sum(item['event'] == 'abort' for item in transport())


def request_count(provider=None):
    with LOCK:
        return sum(provider is None or item['provider'] == provider for item in REQUESTS)


def mode(provider, value):
    with LOCK:
        MODES[provider] = value
    if value == 'hold':
        GATES[provider].clear()
    else:
        GATES[provider].set()


def state(page):
    value = page.evaluate("()=>window.smalt.webSearch('get')")
    assert not any(key in json.dumps(value) for key in KEYS.values()), 'Secret exposed by public IPC state'
    return value


def open_settings(page):
    page.get_by_role('button', name='设置 (Ctrl+,)', exact=True).click()
    page.get_by_test_id('settings-web-search').click()
    expect(page.get_by_test_id('web-search-settings')).to_be_visible()


def screenshot(page, name):
    page.screenshot(path=str(SHOTS / name), animations='disabled')


try:
    PROCESS = subprocess.Popen([str(os.environ.get('SMALT_TEST_ELECTRON_EXECUTABLE',
        ROOT / 'node_modules/electron/dist/electron.exe')), str(HARNESS), '--development-preview',
        '--identity-test', '--remote-debugging-port=' + str(PORT)], cwd=ROOT, env=ENV,
        stdout=LOG, stderr=LOG, creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
    with sync_playwright() as playwright:
        browser = None
        try:
            for _ in range(120):
                try:
                    browser = playwright.chromium.connect_over_cdp('http://127.0.0.1:' + str(PORT), timeout=500)
                    break
                except Exception:
                    if PROCESS.poll() is not None:
                        raise AssertionError('Fixture Electron exited before CDP startup')
                    time.sleep(.1)
            assert browser, 'Fixture Electron did not expose its own CDP port'
            until(lambda: any(page.url.startswith('file:') for context in browser.contexts for page in context.pages))
            page = next(page for context in browser.contexts for page in context.pages if page.url.startswith('file:'))
            page.on('pageerror', lambda error: ERRORS.append(str(error)))
            page.wait_for_load_state('networkidle')
            page.evaluate("cwd=>{localStorage.setItem('smalt.ui.onboarded','true');localStorage.setItem('smalt.ui.dark','false');localStorage.setItem('smalt.ui.workspace',JSON.stringify(cwd))}", str(WORKSPACE))
            page.reload()
            page.wait_for_load_state('networkidle')
            page.get_by_test_id('task-row').filter(has_text='联网验证 A').click()
            open_settings(page)
            panel = page.get_by_test_id('web-search-settings')
            expect(page.get_by_test_id('web-search-test')).to_be_disabled()
            initial = state(page)
            assert not initial['enabled'] and not any(value['configured'] for value in initial['providers'].values())
            expect(panel).to_contain_text('密钥')
            assert request_count() == 0, 'Opening settings sent an unrequested service request'
            CHECKS.append('Unconfigured default gives a visible setup path and sends no search request')

            page.get_by_test_id('web-search-provider').select_option('tavily')
            page.get_by_test_id('web-search-enabled').check()
            page.get_by_test_id('web-search-max-results').fill('3')
            page.get_by_test_id('web-search-key').fill(KEYS['tavily'])
            page.get_by_test_id('web-search-save').click()
            until(lambda: state(page)['providers']['tavily']['configured'])
            expect(page.get_by_test_id('web-search-key')).to_have_value('')
            page.get_by_test_id('web-search-key').fill('tvly-UNSAVED-QA-DRAFT-MUST-NOT-CROSS-VENDORS')
            expect(page.get_by_test_id('web-search-test')).to_be_disabled()
            page.get_by_test_id('web-search-provider').select_option('deepseek')
            expect(page.get_by_test_id('web-search-key')).to_have_value('')
            expect(page.get_by_test_id('web-search-test')).to_be_disabled()
            page.get_by_test_id('web-search-key').fill(KEYS['deepseek'])
            page.get_by_test_id('web-search-save-test').click()
            expect(page.get_by_test_id('web-search-result')).to_contain_text('SmaltCode fixture source', timeout=20000)
            assert REQUESTS[-1]['provider'] == 'deepseek' and REQUESTS[-1]['keyCorrect']
            page.get_by_test_id('web-search-provider').select_option('tavily')
            page.get_by_test_id('web-search-test').click()
            expect(page.get_by_test_id('web-search-result')).to_contain_text('SmaltCode fixture source', timeout=20000)
            assert REQUESTS[-1]['provider'] == 'tavily' and REQUESTS[-1]['keyCorrect']
            current = state(page)
            assert all(current['providers'][provider]['configured'] for provider in KEYS)
            assert current['enabled'] and current['maxResults'] == 3
            for path in HOME.glob('*.json'):
                assert not any(key.encode() in path.read_bytes() for key in KEYS.values()), 'Secret persisted as plaintext in ' + path.name
            assert current['storage'] in ['encrypted', 'session']
            if current['storage'] == 'session':
                expect(panel).to_contain_text('本次')
            page.get_by_test_id('web-search-max-results').fill('0')
            page.get_by_test_id('web-search-save').click()
            expect(page.get_by_test_id('web-search-error')).to_contain_text('1–10')
            assert state(page)['maxResults'] == 3
            page.get_by_test_id('web-search-max-results').fill('3')
            page.get_by_test_id('web-search-save').click()
            expect(page.get_by_test_id('web-search-status')).to_be_visible()
            screenshot(page, 'settings-light.png')
            CHECKS.append('Both services save/test through the real bridge; vendor switching never reuses the other key or returns a secret')

            for code, pattern in [('401', r'401|密钥|认证'), ('402', r'402|额度|余额|计费'),
                                  ('429', r'429|频率|限流|频繁|稍后')]:
                mode('tavily', code)
                other_requests = request_count('deepseek')
                before = request_count('tavily')
                page.get_by_test_id('web-search-test').click()
                alert = page.get_by_test_id('web-search-error')
                expect(alert).to_be_visible(timeout=20000)
                assert re.search(pattern, alert.inner_text()), alert.inner_text()
                assert not any(key in alert.inner_text() for key in KEYS.values())
                assert request_count('tavily') == before + 1 and request_count('deepseek') == other_requests
                expect(page.get_by_test_id('web-search-result')).not_to_be_visible()
            CHECKS.append('401 authentication, 402 balance and 429 rate limits remain visible, redact server-echoed keys, and never silently fall back')

            mode('tavily', 'hold')
            before = request_count('tavily')
            aborted = abort_count()
            page.get_by_test_id('web-search-test').click()
            until(lambda: request_count('tavily') == before + 1)
            page.get_by_test_id('web-search-cancel-test').click()
            until(lambda: abort_count() > aborted)
            expect(page.get_by_test_id('web-search-test')).to_be_enabled()
            mode('tavily', 'ok')
            CHECKS.append('Explicit cancellation aborts the actual transport request and restores test controls')

            mode('tavily', 'hold')
            before = request_count('tavily')
            aborted = abort_count()
            page.get_by_test_id('web-search-test').click()
            until(lambda: request_count('tavily') == before + 1)
            page.get_by_test_id('web-search-provider').select_option('deepseek')
            until(lambda: abort_count() > aborted)
            expect(page.get_by_test_id('web-search-key')).to_have_value('')
            expect(page.get_by_test_id('web-search-test')).to_be_enabled()
            assert state(page)['provider'] == 'tavily', 'Unsaved service selection changed active task configuration'
            mode('tavily', 'ok')
            page.get_by_test_id('web-search-provider').select_option('tavily')
            CHECKS.append('Switching service cancels its old test, discards draft credentials/results and leaves the saved task provider unchanged')

            mode('tavily', 'hold')
            before = request_count('tavily')
            aborted = abort_count()
            page.get_by_test_id('web-search-test').click()
            until(lambda: request_count('tavily') == before + 1)
            page.get_by_role('button', name='关闭设置', exact=True).click()
            until(lambda: abort_count() > aborted)
            mode('tavily', 'ok')
            open_settings(page)
            expect(page.get_by_test_id('web-search-test')).to_be_enabled()
            page.get_by_test_id('web-search-test').click()
            expect(page.get_by_test_id('web-search-result')).to_contain_text('SmaltCode fixture source', timeout=20000)
            CHECKS.append('Closing settings aborts its pending test; reopening starts cleanly and a new request can succeed')

            page.get_by_test_id('web-search-provider').select_option('deepseek')
            page.get_by_test_id('web-search-clear-key').click()
            expect(page.get_by_test_id('web-search-confirm-clear-key')).to_be_visible()
            panel.get_by_role('button', name='取消', exact=True).click()
            assert state(page)['providers']['deepseek']['configured']
            page.get_by_test_id('web-search-clear-key').click()
            page.get_by_test_id('web-search-confirm-clear-key').click()
            until(lambda: not state(page)['providers']['deepseek']['configured'])
            assert state(page)['providers']['tavily']['configured']
            expect(page.get_by_test_id('web-search-test')).to_be_disabled()
            page.get_by_test_id('web-search-provider').select_option('tavily')
            page.get_by_test_id('web-search-save').click()
            until(lambda: state(page)['provider'] == 'tavily')
            page.get_by_role('button', name='关闭设置', exact=True).click()
            CHECKS.append('Confirmed credential deletion affects only the selected service and preserves the other configured provider')

            page.get_by_role('button', name='打开浏览与网页预览', exact=True).click()
            page.get_by_label('网页地址', exact=True).fill(EXISTING_SOURCE)
            page.get_by_role('button', name='新标签', exact=True).click()
            expect(page.get_by_role('tab', name='Existing source tab', exact=True)).to_have_attribute('aria-selected', 'true')
            until(lambda: any(value['url'] == EXISTING_SOURCE for value in read_probe(NATIVE_VIEWS, [])))
            page.get_by_role('button', name='收起面板', exact=True).click()

            # The fixture model requests real web_search/web_fetch tools from the bridge.
            mode('tavily', 'hold')
            before = request_count('tavily')
            page.get_by_label('任务输入', exact=True).fill('联网搜索并读取正文，核对来源。')
            page.get_by_role('button', name='发送', exact=True).click()
            deadline = time.monotonic() + 20
            while request_count('tavily') == before and time.monotonic() < deadline:
                approval = page.get_by_test_id('approval')
                if approval.is_visible():
                    approval.get_by_role('button', name='允许', exact=True).click()
                page.wait_for_timeout(100)
            assert request_count('tavily') > before, 'Real web_search tool did not reach the service fixture'
            page.get_by_test_id('task-row').filter(has_text='独立对话 B').click()
            expect(page.get_by_label('任务输入', exact=True)).to_be_enabled()
            expect(page.get_by_test_id('item-agentMessage').filter(has_text=FINAL)).to_have_count(0)
            mode('tavily', 'ok')
            page.get_by_test_id('task-row').filter(has_text='联网验证 A').click()
            deadline = time.monotonic() + 25
            while time.monotonic() < deadline:
                approval = page.get_by_test_id('approval')
                if approval.is_visible():
                    approval.get_by_role('button', name='允许', exact=True).click()
                if page.get_by_test_id('item-agentMessage').filter(has_text=FINAL).is_visible():
                    break
                page.wait_for_timeout(100)
            answer = page.get_by_test_id('item-agentMessage').filter(has_text=FINAL)
            expect(answer).to_be_visible()
            citation = answer.get_by_role('link', name='来源', exact=True)
            expect(citation).to_have_attribute('title', SOURCE)
            expect(citation).to_have_attribute('data-source-url', SOURCE)
            expect(answer.get_by_test_id('source-copy-link')).to_be_visible()
            assert any(item['action'] == 'fetch' for item in REQUESTS), 'web_fetch was not exercised'
            tool_outputs = [message for request in MODEL_REQUESTS for message in request['messages'] if message['role'] == 'tool']
            assert any(INJECTION in str(message.get('content')) for message in tool_outputs)
            assert any('externalContent' in str(message.get('content')) for message in tool_outputs)
            search_outputs = [json.loads(message['content']) for message in tool_outputs
                              if isinstance(message.get('content'), str) and message['content'].startswith('{')]
            assert any(value.get('query') == 'SMALT_FIXTURE_QUERY' and value.get('sources')
                       for value in search_outputs), 'Search result lost its query or source references'
            system = '\n'.join(str(message.get('content')) for request in MODEL_REQUESTS for message in request['messages'] if message['role'] == 'system')
            assert INJECTION not in system
            assert not any(key in json.dumps(MODEL_REQUESTS) for key in KEYS.values())
            consent_before = sum(item['event'] == 'consent' and item.get('title') == '允许访问网页' for item in transport())
            source_reads_before = len(SOURCE_REQUESTS)
            DENY_DIALOG.write_text('deny', encoding='utf8')
            citation.click()
            until(lambda: sum(item['event'] == 'consent' and item.get('title') == '允许访问网页' for item in transport()) > consent_before)
            expect(answer.get_by_test_id('source-link-status')).to_contain_text('取消')
            assert len(page.evaluate("()=>window.smalt.browser('list',{threadId:'th_search_a'})")['tabs']) == 1
            assert len(SOURCE_REQUESTS) == source_reads_before, 'Denying native source authorization still requested the page'
            DENY_DIALOG.unlink()
            citation.click()
            expect(page.get_by_test_id('browser-panel')).to_be_visible(timeout=15000)
            until(lambda: read_probe(SOURCE_PROBE, {}).get('ready') is True)
            until(lambda: read_probe(SOURCE_PROBE, {}).get('postDenied') is True
                  and read_probe(SOURCE_PROBE, {}).get('crossDenied') is True)
            probe = read_probe(SOURCE_PROBE, {})
            assert probe['url'] == SOURCE
            assert probe['isolation'] == {'bridge': False, 'node': 'undefined'}
            assert probe['process'] == 'undefined'
            until(lambda: (SHOTS / 'source-sandbox.png').exists())
            tabs_a = page.evaluate("()=>window.smalt.browser('list',{threadId:'th_search_a'})")['tabs']
            assert len(tabs_a) == 2 and {value['url'] for value in tabs_a} == {SOURCE, EXISTING_SOURCE}
            expect(page.get_by_role('tab', name='SmaltCode source fixture', exact=True)).to_have_attribute('aria-selected', 'true')
            assert not page.evaluate("()=>window.smalt.browser('list',{threadId:'th_search_b'})")['tabs']
            consent_after = sum(item['event'] == 'consent' and item.get('title') == '允许访问网页' for item in transport())
            assert consent_after == consent_before + 2, 'Opening or retrying a source skipped the native site authorization'
            assert SOURCE_REQUESTS and all(not item['hasAuthorization'] and not item['hasCookie'] for item in SOURCE_REQUESTS)
            assert not any('/embedded' in item['path'] or '/submit' in item['path'] for item in SOURCE_REQUESTS)
            assert not any(item['event'] == 'denied-https' and item.get('host') == 'unapproved.example.com' for item in transport()), 'Unauthorized source crossed browser transport policy'
            page.get_by_test_id('task-row').filter(has_text='独立对话 B').click()
            expect(page.get_by_test_id('item-agentMessage').filter(has_text=FINAL)).to_have_count(0)
            assert not page.evaluate("()=>window.smalt.browser('list',{threadId:'th_search_b'})")['tabs']
            until(lambda: not read_probe(NATIVE_VIEWS, [None]))
            page.get_by_test_id('task-row').filter(has_text='联网验证 A').click()
            expect(page.get_by_role('tab', name='SmaltCode source fixture', exact=True)).to_be_visible()
            until(lambda: len(read_probe(NATIVE_VIEWS, [])) == 1)
            screenshot(page, 'sources-light.png')
            # A delayed open belongs to its original conversation. Returning to A
            # consumes its target once; later manual tab choices must persist.
            pending_before = sum(item['event'] == 'consent-pending' for item in transport())
            HOLD_DIALOG.write_text('hold', encoding='utf8')
            citation.click()
            until(lambda: sum(item['event'] == 'consent-pending' for item in transport()) > pending_before)
            page.get_by_test_id('task-row').filter(has_text='独立对话 B').click()
            HOLD_DIALOG.unlink()
            until(lambda: len(page.evaluate("()=>window.smalt.browser('list',{threadId:'th_search_a'})")['tabs']) == 3)
            expect(page.get_by_test_id('item-agentMessage').filter(has_text=FINAL)).to_have_count(0)
            expect(page.get_by_test_id('browser-panel')).not_to_be_visible()
            assert not page.evaluate("()=>window.smalt.browser('list',{threadId:'th_search_b'})")['tabs']
            until(lambda: not read_probe(NATIVE_VIEWS, [None]))
            page.get_by_test_id('task-row').filter(has_text='联网验证 A').click()
            source_tabs = page.get_by_role('tab', name='SmaltCode source fixture', exact=True)
            expect(source_tabs).to_have_count(2)
            expect(source_tabs.nth(1)).to_have_attribute('aria-selected', 'true')
            page.get_by_role('tab', name='Existing source tab', exact=True).click()
            until(lambda: any(value['url'] == EXISTING_SOURCE for value in read_probe(NATIVE_VIEWS, [])))
            page.get_by_test_id('task-row').filter(has_text='独立对话 B').click()
            page.get_by_test_id('task-row').filter(has_text='联网验证 A').click()
            expect(page.get_by_role('tab', name='Existing source tab', exact=True)).to_have_attribute('aria-selected', 'true')
            until(lambda: any(value['url'] == EXISTING_SOURCE for value in read_probe(NATIVE_VIEWS, [])))
            CHECKS.append('Citations select their new tab when another tab exists; a late result never opens another conversation pane, consumes its target once on return, and preserves later manual tab choices')
            page.get_by_role('button', name='收起面板', exact=True).click()
            page.get_by_role('button', name='切换主题', exact=True).click()
            open_settings(page)
            screenshot(page, 'settings-dark.png')
            CHECKS.append('Real search/fetch tools return query and traceable sources; external instructions stay in marked tool data, while browsing and conversation switching remain responsive and isolated')
            CHECKS.append('A citation sends no page request after denied consent, then opens its original-thread browser tab after explicit site approval; the page has no Node or app bridge, receives no credentials/cookies, and cannot issue POST, embedded-frame or cross-site reads')

            # A pending settings test must also abort during explicit application exit.
            mode('tavily', 'hold')
            before = request_count('tavily')
            aborted = abort_count()
            page.get_by_test_id('web-search-test').click()
            until(lambda: request_count('tavily') == before + 1)
            QUIT.write_text('quit', encoding='utf8')
            PROCESS.wait(timeout=20)
            assert PROCESS.returncode == 0, 'Explicit fixture quit returned an error'
            assert abort_count() > aborted, 'Application exit did not abort its pending service request'
            history_a = (HOME / 'threads/th_search_a.jsonl').read_text(encoding='utf8')
            history_b = (HOME / 'threads/th_search_b.jsonl').read_text(encoding='utf8')
            assert all(value in history_a for value in ['SMALT_FIXTURE_QUERY', SOURCE, INJECTION, FINAL])
            assert not any(value in history_b for value in ['SMALT_FIXTURE_QUERY', SOURCE, INJECTION, FINAL])
            CHECKS.append('Explicit exit aborts pending web requests without leaving an app-owned process running')
            CHECKS.append('Persisted conversation A owns all search/tool/source events; unrelated conversation B contains none of their query, external content or reply')
            assert not ERRORS, ERRORS
            PASSED = True
        finally:
            for gate in GATES.values():
                gate.set()
finally:
    # This also runs if Playwright's driver fails during __enter__, before its
    # inner finally exists. Only the exact process handle created above is owned.
    for gate in GATES.values():
        gate.set()
    HOLD_DIALOG.unlink(missing_ok=True)
    try:
        if PROCESS is not None:
            if PROCESS.poll() is None:
                QUIT.write_text('quit', encoding='utf8')
            try:
                PROCESS.wait(timeout=20)
            except subprocess.TimeoutExpired:
                FORCED_CLEANUP = True
                PASSED = False
                if PROCESS.poll() is None:
                    if os.name == 'nt':
                        subprocess.run(['taskkill', '/PID', str(PROCESS.pid), '/T', '/F'],
                                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                       creationflags=subprocess.CREATE_NO_WINDOW, timeout=15)
                    else:
                        PROCESS.terminate()
                PROCESS.wait(timeout=10)
    except Exception as cleanup_error:
        PASSED = False
        CLEANUP_ERRORS.append(type(cleanup_error).__name__ + ': ' + str(cleanup_error))
    LOG.close()
    SERVER.shutdown()
    SERVER.server_close()
    evidence = {'passed': PASSED and not FORCED_CLEANUP, 'checks': CHECKS, 'rendererErrors': ERRORS,
                'fixture': str(RUN), 'modelRequests': len(MODEL_REQUESTS),
                'serviceRequests': [{'provider': item['provider'], 'action': item['action'],
                                     'keyCorrect': item['keyCorrect']} for item in REQUESTS],
                'sourceRequests': SOURCE_REQUESTS,
                'sourceProbe': read_probe(SOURCE_PROBE, {}),
                'transport': transport(), 'screenshots': [str(path) for path in SHOTS.glob('*.png')],
                'isolatedProfile': True, 'identityTestLaunch': True,
                'forcedCleanup': FORCED_CLEANUP, 'cleanupErrors': CLEANUP_ERRORS,
                'fixturePid': PROCESS.pid if PROCESS is not None else None,
                'fixtureReturnCode': PROCESS.returncode if PROCESS is not None else None}
    (RUN / 'results.json').write_text(json.dumps(evidence, ensure_ascii=False, indent=2), encoding='utf8')
    print(json.dumps(evidence, ensure_ascii=False, indent=2))
    if FORCED_CLEANUP or CLEANUP_ERRORS:
        raise AssertionError('Fixture required forced process cleanup; this is not a passing regression')
