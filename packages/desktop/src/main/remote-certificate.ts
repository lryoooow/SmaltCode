import { X509Certificate } from 'node:crypto';
import { isIP } from 'node:net';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { externalRuntimePath } from './runtime-path.js';

export type RemoteCertificate = { pfx: Buffer; passphrase: string; certificate: string; fingerprint: string; expiresAt: string };
const active = new Set<Worker>();

export function certificateHosts(hosts: unknown): string[] {
  if (!Array.isArray(hosts) || hosts.length > 32 || hosts.some(host => typeof host !== 'string' || host.includes('%') || !isIP(host))) throw new Error('证书地址必须是有效的 IP 地址，最多 32 项');
  return [...new Set(hosts as string[])];
}

/** Key generation and PFX encoding stay off the app loop. No plaintext key files,
 * shell commands, trust-store changes or project-controlled input are involved. */
export async function generateRemoteCertificate(_directory: string, hosts: string[], signal?: AbortSignal, options: { workerPath?: string; timeout?: number } = {}): Promise<RemoteCertificate> {
  const addresses = certificateHosts(hosts);
  if (signal?.aborted) throw new Error('已取消证书生成');
  if (active.size >= 2) throw new Error('证书生成繁忙，请稍后再试');
  const worker = new Worker(options.workerPath ?? externalRuntimePath(join(__dirname, 'remote-certificate-worker.cjs')), {
    workerData: { hosts: addresses }, env: {}, execArgv: [],
    resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16 },
  });
  active.add(worker);
  return new Promise((accept, reject) => {
    let finishing = false;
    const finish = (error?: Error, value?: RemoteCertificate) => {
      if (finishing) return;
      finishing = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
      void worker.terminate().then(() => {
        active.delete(worker); error ? reject(error) : accept(value!);
      }, () => { active.delete(worker); reject(new Error('证书工作线程退出未确认')); });
    };
    const abort = () => finish(new Error('已取消证书生成'));
    const timer = setTimeout(() => finish(new Error('证书生成超时，请稍后重试')), options.timeout ?? 30_000);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) { abort(); return; }
    worker.once('message', result => {
      try {
        if (result?.ok !== true || !(result.pfx instanceof Uint8Array) || result.pfx.length > 64 * 1024 || typeof result.certificate !== 'string' || result.certificate.length > 16 * 1024 || typeof result.passphrase !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(result.passphrase)) throw new Error();
        const cert = new X509Certificate(result.certificate), pfx = Buffer.from(result.pfx);
        if (!cert.verify(cert.publicKey) || cert.ca || cert.publicKey.asymmetricKeyType !== 'rsa' || (cert.publicKey.asymmetricKeyDetails?.modulusLength ?? 0) < 2048 || !cert.checkHost('localhost') || addresses.some(host => !cert.checkIP(host))) throw new Error();
        if (Date.parse(cert.validFrom) > Date.now() || Date.parse(cert.validTo) <= Date.now()) throw new Error();
        finish(undefined, { pfx, passphrase: result.passphrase, certificate: cert.toString(), fingerprint: cert.fingerprint256, expiresAt: new Date(cert.validTo).toISOString() });
      } catch { finish(new Error('本机证书生成或校验失败')); }
    });
    worker.once('error', () => finish(new Error('本机证书工作线程无法运行')));
    worker.once('exit', () => { if (!finishing) finish(new Error('证书生成中断，未启动远程监听')); });
  });
}
