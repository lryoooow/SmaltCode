import { auth, refreshAuthorization, type OAuthClientProvider, type OAuthDiscoveryState, type StoredOAuthTokens, type StoredOAuthClientInformation } from '@modelcontextprotocol/client';
import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { integrationURL } from './integration-policy.js';
import { integrationFetch } from './integration-network.js';
import type { IntegrationVault } from './integration-vault.js';
import type { McpServer } from '../shared/integrations.js';

type Consent = (title: string, detail: string) => Promise<boolean>;
/** An explicit user action owns one PKCE round trip. A tool call cannot open a login window. */
export async function loginMcp(server: McpServer, vault: IntegrationVault, signal: AbortSignal, consent: Consent, open: (url: string) => Promise<void>) {
  const endpoint = integrationURL(server.url), allowed = new Set([endpoint.origin]);
  const secret = vault.get(server.id, server.digest);
  const persist = () => { if (signal.aborted) throw new Error('认证已取消'); vault.save(server.id, server.digest, secret); };
  let verifier = '', authorizationCode = '', discovery: OAuthDiscoveryState | undefined;
  const state = randomBytes(32).toString('hex');
  const http = createServer();
  await new Promise<void>((resolve, reject) => { http.once('error', reject); http.listen(0, '127.0.0.1', () => { http.removeListener('error', reject); resolve(); }); });
  const port = (http.address() as { port: number }).port, redirect = `http://127.0.0.1:${port}/oauth/callback`;
  let finish!: (value: { code: string; iss?: string }) => void, fail!: (error: Error) => void, consumed = false;
  const callback = new Promise<{ code: string; iss?: string }>((resolve, reject) => { finish = resolve; fail = reject; });
  void callback.catch(() => {});
  const abort = () => { fail(new Error('认证已取消')); http.close(); http.closeAllConnections(); };
  signal.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => { fail(new Error('登录超过 5 分钟，请重新开始')); http.close(); http.closeAllConnections(); }, 300_000);
  http.on('request', (req, res) => {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8'); res.setHeader('Cache-Control', 'no-store'); res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    let url: URL; try { url = new URL(req.url ?? '/', redirect); } catch { res.writeHead(400); res.end('无效的回调地址'); return; }
    const returned = url.searchParams.get('state') ?? '';
    const valid = !consumed && req.method === 'GET' && req.headers.host === `127.0.0.1:${port}` && url.pathname === '/oauth/callback' && /^[a-f0-9]{64}$/.test(returned) && timingSafeEqual(Buffer.from(returned), Buffer.from(state)) && url.searchParams.getAll('state').length === 1;
    if (!valid) { res.writeHead(400); res.end('认证回调无效，请返回 SmaltCode。'); return; }
    consumed = true;
    const code = url.searchParams.get('code');
    if (!code || code.length > 8192 || url.searchParams.getAll('code').length !== 1 || url.searchParams.has('error')) { res.writeHead(400); res.end('认证未完成，请返回 SmaltCode。'); fail(new Error('登录被拒绝或未返回授权码')); return; }
    res.end('授权信息已接收，可以关闭此页并返回 SmaltCode。'); finish({ code, iss: url.searchParams.get('iss') ?? undefined });
  });
  const fetchFn = integrationFetch(async (url, request) => {
    if (signal.aborted) throw new Error('认证已取消');
    // A remote resource cannot send the app into a local authentication endpoint.
    if (endpoint.protocol === 'https:' && url.protocol !== 'https:') throw new Error('远程服务认证不能访问本机 HTTP 地址');
    if (!allowed.has(url.origin)) {
      if (request.headers.has('authorization')) throw new Error('已阻止向未经确认的认证来源传递凭据');
      if (!await consent('确认认证来源', `服务：${endpoint.href}\n认证来源：${url.origin}\n\n此来源可能接收客户端注册和登录信息。请核对服务文档。`)) throw new Error('已取消认证来源授权');
      if (signal.aborted) throw new Error('认证已取消'); allowed.add(url.origin);
    }
  });
  const provider: OAuthClientProvider = {
    redirectUrl: redirect,
    clientMetadata: { client_name: 'SmaltCode', redirect_uris: [redirect], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' },
    state: () => state,
    clientInformation: ctx => server.clientId ? { client_id: server.clientId } : secret.clients?.[ctx?.issuer ?? ''],
    saveClientInformation: (info: StoredOAuthClientInformation, ctx) => { secret.clients = { ...secret.clients, [ctx?.issuer ?? '']: info }; persist(); },
    tokens: ctx => ctx ? secret.tokens?.[ctx.issuer] : secret.tokens?.[secret.issuer],
    saveTokens: (tokens: StoredOAuthTokens, ctx) => { const issuer = ctx?.issuer; if (!issuer) throw new Error('认证结果缺少来源绑定'); secret.tokens = { ...secret.tokens, [issuer]: { ...tokens, expiresAt: tokens.expires_in ? Date.now() + tokens.expires_in * 1000 : undefined } }; secret.issuer = issuer; persist(); },
    redirectToAuthorization: async url => {
      const target = new URL(url); integrationURL(target.origin);
      if (endpoint.protocol === 'https:' && target.protocol !== 'https:') throw new Error('远程认证必须使用 HTTPS');
      if (!await consent('在浏览器中登录', `MCP 服务：${endpoint.href}\n登录来源：${target.origin}\n请求范围：${target.searchParams.get('scope') ?? '服务默认范围'}\n\n登录不会启用工具，也不会扩大任务权限。`)) throw new Error('已取消登录');
      if (signal.aborted) throw new Error('认证已取消'); await open(url.href);
    },
    saveCodeVerifier: value => { verifier = value; }, codeVerifier: () => verifier,
    saveDiscoveryState: value => { discovery = value; secret.discovery = value; persist(); }, discoveryState: () => discovery,
    invalidateCredentials: scope => { if (scope === 'all' || scope === 'tokens') { delete secret.tokens; delete secret.issuer; } if (scope === 'all' || scope === 'client') delete secret.clients; if (scope === 'all' || scope === 'verifier') verifier = ''; if (scope === 'all' || scope === 'discovery') discovery = undefined; persist(); },
  };
  try {
    if (signal.aborted) throw new Error('认证已取消');
    const result = await auth(provider, { serverUrl: endpoint, fetchFn: (input, init) => fetchFn(input, { ...init, signal }) });
    if (result === 'REDIRECT') { const value = await callback; authorizationCode = value.code; await auth(provider, { serverUrl: endpoint, authorizationCode: value.code, iss: value.iss, fetchFn: (input, init) => fetchFn(input, { ...init, signal }) }); }
    if (!secret.issuer || !secret.tokens?.[secret.issuer]?.access_token) throw new Error('服务未返回可用的访问令牌');
    secret.authOrigins = [...allowed]; persist();
  } catch (error) { let message = vault.redact(error instanceof Error ? error.message : String(error)); for (const value of [verifier, authorizationCode, state]) if (value) message = message.split(value).join('[已隐藏认证验证信息]'); throw new Error(message); }
  finally { verifier = ''; authorizationCode = ''; clearTimeout(timer); signal.removeEventListener('abort', abort); http.close(); http.closeAllConnections(); }
}

