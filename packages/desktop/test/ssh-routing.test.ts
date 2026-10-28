import { expect,it } from 'vitest';
import { sshInputGuard,sshSetupMarker,needsSshSetup } from '../src/shared/ssh-routing';
import { operationIssues } from '../src/renderer/src/c/issues';
import { sshConnectionTool } from '../src/main/ssh-connection-tool';
it('routes common direct SSH clients and credential reads to native username/password authentication',()=>{
 for(const input of [{command:'ssh -o BatchMode=yes root@172.18.0.207 hostname'},{program:'C:\\Windows\\System32\\OpenSSH\\ssh.exe',args:['host']},{command:'cd /d D:\\work && ssh root@host'},{command:'"C:\\tools\\ssh.exe" user@host'},{command:'ssh-copy-id user@host'}])expect(sshInputGuard('shell',input)).toContain(sshSetupMarker);
 expect(sshInputGuard('read',{path:'C:\\Users\\person\\.ssh\\config'})).toContain('固定保护边界');
 for(const command of ['echo ssh user@host','node test-ssh.cjs','git status'])expect(sshInputGuard('shell',{command})).toBeUndefined();
});
it('does not suggest changing permissions for protected SSH directories or hide authentication causes',()=>{
 const base={id:'blocked',threadId:'th',turnId:'turn',createdAt:'',kind:'commandExecution',command:'read C:\\Users\\p\\.ssh\\config',tool:'read',status:'blocked',exitCode:null} as const;
 const issue=operationIssues([{...base,output:'Cannot read: credential/config directories are off-limits to the agent.'}])[0]!;expect(issue.reason).toContain('固定保护');expect(issue.hint).not.toContain('可调整权限');
});
it('prefers concrete SSH authentication errors over assessment summaries',()=>{
 const issue=operationIssues([{id:'failed',threadId:'th',turnId:'turn',createdAt:'',kind:'commandExecution',command:'ssh root@host hostname',status:'failed',exitCode:255,output:'root@host: Permission denied (publickey,password).\n[assessment: error] 操作执行失败，请核对原始输出'}])[0]!;
 expect(issue.reason).toContain('Permission denied');expect(issue.reason).not.toContain('[assessment:');expect(issue.hint).toContain('用户名/密码');expect(needsSshSetup(issue.output)).toBe(true);
});
it('reports connection metadata without returning secret-bearing objects or connecting',async()=>{
 const metadata={profile:{id:'profile',name:'server',host:'host',username:'user',port:2222,root:'/work',auth:'password',password:'MUST_NOT_LEAK'},status:'disconnected',granted:false,privateKey:'KEY_MUST_NOT_LEAK'};
 const tool=sshConnectionTool({list:()=>({connections:[metadata]})} as any,{list:()=>({bindings:[{threadId:'foreign',target:{host:'FOREIGN_BINDING'}}]})} as any);const results=[];for await(const value of tool.run({}, {threadId:'mine',signal:new AbortController().signal} as any))results.push(value);
 const text=JSON.stringify(results);expect(text).toContain('passwordAuthenticationSupported');expect(text).toContain('2222');expect(text).not.toContain('MUST_NOT_LEAK');expect(text).not.toContain('FOREIGN_BINDING');
});
