import { createHash,randomBytes,randomUUID,timingSafeEqual } from 'node:crypto';
import { isAbsolute } from 'node:path';
import type { RemoteGrant } from '../shared/remote.js';
export const remoteId=(prefix:string)=>prefix+'_'+randomUUID();
export const remoteToken=()=>randomBytes(32).toString('base64url');
export const remoteDigest=(value:unknown)=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
export const remoteStamp=()=>new Date().toISOString();
export function sameSecret(a:string,b:string){const x=Buffer.from(remoteDigest(a),'hex'),y=Buffer.from(remoteDigest(b),'hex');return timingSafeEqual(x,y);}
export function remoteText(value:unknown,max:number,label:string,empty=false):string{if(typeof value!=='string'||(!empty&&!value.trim())||value.length>max||value.includes('\0'))throw new Error(label+'无效');return value.trim();}
export function remoteURL(value:unknown){const raw=remoteText(value,2048,'主机地址'),url=new URL(raw);if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||url.pathname!=='/'||!url.hostname||/%/.test(url.hostname))throw new Error('请输入 HTTPS 主机地址与端口，不含用户名、路径、查询或片段');return url.origin;}
export function remotePath(value:unknown,empty=true){if(value===''&&empty)return '';const path=remoteText(value,1000,'远程路径');if(isAbsolute(path)||/[\\:\x00-\x1f*?"<>|]/.test(path)||path.split('/').some(p=>!p||p==='.'||p==='..'||/[. ]$/.test(p)||/^(?:\.git|\.smalt|\.local-preview|\.ssh|\.aws|\.gnupg|con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(p)))throw new Error('远程路径必须位于获准目录内，不能访问配置、设备或目录跳转');return path;}
export function remoteGrant(value:any,scopeIds:string[]):RemoteGrant{if(!value||!Array.isArray(value.scopeIds)||!value.scopeIds.length||value.scopeIds.length>12||new Set(value.scopeIds).size!==value.scopeIds.length||!value.scopeIds.every((id:unknown)=>typeof id==='string'&&scopeIds.includes(id))||!['reply','run','files'].every(k=>typeof value[k]==='boolean')||!['plan','default'].includes(value.mode)||!Number.isSafeInteger(value.hours)||value.hours<1||value.hours>8)throw new Error('请选择实际共享范围、权限和 1–8 小时有效期');return{scopeIds:[...value.scopeIds],reply:value.reply,run:value.run,files:value.files,mode:value.mode,hours:value.hours};}
export const remoteError=(e:unknown)=>e instanceof Error?e.message:'远程操作失败';
