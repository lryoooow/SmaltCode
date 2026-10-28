import{afterEach,beforeEach,describe,expect,it,vi}from'vitest';
import{existsSync,mkdtempSync,mkdirSync,readFileSync,readdirSync,rmSync,symlinkSync,writeFileSync}from'node:fs';
import{dirname,join,resolve}from'node:path';import{tmpdir}from'node:os';import{createHash}from'node:crypto';
import type{ShortcutDetails}from'electron';
const mocks=vi.hoisted(()=>({write:vi.fn(),read:vi.fn(),failWrite:false,badReadBack:false,onRead:undefined as undefined|((path:string)=>void)}));
vi.mock('electron',()=>({shell:{writeShortcutLink:mocks.write,readShortcutLink:mocks.read}}));
import{ensurePreviewShortcut}from'../src/main/preview-shortcut';
const platform=Object.getOwnPropertyDescriptor(process,'platform')!;
let root:string,repo:string,appPath:string,appData:string,profile:string,executable:string,programs:string,raw:string;
const appId='app.smaltcode.desktop.development';
const file=(path:string,value:string)=>{mkdirSync(dirname(path),{recursive:true});writeFileSync(path,value)};
const link=(path:string,details:Partial<ShortcutDetails>)=>file(path,JSON.stringify(details));
const options=()=>({enabled:true,executable,appPath,appData,profile,appId});
const args=()=>'"'+appPath+'" --development-preview';
const desired=(target=executable)=>({target,args:args(),cwd:appPath,icon:target,iconIndex:0,appUserModelId:appId,description:'SmaltCode 开发预览'});
const legacy=(patch:Partial<ShortcutDetails>={})=>({target:raw,args:'',appUserModelId:appId,...patch});
const legacyPath=()=>join(programs,'Electron.lnk');
const primary=()=>join(programs,'SmaltCode 开发预览.lnk');
const fallback=()=>join(programs,'SmaltCode 开发预览 ('+createHash('sha256').update(resolve(repo).toLowerCase()).digest('hex').slice(0,10)+').lnk');
beforeEach(()=>{
 Object.defineProperty(process,'platform',{...platform,value:'win32'});
 root=mkdtempSync(join(tmpdir(),'smalt-preview-shortcut-'));repo=join(root,'repo space');appPath=join(repo,'packages','desktop');appData=join(root,'appData');profile=join(repo,'.local-preview','data','desktop-preview-profile');executable=join(repo,'.local-preview','runtime','electron-version-one','SmaltCode Preview.exe');raw=join(repo,'node_modules','electron','dist','electron.exe');programs=join(appData,'Microsoft','Windows','Start Menu','Programs');
 mkdirSync(appPath,{recursive:true});file(executable,'branded-fixture');file(raw,'shared-fixture');
 mocks.failWrite=false;mocks.badReadBack=false;mocks.onRead=undefined;
 mocks.write.mockReset().mockImplementation((path:string,_operation:string,details:ShortcutDetails)=>{if(mocks.failWrite)return false;file(path,JSON.stringify(mocks.badReadBack?{...details,target:raw}:details));return true});
 mocks.read.mockReset().mockImplementation((path:string)=>{mocks.onRead?.(path);return JSON.parse(readFileSync(path,'utf8'))});
});
afterEach(()=>{Object.defineProperty(process,'platform',platform);vi.restoreAllMocks();if(!resolve(root).startsWith(resolve(tmpdir())+'\\')&&!resolve(root).startsWith(resolve(tmpdir())+'/'))throw Error('cleanup escaped temp root');rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:30});});
describe('repository-owned branded preview shortcut',()=>{
 it('does nothing for disabled, non-Windows, raw/shared Electron or another app identity',()=>{
  for(const input of [{...options(),enabled:false},{...options(),executable:raw},{...options(),appId:'app.smaltcode.desktop'}])expect(ensurePreviewShortcut(input)).toMatchObject({created:false,migrated:false});
  Object.defineProperty(process,'platform',{...platform,value:'linux'});expect(ensurePreviewShortcut(options()).created).toBe(false);expect(mocks.write).not.toHaveBeenCalled();expect(existsSync(programs)).toBe(false);expect(existsSync(profile)).toBe(false);
 });
 it('writes and verifies a dedicated link and reuses it without rewriting',()=>{
  const first=ensurePreviewShortcut(options());expect(first).toMatchObject({created:true,updated:false,migrated:false,path:primary()});expect(JSON.parse(readFileSync(primary(),'utf8'))).toEqual(desired());expect(mocks.write).toHaveBeenCalledOnce();const before=readFileSync(primary());expect(ensurePreviewShortcut(options())).toMatchObject({created:false,updated:false,path:primary()});expect(mocks.write).toHaveBeenCalledOnce();expect(readFileSync(primary())).toEqual(before);
 });
 it('retires a recreated legacy Electron link while reusing the correct dedicated shortcut unchanged',()=>{
  ensurePreviewShortcut(options());const correct=readFileSync(primary());link(legacyPath(),legacy());const old=readFileSync(legacyPath());let legacyReads=0,verifiedBackupBeforeRemoval=false;
  mocks.onRead=path=>{if(path!==legacyPath())return;expect(readFileSync(primary())).toEqual(correct);if(++legacyReads===2){expect(existsSync(legacyPath())).toBe(true);const backups=readdirSync(join(profile,'shortcut-backups'));expect(backups).toHaveLength(1);expect(readFileSync(join(profile,'shortcut-backups',backups[0]!))).toEqual(old);verifiedBackupBeforeRemoval=true;}};
  const result=ensurePreviewShortcut(options());expect(result).toMatchObject({created:false,updated:false,migrated:true,path:primary()});expect(verifiedBackupBeforeRemoval).toBe(true);expect(mocks.write).toHaveBeenCalledOnce();expect(readFileSync(primary())).toEqual(correct);expect(existsSync(legacyPath())).toBe(false);expect(result.backups).toHaveLength(1);expect(readFileSync(result.backups[0]!)).toEqual(old);
 });
 it.each(['','quoted','bare'])('backs up and removes only the exact legacy Electron link (%s arguments)',mode=>{
  link(legacyPath(),legacy({args:mode==='quoted'?args():mode==='bare'?'"'+appPath+'"':''}));const before=readFileSync(legacyPath());const production=join(programs,'SmaltCode.lnk');link(production,{target:join(root,'installed','SmaltCode.exe'),appUserModelId:'app.smaltcode.desktop'});const normal=readFileSync(production);
  const result=ensurePreviewShortcut(options());expect(result.migrated).toBe(true);expect(existsSync(legacyPath())).toBe(false);expect(result.backups).toHaveLength(1);expect(readFileSync(result.backups[0]!)).toEqual(before);expect(readFileSync(production)).toEqual(normal);expect(JSON.parse(readFileSync(primary(),'utf8'))).toEqual(desired());
 });
 it.each([{appUserModelId:'another.electron.app'},{target:'C:\\another-repository\\node_modules\\electron\\dist\\electron.exe'},{args:'"foreign app" --development-preview'}])('preserves a legacy link with foreign ownership metadata: %j',patch=>{
  link(legacyPath(),legacy(patch));const before=readFileSync(legacyPath());const result=ensurePreviewShortcut(options());expect(result.created).toBe(true);expect(result.migrated).toBe(false);expect(result.backups).toEqual([]);expect(readFileSync(legacyPath())).toEqual(before);
 });
 it('uses the repository hash name when the friendly name belongs to another application',()=>{
  link(primary(),{target:join(root,'foreign.exe'),args:'foreign',appUserModelId:'foreign'});const before=readFileSync(primary());const result=ensurePreviewShortcut(options());expect(result.path).toBe(fallback());expect(JSON.parse(readFileSync(fallback(),'utf8'))).toEqual(desired());expect(readFileSync(primary())).toEqual(before);
 });
 it('refuses to overwrite either of two foreign names and leaves the legacy link intact',()=>{
  link(primary(),{target:'foreign'});link(fallback(),{target:'foreign fallback'});link(legacyPath(),legacy());const before=readFileSync(legacyPath());expect(()=>ensurePreviewShortcut(options())).toThrow('未覆盖');expect(mocks.write).not.toHaveBeenCalled();expect(readFileSync(legacyPath())).toEqual(before);
 });
 it.each(['write','read-back'])('does not migrate legacy data after %s failure',kind=>{
  link(legacyPath(),legacy());const before=readFileSync(legacyPath());mocks.failWrite=kind==='write';mocks.badReadBack=kind==='read-back';expect(()=>ensurePreviewShortcut(options())).toThrow(/写入失败|读回校验失败/);expect(readFileSync(legacyPath())).toEqual(before);expect(existsSync(primary())).toBe(false);expect(existsSync(join(profile,'shortcut-backups'))).toBe(false);
 });
 it('atomically updates its strictly owned old-version link and retains a verified backup',()=>{
  const old=join(repo,'.local-preview','runtime','old-version','SmaltCode Preview.exe');file(old,'old branded');link(primary(),desired(old));const before=readFileSync(primary());const result=ensurePreviewShortcut(options());expect(result).toMatchObject({created:false,updated:true,path:primary()});expect(result.backups).toHaveLength(1);expect(readFileSync(result.backups[0]!)).toEqual(before);expect(JSON.parse(readFileSync(primary(),'utf8'))).toEqual(desired());expect(readdirSync(programs).filter(n=>n.endsWith('.lnk'))).toEqual(['SmaltCode 开发预览.lnk']);
 });
 it.each(['runtime','source'])('repairs its exact current branded primary with missing source arguments and %s cwd, preserving the fallback and original bytes',mode=>{
  const incomplete={...desired(),args:'',cwd:mode==='runtime'?dirname(executable):appPath,icon:''};link(primary(),incomplete);link(fallback(),desired());const before=readFileSync(primary()),fallbackBefore=readFileSync(fallback());let verifiedBackupBeforeReplace=false;
  mocks.onRead=path=>{if(path!==primary()||verifiedBackupBeforeReplace)return;const folder=join(profile,'shortcut-backups');if(!existsSync(folder))return;const backups=readdirSync(folder);if(backups.length){expect(readFileSync(join(folder,backups[0]!))).toEqual(before);expect(readFileSync(primary())).toEqual(before);verifiedBackupBeforeReplace=true;}};
  const result=ensurePreviewShortcut(options());expect(result).toMatchObject({created:false,updated:true,migrated:false,path:primary()});expect(verifiedBackupBeforeReplace).toBe(true);expect(result.backups).toHaveLength(1);expect(readFileSync(result.backups[0]!)).toEqual(before);expect(JSON.parse(readFileSync(primary(),'utf8'))).toEqual(desired());expect(readFileSync(fallback())).toEqual(fallbackBefore);
  const corrected=readFileSync(primary());expect(ensurePreviewShortcut(options())).toMatchObject({created:false,updated:false,migrated:false,backups:[]});expect(readFileSync(primary())).toEqual(corrected);expect(readFileSync(fallback())).toEqual(fallbackBefore);
 });
 it.each([{appUserModelId:'another.application'},{target:'C:\\foreign\\SmaltCode Preview.exe'},{args:'"foreign application" --development-preview'},{cwd:'C:\\foreign-workspace'},{icon:'C:\\foreign-icon.exe'},{iconIndex:1}])('preserves a branded-looking empty-argument primary outside the precise repair predicate: %j',patch=>{
  link(primary(),{...desired(),args:'',cwd:dirname(executable),icon:'',...patch});const before=readFileSync(primary());const result=ensurePreviewShortcut(options());expect(result).toMatchObject({created:true,updated:false,migrated:false,path:fallback(),backups:[]});expect(readFileSync(primary())).toEqual(before);expect(JSON.parse(readFileSync(fallback(),'utf8'))).toEqual(desired());
 });
 it('does not repair missing arguments in an existing hashed fallback',()=>{
  link(primary(),{target:'C:\\foreign.exe',args:'',appUserModelId:'foreign'});link(fallback(),{...desired(),args:'',cwd:dirname(executable),icon:''});const before=readFileSync(fallback());expect(()=>ensurePreviewShortcut(options())).toThrow('未覆盖');expect(readFileSync(fallback())).toEqual(before);expect(mocks.write).not.toHaveBeenCalled();
 });
 it('retains a primary whose ownership changes after backup rather than publishing over it',()=>{
  link(primary(),{...desired(),args:'',cwd:dirname(executable),icon:''});const before=readFileSync(primary());let reads=0;mocks.onRead=path=>{if(path===primary()&&++reads===2)link(path,{...desired(),args:'foreign-nonempty'})};
  expect(()=>ensurePreviewShortcut(options())).toThrow('变化');expect(JSON.parse(readFileSync(primary(),'utf8')).args).toBe('foreign-nonempty');const backups=readdirSync(join(profile,'shortcut-backups'));expect(backups).toHaveLength(1);expect(readFileSync(join(profile,'shortcut-backups',backups[0]!))).toEqual(before);
 });
 it('preserves a legacy file changed after backup even when its parsed metadata is still identical',()=>{
  link(legacyPath(),legacy());const before=readFileSync(legacyPath());let reads=0;mocks.onRead=path=>{if(path===legacyPath()&&++reads===2)writeFileSync(path,Buffer.concat([readFileSync(path),Buffer.from(' ')]))};
  expect(()=>ensurePreviewShortcut(options())).toThrow('变化');expect(readFileSync(legacyPath())).toEqual(Buffer.concat([before,Buffer.from(' ')]));const backups=readdirSync(join(profile,'shortcut-backups')).map(n=>readFileSync(join(profile,'shortcut-backups',n)));expect(backups).toContainEqual(before);expect(existsSync(primary())).toBe(true);
 });
 it('verifies the published replacement before reading or retiring the old Electron link',()=>{
  link(legacyPath(),legacy());mocks.onRead=path=>{if(path===legacyPath())expect(JSON.parse(readFileSync(primary(),'utf8'))).toEqual(desired())};expect(ensurePreviewShortcut(options()).migrated).toBe(true);
 });
 it('rejects a junction in the destination ancestry without writing links or following it',()=>{
  const target=join(root,'foreign-programs');mkdirSync(target);mkdirSync(dirname(programs),{recursive:true});symlinkSync(target,programs,'junction');expect(()=>ensurePreviewShortcut(options())).toThrow('包含链接');expect(mocks.write).not.toHaveBeenCalled();expect(readdirSync(target)).toEqual([]);
 });
 it('preserves a non-file Electron.lnk entry rather than following or removing it',()=>{
  mkdirSync(legacyPath(),{recursive:true});expect(ensurePreviewShortcut(options()).migrated).toBe(false);expect(existsSync(legacyPath())).toBe(true);
 });
});
