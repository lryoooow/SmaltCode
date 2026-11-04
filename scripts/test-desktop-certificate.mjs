/** Real Electron + ASAR + external worker + pinned local HTTPS round trip. */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { buildSync } from 'esbuild';

const root = join(dirname(fileURLToPath(import.meta.url)), '..'), require = createRequire(import.meta.url);
const { createPackageWithOptions } = require('@electron/asar');
const builtWorker = join(root, 'packages/desktop/dist/main/remote-certificate-worker.cjs');
if (!existsSync(builtWorker)) throw Error('Build the desktop bundle before certificate acceptance');
const qa = join(root, '.qa-work'); mkdirSync(qa, { recursive: true });
const run = mkdtempSync(join(qa, 'certificate-native-')), source = join(run, 'source'), main = join(source, 'dist/main'); mkdirSync(main, { recursive: true });
buildSync({ entryPoints: [join(root, 'packages/desktop/src/main/remote-certificate.ts')], outfile: join(main, 'certificate.cjs'), bundle: true, platform: 'node', format: 'cjs', target: 'node22', logLevel: 'silent' });
buildSync({ entryPoints: [join(root, 'packages/desktop/src/main/remote-client.ts')], outfile: join(main, 'client.cjs'), bundle: true, platform: 'node', format: 'cjs', target: 'node22', external: ['electron'], logLevel: 'silent' });
cpSync(builtWorker, join(main, 'remote-certificate-worker.cjs'));
const archive = join(run, 'app.asar');
await createPackageWithOptions(source, archive, { unpack: '*worker.cjs' });
if (!existsSync(join(archive + '.unpacked', 'dist/main/remote-certificate-worker.cjs'))) throw Error('Worker was not unpacked');
const harness = join(run, 'harness.cjs');
writeFileSync(harness, `
const {app}=require('electron'),assert=require('node:assert/strict'),https=require('node:https'),fs=require('node:fs');
app.commandLine.appendSwitch('identity-test');
app.whenReady().then(async()=>{
 let server;
 try {
  const {generateRemoteCertificate}=require(${JSON.stringify(join(archive, 'dist/main/certificate.cjs'))});
  const {remoteRequest}=require(${JSON.stringify(join(archive, 'dist/main/client.cjs'))});
  let beats=0;const pulse=setInterval(()=>beats++,5);
  let cert;try{cert=await generateRemoteCertificate(${JSON.stringify(run)},['127.0.0.1','::1']);}finally{clearInterval(pulse);}
  assert(beats>0);
  let requests=0;
  server=https.createServer({pfx:cert.pfx,passphrase:cert.passphrase,minVersion:'TLSv1.2'},(_req,res)=>{requests++;res.setHeader('Content-Type','application/json');res.end(JSON.stringify({value:'verified'}));});
  await new Promise(done=>server.listen(0,'127.0.0.1',done));
  const profile={url:'https://127.0.0.1:'+server.address().port,certificate:cert.certificate,fingerprint:cert.fingerprint};
  const body=await remoteRequest(profile,'/v1/hello',{timeout:5000});assert.equal(body.data.value,'verified');
  const other=await generateRemoteCertificate(${JSON.stringify(run)},['127.0.0.1']);
  await assert.rejects(remoteRequest({...profile,certificate:other.certificate,fingerprint:other.fingerprint},'/v1/operation',{token:'S'.repeat(43),body:{private:'must-not-send'},timeout:5000}),/指纹/);
  assert.equal(requests,1);
  const cancel=new AbortController(),pending=generateRemoteCertificate(${JSON.stringify(run)},['127.0.0.1'],cancel.signal);cancel.abort();await assert.rejects(pending,/取消/);
  const evidence={passed:true,platform:process.platform,electron:process.versions.electron,asarWorker:true,https:true,eventLoopResponsive:true,cancelledWorker:true,pinnedPeerBeforeHTTP:true,changedPinRejected:true};
  fs.writeFileSync(${JSON.stringify(join(run, 'verification.json'))},JSON.stringify(evidence,null,2));
  console.log('[certificate-native] passed');
 } catch(error){console.error('[certificate-native] failed: '+error.message);process.exitCode=1;}
 finally{if(server)await new Promise(done=>server.close(done));app.exit(process.exitCode||0);}
});
`);
const electron = join(root, 'node_modules/electron/dist', process.platform === 'win32' ? 'electron.exe' : process.platform === 'darwin' ? 'Electron.app/Contents/MacOS/Electron' : 'electron');
const env = { ...process.env, SMALT_HOME: join(run, 'home') }; delete env.ELECTRON_RUN_AS_NODE;
const result = spawnSync(electron, [harness, '--identity-test', '--smoke-test'], { cwd: root, env, encoding: 'utf8', windowsHide: true, timeout: 45_000 });
writeFileSync(join(run, 'runtime.log'), (result.stdout ?? '') + (result.stderr ?? ''));
if (result.status !== 0 || !result.stdout?.includes('[certificate-native] passed')) throw Error('Electron certificate acceptance failed; inspect ' + join(run, 'runtime.log'));
const evidence = JSON.parse(readFileSync(join(run, 'verification.json'), 'utf8')); if (!evidence.passed) throw Error('Missing acceptance receipt');
console.log(JSON.stringify({ ...evidence, evidence: join(run, 'verification.json') }));
