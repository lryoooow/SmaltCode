/** Exercise the shipped native ABI and external Office/SSH workers, using private QA copies. */
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync,execFileSync} from 'node:child_process';
import {buildSync} from 'esbuild';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const index=process.argv.indexOf('--release-dir');
if(index>=0&&!process.argv[index+1])throw Error('--release-dir requires a directory');
const release=index>=0?resolve(process.argv[index+1]):join(root,'packages/desktop/release');
const run=mkdtempSync(join(root,'.qa-work/package-runtime-')),cwd=join(run,'中文 工作区');mkdirSync(cwd);
const key=join(run,'fixture-key'),passphrase='packaged-fixture-passphrase';
execFileSync('ssh-keygen',['-q','-t','ed25519','-N',passphrase,'-f',key],{windowsHide:true,stdio:'pipe'});
const engine=process.env.SMALT_TEST_OFFICE_LIBRE,python=process.env.SMALT_TEST_OFFICE_PYTHON;
if(engine&&!python)throw Error('Real Office package validation requires SMALT_TEST_OFFICE_PYTHON');
if(engine)execFileSync(python,['scripts/fixtures/office.py',cwd],{cwd:root,windowsHide:true,stdio:'pipe'});
const config={run,cwd,runtime:join(release,'win-unpacked/resources/app.asar/dist/main'),node:process.execPath,key,passphrase,engine};
writeFileSync(join(run,'config.json'),JSON.stringify(config));
const source=`
import assert from 'node:assert/strict';import{readFileSync,writeFileSync}from'node:fs';import{join}from'node:path';import{createHash,createPrivateKey,randomUUID}from'node:crypto';import{Worker}from'node:worker_threads';
import{ProcessManager}from'./packages/desktop/src/main/process-manager.ts';import{OfficeSessions}from'./packages/desktop/src/main/office-sessions.ts';import{OfficeWorker}from'./packages/desktop/src/main/office-worker.ts';import{ArtifactManager}from'./packages/desktop/src/main/artifact-manager.ts';import{inspectArtifact,buildArtifact}from'./packages/desktop/src/main/artifact-office.ts';import{externalRuntimePath}from'./packages/desktop/src/main/runtime-path.ts';
const c=JSON.parse(readFileSync(join(__dirname,'config.json'),'utf8')),checks=[],digest=b=>createHash('sha256').update(b).digest('hex');
const wait=async fn=>{const end=Date.now()+15000;while(Date.now()<end){if(fn())return;await new Promise(r=>setTimeout(r,50));}throw Error('Packaged native output timeout')};
(async()=>{
 const path=externalRuntimePath(join(c.runtime,'ssh-key-worker.cjs'));assert(!path.includes('app.asar/'));assert(!path.includes('app.asar\\\\'));
 const worker=new Worker(path,{workerData:{privateKey:readFileSync(c.key,'utf8'),passphrase:c.passphrase}});
 try{const value=await new Promise((resolve,reject)=>{const t=setTimeout(()=>reject(Error('SSH worker timeout')),15000);worker.once('message',v=>{clearTimeout(t);resolve(v)});worker.once('error',e=>{clearTimeout(t);reject(e)})});assert(value.key&&!value.error);assert(createPrivateKey(value.key));checks.push('shipped encrypted-key worker decodes a private fixture through a physical unpacked path');}finally{await worker.terminate()}
 const processes=new ProcessManager({directory:join(c.run,'processes'),runtime:c.runtime,thread:()=>({cwd:c.cwd}),canInput:()=>true,notify:()=>{}});
 try{const p=await processes.start('qa',{},'user',true);await wait(()=>processes.read('qa',p.id).process.state==='running');processes.revokeInput('qa');assert.throws(()=>processes.write('qa',p.id,'blocked'),/未授权/);processes.authorizeInput('qa',p.id);processes.write('qa',p.id,"Write-Output ('PACKAGED_' + 'PTY_INPUT')\\r");await wait(()=>processes.read('qa',p.id).output.data.includes('PACKAGED_PTY_INPUT'));await processes.shutdown();assert.equal(processes.read('qa',p.id).process.state,'stopped');checks.push('shipped Electron loads its real PTY ABI and Job Object supervisor, enforces input approval, accepts input and exits cleanly');}finally{await processes.shutdown()}
 const formats=[];
 if(c.engine){const art=new ArtifactManager({directory:join(c.run,'artifacts'),scope:async()=>({cwd:c.cwd}),inspect:async(n,b)=>inspectArtifact(n,b),build:async(n,b,v)=>buildArtifact(n,b,v),consent:async()=>true,notify:()=>{}}),office=new OfficeSessions({directory:join(c.run,'office'),runtime:c.runtime,artifacts:art,libreOfficePath:c.engine,visible:false,consent:async()=>true,notify:()=>{},worker:options=>new OfficeWorker(join(c.runtime,'libreoffice-worker.py'),{...options,validation:true,timeout:45000})});
 try{for(const format of ['docx','xlsx','pptx']){const name='sample.'+format,path=join(c.cwd,name),original=digest(readFileSync(path)),v=await art.open('qa',name);await office.validate(v.id,v.revision,'libreoffice');await office.start(v.id,v.revision,'libreoffice');await office.capture(v.id);await office.close(v.id);assert.equal(digest(readFileSync(path)),original);const candidate=await art.view(v.id);assert(candidate.draft?.binaryVersion);await office.save(v.id,candidate.revision,randomUUID());assert.equal(digest(readFileSync(path)),candidate.sourceDigest);await office.cleanup(v.id);formats.push(format);}checks.push('shipped runtime opens, edits, saves, reopens and collects DOCX/XLSX/PPTX via the actual extracted LibreOffice scripts');}finally{office.dispose()}}
 const result={passed:true,electron:process.versions.electron,node:process.versions.node,checks,officeFormats:formats,officeSkipped:!c.engine};writeFileSync(join(c.run,'result.json'),JSON.stringify(result,null,2));console.log('[package-runtime] '+JSON.stringify(result));
})().catch(e=>{console.error(e);process.exitCode=1});`;
const probe=join(run,'probe.cjs');
buildSync({stdin:{contents:source,resolveDir:root,sourcefile:'package-runtime-probe.ts'},bundle:true,platform:'node',format:'cjs',outfile:probe,alias:{'@smalt/kernel':join(root,'packages/kernel/src/index.ts')}});
const result=spawnSync(join(release,'win-unpacked/SmaltCode.exe'),[probe],{cwd:run,env:{...process.env,ELECTRON_RUN_AS_NODE:'1',SMALT_HOME:join(run,'home')},encoding:'utf8',timeout:330000,windowsHide:true});
writeFileSync(join(run,'runtime.log'),(result.stdout??'')+(result.stderr??''));
assert.equal(result.status,0,(result.error?.message??'')+'\n'+result.stdout+'\n'+result.stderr);
assert(result.stdout.includes('[package-runtime]'));
console.log(result.stdout.trim());console.log('Packaged native runtime evidence: '+run);
