import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { isIP } from 'node:net';

export function publicAddress(address: string): boolean {
  let ip = address.toLowerCase().split('%')[0]!;
  if (isIP(ip) === 6) ip = new URL('http://[' + ip + ']').hostname.slice(1, -1);
  if (isIP(ip) === 4) {
    const [a = 0, b = 0, c = 0] = ip.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && (b === 168 || b === 0 && (c === 0 || c === 2) || b === 88 && c === 99) || a === 100 && b >= 64 && b <= 127 || a === 198 && (b === 18 || b === 19 || b === 51 && c === 100) || a === 203 && b === 0 && c === 113);
  }
  if (isIP(ip) === 6) {
    // Only global unicast IPv6; block transition ranges carrying private IPv4.
    return /^[23][0-9a-f]{3}:/.test(ip) && !(ip.startsWith('2001:') && (parseInt(ip.split(':')[1] || '0', 16) < 0x200 || ip.startsWith('2001:db8:'))) && !ip.startsWith('2002:');
  }
  return false;
}

export function skillURL(value: string): URL {
  if (typeof value !== 'string' || value.length > 4096) throw new Error('无效的技能链接');
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('请输入完整的公开 HTTPS 链接'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port && url.port !== '443') throw new Error('仅支持不含账号信息的公开 HTTPS 链接（443 端口）');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || isIP(host) && !publicAddress(host)) throw new Error('不允许访问本机、私网或保留地址');
  if (url.hostname === 'github.com') {
    const parts = url.pathname.split('/');
    if (parts.length < 6 || parts[3] !== 'blob') throw new Error('请提供指向 SKILL.md 的 GitHub 文件链接');
    url = new URL('https://raw.githubusercontent.com/' + [parts[1], parts[2], ...parts.slice(4)].join('/'));
  }
  url.hash = '';
  return url;
}

/** HTTPS with DNS pinning, bounded redirects/body/time, and no ambient cookies. */
export async function downloadSkill(value: string): Promise<{ text: string; origin: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  timer.unref();
  try {
    let url = skillURL(value);
    for (let redirects = 0; redirects <= 3; redirects++) {
      const hostname = url.hostname.replace(/^\[|\]$/g, '');
      const addresses = await new Promise<Array<{ address: string; family: number }>>((resolve, reject) => {
        const abort = () => reject(new Error('下载超时，请稍后再试'));
        if (controller.signal.aborted) { abort(); return; }
        controller.signal.addEventListener('abort', abort, { once: true });
        void lookup(hostname, { all: true, verbatim: true }).then(
          result => { controller.signal.removeEventListener('abort', abort); resolve(result); },
          error => { controller.signal.removeEventListener('abort', abort); reject(error); },
        );
      });
      if (!addresses.length || addresses.some(a => !publicAddress(a.address))) throw new Error('链接解析到了私网或保留地址，已阻止下载。请检查代理的 DNS 模式，或下载 SKILL.md 后从文件导入。');
      if (controller.signal.aborted) throw new Error('下载超时');
      const pinned = addresses[0]!;
      const response = await new Promise<{ location?: string; bytes?: Buffer }>((resolve, reject) => {
        const req = request(url, {
          signal: controller.signal, headers: { accept: 'text/plain, text/markdown;q=0.9', 'user-agent': 'SmaltCode-Skill-Import' },
          family: pinned.family,
          // Bind the connection to the address we just validated; do not resolve twice.
          lookup: ((_host: string, _options: unknown, callback: (error: Error | null, address: string, family: number) => void) => callback(null, pinned.address, pinned.family)) as never,
        }, res => {
          if ([301, 302, 303, 307, 308].includes(res.statusCode ?? 0)) { res.resume(); resolve({ location: res.headers.location }); return; }
          if (res.statusCode !== 200) { res.resume(); reject(new Error('技能下载失败，HTTP ' + res.statusCode)); return; }
          if (res.headers['content-encoding'] && res.headers['content-encoding'] !== 'identity') { res.destroy(); reject(new Error('请使用未压缩的 SKILL.md 原始文件链接')); return; }
          if (Number(res.headers['content-length']) > 64 * 1024) { res.destroy(); reject(new Error('技能文件超过 64 KB')); return; }
          const chunks: Buffer[] = []; let total = 0;
          res.on('data', (chunk: Buffer) => { total += chunk.length; if (total > 64 * 1024) { res.destroy(new Error('技能文件超过 64 KB')); return; } chunks.push(chunk); });
          res.on('error', reject); res.on('end', () => resolve({ bytes: Buffer.concat(chunks) }));
        });
        req.on('error', reject); req.end();
      });
      if (response.location) { url = skillURL(new URL(response.location, url).href); continue; }
      if (!response.bytes) throw new Error('技能链接未返回文件内容');
      let text: string;
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(response.bytes); } catch { throw new Error('技能文件必须为 UTF-8 文本'); }
      const origin = new URL(url.href); origin.search = ''; origin.hash = '';
      return { text, origin: origin.href };
    }
    throw new Error('技能链接重定向次数过多');
  } catch (error) { if (controller.signal.aborted) throw new Error('下载超时，请稍后再试'); throw error; }
  finally { clearTimeout(timer); }
}
