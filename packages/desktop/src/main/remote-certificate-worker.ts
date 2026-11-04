import { generateKeyPair, randomBytes } from 'node:crypto';
import { parentPort, workerData } from 'node:worker_threads';
import forge from 'node-forge';
import { isIP } from 'node:net';
import { createSecureContext } from 'node:tls';

async function generate() {
  const hosts: unknown = workerData?.hosts;
  if (!Array.isArray(hosts) || hosts.length > 32 || hosts.some(host => typeof host !== 'string' || host.includes('%') || !isIP(host))) throw new Error('invalid hosts');
  const keys = await new Promise<{ privateKey: string; publicKey: string }>((accept, reject) => {
    generateKeyPair('rsa', { modulusLength: 2048, publicExponent: 0x10001, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } }, (error, publicKey, privateKey) => error ? reject(error) : accept({ publicKey, privateKey }));
  });
  const privateKey = forge.pki.privateKeyFromPem(keys.privateKey), cert = forge.pki.createCertificate();
  cert.publicKey = forge.pki.publicKeyFromPem(keys.publicKey);
  cert.serialNumber = '01' + randomBytes(19).toString('hex');
  cert.validity.notBefore = new Date(Date.now() - 5 * 60_000);
  cert.validity.notAfter = new Date(Date.now() + 365 * 24 * 3600_000);
  cert.setSubject([{ name: 'commonName', value: 'SmaltCode Remote' }]); cert.setIssuer(cert.subject.attributes);
  cert.setExtensions([
    { name: 'basicConstraints', critical: true, cA: false },
    { name: 'keyUsage', critical: true, digitalSignature: true, keyEncipherment: true },
    { name: 'extKeyUsage', serverAuth: true },
    { name: 'subjectAltName', altNames: [{ type: 2, value: 'localhost' }, ...hosts.map(ip => ({ type: 7, ip }))] },
  ]);
  cert.sign(privateKey, forge.md.sha256.create());
  const passphrase = randomBytes(32).toString('base64url');
  const p12 = forge.pkcs12.toPkcs12Asn1(privateKey, [cert], passphrase, { algorithm: 'aes256', count: 100_000, saltSize: 32, useMac: true, friendlyName: 'SmaltCode Remote' });
  const pfx = Buffer.from(forge.asn1.toDer(p12).getBytes(), 'binary');
  createSecureContext({ pfx, passphrase, minVersion: 'TLSv1.2' });
  parentPort!.postMessage({ ok: true, pfx, passphrase, certificate: forge.pki.certificateToPem(cert) });
}
void generate().catch(() => parentPort?.postMessage({ ok: false }));