/** Refresh only against the exact token endpoint reviewed during login. Never starts interactive auth or replays a tool. */
export async function oauthToken(server: McpServer, vault: IntegrationVault, signal: AbortSignal): Promise<string> {
  const secret = vault.get(server.id, server.digest), issuer = secret.issuer, tokens = secret.tokens?.[issuer];
  if (!tokens?.access_token) throw new Error('请先在连接器中登录');
  if (!tokens.expiresAt || tokens.expiresAt > Date.now() + 15_000) return tokens.access_token;
  const discovery = secret.discovery as OAuthDiscoveryState | undefined, metadata = discovery?.authorizationServerMetadata;
  if (!tokens.refresh_token || !issuer || !metadata?.token_endpoint || metadata.issuer !== issuer || discovery?.authorizationServerUrl !== issuer) throw new Error('登录已过期，请在连接器中重新登录');
  const endpoint = integrationURL(metadata.token_endpoint), resource = integrationURL(server.url);
  if (!secret.authOrigins?.includes(endpoint.origin) || resource.protocol === 'https:' && endpoint.protocol !== 'https:') throw new Error('认证来源已变化，请重新登录确认');
  const client = server.clientId ? { client_id: server.clientId } : secret.clients?.[issuer];
  if (!client) throw new Error('登录客户端信息缺失，请重新登录');
  const result = await refreshAuthorization(issuer, { metadata, clientInformation: client, refreshToken: tokens.refresh_token, resource, fetchFn: (input, init) => integrationFetch(async url => { if (url.href !== endpoint.href || signal.aborted) throw new Error('认证刷新已取消或地址发生变化'); })(input, { ...init, signal }) });
  if (signal.aborted) throw new Error('认证刷新已取消');
  secret.tokens[issuer] = { ...tokens, ...result, expiresAt: result.expires_in ? Date.now() + result.expires_in * 1000 : undefined };
  vault.save(server.id, server.digest, secret); return result.access_token;
}
