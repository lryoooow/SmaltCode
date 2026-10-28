import { existsSync,lstatSync,mkdirSync,readFileSync,renameSync,writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sshEndpoint,sshId,sshProfile } from './ssh-policy.js';
import type { SshProfile,SshAudit } from '../shared/ssh.js';
type Data={version:1;profiles:SshProfile[];pins:Record<string,string>;audits:SshAudit[]};
export class SshStore {
  data:Data={version:1,profiles:[],pins:{},audits:[]};notice?:string;private file:string;
  constructor(private directory:string){this.file=join(directory,'ssh.json');if(!existsSync(this.file))return;try{if(lstatSync(this.file).isSymbolicLink())throw Error();const bytes=readFileSync(this.file);if(bytes.length>512*1024)throw Error();const v=JSON.parse(bytes.toString());this.validate(v);this.data=v;}catch{this.notice='SSH 数据损坏或版本不兼容，原文件已保留；请恢复备份。其他功能仍可使用。';}}
  private validate(v:any){if(v?.version!==1||!Array.isArray(v.profiles)||v.profiles.length>20||!v.pins||Array.isArray(v.pins)||typeof v.pins!=='object'||Object.keys(v.pins).length>40||!Array.isArray(v.audits)||v.audits.length>200)throw Error('SSH 数据格式无效');const ids=new Set();for(const p of v.profiles){if(typeof p.id!=='string'||!/^[a-f0-9-]{36}$/.test(p.id)||ids.has(p.id)||!Number.isFinite(Date.parse(p.createdAt))||JSON.stringify(sshProfile(p,p.id,p.createdAt))!==JSON.stringify(p))throw Error('SSH 项目记录无效');ids.add(p.id);}for(const[k,f]of Object.entries(v.pins))if(k.length>280||!/^SHA256:[A-Za-z0-9+/]{43}$/.test(String(f)))throw Error('主机指纹无效');for(const a of v.audits)if(!a||typeof a.detail!=='string'||a.detail.length>600||typeof a.event!=='string'||a.event.length>80||!Number.isFinite(Date.parse(a.at)))throw Error('SSH 访问记录无效');}
  save(value:Data){if(this.notice)throw Error(this.notice);this.validate(value);try{mkdirSync(this.directory,{recursive:true});if(existsSync(this.file)&&lstatSync(this.file).isSymbolicLink())throw Error();const temp=this.file+'.'+sshId()+'.tmp';writeFileSync(temp,JSON.stringify(value),{mode:0o600});renameSync(temp,this.file);this.data=structuredClone(value);}catch{this.notice='SSH 数据保存失败，已停止后续访问，请检查磁盘后重启。';throw Error(this.notice);}}
  audit(id:string,event:string,detail:string){const next=structuredClone(this.data);next.audits.push({at:new Date().toISOString(),id,event,detail:detail.slice(0,600)});next.audits=next.audits.slice(-200);this.save(next);}
  binding(p:SshProfile){return JSON.stringify([sshEndpoint(p),p.username,p.root,p.auth]);}
}
