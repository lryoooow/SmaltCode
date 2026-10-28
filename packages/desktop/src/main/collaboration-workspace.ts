import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import { delimiter, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { isSensitivePath } from '@smalt/kernel';
import type { ReviewFile } from '../shared/collaboration.js';

type Entry = { hash: string; mode: number; size: number };
export type Manifest = Record<string, Entry>;
type Baseline = { cwd: string; head: string; common: string; index: string; files: Manifest; excluded: string[] };
const MAX_FILE = 2 * 1024 * 1024, MAX_TOTAL = 96 * 1024 * 1024, MAX_FILES = 10000;
const digest = (b: string | Buffer) => createHash('sha256').update(b).digest('hex');
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const exists = async (p: string) => fs.lstat(p).then(() => true, e => { if (e.code === 'ENOENT') return false; throw e; });
export function safeRelative(p: string): string {
  if (typeof p !== 'string' || !p || p.length > 1000 || /[\x00-\x1f\\:*?"<>|]/.test(p) || isAbsolute(p) || p.split('/').some(s => !s || s === '.' || s === '..' || /[. ]$/.test(s) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(s))) throw new Error('路径必须是项目内的普通相对文件或目录：' + String(p).slice(0, 100));
  return p;
}
export function excludedPath(p: string) {
  return p.split('/').some(s => /^(?:\.git(?:attributes|modules)?|\.gitconfig|\.git-credentials|\.npmrc|\.netrc|id_rsa|id_dsa|id_ed25519|id_ecdsa|\.smalt|\.local-preview|node_modules|\.venv|\.ssh|\.aws|\.gnupg)$/i.test(s)) || /(?:^|\/)\.env(?:\.|$)/i.test(p) && !/\.(?:example|template)$/i.test(p) || /\.(?:pem|key|pfx|p12)$/i.test(p);
}
export function grantedPath(path: string, grants: string[]) { return grants.some(p => path === p || path.startsWith(p + '/')); }
export async function canonicalPath(p: string) { const value=(await fs.realpath(p)).replace(/\\/g, '/').replace(/\/$/, ''); return process.platform==='win32'?value.toLowerCase():value; }
async function filePath(root: string, name: string, internal = false) {
  safeRelative(name); const base = await fs.realpath(root), target = resolve(base, name); let cursor = base;
  for (const segment of name.split('/')) {
    cursor = join(cursor, segment);
    try { const st = await fs.lstat(cursor); if (st.isSymbolicLink()) throw new Error('协作不接受符号链接或目录联接：' + name); }
    catch (e: any) { if (e.code !== 'ENOENT') throw e; }
  }
  if (!internal && isSensitivePath(base, target)) throw new Error('敏感位置不能进入协作快照：' + name);
  return target;
}
async function gitExecutable(cwd:string){
  for(const dir of (process.env.PATH??'').split(delimiter)){
    if(!isAbsolute(dir)||relative(cwd,dir)===''||!relative(cwd,dir).startsWith('..')&&!isAbsolute(relative(cwd,dir)))continue;
    const path=join(dir,process.platform==='win32'?'git.exe':'git');try{if((await fs.stat(path)).isFile())return path;}catch{}
  }
  throw new Error('找不到系统 Git，请安装 Git 并将程序目录加入 PATH 后重启应用');
}
export async function git(cwd: string, args: string[], signal?: AbortSignal, runtime?:string): Promise<{ text: string; code: number }> {
  signal?.throwIfAborted();
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_|(?:TOKEN|SECRET|API_?KEY|PASSWORD|CREDENTIAL)|^NODE_OPTIONS$/i.test(key)));
  Object.assign(env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_TERMINAL_PROMPT: '0' });
  const program=await gitExecutable(cwd),argv=['-c', 'core.hooksPath=' + (process.platform==='win32'?'NUL':'/dev/null'), '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', '-c', 'core.autocrlf=false', '-c', 'gc.auto=0', '-c', 'maintenance.auto=false', ...args];
  const supervisor=runtime&&process.platform==='win32'?join(runtime,'native','SmaltProcessSupervisor.exe').replace(/([\\/])app\.asar([\\/]|$)/i,'$1app.asar.unpacked$2'):undefined;
  if(supervisor&&!await exists(supervisor))throw new Error('缺少 Git 进程监管程序，请修复应用文件后再运行协作');
  const launchArgs=supervisor?[Buffer.from(JSON.stringify({file:program,args:argv,parentPid:process.pid,parentStartedAt:Date.now()-process.uptime()*1000,stdio:true})).toString('base64')]:argv;
  signal?.throwIfAborted();return new Promise((accept, reject) => {
    execFile(supervisor??program, launchArgs, { cwd, env, signal, windowsHide: true, timeout: 60000, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' }, (error: any, stdout, stderr) => {
      if (error && ![1, 2].includes(error.code)) reject(new Error('Git 操作失败：' + String(stderr || error.message).slice(0, 2000)));
      else accept({ text: stdout, code: error?.code ?? 0 });
    });
  });
}
async function strictGit(cwd: string, args: string[], signal?: AbortSignal,runtime?:string) { const r = await git(cwd, args, signal,runtime); if (r.code) throw new Error('Git 操作未完成：' + args[0]); return r.text.trim(); }
async function readFile(root: string, name: string, internal = false): Promise<{ bytes: Buffer; entry: Entry } | undefined> {
  const path = await filePath(root, name, internal);
  let handle;
  try {
    handle = await fs.open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); const st = await handle.stat();
    if (!st.isFile() || st.size > MAX_FILE) throw new Error('文件类型或大小不适合协作（单文件上限 2 MB）：' + name);
    const bytes = await handle.readFile(); await filePath(root, name, internal); const after = await handle.stat();
    if (bytes.length !== st.size || after.mtimeMs !== st.mtimeMs || after.size !== st.size) throw new Error('文件正在变化，请稍后重试：' + name);
    return { bytes, entry: { hash: digest(bytes), mode: st.mode & 0o777, size: bytes.length } };
  } catch (e: any) { if (e.code === 'ENOENT') return undefined; throw e; } finally { await handle?.close(); }
}
async function treeNames(root: string, sub = ''): Promise<string[]> {
  const out: string[] = [];
  for (const d of await fs.readdir(join(root, sub), { withFileTypes: true })) {
    const name = sub ? sub + '/' + d.name : d.name;
    if (d.name === '.git' && !sub) continue;
    safeRelative(name);
    if (excludedPath(name)) throw new Error('隔离工作区出现禁止的配置或生成目录：' + name);
    if (d.isSymbolicLink()) throw new Error('隔离工作区出现链接：' + name);
    if (d.isDirectory()) out.push(...await treeNames(root, name)); else if (d.isFile()) out.push(name); else throw new Error('不支持的文件类型：' + name);
    if (out.length > MAX_FILES) throw new Error('协作文件超过 10000 项');
  }
  return out.sort();
}
async function manifest(root: string, names: string[], copy?: string, signal?: AbortSignal, internal = false) {
  const files: Manifest = Object.create(null); let total = 0;
  for (const name of names) {
    signal?.throwIfAborted(); const file = await readFile(root, name, internal); if (!file) continue;
    total += file.bytes.length; if (total > MAX_TOTAL) throw new Error('协作快照超过 96 MB，请缩小项目范围'); files[name] = file.entry;
    if (copy) { const p = join(copy, name); await fs.mkdir(dirname(p), { recursive: true }); await fs.writeFile(p, file.bytes, { mode: file.entry.mode }); }
  }
  return files;
}
export class CollaborationWorkspace {
  readonly directory: string;
  constructor(private root: string, readonly id: string,private runtime?:string,private expectedCwd?:string) {
    if (!/^team_[a-f0-9-]{36}$/.test(id)) throw new Error('无效的协作标识');
    this.directory = join(root, 'collaborations', id);
  }
  private git(cwd:string,args:string[],signal?:AbortSignal){return strictGit(cwd,args,signal,this.runtime);}
  path(key: string) { if (!/^(?:task-[a-z0-9-]{1,40}|review)$/.test(key)) throw new Error('无效的子任务标识'); return join(this.root + '-workspaces', this.id, key); }
  private async load(): Promise<Baseline> {
    const bytes=await fs.readFile(join(this.directory,'baseline.json'));if(bytes.length>4*1024*1024)throw new Error('协作快照记录过大');const value=JSON.parse(bytes.toString());
    if(!value||!value.files||typeof value.files!=='object'||Array.isArray(value.files)||Object.keys(value.files).length>MAX_FILES||!/^[a-f0-9]{40,64}$/.test(value.head)||typeof value.cwd!=='string'||typeof value.common!=='string'||typeof value.index!=='string')throw new Error('协作快照记录无效');
    for(const [name,e]of Object.entries(value.files) as [string,Entry][]){safeRelative(name);if(excludedPath(name)||!e||!/^[a-f0-9]{64}$/.test(e.hash)||!Number.isSafeInteger(e.mode)||!Number.isSafeInteger(e.size)||e.size<0||e.size>MAX_FILE)throw new Error('协作文件清单无效');}
    if(this.expectedCwd&&await canonicalPath(value.cwd)!==await canonicalPath(this.expectedCwd))throw new Error('协作基线与获准的原项目不匹配');return value;
  }
  private async source(cwd: string, signal?: AbortSignal) {
    const top = await this.git(cwd, ['rev-parse', '--show-toplevel'], signal);
    if (await canonicalPath(top) !== await canonicalPath(cwd)) throw new Error('请选择 Git 仓库根目录作为协作工作区');
    const common = resolve(cwd, await this.git(cwd, ['rev-parse', '--git-common-dir'], signal));
    const ownGit = resolve(cwd, await this.git(cwd, ['rev-parse', '--git-dir'], signal));
    for (const mark of ['MERGE_HEAD','CHERRY_PICK_HEAD','REVERT_HEAD','rebase-merge','rebase-apply','index.lock']) if (await exists(join(ownGit, mark))) throw new Error('项目有未完成的 Git 操作，请处理后开始协作');
    const stages = await this.git(cwd, ['ls-files', '--stage', '-z'], signal);
    if (stages.split('\0').some(line => /^(?:120000|160000) /.test(line) || /^\d+ [a-f0-9]+ [123]\t/.test(line))) throw new Error('项目包含链接、子模块或未解决的索引冲突，暂不支持安全隔离');
    const names = (await this.git(cwd, ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], signal)).split('\0').filter(Boolean);
    if (names.length > MAX_FILES) throw new Error('项目文件超过 10000 项，请缩小协作范围');
    const excluded = names.filter(excludedPath), selected = [...new Set(names.filter(p => !excludedPath(p)).map(safeRelative))].sort();
    if (new Set(selected.map(p => p.toLowerCase())).size !== selected.length) throw new Error('项目存在大小写冲突文件');
    const indexPath = resolve(cwd, await this.git(cwd, ['rev-parse', '--git-path', 'index'], signal));
    const index = await fs.readFile(indexPath).then(digest, e => { if (e.code === 'ENOENT') return ''; throw e; });
    return { cwd: await fs.realpath(cwd), common: await fs.realpath(common), head: await this.git(cwd, ['rev-parse', 'HEAD'], signal), index, selected, excluded };
  }
  async prepare(cwd: string, signal: AbortSignal) {
    if (await exists(this.directory)) throw new Error('协作目录已存在，不能覆盖旧结果');
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const source = await this.source(cwd, signal), base = join(this.directory, 'baseline'); await fs.mkdir(base);
    const files = await manifest(cwd, source.selected, base, signal);
    const after = await this.source(cwd, signal);
    if (source.head !== after.head || source.index !== after.index || !same(source.selected, after.selected) || !same(files, await manifest(cwd, after.selected, undefined, signal))) throw new Error('项目在快照期间发生变化，请新建协作重试');
    const baseline: Baseline = { cwd: source.cwd, common: source.common, head: source.head, index: source.index, files, excluded: source.excluded };
    await fs.writeFile(join(this.directory, 'baseline.json'), JSON.stringify(baseline), { mode: 0o600 }); return { head: source.head, snapshot: digest(JSON.stringify(files)), excluded: source.excluded };
  }
  async create(key: string, signal: AbortSignal) {
    const b = await this.load(), path = this.path(key); signal.throwIfAborted();
    if (await exists(path)) throw new Error('隔离工作区已存在');
    // --no-checkout avoids repository hooks and clean/smudge filters. Populate our immutable byte snapshot instead.
    await fs.mkdir(dirname(path),{recursive:true,mode:0o700});
    await fs.writeFile(join(this.directory,key+'.owner.json'),JSON.stringify({path,common:b.common,state:'creating'}),{mode:0o600});
    await this.git(b.cwd, ['worktree', 'add', '--detach', '--no-checkout', '--lock', '--reason', 'SmaltCode ' + this.id, path, b.head], signal);
    const pointer = await fs.readFile(join(path, '.git'), 'utf8'), gitdir = pointer.match(/^gitdir: (.+)\s*$/)?.[1]; if (!gitdir) throw new Error('worktree 元数据异常');
    await fs.writeFile(join(this.directory, key + '.owner.json'), JSON.stringify({ path, gitdir: resolve(path, gitdir), common: b.common }), { mode: 0o600 });
    await this.git(path, ['read-tree', b.head], signal);
    await manifest(join(this.directory, 'baseline'), Object.keys(b.files), path, signal, true); await this.verify(key); return path;
  }
  async verify(key: string) {
    const b = await this.load(), path = this.path(key), owner = JSON.parse(await fs.readFile(join(this.directory, key + '.owner.json'), 'utf8'));
    const lexical=resolve(path).replace(/\\/g, '/');
    if (owner.path !== path || owner.common !== b.common || await canonicalPath(path) !== (process.platform==='win32'?lexical.toLowerCase():lexical)) throw new Error('隔离工作区位置或所有权已变化');
    const pointer = (await fs.readFile(join(path, '.git'), 'utf8')).match(/^gitdir: (.+)\s*$/)?.[1];
    const expected = typeof owner.gitdir==='string'?resolve(owner.gitdir):resolve(path,pointer??'.'); const rel = relative(join(b.common, 'worktrees'), expected);
    if (!pointer || resolve(path, pointer) !== expected || !rel || rel.startsWith('..') || isAbsolute(rel) || relative(expected, join(b.common, 'worktrees', rel)) !== '') throw new Error('worktree 指针不属于本协作');
    if ((await fs.readFile(join(expected, 'gitdir'), 'utf8')).trim().replace(/\\/g, '/') !== join(path, '.git').replace(/\\/g, '/')) throw new Error('worktree 反向指针不匹配');
    if(!owner.gitdir&&(owner.state!=='creating'||(await fs.readFile(join(expected,'locked'),'utf8')).trim()!=='SmaltCode '+this.id))throw new Error('未完成的 worktree 创建记录不能证明所有权');
    return path;
  }
  async changes(key: string, grants?: string[]) {
    const b = await this.load(), path = await this.verify(key), files = await manifest(path, await treeNames(path));
    const changed = [...new Set([...Object.keys(b.files), ...Object.keys(files)])].filter(p => !same(b.files[p], files[p])).sort();
    if (grants && changed.some(p => !grantedPath(p, grants))) throw new Error('子任务出现授权范围外的修改，已阻止汇总和合并'); return { changed, files };
  }
  async assertSource() {
    const b = await this.load(), s = await this.source(b.cwd);
    if (s.head !== b.head || s.index !== b.index || !same(b.files, await manifest(b.cwd, s.selected))) throw new Error('原项目或 Git 索引已变化，不能覆盖；请保留结果并新建协作重新审查');
    return b;
  }
  async review(selected: { key: string; paths: string[]; role: string }[], signal: AbortSignal): Promise<ReviewFile[]> {
    await this.assertSource(); const b = await this.load(); const review = this.path('review');
    if (await exists(review)) await this.remove('review'); await this.create('review', signal);
    const files: ReviewFile[] = [];
    for (const child of selected) {
      signal.throwIfAborted(); const { changed } = await this.changes('task-' + child.key, child.role === 'read' ? [] : child.paths);
      for (const path of changed) {
        const original = await readFile(join(this.directory, 'baseline'), path, true), theirs = await readFile(this.path('task-' + child.key), path);
        let f = files.find(v => v.path === path);
        const text = (b: Buffer | undefined) => { if (!b) return null; try { const t = new TextDecoder('utf8', { fatal: true, ignoreBOM:true }).decode(b); return t.includes('\0') ? undefined : t; } catch { return undefined; } };
        const base = text(original?.bytes), next = text(theirs?.bytes);
        if (base === undefined || next === undefined) throw new Error('二进制修改需在子任务目录手动处理，不能自动合并：' + path);
        if (!f) { f = { path, base, current: base, proposed: next, binary: false, conflict: false, resolved: true, sources: [child.key] }; files.push(f); }
        else {
          if(f.conflict)throw new Error('同一文件有超过两项互相冲突的结果，请分批选择审查：'+path);
          f.sources.push(child.key);
          if (f.proposed === next) continue;
          if (f.conflict || base === null || next === null || f.proposed === null) { f.conflict = true; f.resolved = false; f.current = f.proposed; f.proposed = next; }
          else {
            const temp = join(this.directory, 'merge-' + randomUUID()); await fs.mkdir(temp);
            try {
              await Promise.all([fs.writeFile(join(temp,'ours'), f.proposed),fs.writeFile(join(temp,'base'), base),fs.writeFile(join(temp,'theirs'), next)]);
              const result = await git(b.cwd, ['merge-file','-p','--diff3','-L','已汇总修改','-L','共享基线','-L',child.key,join(temp,'ours'),join(temp,'base'),join(temp,'theirs')], signal, this.runtime);
              if (result.code > 0) { f.current = f.proposed; f.conflict = true; f.resolved = false; } f.proposed = result.text;
            } finally { await fs.rm(temp, { recursive: true, force: true }); }
          }
        }
      }
    }
    if (files.length > 200 || files.reduce((n,f)=>n+(f.base?.length??0)+(f.proposed?.length??0)+(f.current?.length??0),0)>4*1024*1024) throw new Error('审查内容过多（最多 200 文件 / 4 MB），请减少选择的子任务');
    await this.writeReview(files); return files;
  }
  async writeReview(files: ReviewFile[]) {
    const root = await this.verify('review');
    for (const f of files) { const target = await filePath(root, f.path); if (f.proposed === null) await fs.rm(target, { force: true }); else { await fs.mkdir(dirname(target), { recursive: true }); await fs.writeFile(target, f.proposed); } }
  }
  async assertReview(files: ReviewFile[]) {
    const b = await this.load(), root = await this.verify('review'); const expected = structuredClone(b.files);
    for (const f of files) {
      if (f.conflict && !f.resolved) throw new Error('还有未解决的冲突');
      if (f.proposed === null) delete expected[f.path]; else { const bytes = Buffer.from(f.proposed); expected[f.path] = { hash: digest(bytes), size: bytes.length, mode: b.files[f.path]?.mode ?? 0o644 }; }
    }
    // A manual test may create ignored dependency/cache directories. They are not merge inputs.
    // Always inspect every baseline/candidate path even if a changed .gitignore would hide it.
    const listed=(await this.git(root,['ls-files','--cached','--others','--exclude-standard','-z'])).split('\0').filter(p=>p&&!excludedPath(p)).map(safeRelative);
    const actual = await manifest(root,[...new Set([...Object.keys(expected),...listed])].sort());
    // Windows does not expose Unix executable bits; compare byte content, not an invented mode change.
    if (!same(Object.keys(expected).sort(), Object.keys(actual).sort()) || Object.keys(expected).some(p=>expected[p]!.hash!==actual[p]!.hash)) throw new Error('审查工作区已被修改，请重新汇总；旧验证已失效');
  }
  async apply(files: ReviewFile[], reviewDigest: string) {
    const b = await this.assertSource(); await this.assertReview(files);
    const journalPath = join(this.directory,'apply-journal.json');
    if (await exists(journalPath)) throw new Error('已有合并事务记录，不能重复应用；请检查结果或恢复备份');
    const journal = { status:'applying', reviewDigest, cwd:b.cwd, files: files.map(f=>({ path:f.path, before:f.base, after:f.proposed })), applied: [] as string[], error: '' };
    const save = () => fs.writeFile(journalPath, JSON.stringify(journal), { mode:0o600 }); await save();
    try {
      for (const f of files) {
        const before = await readFile(b.cwd,f.path); if ((before?.bytes.toString('utf8') ?? null) !== f.base) throw new Error('写入前文件已变化：'+f.path);
        const target = await filePath(b.cwd,f.path); await fs.mkdir(dirname(target),{recursive:true});
        if (f.proposed===null) await fs.rm(target); else { const tmp=target+'.smalt-'+randomUUID()+'.tmp'; try { await fs.writeFile(tmp,f.proposed,{mode:b.files[f.path]?.mode ?? 0o644,flag:'wx'}); await filePath(b.cwd,f.path); await fs.rename(tmp,target); } finally { await fs.rm(tmp,{force:true}); } }
        journal.applied.push(f.path); await save();
      }
      journal.status='applied'; await save();
    } catch (e) {
      journal.error=e instanceof Error?e.message:String(e); journal.status='rolled-back';
      for (const name of [...journal.applied].reverse()) {
        const f=files.find(f=>f.path===name)!;
        try { const current=await readFile(b.cwd,name); if ((current?.bytes.toString('utf8') ?? null)!==f.proposed) throw new Error('并发修改'); const target=await filePath(b.cwd,name); if(f.base===null)await fs.rm(target,{force:true});else await fs.writeFile(target,f.base); }
        catch { journal.status='recovery-required'; }
      }
      await save(); throw new Error(journal.error + (journal.status==='recovery-required'?'；部分文件已被再次修改，备份与事务记录已保留，请人工恢复':'；本次写入已撤回，备份已保留'));
    }
  }
  async remove(key: string) { const b=await this.load(); const path=await this.verify(key);const pointer=(await fs.readFile(join(path,'.git'),'utf8')).match(/^gitdir: (.+)\s*$/)![1]!;if(await exists(join(resolve(path,pointer),'locked')))await this.git(b.cwd,['worktree','unlock',path]);await this.git(b.cwd,['worktree','remove','--force',path]); }
  async keys() { try { return (await fs.readdir(this.directory)).filter(n=>/^(task-[a-z0-9-]{1,40}|review)\.owner\.json$/.test(n)).map(n=>n.replace('.owner.json','')); } catch(e:any) {if(e.code==='ENOENT')return [];throw e;} }
  async exists(key:string) { return exists(this.path(key)); }
  async journal() { try { return JSON.parse(await fs.readFile(join(this.directory,'apply-journal.json'),'utf8')) as {status:string}; } catch(e:any) {if(e.code==='ENOENT')return undefined;throw e;} }
}
export const reviewDigest = (files: ReviewFile[]) => digest(JSON.stringify(files));
