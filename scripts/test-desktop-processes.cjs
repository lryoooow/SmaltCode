const {buildSync}=require('esbuild');const fs=require('node:fs');const path=require('node:path');const assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..');const run=fs.mkdtempSync(path.join(root,'.qa-work/process-native-'));const checks=[];
buildSync({entryPoints:[path.join(root,'packages/desktop/src/main/process-manager.ts')],bundle:true,platform:'node',format:'cjs',outfile:path.join(run,'manager.cjs'),alias:{'@smalt/kernel':path.join(root,'packages/kernel/src/index.ts')}});
const {ProcessManager}=require(path.join(run,'manager.cjs'));
const directory=run;const cwd=path.join(directory,'中文 工作区');fs.mkdirSync(cwd);
const manager=new ProcessManager({directory,runtime:path.join(root,'packages/desktop/dist/main'),thread:id=>({cwd}),canInput:()=>true,notify:()=>{}});
async function until(test,timeout=12000){const end=Date.now()+timeout;while(Date.now()<end){if(await test())return;await new Promise(r=>setTimeout(r,50))}throw Error('Timed out')}
const alive=pid=>{try{process.kill(pid,0);return true}catch{return false}};
(async()=>{
 try {
  const first=await manager.start('a',{program:process.execPath,args:['-e',"console.log('中文PTY-ready');setInterval(()=>{},1000)"]},'user');
  await until(()=>manager.read('a',first.id).output.data.includes('中文PTY-ready'));
  assert.equal(manager.read('a',first.id).process.state,'running');
  // Rebuilding with a real native module and supervisor loaded must preserve
  // their bytes and the live process, rather than removing dist mid-session.
  const crypto=require('node:crypto'),cp=require('node:child_process');
  const runtime=path.join(root,'packages/desktop/dist/main/native');
  function snapshot(dir,prefix=''){return Object.fromEntries(fs.readdirSync(dir,{withFileTypes:true}).flatMap(entry=>entry.isDirectory()?Object.entries(snapshot(path.join(dir,entry.name),prefix+entry.name+'/')):[[prefix+entry.name,crypto.createHash('sha256').update(fs.readFileSync(path.join(dir,entry.name))).digest('hex')]]))}
  const nativeBefore=snapshot(runtime);
  const rebuild=cp.spawnSync(process.execPath,[path.join(root,'packages/desktop/bundle.mjs')],{cwd:root,encoding:'utf8',windowsHide:true,timeout:90000});
  assert.equal(rebuild.status,0,rebuild.stdout+rebuild.stderr);assert.deepEqual(snapshot(runtime),nativeBefore);assert(alive(first.pid));
  checks.push('source rebuild while a real PTY and supervisor are active preserves all native runtime bytes and the live process');
  await manager.stop('a',first.id);assert.equal(manager.read('a',first.id).process.state,'stopped');
  const script="const cp=require('node:child_process');const c=cp.spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',detached:true,windowsHide:true});console.log('OWNED_CHILD='+c.pid);setInterval(()=>{},1000)";
  const tree=await manager.start('a',{program:process.execPath,args:['-e',script]},'user');
  await until(()=>/OWNED_CHILD=(\d+)/.test(manager.read('a',tree.id).output.data));
  const child=Number(manager.read('a',tree.id).output.data.match(/OWNED_CHILD=(\d+)/)[1]);assert(alive(child));
  await manager.stop('a',tree.id);await until(()=>!alive(child));
  const early=await manager.start('b',{program:process.execPath,args:['-e',"const c=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',detached:true,windowsHide:true});console.log('EARLY_CHILD='+c.pid);c.unref();"]},'user');
  await until(()=>/EARLY_CHILD=(\d+)/.test(manager.read('b',early.id).output.data));const orphan=Number(manager.read('b',early.id).output.data.match(/EARLY_CHILD=(\d+)/)[1]);
  await until(()=>manager.read('b',early.id).process.state==='exited');await until(()=>!alive(orphan));
  checks.push('Unicode output, individual stop, detached descendant cleanup and parent early exit use real Windows Job Objects');
  const quoted=await manager.start('a',{command:`node -e "console.log('CMD_QUOTE_OK')"`},'user');
  await until(()=>['exited','failed'].includes(manager.read('a',quoted.id).process.state));
  assert.equal(manager.read('a',quoted.id).process.exitCode,0,manager.read('a',quoted.id).output.data);
  assert(manager.read('a',quoted.id).output.data.includes('CMD_QUOTE_OK'));
  checks.push('cmd command quoting preserves the actual executable exit code');
  const terminal=await manager.start('a',{},'user',true);await until(()=>manager.read('a',terminal.id).process.state==='running');
  manager.resize('a',terminal.id,120,32);
  manager.write('a',terminal.id,"Write-Output ('PTY_' + 'INPUT_OK')\r");
  await until(()=>manager.read('a',terminal.id).output.data.includes('PTY_INPUT_OK'));
  manager.write('a',terminal.id,"Write-Output ('中文_' + '输入已确认')\r");await until(()=>manager.read('a',terminal.id).output.data.includes('中文_输入已确认'));
  manager.write('a',terminal.id,'while ($true) { Start-Sleep -Milliseconds 50 }\r');
  await new Promise(resolve=>setTimeout(resolve,300));manager.write('a',terminal.id,'\x03');
  await new Promise(resolve=>setTimeout(resolve,200));manager.write('a',terminal.id,"Write-Output ('AFTER_' + 'CTRL_C')\r");
  await until(()=>manager.read('a',terminal.id).output.data.includes('AFTER_CTRL_C'));
  await assert.rejects(manager.stop('b',terminal.id),/不属于/);
  await manager.stop('a',terminal.id);
  checks.push('real PowerShell PTY accepts Unicode input, resize and Ctrl+C; cross-conversation stop is rejected');
  const crashDirectory=path.join(run,'crash-profile');fs.mkdirSync(crashDirectory);const readyFile=path.join(crashDirectory,'ready.json');const hostFile=path.join(crashDirectory,'host.cjs');
  fs.writeFileSync(hostFile,`const fs=require('node:fs');const {ProcessManager}=require(${JSON.stringify(path.join(run,'manager.cjs'))});const m=new ProcessManager({directory:${JSON.stringify(crashDirectory)},runtime:${JSON.stringify(path.join(root,'packages/desktop/dist/main'))},thread:()=>({cwd:${JSON.stringify(cwd)}}),canInput:()=>true,notify:()=>{}});(async()=>{const p=await m.start('crash',{program:process.execPath,args:['-e',${JSON.stringify(script)}]},'user');const timer=setInterval(()=>{const out=m.read('crash',p.id).output.data;const match=out.match(/OWNED_CHILD=(\\d+)/);if(match){clearInterval(timer);setTimeout(()=>fs.writeFileSync(${JSON.stringify(readyFile)},JSON.stringify({root:p.pid,child:Number(match[1])})),1500)}},50)})();`);
  const host=require('node:child_process').spawn(process.execPath,[hostFile],{stdio:'ignore',windowsHide:true});
  try { await until(()=>fs.existsSync(readyFile));const ids=JSON.parse(fs.readFileSync(readyFile,'utf8'));assert(alive(ids.child));host.kill('SIGKILL');await until(()=>!alive(ids.root)&&!alive(ids.child));
    const restored=new ProcessManager({directory:crashDirectory,runtime:path.join(root,'packages/desktop/dist/main'),thread:()=>({cwd}),canInput:()=>true,notify:()=>{}});assert.equal(restored.list()[0].state,'interrupted');assert.equal(restored.list()[0].pid,undefined);await restored.shutdown();
  } finally {if(host.exitCode===null)host.kill('SIGKILL')}
  checks.push('abrupt parent termination kills its Job Object descendants; reopening marks interrupted and never replays or trusts saved PIDs');
  fs.writeFileSync(path.join(root,'docs/screenshots/phase-three-native.json'),JSON.stringify({passed:true,checks,fixture:run,platform:process.platform},null,2));
  console.log(JSON.stringify({passed:true,checks}));
 } finally {await manager.shutdown()}
})().catch(error=>{console.error(error);process.exitCode=1});
