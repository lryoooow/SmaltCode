import { posix } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { SshConfigPreview, SshProfile } from '../shared/ssh.js';
const control=/[\x00-\x1f\x7f]/;
export const sshId=()=>randomUUID();
export const sshDigest=(value:Buffer|string)=>createHash('sha256').update(value).digest('hex');
export const sshFingerprint=(value:Buffer)=>'SHA256:'+createHash('sha256').update(value).digest('base64').replace(/=+$/,'');
export function sshRoot(value:unknown):string {
  if(typeof value!=='string'||value.length>2048||!value.startsWith('/')||value.startsWith('//')||value.includes('\\')||control.test(value)||value.split('/').includes('..'))throw Error('请填写 Linux 主机的绝对项目路径，不允许父目录或 Windows 路径');
  const result=posix.normalize(value);return result.length>1?result.replace(/\/$/,''):result;
}
export function sshRelative(value:unknown):string {
  if(typeof value!=='string'||value.length>2048||value.startsWith('/')||value.includes('\\')||control.test(value)||value.split('/').includes('..'))throw Error('远程路径必须位于当前项目内');
  const path=posix.normalize(value);if(path==='.')return '';
  if(path.split('/').some(p=>/^(?:\.git|\.ssh|\.aws|\.gnupg|\.smalt|\.env(?:\..*)?|id_(?:rsa|ed25519|ecdsa)(?:\.pub)?|.*\.(?:pem|key|pfx|p12))$/i.test(p)))throw Error('此路径包含凭据或内部数据，未开放读取');
  return path;
}
export function sshProfile(value:any,id:string=sshId(),createdAt=new Date().toISOString()):SshProfile {
  if(!value||typeof value!=='object'||Array.isArray(value))throw Error('SSH 配置无效');
  for(const [key,max]of [['name',80],['host',253],['username',128]] as const)if(typeof value[key]!=='string'||!value[key].trim()||value[key].length>max||control.test(value[key]))throw Error('请填写有效的主机名称、地址与用户名');
  const host=value.host.trim().toLowerCase();if(!/^[a-z0-9.:_-]+$/i.test(host)||host.startsWith('-'))throw Error('主机地址不允许 URL、参数或命令');
  if(!Number.isInteger(value.port)||value.port<1||value.port>65535||!['password','key','agent'].includes(value.auth))throw Error('SSH 端口或认证方式无效');
  return{id,name:value.name.trim(),host,port:value.port,username:value.username.trim(),root:(sshRelative(sshRoot(value.root).slice(1)),sshRoot(value.root)),auth:value.auth,createdAt};
}
export const sshEndpoint=(p:SshProfile)=>`${p.host}:${p.port}`;
/** Parse data only: never spawn ssh -G, read Includes, expand commands or execute Match. */
export function sshConfig(text:string):SshConfigPreview {
  if(Buffer.byteLength(text)>256*1024)throw Error('SSH 配置文件过大');
  const profiles:SshConfigPreview['profiles']=[],warnings=new Set<string>();let block:any,skip=true;
  for(const line of text.split(/\r?\n/)){
    const s=line.trim();if(!s||s.startsWith('#'))continue;
    const match=/^(\S+?)(?:\s*=\s*|\s+)(.*)$/.exec(s);if(!match){warnings.add('已忽略无法解析的配置行');continue;}
    const key=match[1]!.toLowerCase(),raw=match[2]!.replace(/\s+#.*$/,'').trim(),v=raw.replace(/^"([^"]*)"$/,'$1');
    if(key==='host'){skip=true;block=undefined;if(/^[a-z0-9._-]+$/i.test(v)&&!v.startsWith('-')){block={name:v,host:v,port:22,username:''};profiles.push(block);skip=false;}else warnings.add('通配符或多主机规则未导入，请手动核对');continue;}
    if(key==='match'){skip=true;warnings.add('Match 规则未执行或导入');continue;}
    if(!['hostname','port','user','identityfile'].includes(key)){warnings.add(`${match[1]!.slice(0,40)} 未执行或导入`);continue;}
    if(skip||!block)continue;if(/[%$`\x00-\x1f]/.test(v)){warnings.add('变量和命令替换未展开，请手动填写');continue;}
    if(key==='hostname')block.host=v;else if(key==='user')block.username=v;else if(key==='port')block.port=Number(v);else block.keyHint=v;
  }
  return{profiles:profiles.filter(p=>/^[a-z0-9.:_-]+$/i.test(p.host)&&!p.host.startsWith('-')&&Number.isInteger(p.port)&&p.port>0&&p.port<65536).slice(0,20),warnings:[...warnings].slice(0,30)};
}
