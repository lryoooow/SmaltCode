import { BrowserWindow, WebContentsView, session, dialog, type WebContents } from 'electron';
import { randomUUID } from 'node:crypto';
import { basename, dirname, resolve } from 'node:path';
import { readBounded } from './read-bounded.js';
import { browserURL, browserRequestAllowed, localPreviewAsset, browserCSP } from './browser-policy.js';
import { browserFetch } from './browser-network.js';
import { readContextFile } from './context-files.js';
import { FeedbackStore } from './feedback.js';
import type { BrowserTab } from '../shared/browser.js';

type Entry = { state: BrowserTab; view: WebContentsView; cwd: string; fileCwd?:string; root?: string; origin: string; inflight: number; picking: boolean; navigation: number };
const picker = `new Promise(resolve => {
  if (globalThis.__smaltPickCancel) globalThis.__smaltPickCancel();
  const marker=document.createElement('div');marker.style.cssText='position:fixed;pointer-events:none;z-index:2147483647;border:2px solid #6366f1;background:#6366f11a;box-sizing:border-box';document.documentElement.append(marker);
  let timer;
  const clean=()=>{clearTimeout(timer);document.removeEventListener('pointermove',move,true);document.removeEventListener('click',click,true);document.removeEventListener('keydown',key,true);marker.remove();delete globalThis.__smaltPickCancel};
  const cancel=()=>{clean();resolve(null)};globalThis.__smaltPickCancel=cancel;
  const move=e=>{const r=e.target.getBoundingClientRect();Object.assign(marker.style,{left:r.x+'px',top:r.y+'px',width:r.width+'px',height:r.height+'px'})};
  const click=e=>{e.preventDefault();e.stopImmediatePropagation();const el=e.target,r=el.getBoundingClientRect();let node=el,parts=[];for(let i=0;node&&i<6;i++,node=node.parentElement){let p=node.tagName.toLowerCase();if(node.id){p+='#'+CSS.escape(node.id);parts.unshift(p);break}if(node.parentElement)p+=':nth-child('+([...node.parentElement.children].indexOf(node)+1)+')';parts.unshift(p)}const sensitive=!!el.closest('input,textarea,[contenteditable=true]')||!!el.querySelector('input,textarea,[contenteditable=true]');const out={selector:parts.join(' > ').slice(0,1000),sensitive,text:sensitive?'[表单输入内容不采集]':(el.innerText||el.getAttribute('alt')||'').slice(0,6000),rect:{x:Math.max(0,r.x),y:Math.max(0,r.y),width:Math.max(0,Math.min(r.right,innerWidth)-Math.max(0,r.x)),height:Math.max(0,Math.min(r.bottom,innerHeight)-Math.max(0,r.y))},viewport:{width:innerWidth,height:innerHeight},tag:el.tagName};clean();resolve(out)};
  const key=e=>{if(e.key==='Escape'){e.preventDefault();e.stopImmediatePropagation();cancel()}};document.addEventListener('pointermove',move,true);document.addEventListener('click',click,true);document.addEventListener('keydown',key,true);timer=setTimeout(cancel,30000)
})`;

export class BrowserManager {
  private entries = new Map<string, Entry>();
  private attached?: Entry;
  private epoch = 0;
  private notification?: ReturnType<typeof setTimeout>;
  private changed() { if (!this.notification) this.notification = setTimeout(() => { this.notification = undefined; if (!this.owner.isDestroyed()) this.notify(); }, 50); }

