import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Collaboration, CollaborationConfig } from '../shared/collaboration.js';
import { excludedPath, safeRelative } from './collaboration-workspace.js';
function text(v: unknown, max: number, empty = false): v is string { return typeof v==='string' && (empty || !!v.trim()) && v.length<=max && !v.includes('\0'); }
function integer(v:unknown,min:number,max:number): v is number {return Number.isSafeInteger(v)&&(v as number)>=min&&(v as number)<=max;}
export function collaborationConfig(v:any): CollaborationConfig {
  if(!v || !text(v.parentThreadId,100) || !text(v.title,100) || !text(v.context,16000,true) || !integer(v.concurrency,1,2) || !Array.isArray(v.tasks) || v.tasks.length<2 || v.tasks.length>8)throw new Error('协作需设置父对话、标题、共享资料和 2–8 项子任务，并发最多 2 项');
  const b=v.budget; if(!b || !integer(b.requests,1,80)||!integer(b.tools,1,200)||!integer(b.tokens,8192,1000000)||!integer(b.minutes,1,120))throw new Error('请设置每项子任务的有限请求、操作、Token 和时间预算');
  const keys=new Set<string>();
  const tasks=v.tasks.map((t:any)=>{
    if(!t || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(t.key)||keys.has(t.key)||!text(t.title,100)||!text(t.instructions,12000)||!text(t.model,400)||!['read','edit'].includes(t.role)||!Array.isArray(t.paths)||t.paths.length>20||!Array.isArray(t.dependsOn)||t.dependsOn.length>7)throw new Error('子任务名称、模型、路径或依赖无效');
    keys.add(t.key); const paths=t.paths.map((p:unknown)=>{if(typeof p!=='string')throw new Error('写入路径无效');safeRelative(p);if(excludedPath(p))throw new Error('配置和敏感位置不能授权子任务');return p;});
    if(t.role==='edit'&&!paths.length)throw new Error('写入子任务必须指定相对文件或目录');
    if(t.role==='read'&&paths.length)throw new Error('只读子任务不能配置写入路径');
    return {key:t.key,title:t.title,instructions:t.instructions,model:t.model,role:t.role,paths:[...new Set(paths)] as string[],dependsOn:[...new Set(t.dependsOn)] as string[]};
  });
  for(const t of tasks)if(t.dependsOn.some((k:string)=>!keys.has(k)||k===t.key))throw new Error('依赖任务不存在或指向自身');
  const seen=new Set<string>(),stack=new Set<string>();
  function visit(k:string){if(stack.has(k))throw new Error('子任务依赖不能形成循环');if(seen.has(k))return;stack.add(k);for(const d of tasks.find((t:any)=>t.key===k)!.dependsOn)visit(d);stack.delete(k);seen.add(k);} for(const key of keys)visit(key);
  return {parentThreadId:v.parentThreadId,title:v.title,context:v.context,concurrency:v.concurrency,budget:{requests:b.requests,tools:b.tools,tokens:b.tokens,minutes:b.minutes},tasks};
}
function valid(v:any):v is Collaboration {
  try{
    collaborationConfig(v);
    if(!/^team_[a-f0-9-]{36}$/.test(v.id)||!integer(v.revision,1,1e9)||!text(v.cwd,4096)||!text(v.canonical,4096)||!Number.isFinite(Date.parse(v.createdAt))||!Number.isFinite(Date.parse(v.updatedAt))||!['draft','preparing','running','review','cancelled','failed','applied','cleaned'].includes(v.status)||!Array.isArray(v.excluded))return false;
    if(!(v.reason===undefined||text(v.reason,2000,true))||!(v.projectId===undefined||text(v.projectId,100))||v.excluded.length>10000||!v.excluded.every((p:unknown)=>typeof p==='string'&&safeRelative(p))||!(v.head===undefined||/^[a-f0-9]{40,64}$/.test(v.head))||!(v.snapshot===undefined||/^[a-f0-9]{64}$/.test(v.snapshot)))return false;
    for(const t of v.tasks)if(!['queued','running','completed','failed','cancelled','blocked','interrupted'].includes(t.status)||!(t.threadId===undefined||text(t.threadId,100))||!(t.reason===undefined||text(t.reason,2000,true))||!(t.summary===undefined||text(t.summary,6000,true))||!(t.metrics===undefined||t.metrics&&['requests','chargedTokens','toolCalls'].every(key=>integer(t.metrics[key],0,Number.MAX_SAFE_INTEGER)))||!(t.changed===undefined||Array.isArray(t.changed)&&t.changed.length<=10000&&t.changed.every((p:string)=>safeRelative(p))))return false;
    if(v.review){const r=v.review;if(!/^review_[a-f0-9-]{36}$/.test(r.id)||!Array.isArray(r.files)||r.files.length>200||new Set(r.files.map((f:any)=>f.path)).size!==r.files.length||!Array.isArray(r.selected)||!r.selected.every((k:unknown)=>v.tasks.some((t:any)=>t.key===k))||!Number.isFinite(Date.parse(r.createdAt))||!/^[a-f0-9]{64}$/.test(r.digest)||!(r.appliedAt===undefined||Number.isFinite(Date.parse(r.appliedAt))))return false;for(const f of r.files){safeRelative(f.path);if(excludedPath(f.path)||![f.base,f.current,f.proposed].every(s=>s===null||text(s,2*1024*1024,true))||typeof f.conflict!=='boolean'||typeof f.resolved!=='boolean'||!Array.isArray(f.sources)||!f.sources.every((k:unknown)=>v.tasks.some((t:any)=>t.key===k)))return false;}if(r.validation&&(!/^[a-f0-9]{64}$/.test(r.validation.digest)||!text(r.validation.note,3000)||!Number.isFinite(Date.parse(r.validation.at))))return false;}
    return true;
  }catch{return false;}
}
/** A malformed collaboration database cannot start workers or overwrite its original bytes. */
export class CollaborationStore {
  groups:Collaboration[]=[];notice?:string;private file:string;
  constructor(private directory:string){this.file=join(directory,'collaborations.json');if(!existsSync(this.file))return;try{const bytes=readFileSync(this.file);if(bytes.length>12*1024*1024)throw new Error();const value=JSON.parse(bytes.toString());if(value.version!==1||!Array.isArray(value.groups)||value.groups.length>40||!value.groups.every(valid)||new Set(value.groups.map((g:any)=>g.id)).size!==value.groups.length)throw new Error();this.groups=value.groups;}catch{this.notice='协作记录损坏或版本不兼容，原 collaborations.json 已保留，协作执行已停用；普通对话仍可使用。';}}
  save(groups:Collaboration[]){if(this.notice)throw new Error(this.notice);if(groups.length>40)throw new Error('协作记录最多 40 组，请先清理旧记录');const bytes=JSON.stringify({version:1,groups});if(Buffer.byteLength(bytes)>12*1024*1024)throw new Error('协作记录超过 12 MB，请减少审查内容');try{mkdirSync(this.directory,{recursive:true});const tmp=this.file+'.'+randomUUID()+'.tmp';writeFileSync(tmp,bytes,{mode:0o600});renameSync(tmp,this.file);this.groups=structuredClone(groups);}catch(e){this.notice='协作记录保存失败，已停止后续执行；请检查磁盘与权限后重启。';throw new Error(this.notice,{cause:e});}}
}
