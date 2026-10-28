"""Persistent fixture filesystem server, in existing WSL; owns only a new /tmp directory."""
import os,sys,json,tempfile,base64,stat,shutil
parent=os.environ.get('SMALT_FIXTURE_PARENT','/tmp');base=tempfile.mkdtemp(prefix='smalt-ssh-fixture-',dir=parent);home=os.path.join(base,'home');roots=[os.path.join(base,n)for n in ['project-one','project-two']]
for p in [home,*roots]:os.mkdir(p,0o700)
for i,p in enumerate(roots):
 open(os.path.join(p,'notes.md'),'w').write('LINUX_REMOTE_%d\n'%i);os.mkdir(os.path.join(p,'中文 空间'));open(os.path.join(p,'中文 空间','说明.md'),'w').write('真实 Linux 文件\n');os.symlink(home,os.path.join(p,'escape'))
handles={};counter=0
def attrs(s):return dict(mode=s.st_mode,size=s.st_size,uid=s.st_uid,gid=s.st_gid,atime=int(s.st_atime),mtime=int(s.st_mtime))
print(json.dumps(dict(ready=True,base=base,home=home,roots=roots)),flush=True)
for line in sys.stdin:
 try:
  q=json.loads(line);action=q['action'];args=q.get('args',[]);value=None
  if action=='realpath':value=os.path.realpath(args[0])
  elif action=='lstat':value=attrs(os.lstat(args[0]))
  elif action=='stat':value=attrs(os.stat(args[0]))
  elif action=='open':
   if args[1]!=1:raise PermissionError('readonly fixture')
   counter+=1;handles[counter]=os.open(args[0],os.O_RDONLY);value=counter
  elif action=='read':value=base64.b64encode(os.pread(handles[args[0]],args[2],args[1])).decode()
  elif action=='fstat':value=attrs(os.fstat(handles[args[0]]))
  elif action=='close':os.close(handles.pop(args[0]))
  elif action=='list':value=[dict(filename=n,longname=n,attrs=attrs(os.lstat(os.path.join(args[0],n))))for n in os.listdir(args[0])]
  elif action=='inspect':value={'content':open(args[0]).read(),'exists':True}if os.path.exists(args[0])else{'exists':False}
  elif action=='alive':
   try:
    fields=open('/proc/%d/stat'%args[0]).read().rsplit(')',1)[1].split();value=fields[0]!='Z'
   except OSError:value=False
  elif action=='fixture-write':
   root,rel,text=args[:3]
   if root not in roots or os.path.isabs(rel) or '..' in rel.split('/') or '\\' in rel:raise ValueError('fixture write outside owned root')
   path=os.path.join(root,rel);os.makedirs(os.path.dirname(path),exist_ok=True)
   if os.path.commonpath([os.path.realpath(path),root])!=root:raise ValueError('fixture write through link')
   open(path,'w').write(text);os.chmod(path,args[3] if len(args)>3 else 0o644);value=True
  elif action=='cleanup':
   if os.path.dirname(os.path.realpath(base))!=os.path.realpath(parent)or not os.path.basename(base).startswith('smalt-ssh-fixture-'):raise ValueError('unsafe cleanup')
   shutil.rmtree(base);print(json.dumps(dict(id=q['id'],value=True)),flush=True);break
  else:raise ValueError('unsupported fixture operation')
  print(json.dumps(dict(id=q['id'],value=value),ensure_ascii=True),flush=True)
 except Exception as e:print(json.dumps(dict(id=q.get('id'),error=str(e),code=3 if isinstance(e,PermissionError)else 2)),flush=True)
