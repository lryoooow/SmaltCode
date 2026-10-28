import { shell, type ShortcutDetails } from 'electron';
import { constants, copyFileSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, openSync, fsyncSync, closeSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

type Options={enabled:boolean;executable:string;appPath:string;appData:string;profile:string;appId:string};
type Result={created:boolean;updated:boolean;migrated:boolean;path?:string;backups:string[]};
type Snapshot={bytes:Buffer;hash:string;details:ShortcutDetails};
const id='app.smaltcode.desktop.development',title='SmaltCode 开发预览',limit=1024*1024;
const key=(path:string)=>resolve(path).toLowerCase();
const same=(a:unknown,b:string)=>typeof a==='string'&&isAbsolute(a)&&key(a)===key(b);
const hash=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
function inside(root:string,path:string){const rel=relative(resolve(root),resolve(path));return !!rel&&!rel.startsWith('..'+sep)&&rel!=='..'&&!isAbsolute(rel);}
function stat(path:string){try{return lstatSync(path);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}}
/** Reject junctions as well as symbolic links, including existing ancestors of a new path. */
function noLinks(path:string){let current=resolve(path);for(;;){const info=stat(current);if(info?.isSymbolicLink())throw Error('快捷方式路径包含链接，未自动修改');const parent=dirname(current);if(parent===current)break;current=parent;}}
function directory(path:string){noLinks(path);mkdirSync(path,{recursive:true});noLinks(path);if(!lstatSync(path).isDirectory())throw Error('快捷方式目录不是普通目录');}
function bytes(path:string){noLinks(path);const info=lstatSync(path);if(!info.isFile()||info.size>limit)throw Error('快捷方式不是有界普通文件');const value=readFileSync(path);if(value.length>limit)throw Error('快捷方式超过读取限制');return value;}
function shortcut(path:string):Snapshot|undefined{
  const info=stat(path);if(!info||info.isSymbolicLink()||!info.isFile()||info.size>limit)return;
  noLinks(path);const value=bytes(path);let details:ShortcutDetails;
  try{details=shell.readShortcutLink(path);}catch{return;}
  const digest=hash(value);if(hash(bytes(path))!==digest)throw Error('快捷方式在读取期间变化，未自动修改');
  return{bytes:value,hash:digest,details};
}
function desiredLink(d:ShortcutDetails,want:ShortcutDetails){return same(d.target,want.target)&&same(d.cwd,want.cwd!)&&d.args===want.args&&same(d.icon,want.icon!)&&(d.iconIndex??0)===0&&d.appUserModelId===want.appUserModelId;}
function branded(root:string,path:unknown){return typeof path==='string'&&isAbsolute(path)&&basename(path).toLowerCase()==='smaltcode preview.exe'&&inside(root,path);}
function owned(d:ShortcutDetails,runtime:string,appPath:string,args:string,appId:string){
  if(!branded(runtime,d.target)||d.appUserModelId!==appId||d.args!==args||!same(d.cwd,appPath))return false;
  try{noLinks(d.target);return true;}catch{return false;}
}
/** Repair only the exact branded primary entry whose missing source args prevent reopening. */
function repairableEmptyArgs(path:string,primary:string,d:ShortcutDetails,executable:string,appPath:string,appId:string){
  if(!same(path,primary)||d.appUserModelId!==appId||!same(d.target,executable)||(d.args??'')!==''||!(same(d.cwd,appPath)||same(d.cwd,dirname(executable)))||d.icon&& !same(d.icon,executable)||(d.iconIndex??0)!==0)return false;
  try{noLinks(d.target);return true;}catch{return false;}
}
function unchanged(path:string,before:Snapshot,accept:(details:ShortcutDetails)=>boolean){const current=shortcut(path);if(!current||current.hash!==before.hash||!accept(current.details))throw Error('快捷方式在确认期间变化，原文件保留');}
function backup(path:string,before:Snapshot,profile:string,results:string[]){
  const folder=join(profile,'shortcut-backups');directory(folder);noLinks(path);
  if(hash(bytes(path))!==before.hash)throw Error('快捷方式在备份前变化，原文件保留');
  const target=join(folder,basename(path,'.lnk')+'-'+before.hash.slice(0,16)+'-'+randomUUID()+'.lnk');
  copyFileSync(path,target,constants.COPYFILE_EXCL);
  if(hash(bytes(target))!==before.hash||hash(bytes(path))!==before.hash)throw Error('快捷方式备份校验失败，原文件保留');
  const fd=openSync(target,'r+');try{fsyncSync(fd);}finally{closeSync(fd);}
  results.push(target);return target;
}
function cleanup(path:string|undefined,expected?:string){if(!path||!expected)return;try{const info=stat(path);if(info?.isFile()&&!info.isSymbolicLink()&&hash(bytes(path))===expected)unlinkSync(path);}catch{/* retain uncertain temporary evidence rather than removing someone else's file */}}

/** Register only this repository's branded preview, then retire its exact legacy Electron link. */
export function ensurePreviewShortcut(options:Options):Result{
  const result:Result={created:false,updated:false,migrated:false,backups:[]};
  if(process.platform!=='win32'||!options.enabled)return result;
  if(options.appId!==id||![options.executable,options.appPath,options.appData,options.profile].every(p=>typeof p==='string'&&isAbsolute(p)))return result;
  const appPath=resolve(options.appPath),repo=resolve(appPath,'../..'),runtime=join(repo,'.local-preview','runtime'),executable=resolve(options.executable),profile=resolve(options.profile);
  if(!same(appPath,join(repo,'packages','desktop'))||!branded(runtime,executable)||!inside(join(repo,'.local-preview'),profile)||/["\r\n\0]/.test(appPath))return result;
  for(const path of [appPath,executable,profile,options.appData])noLinks(path);
  if(!lstatSync(appPath).isDirectory()||!lstatSync(executable).isFile())throw Error('开发预览程序或项目目录无效');
  const args='"'+appPath+'" --development-preview',programs=join(resolve(options.appData),'Microsoft','Windows','Start Menu','Programs');
  const want:ShortcutDetails={target:executable,args,cwd:appPath,icon:executable,iconIndex:0,appUserModelId:options.appId,description:title};
  directory(programs);
  const names=[title+'.lnk',title+' ('+createHash('sha256').update(key(repo)).digest('hex').slice(0,10)+').lnk'];
  const primary=join(programs,names[0]!);
  const ours=(path:string,d:ShortcutDetails)=>owned(d,runtime,appPath,args,options.appId)||repairableEmptyArgs(path,primary,d,executable,appPath,options.appId);
  let path:string|undefined,previous:Snapshot|undefined;
  for(const name of names){const candidate=join(programs,name),existing=stat(candidate);if(!existing){path=candidate;break;}const read=shortcut(candidate);if(read&&(desiredLink(read.details,want)||ours(candidate,read.details))){path=candidate;previous=read;break;}}
  if(!path)throw Error('同名开发预览快捷方式不属于此项目，未覆盖任何链接');
  result.path=path;
  if(!previous||!desiredLink(previous.details,want)){
    const staging=join(profile,'shortcut-staging');directory(staging);const temporary=join(staging,'preview-'+randomUUID()+'.lnk');let adjacent:string|undefined,digest:string|undefined;
    try{
      if(!shell.writeShortcutLink(temporary,'create',want))throw Error('开发预览快捷方式写入失败，旧链接保留');
      const written=shortcut(temporary);if(!written||!desiredLink(written.details,want))throw Error('开发预览快捷方式读回校验失败，旧链接保留');digest=written.hash;
      if(previous){
        backup(path,previous,profile,result.backups);
        const candidate=join(programs,'.smalt-preview-'+randomUUID()+'.lnk');copyFileSync(temporary,candidate,constants.COPYFILE_EXCL);adjacent=candidate;
        if(hash(bytes(adjacent))!==digest||!desiredLink(shell.readShortcutLink(adjacent),want))throw Error('开发预览快捷方式临时发布校验失败');
        noLinks(programs);unchanged(path,previous,d=>ours(path!,d));
        renameSync(adjacent,path);adjacent=undefined;result.updated=true;
      }else{noLinks(programs);copyFileSync(temporary,path,constants.COPYFILE_EXCL);result.created=true;}
      const published=shortcut(path);if(!published||published.hash!==digest||!desiredLink(published.details,want))throw Error('开发预览快捷方式最终校验失败，旧Electron链接保留');
    }finally{cleanup(temporary,digest);cleanup(adjacent,digest);}
  }
  // Never retire a legacy link unless the replacement still reads back correctly.
  const active=shortcut(path);if(!active||!desiredLink(active.details,want))throw Error('开发预览快捷方式已变化，旧链接保留');
  const legacy=join(programs,'Electron.lnk'),legacyRead=shortcut(legacy),raw=join(repo,'node_modules','electron','dist','electron.exe');
  const allowedArgs=new Set(['',args,'"'+appPath+'"',...(!/\s/.test(appPath)?[appPath,appPath+' --development-preview']:[])]);
  const legacyOurs=(d:ShortcutDetails)=>d.appUserModelId===options.appId&&same(d.target,raw)&&allowedArgs.has(d.args??'');
  if(legacyRead&&legacyOurs(legacyRead.details)){
    noLinks(raw);backup(legacy,legacyRead,profile,result.backups);
    const replacement=shortcut(path);if(!replacement||!desiredLink(replacement.details,want))throw Error('替代快捷方式已变化，旧Electron链接保留');
    noLinks(programs);unchanged(legacy,legacyRead,legacyOurs);unlinkSync(legacy);result.migrated=true;
  }
  return result;
}
