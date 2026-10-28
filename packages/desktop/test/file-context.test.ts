import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, renameSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { FileContexts } from '../src/main/file-context';
import { fileContextTools } from '../src/main/file-context-tools';

let dir:string, home:string, output:string, work:string, source:string, manager:FileContexts, allowed:Set<string>;
beforeEach(()=>{dir=mkdtempSync(join(process.cwd(),'.qa-work/file-context-')); home=join(dir,'Data'); output=join(dir,'output'); work=join(dir,'work'); source=join(dir,'source'); for(const p of [home,output,work,source])mkdirSync(p); allowed=new Set([output,work]); manager=new FileContexts(home,p=>allowed.has(p)); manager.ensureDraft(output); writeFileSync(join(source,'reference.txt'),'original material'); });
afterEach(()=>rmSync(dir,{recursive:true,force:true}));
it('starts without a project or folder, fixes command target separately from generated outputs, and restores associations',()=>{
  expect(manager.view(output)).toMatchObject({cwd:output,output,sources:[],workspaces:[],bound:false});
  const v=manager.add(output,work,'workspace'); expect(v.cwd).toBe(work);expect(v.output).toBe(output);
  manager.bind(output,'task-a',work);expect(()=>manager.primary('task-a')).toThrow('固定');
  expect(new FileContexts(home,p=>allowed.has(p)).view('task-a')).toMatchObject({cwd:work,output,bound:true});
  expect(()=>manager.bind(output,'task-b',work)).toThrow();
});
it('imports and removes project sources without changing command or output location and preserves manual sources',()=>{
  const p=manager.projectDraft();manager.projectAdd(p.token,source,'source');manager.projectAdd(p.token,work,'workspace');manager.saveProject(p.token,'project-a');
  const inherited=manager.applyProject(output,'project-a');expect(inherited.cwd).toBe(output);expect(inherited.output).toBe(output);expect(inherited.sources).toHaveLength(1);
  expect(manager.applyProject(output).sources).toHaveLength(0);expect(manager.view(output).workspaces).toHaveLength(0);
  manager.applyProject(output,'project-a'); manager.add(output,source,'source');
  expect(manager.applyProject(output).sources).toHaveLength(1);
  manager.applyProject(output,'project-a');manager.primary(output,manager.projectConfig('project-a').primary);
  expect(manager.applyProject(output).cwd).toBe(work);expect(manager.view(output).workspaces).toHaveLength(1);
});
it('cancels project edits without changing saved associations or touching files',()=>{
  const p=manager.projectDraft();manager.projectAdd(p.token,source,'source');manager.discardProject(p.token);
  expect(manager.projectConfig('project-a').sources).toHaveLength(0);expect(readFileSync(join(source,'reference.txt'),'utf8')).toBe('original material');
});
it('uses scoped source IDs, denies cross-task and parent access, fixes versions, and revokes pending reads',async()=>{
  const root=manager.add(output,join(source,'reference.txt'),'source',true).sources[0]!;
  const result=await manager.search(output,root.id,'reference');const ref=result.files[0]!.path;
  expect((await manager.preview(output,ref)).text).toContain('original material');
  expect(await manager.resolve(output,[{path:ref,digest:(await manager.preview(output,ref)).digest}])).toHaveProperty('references');
  const other=join(dir,'other');mkdirSync(other);manager.ensureDraft(other);await expect(manager.preview(other,ref)).rejects.toThrow('不属于');
  await expect(manager.preview(output,'source:'+root.id+':'+encodeURIComponent('../private'))).rejects.toThrow('父目录');
  const old=(await manager.preview(output,ref)).digest;writeFileSync(join(source,'reference.txt'),'changed');await expect(manager.resolve(output,[{path:ref,digest:old}])).rejects.toThrow('版本');
  manager.remove(output,root.id);await expect(manager.preview(output,ref)).rejects.toThrow('不属于');
});
it('writes output without modifying reference originals, requires exact versions, and exports only own history',()=>{
  const readonly=manager.add(output,source,'source').sources[0]!;
  expect(()=>manager.write(output,readonly.id,'reference.txt','bad')).toThrow('只读');
  expect(()=>manager.write(output,'output','../outside','bad')).toThrow('相对路径');
  const first=manager.write(output,'output','report.txt','one');expect(()=>manager.write(output,'output','report.txt','two')).toThrow('版本冲突');
  const second=manager.write(output,'output','report.txt','two',first.digest);expect(second.versionCount).toBe(2);
  expect(manager.version(output,second.path,first.digest).toString()).toBe('one');expect(readFileSync(join(source,'reference.txt'),'utf8')).toBe('original material');
  expect(()=>manager.version(output,second.path,'0'.repeat(64))).toThrow('不属于');
});
it('rejects moved/replaced roots and revoked work grants, without local fallback',async()=>{
  const root=manager.add(output,source,'source').sources[0]!;renameSync(source,source+'-old');symlinkSync(work,source,process.platform==='win32'?'junction':'dir');
  await expect(manager.search(output,root.id,'')).rejects.toThrow('路径');
  const v=manager.add(output,work,'workspace');allowed.delete(work);expect(()=>manager.write(output,v.primary!,'x.txt','bad')).toThrow('授权');
});
it('lists script-generated deliverables alongside versioned text files',async()=>{
  writeFileSync(join(output,'generated.csv'),'a,b\n1,2');expect((await manager.files(output,'outputs')).files.some(f=>f.name==='generated.csv')).toBe(true);
});
it('uses the same normalized text digest for Windows CRLF reads and optimistic writes',async()=>{
  writeFileSync(join(output,'windows.txt'),'line one\r\nline two\r\n');
  const {readContextFile}=await import('../src/main/context-files');const file=await readContextFile(output,'windows.txt');
  expect(manager.write(output,'output','windows.txt','new\r\n',file.digest).digest).toBe((await readContextFile(output,'windows.txt')).digest);
  writeFileSync(join(output,'binary.txt'),Buffer.from([0,255]));expect(()=>manager.write(output,'output','binary.txt','bad','0'.repeat(64))).toThrow();
});
it('can reference separate output and additional work roots without broadening the command cwd',async()=>{
  manager.add(output,work,'workspace');const file=manager.write(output,'output','report.txt','standalone output');manager.bind(output,'task-a',work);
  const preview=await manager.read('task-a',file.path);expect((await manager.resolve('task-a',[{path:file.path,digest:preview.digest}])).text).toContain('standalone output');
  expect(manager.view('task-a').cwd).toBe(work);await expect(manager.read('task-a',join(source,'reference.txt'))).rejects.toThrow('不属于');
});
it('rejects a read whose source is removed while a document parser is still working',async()=>{
  writeFileSync(join(source,'document.pdf'),'%PDF-test');const root=manager.add(output,source,'source').sources[0]!;
  let release!:()=>void;const held=new Promise<void>(r=>{release=r});let ready!:()=>void;const started=new Promise<void>(r=>{ready=r});
  const pending=manager.preview(output,'source:'+root.id+':document.pdf',async()=>{ready();await held;return{format:'pdf',text:'parsed',warnings:[]}});
  await started;manager.remove(output,root.id);release();await expect(pending).rejects.toThrow('不属于');
});
it('distinguishes same-named materials across roots and refuses to publish into replaced output roots',async()=>{
  const second=join(dir,'second-source');mkdirSync(second);writeFileSync(join(second,'reference.txt'),'different material');
  const a=manager.add(output,source,'source').sources[0]!,b=manager.add(output,second,'source').sources[1]!;
  const ra=(await manager.search(output,a.id,'reference')).files[0]!,rb=(await manager.search(output,b.id,'reference')).files[0]!;
  expect(ra.path).not.toBe(rb.path);expect((await manager.preview(output,ra.path)).text).toBe('original material');expect((await manager.preview(output,rb.path)).text).toBe('different material');
  renameSync(output,output+'-old');symlinkSync(work,output,process.platform==='win32'?'junction':'dir');expect(()=>manager.write(output,'output','must-not-exist.txt','bad')).toThrow();
  expect(()=>readFileSync(join(work,'must-not-exist.txt'))).toThrow();
});
it('rejects prototype IDs and a concurrently modified index without overwriting it',()=>{
  expect(()=>manager.ensureThread('__proto__',work)).toThrow('标识');
  writeFileSync(join(home,'file-contexts.json'),'external-change');expect(()=>manager.add(output,source,'source')).toThrow('其他进程');expect(readFileSync(join(home,'file-contexts.json'),'utf8')).toBe('external-change');
});
it('tools use the host task, reject remote targets, and never accept model-supplied writable source IDs',async()=>{
  const root=manager.add(output,source,'source').sources[0]!;manager.bind(output,'task-a',output);
  const tools=fileContextTools(manager,id=>{if(id!=='task-a')throw Error('remote target');},async()=>{throw Error('unused');});
  const ctx=(id:string)=>({threadId:id,signal:new AbortController().signal,emitItem:async()=>{}} as any);
  const run=async(name:string,args:any,id='task-a')=>{const values=[];for await(const v of tools.find(t=>t.name===name)!.run(args,ctx(id)))values.push(v);return values.at(-1) as any;};
  expect(await run('resource_write',{root:root.id,path:'reference.txt',content:'bad'})).toMatchObject({isError:true});
  expect(await run('resource_list',{},'remote')).toMatchObject({isError:true,text:'remote target'});
  expect(await run('resource_write',{root:'output',path:'result.txt',content:'done'})).not.toHaveProperty('isError',true);
  expect(readFileSync(join(source,'reference.txt'),'utf8')).toBe('original material');
});

it('recovers a separately claimed output after index corruption without restoring old material grants',()=>{
  manager.add(output,source,'source');manager.add(output,work,'workspace');manager.bind(output,'task-a',work);writeFileSync(join(output,'kept.txt'),'original output');writeFileSync(join(home,'file-contexts.json'),'{broken');
  const restored=new FileContexts(home,p=>allowed.has(p));const v=restored.ensureThread('task-a',work,output);expect(v.output).toBe(output);expect(v.cwd).toBe(work);expect(v.sources).toHaveLength(0);expect(v.notice).toContain('原记录已保留');expect(readFileSync(join(output,'kept.txt'),'utf8')).toBe('original output');
});