  constructor(private owner: WebContents, private thread: (id: string) => { cwd: string }, private feedback: FeedbackStore, private notify: () => void, private fileScope?:(threadId:string,path:string)=>string) {
    const window=BrowserWindow.fromWebContents(owner),restore=()=>{setTimeout(()=>{const p=this.pendingLayout;if(p&&!owner.isDestroyed())try{this.layout(p.threadId,p.id,p.bounds);}catch{/* target was revoked */}},30).unref();};
    window?.on('show',restore);window?.on('restore',restore);window?.on('resize',restore);
    owner.on('did-start-loading', () => { this.epoch++; this.hide(); });
    owner.on('render-process-gone', () => { this.epoch++; this.hide(); });
    owner.once('destroyed', () => this.dispose());
  }
  list(threadId: string) { this.thread(threadId); return { tabs: [...this.entries.values()].filter(entry => entry.state.threadId === threadId).map(entry => ({ ...entry.state })) }; }
  private get(threadId: string, id: unknown) {
    const entry = this.entries.get(String(id)); this.thread(threadId);
    if (!entry || entry.state.threadId !== threadId) throw new Error('网页不属于当前对话或已关闭');
    return entry;
  }
  private update(entry: Entry) {
    if (entry.view.webContents.isDestroyed()) return;
    const wc = entry.view.webContents;
    Object.assign(entry.state, { title: (wc.getTitle() || entry.state.localPath && basename(entry.state.localPath) || '网页').slice(0, 200), url: wc.getURL() || entry.state.url, back: wc.navigationHistory.canGoBack(), forward: wc.navigationHistory.canGoForward(), loading: wc.isLoading() });
    if (entry.root) try { entry.state.localPath = localPreviewAsset(entry.fileCwd??entry.cwd, entry.root, new URL(entry.state.url).pathname).path; } catch { /* initial about:blank */ }
    this.changed();
  }
  async openHTML(threadId: string, html: string, source: string) {
    if (Buffer.byteLength(html) > 512 * 1024) throw new Error('交互内容超过 512 KB');
    return this.open(threadId, {}, { html, source });
  }
  async open(threadId: string, value: { url?: unknown; path?: unknown }, content?: { html: string; source: string }) {
    const cwd = this.thread(threadId).cwd, epoch = this.epoch;
    if (this.entries.size >= 16 || this.list(threadId).tabs.length >= 6) throw new Error('每对话最多 6 个网页，全应用最多 16 个；请先关闭部分标签');
    const local = typeof value.path === 'string' ? resolve(cwd, value.path) : undefined;
    const fileCwd=local&&this.fileScope?this.fileScope(threadId,local):cwd;
    let url: string, root: string | undefined;
    const id = 'web_' + randomUUID();
    if (content) url = 'smalt-preview://' + id.replace(/_/g, '-') + '/index.html';
    else if (local) {
      if (!/\.html?$/i.test(local)) throw new Error('请选择 HTML 文件');
      await readContextFile(fileCwd, local); root = dirname(local);
      const result = await dialog.showMessageBox({ type: 'question', title: '预览本地网页', message: '允许执行此 HTML 及同目录下的静态资源？', detail: `${local}\n\n页面使用独立沙箱，不能调用 SmaltCode 桥接接口；默认断网。静态资源仅限此目录内的 HTML、脚本、样式、图片、字体和 JSON。`, buttons: ['打开预览', '取消'], defaultId: 1, cancelId: 1 });
      if (result.response !== 0) throw new Error('已取消网页预览');
      if(this.fileScope&&this.fileScope(threadId,local)!==fileCwd)throw Error('网页资料范围已变化');
      url = 'smalt-preview://' + id.replace(/_/g, '-') + '/' + encodeURIComponent(basename(local));
    } else {
      const target = browserURL(value.url);
      const result = await dialog.showMessageBox({ type: 'question', title: '允许访问网页', message: '在隔离浏览视图中打开这个站点？', detail: `${target.origin}\n\n仅允许此来源的只读 GET / HEAD 请求；跨站资源、表单提交、新窗口、下载与设备权限默认阻止，不复用系统浏览器登录态。需要其他来源时在“站点权限”中单独授权。`, buttons: ['允许此站点', '取消'], defaultId: 1, cancelId: 1 });
      if (result.response !== 0) throw new Error('已取消站点访问');
      url = target.href;
    }
    if (epoch !== this.epoch || this.owner.isDestroyed()) throw new Error('界面已重载，请重新打开网页');
    this.thread(threadId);
    if (this.entries.size >= 16 || this.list(threadId).tabs.length >= 6) throw new Error('网页标签数量已达上限');
    const ses = session.fromPartition('smalt-browser-' + randomUUID(), { cache: false });
    // Chromium's native network stack has no direct egress. Authorized reads use
    // the bounded DNS-pinned Node transport below; WebRTC cannot bypass it by UDP.
    await ses.setProxy({ mode: 'fixed_servers', proxyRules: 'socks5://127.0.0.1:9', proxyBypassRules: '<-loopback>' });
    if (epoch !== this.epoch || this.owner.isDestroyed()) throw new Error('界面已重载，请重新打开网页');
    if (this.entries.size >= 16 || this.list(threadId).tabs.length >= 6) throw new Error('网页标签数量已达上限');
    ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false)); ses.setPermissionCheckHandler(() => false);
    ses.setDevicePermissionHandler(() => false);
    const view = new WebContentsView({ webPreferences: { session: ses, sandbox: true, contextIsolation: true, nodeIntegration: false, nodeIntegrationInSubFrames: false, webSecurity: true, allowRunningInsecureContent: false, navigateOnDragDrop: false, safeDialogs: true, disableDialogs: true, spellcheck: false, devTools: false } });
    const origin = local || content ? new URL(url).protocol + '//' + new URL(url).host : new URL(url).origin;
    const entry: Entry = { view, cwd, fileCwd, root, origin, inflight: 0, picking: false, navigation: 0, state: { id, threadId, title: content ? '外部交互内容' : local ? basename(local) : new URL(url).hostname, notice: content ? '外部来源：' + content.source + '。独立沙箱，默认断网，无工具调用权限。' : undefined, url, localPath: local, externalSource: content?.source, loading: true, back: false, forward: false, zoom: 1, sources: local || content ? [] : [origin] } };
    this.entries.set(id, entry);
    const wc = view.webContents;
    wc.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');
    const notice = (message: string, pendingURL?: string) => { entry.state.notice = message; entry.state.pendingURL = pendingURL; this.changed(); };
    ses.on('will-download', (event, item) => { event.preventDefault(); notice('已阻止下载：' + item.getFilename().slice(0, 200)); });
    ses.webRequest.onBeforeRequest((details, callback) => {
      const allowed = [origin, ...entry.state.sources].some(source => browserRequestAllowed(details.url, source)) && details.resourceType !== 'webSocket' && ['GET', 'HEAD'].includes(details.method);
      if (!allowed && !details.url.startsWith('devtools:')) {
        let source = ''; try { const blocked = new URL(details.url); source = blocked.origin === 'null' ? blocked.protocol : blocked.origin; } catch {}
        notice(details.resourceType === 'webSocket' ? '审阅模式不连接 WebSocket；开发页可手动刷新。' : !['GET', 'HEAD'].includes(details.method) ? '只读审阅已阻止 ' + details.method + ' 请求。' : '此来源尚未授权：' + source + '。可在“站点权限”中核对。');
      }
      callback({ cancel: !allowed });
    });
    const transport = async (request: Request) => {
      if (entry.inflight >= 6) return new Response('请求过多', { status: 429 });
      entry.inflight++;
      try {
        const granted = [origin, ...entry.state.sources].find(source => browserRequestAllowed(request.url, source));
        if (wc.isDestroyed() || !granted || !['GET', 'HEAD'].includes(request.method)) return new Response('未授权来源', { status: 403 });
        if (content && new URL(request.url).protocol === 'smalt-preview:') return new Response(new URL(request.url).pathname === '/index.html' ? content.html : '资源不存在', { status: new URL(request.url).pathname === '/index.html' ? 200 : 404, headers: { 'Content-Type': 'text/html; charset=utf-8', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': browserCSP(entry.state.sources) } });
        if (root && new URL(request.url).protocol === 'smalt-preview:') {
          if(local&&this.fileScope&&this.fileScope(threadId,local)!==fileCwd)throw Error('网页访问范围已变化');
          const asset = localPreviewAsset(fileCwd, root, new URL(request.url).pathname), bytes = await readBounded(asset.path, 8 * 1024 * 1024);
          localPreviewAsset(fileCwd, root, new URL(request.url).pathname);
          if(local&&this.fileScope&&this.fileScope(threadId,local)!==fileCwd)throw Error('网页访问范围已变化');
          return new Response(request.method === 'HEAD' ? null : new Uint8Array(bytes).buffer, { headers: { 'Content-Type': asset.contentType, 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': browserCSP(entry.state.sources) } });
        }
        const result = await browserFetch(request, granted, entry.state.sources);
        return !wc.isDestroyed() && [entry.origin, ...entry.state.sources].some(source => browserRequestAllowed(request.url, source)) ? result : new Response('来源授权已撤销', { status: 403 });
      } catch (error) { notice(error instanceof Error ? error.message : '资源读取失败'); return new Response('无法加载预览资源', { status: 502 }); }
      finally { entry.inflight--; }
    };
    for (const scheme of ['http', 'https', ...(local || content ? ['smalt-preview'] : [])]) ses.protocol.handle(scheme, transport);
    wc.setWindowOpenHandler(details => { let pending: string | undefined; try { pending = browserURL(details.url).href; } catch {} notice('页面请求打开新窗口。请核对地址后手动打开。', pending); return { action: 'deny' }; });
    wc.on('will-frame-navigate', details => { if (!browserRequestAllowed(details.url, origin) || !details.isMainFrame) { details.preventDefault(); let pending: string | undefined; try { pending = browserURL(details.url).href; } catch {} notice('已阻止跨站或嵌入页面导航。', pending); } });
    wc.on('will-prevent-unload', event => event.preventDefault());
    wc.on('console-message', details => {
      if (!details.message.includes('Content Security Policy')) return;
      const match = details.message.match(/https?:\/\/[^\s'"<>]+/);
      let source = ''; try { if (match) source = browserURL(match[0]).origin; } catch {}
      notice('页面资源受到沙箱策略限制' + (source ? '：' + source : '') + '。所需 CDN 或开发 API 可在“站点权限”中单独核对授权。');
    });
    wc.on('did-start-loading', () => { entry.state.error = undefined; this.update(entry); });
    wc.on('did-start-navigation', details => { if (details.isMainFrame) entry.navigation++; });
    wc.on('did-stop-loading', () => this.update(entry)); wc.on('page-title-updated', () => this.update(entry)); wc.on('did-navigate-in-page', () => this.update(entry));
    wc.on('did-fail-load', (_event, code, message, _url, main) => { if (main && code !== -3) { entry.state.error = `页面加载失败（${code}）：${message}`; this.update(entry); } });
    wc.on('render-process-gone', () => { entry.state.error = '页面进程已停止，可刷新重试'; entry.state.loading = false; this.changed(); });
    wc.on('before-input-event', (event, input) => {
      if (input.type === 'keyDown' && input.key === 'Escape' && !entry.picking) { event.preventDefault(); this.owner.focus(); this.owner.send('smalt:browser-shortcut', { key: 'Escape', control: false }); return; }
      if (input.type !== 'keyDown' || !(input.control || input.meta) || !['k', 'b', 'j', 'n', ',', 'w', 'l', 'tab'].includes(input.key.toLowerCase())) return;
      event.preventDefault();
      if (input.key.toLowerCase() === 'w') { this.close(entry); this.changed(); this.owner.focus(); return; }
      this.owner.focus(); this.owner.send('smalt:browser-shortcut', { key: input.key, control: true, shift: input.shift });
    });
    void wc.loadURL(url).catch(() => {}); this.changed(); return { id };
  }
  hide() { if (this.attached) { const win = BrowserWindow.fromWebContents(this.owner); win?.contentView.removeChildView(this.attached.view); this.attached = undefined; } }
  private pendingLayout?:{threadId:string;id:unknown;bounds:{x:number;y:number;width:number;height:number}};
  layout(threadId: string, id: unknown, bounds?: { x: number; y: number; width: number; height: number }) {
    const entry = this.get(threadId, id), win = BrowserWindow.fromWebContents(this.owner);
    if (!bounds || !win || ![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite)) {if(this.pendingLayout?.id===id)this.pendingLayout=undefined; if (this.attached === entry) this.hide(); return; }
    this.pendingLayout={threadId,id,bounds};
    const zoom = this.owner.getZoomFactor(), size = win.getContentSize();
    const x = Math.max(0, Math.round(bounds.x * zoom)), y = Math.max(0, Math.round(bounds.y * zoom));
    const width = Math.min(Math.round(bounds.width * zoom), size[0]! - x), height = Math.min(Math.round(bounds.height * zoom), size[1]! - y);
    if (width < 40 || height < 40) { if (this.attached === entry) this.hide(); return; }
    if (this.attached !== entry) { this.hide(); win.contentView.addChildView(entry.view); this.attached = entry; }
    entry.view.setBounds({ x, y, width, height });
  }
  async action(threadId: string, action: string, value: Record<string, unknown>) {
    if (action === 'list') return this.list(threadId);
    if (action === 'open') return this.open(threadId, value);
    const entry = this.get(threadId, value.id), wc = entry.view.webContents;
    if (action === 'layout') { this.layout(threadId, value.id, value.bounds as never); return; }
    if (action === 'close') { this.close(entry); this.changed(); return; }
    if (action === 'dismiss-notice') { entry.state.notice = undefined; entry.state.pendingURL = undefined; this.changed(); return; }
    if (action === 'grant-source') {
      const source = browserURL(value.url).origin;
      if (entry.state.sources.includes(source)) return;
      if (entry.state.sources.length >= 8) throw new Error('每个网页最多授权 8 个网络来源');
      const result = await dialog.showMessageBox({ type: 'question', title: '授权网页资源来源', message: '允许此标签读取这个来源的页面、脚本和资源？', detail: source + '\n\n仅 GET / HEAD；同来源脚本可读取当前页面内容。不会传送系统浏览器 Cookie 或模型密钥。授权后刷新当前页；仅此标签生效，关闭标签后失效。', buttons: ['授权并刷新', '取消'], defaultId: 1, cancelId: 1 });
      if (result.response !== 0) throw new Error('已取消来源授权');
      this.get(threadId, value.id);
      if (entry.state.sources.length >= 8) throw new Error('网页来源授权已达上限');
      if (!entry.state.sources.includes(source)) entry.state.sources.push(source);
      wc.reload(); this.changed(); return;
    }
    if (action === 'revoke-source') {
      const source = browserURL(value.url).origin;
      if (source === entry.origin) throw new Error('关闭此标签即可撤销当前站点的授权');
      entry.state.sources = entry.state.sources.filter(value => value !== source); wc.reload(); this.changed(); return;
    }
    if (action === 'reload') wc.reload();
    else if (action === 'back' && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
    else if (action === 'forward' && wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
    else if (action === 'stop') wc.stop();
    else if (action === 'zoom') { if (typeof value.zoom !== 'number' || ![.5, .75, 1, 1.25, 1.5, 2].includes(value.zoom)) throw new Error('无效的缩放比例'); wc.setZoomFactor(value.zoom); entry.state.zoom = value.zoom; this.changed(); }
    else if (action === 'navigate') { const target = browserURL(value.url); if (!browserRequestAllowed(target.href, entry.origin)) throw new Error('来源不同，请新建标签并授权该站点'); void wc.loadURL(target.href).catch(() => {}); }
    else if (action === 'cancel-pick') await wc.executeJavaScriptInIsolatedWorld(998, [{ code: 'globalThis.__smaltPickCancel?.()' }]);
    else if (action === 'pick') {
      if (entry.picking || this.attached !== entry || entry.state.loading) throw new Error('请等待页面就绪后在当前可见页面选择元素');
      entry.picking = true; const url = wc.getURL(), navigation = entry.navigation;
      try {
        const result = await wc.executeJavaScriptInIsolatedWorld(998, [{ code: picker }], true);
        if (!result) return null;
        if (wc.isDestroyed() || wc.getURL() !== url || entry.navigation !== navigation || !this.entries.has(entry.state.id)) throw new Error('页面已变化，请重新选择');
        if (typeof result.selector !== 'string' || typeof result.text !== 'string' || result.selector.length > 1000 || result.text.length > 6000) throw new Error('元素内容无效');
        const capturedAt = new Date().toISOString(), source = entry.state.localPath ?? url;
        const rect = result.rect, viewport = result.viewport;
        if (!rect || !viewport || ![rect.x, rect.y, rect.width, rect.height, viewport.width, viewport.height].every(n => typeof n === 'number' && Number.isFinite(n) && n >= 0) || !viewport.width || !viewport.height) throw new Error('元素坐标已失效');
        const shot = await wc.capturePage(), size = shot.getSize(), x = Math.floor(Math.min(rect.x / viewport.width, .999) * size.width), y = Math.floor(Math.min(rect.y / viewport.height, .999) * size.height);
        let crop = shot.crop({ x, y, width: Math.max(1, Math.min(size.width - x, Math.round(rect.width / viewport.width * size.width))), height: Math.max(1, Math.min(size.height - y, Math.round(rect.height / viewport.height * size.height))) });
        const scale = Math.min(1, 1200 / crop.getSize().width, 1200 / crop.getSize().height);
        if (scale < 1) crop = crop.resize({ width: Math.max(1, Math.round(crop.getSize().width * scale)), height: Math.max(1, Math.round(crop.getSize().height * scale)) });
        if (wc.isDestroyed() || wc.getURL() !== url || entry.navigation !== navigation || !this.entries.has(entry.state.id)) throw new Error('页面已变化，请重新选择');
        return this.feedback.add({ cwd: entry.cwd, label: '网页元素 · ' + entry.state.title.slice(0, 50), source, ...(!result.sensitive ? { image: { type: 'image' as const, mimeType: 'image/png' as const, dataBase64: crop.toPNG().toString('base64') } } : {}), text: JSON.stringify({ source, url, title: entry.state.title, selector: result.selector, text: result.text, viewport, rect, capturedAt }) });
      } finally { entry.picking = false; }
    }
    else throw new Error('无效的网页操作');
  }
  private close(entry: Entry) {
    if (this.attached === entry) this.hide(); this.entries.delete(entry.state.id);
    const wc = entry.view.webContents;
    if (!wc.isDestroyed()) { const ses = wc.session; ses.webRequest.onBeforeRequest(null); ses.removeAllListeners('will-download'); for (const scheme of ['http', 'https', ...(entry.origin.startsWith('smalt-preview:') ? ['smalt-preview'] : [])]) ses.protocol.unhandle(scheme); wc.close({ waitForBeforeUnload: false }); void ses.clearStorageData().catch(() => {}); }
  }
  forget(threadId: string) { for (const entry of [...this.entries.values()]) if (entry.state.threadId === threadId) this.close(entry); }
  dispose() { clearTimeout(this.notification); this.notification = undefined; this.hide(); for (const entry of [...this.entries.values()]) this.close(entry); }
}
