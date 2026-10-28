import { existsSync,mkdirSync,readFileSync,renameSync,writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { remoteId,remoteStamp } from './remote-policy.js';
import type { RemoteAudit,RemoteDevice,RemoteOperation,RemoteProfile,RemoteScope,RemoteSession } from '../shared/remote.js';
export type RemoteIntent={id:string;profileId:string;digest:string;threadId?:string;status:'sending'|'unknown'|'acknowledged';createdAt:string;reason?:string};
export type RemoteData={version:1;hostId:string;name:string;scopes:RemoteScope[];devices:RemoteDevice[];sessions:RemoteSession[];audits:RemoteAudit[];operations:RemoteOperation[];profiles:RemoteProfile[];intents:RemoteIntent[]};
const bounded=(v:unknown,n:number)=>typeof v==='string'&&v.length<=n&&!v.includes('\0');
function valid(v:any){
  if(v?.version!==1||!/^host_[a-f0-9-]{36}$/.test(v.hostId)||!bounded(v.name,80))return false;
  for(const[k,max]of Object.entries({scopes:24,devices:40,sessions:80,audits:500,operations:200,profiles:20,intents:200})){const a=v[k];if(!Array.isArray(a)||a.length>max||a.some((x:any)=>!x||!bounded(x.id,100))||new Set(a.map((x:any)=>x.id)).size!==a.length)return false;}
  for(const s of v.scopes)if(!bounded(s.threadId,100)||!bounded(s.title,120)||!bounded(s.cwd,4096)||!bounded(s.canonical,4096)||!bounded(s.model,400))return false;
  for(const d of v.devices)if(!bounded(d.name,80)||!['phone','desktop'].includes(d.kind)||!d.grant||!Array.isArray(d.grant.scopeIds)||d.grant.scopeIds.length>12||!d.grant.scopeIds.every((id:any)=>bounded(id,100))||!['reply','run','files'].every(k=>typeof d.grant[k]==='boolean')||!['plan','default'].includes(d.grant.mode)||!Number.isInteger(d.grant.hours)||d.grant.hours<1||d.grant.hours>8)return false;
  for(const s of v.sessions)if(!bounded(s.deviceId,100)||!Number.isFinite(Date.parse(s.expiresAt)))return false;
  for(const a of v.audits)if(!bounded(a.event,100)||!bounded(a.detail,600)||!Number.isFinite(Date.parse(a.at)))return false;
  for(const o of v.operations)if(!bounded(o.deviceId,100)||!bounded(o.sessionId,100)||!bounded(o.scopeId,100)||!['start','reply','answer','stop'].includes(o.kind)||!['claimed','running','completed','failed','interrupted'].includes(o.status)||!/^[a-f0-9]{64}$/.test(o.digest)||!(o.reason===undefined||bounded(o.reason,1200)))return false;
  for(const p of v.profiles)if(!bounded(p.name,80)||!bounded(p.url,2048)||!bounded(p.fingerprint,100)||!bounded(p.certificate,12000)||!bounded(p.hostId,100)||!p.aliases||typeof p.aliases!=='object'||Object.values(p.aliases).some(a=>!bounded(a,80)))return false;
  for(const i of v.intents)if(!bounded(i.profileId,100)||!/^[a-f0-9]{64}$/.test(i.digest)||!['sending','unknown','acknowledged'].includes(i.status)||!Number.isFinite(Date.parse(i.createdAt)))return false;
  return true;
}
/** No active token or private key is serialized here. Invalid original bytes remain untouched. */
export class RemoteStore {
  data:RemoteData;notice?:string;private file:string;
  constructor(private directory:string){this.file=join(directory,'remote.json');this.data={version:1,hostId:remoteId('host'),name:'SmaltCode 主机',scopes:[],devices:[],sessions:[],audits:[],operations:[],profiles:[],intents:[]};if(!existsSync(this.file))return;try{const bytes=readFileSync(this.file);if(bytes.length>3*1024*1024)throw new Error();const value=JSON.parse(bytes.toString());if(!valid(value))throw new Error();this.data=value;
      let changed=false;for(const s of value.sessions)if(!s.revokedAt){s.revokedAt=remoteStamp();changed=true;}for(const o of value.operations)if(['claimed','running'].includes(o.status)){o.status='interrupted';o.reason='主机已重启，未重放此操作；请核对实际结果';o.endedAt=remoteStamp();changed=true;}for(const i of value.intents)if(i.status==='sending'){i.status='unknown';i.reason='上次回执未确认，重开后仅核对状态，不重发';changed=true;}if(changed)this.save(value);
    }catch{this.notice='远程记录损坏或版本不兼容，原 remote.json 已保留，远程功能已停用；本机对话仍可使用。';}}
  save(value:RemoteData){if(this.notice)throw new Error(this.notice);const bytes=JSON.stringify(value);if(Buffer.byteLength(bytes)>3*1024*1024||!valid(value))throw new Error('远程记录格式或数量超出限制');try{mkdirSync(this.directory,{recursive:true});const tmp=this.file+'.'+remoteId('write')+'.tmp';writeFileSync(tmp,bytes,{mode:0o600});renameSync(tmp,this.file);this.data=structuredClone(value);}catch(error){this.notice='远程记录保存失败，已禁止后续访问；请检查磁盘与权限后重启。';throw new Error(this.notice,{cause:error});}}
}
