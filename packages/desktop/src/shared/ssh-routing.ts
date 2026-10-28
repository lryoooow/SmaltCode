export const sshSetupMarker='SMALT_SSH_SETUP_REQUIRED';
export const sshSetupMessage=sshSetupMarker+'：当前对话尚未通过软件授权 SSH 执行目标。SmaltCode 支持用户名和密码认证，不要求免密登录。请调用 ssh_connections 查看本机连接状态，再提示用户点击“打开 SSH 连接”，在软件内填写主机地址、端口、用户名和密码，核验主机指纹并绑定当前对话。密码、私钥和解密口令不能在对话中索取或传给模型。不要读取 ~/.ssh、调用系统 ssh/ssh-copy-id/sshpass，或安装公钥来绕过软件连接。known_hosts 有记录不证明主机当前在线或认证成功。';
const clients=/^(?:ssh|scp|sftp|plink|pscp|psftp|sshpass|ssh-copy-id)(?:\.exe)?$/i;
/** A desktop workflow gate for common direct-client invocations, not an OS command sandbox. */
export function sshInputGuard(name:string,input:unknown):string|undefined {
  const v=input as Record<string,unknown>|null;if(!v||typeof v!=='object')return;
  if(['read','glob','grep'].includes(name)&&typeof v.path==='string'&&/(?:^|[\\/])\.ssh(?:[\\/]|$)/i.test(v.path))return sshSetupMessage+' 凭据目录属于固定保护边界，调整普通审批模式不会开放读取。';
  if(!['shell','process_start'].includes(name))return;
  if(typeof v.program==='string'&&clients.test(v.program.replace(/\\/g,'/').split('/').at(-1)!))return sshSetupMessage;
  if(typeof v.command==='string'&&/(?:^|[;&|()\r\n])\s*(?:&\s*)?["']?(?:[^\s"';&|()]*[\\/])?(?:ssh|scp|sftp|plink|pscp|psftp|sshpass|ssh-copy-id)(?:\.exe)?(?=["'\s]|$)/i.test(v.command))return sshSetupMessage;
}
export function needsSshSetup(text:string){return text.includes(sshSetupMarker)||/credential\/config directories are off-limits[\s\S]*|Permission denied \((?:publickey|password|keyboard-interactive)[^)]*\)/i.test(text)&&/\.ssh|\bssh(?:\.exe)?\b|publickey/i.test(text);}
