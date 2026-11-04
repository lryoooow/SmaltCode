import { describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { X509Certificate } from 'node:crypto';
import { createServer, request } from 'node:https';
import { createSecureContext } from 'node:tls';
import { certificateHosts, generateRemoteCertificate } from '../src/main/remote-certificate';
import { certificateWorkerFixture } from './fixtures/certificate-worker';

const workerPath = certificateWorkerFixture();
const generate = (hosts: string[], signal?: AbortSignal, timeout?: number) => generateRemoteCertificate('unused-no-keys-on-disk', hosts, signal, { workerPath, timeout });

describe('portable, cancellable remote HTTPS identity', () => {
  it('generates an encrypted PFX with a valid self-signed server certificate and exact IP SANs', async () => {
    const directory = mkdtempSync(resolve('.qa-work/certificate-memory-'));
    let beats = 0; const pulse = setInterval(() => beats++, 5);
    const identity = await generateRemoteCertificate(directory, ['127.0.0.1', '::1', '192.0.2.10'], undefined, { workerPath });
    clearInterval(pulse);
    const cert = new X509Certificate(identity.certificate);
    expect(beats).toBeGreaterThan(0); expect(cert.ca).toBe(false); expect(cert.verify(cert.publicKey)).toBe(true);
    expect(cert.checkHost('localhost')).toBe('localhost');
    for (const ip of ['127.0.0.1', '::1', '192.0.2.10']) expect(cert.checkIP(ip)).toBe(ip);
    expect(cert.checkIP('192.0.2.11')).toBeUndefined(); expect(cert.publicKey.asymmetricKeyDetails?.modulusLength).toBe(2048);
    expect(cert.fingerprint256).toBe(identity.fingerprint); expect(Date.parse(identity.expiresAt)).toBeGreaterThan(Date.now());
    expect(() => createSecureContext({ pfx: identity.pfx, passphrase: 'wrong-password' })).toThrow();
    expect(readdirSync(directory)).toEqual([]);
    const server = createServer({ pfx: identity.pfx, passphrase: identity.passphrase, minVersion: 'TLSv1.2' }, (_req, res) => res.end('verified'));
    try {
      await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
      const port = (server.address() as { port: number }).port;
      const body = await new Promise<string>((done, fail) => {
        const req = request({ host: '127.0.0.1', port, ca: identity.certificate, servername: 'localhost' }, res => { let value = ''; res.on('data', data => value += data); res.on('end', () => done(value)); });
        req.on('error', fail); req.end();
      });
      expect(body).toBe('verified');
    } finally { await new Promise<void>(done => server.close(() => done())); }
  });
  it('rejects hostname/config injection, invalid and excessive addresses before starting a worker', async () => {
    expect(certificateHosts(['127.0.0.1', '127.0.0.1'])).toEqual(['127.0.0.1']);
    for (const hosts of [['example.org'], ['127.0.0.1\nDNS:evil.test'], ['::1%en0'], Array(33).fill('127.0.0.1')]) await expect(generate(hosts)).rejects.toThrow('IP');
  });
  it('cancels before and during generation, then immediately accepts a later request', async () => {
    const before = new AbortController(); before.abort(); await expect(generate([], before.signal)).rejects.toThrow('取消');
    const during = new AbortController(), pending = generate(['127.0.0.1'], during.signal);
    during.abort(); await expect(pending).rejects.toThrow('取消');
    await expect(generate(['127.0.0.1'])).resolves.toHaveProperty('fingerprint');
  });
  it('bounds concurrency and releases both slots only after the cancelled workers exit', async () => {
    const one = new AbortController(), two = new AbortController();
    const a = generate([], one.signal).catch(error => error), b = generate([], two.signal).catch(error => error);
    await expect(generate([])).rejects.toThrow('繁忙'); one.abort(); two.abort();
    expect((await a).message).toContain('取消'); expect((await b).message).toContain('取消');
    await expect(generate([])).resolves.toHaveProperty('fingerprint');
  });
  it('terminates stalled or broken workers and rejects malformed receipts without exposing worker errors', async () => {
    const directory = mkdtempSync(resolve('.qa-work/certificate-failure-'));
    const hung = join(directory, 'hung.cjs'); writeFileSync(hung, 'setInterval(()=>{},1000)');
    await expect(generateRemoteCertificate('', [], undefined, { workerPath: hung, timeout: 80 })).rejects.toThrow('超时');
    const broken = join(directory, 'broken.cjs'); writeFileSync(broken, 'throw Error("PRIVATE-DETAIL")');
    await expect(generateRemoteCertificate('', [], undefined, { workerPath: broken })).rejects.toThrow('无法运行');
    const invalid = join(directory, 'invalid.cjs'); writeFileSync(invalid, 'require("node:worker_threads").parentPort.postMessage({ok:true,pfx:new Uint8Array(100000)})');
    await expect(generateRemoteCertificate('', [], undefined, { workerPath: invalid })).rejects.toThrow('校验失败');
    await expect(generate([])).resolves.toHaveProperty('fingerprint');
  });
});
