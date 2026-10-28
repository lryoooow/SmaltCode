"""Read-only bounded project inspection; caller supplies a pinned container and UID."""
import os,sys,json,stat,hashlib
def guard(root,path):
 if not isinstance(root,str)or not root.startswith('/')or root!=os.path.realpath(root):raise ValueError('容器项目根目录已变化')
 if not isinstance(path,str)or path.startswith('/')or '\\'in path or '..'in path.split('/')or any(ord(c)<32 for c in path):raise ValueError('路径超出容器项目')
 result=os.path.normpath(os.path.join(root,path));cursor='/'
 for part in result.split('/')[1:]:
  cursor=os.path.join(cursor,part)
  if stat.S_ISLNK(os.lstat(cursor).st_mode):raise ValueError('容器路径包含符号链接')
 if os.path.commonpath([root,result])!=root:raise ValueError('路径超出容器项目')
 return result
try:
 raw=os.read(0,16385)
 if len(raw)>16384:raise ValueError('请求过大')
 req=json.loads(raw);path=req.get('path','');full=guard(req['root'],path)
 if req['operation']=='probe':
  if sys.platform!='linux'or not hasattr(os,'pidfd_open')or not hasattr(__import__('signal'),'pidfd_send_signal'):raise ValueError('容器执行需要 Linux /proc、pidfd 和 Python 3.9+')
  fd=os.pidfd_open(os.getpid(),0);__import__('signal').pidfd_send_signal(fd,0);os.close(fd)
  if not os.path.isdir(full):raise ValueError('容器工作目录不存在')
  result={'uid':os.getuid(),'root':full}
 elif req['operation']=='list':
  entries=[];truncated=False
  with os.scandir(full)as it:
   for e in it:
    if len(entries)>=500:truncated=True;break
    if e.is_symlink():continue
    s=e.stat(follow_symlinks=False)
    if stat.S_ISREG(s.st_mode)or stat.S_ISDIR(s.st_mode):entries.append(dict(name=e.name,path='/'.join(filter(None,[path,e.name])),kind='directory'if stat.S_ISDIR(s.st_mode)else'file',size=s.st_size))
  result=dict(path=path,entries=sorted(entries,key=lambda e:(e['kind']!='directory',e['name'].lower())),truncated=truncated)
 elif req['operation']=='read':
  fd=os.open(full,os.O_RDONLY|os.O_NOFOLLOW)
  try:
   s=os.fstat(fd)
   if not stat.S_ISREG(s.st_mode)or s.st_size>512*1024:raise ValueError('仅可读取 512 KB 以内普通文本文件')
   data=os.read(fd,512*1024+1)
   if len(data)>512*1024 or b'\x00'in data:raise ValueError('文件过大或不是文本文件')
   text=data.decode('utf-8')
   if len(text)>40000:raise ValueError('文本超过 40000 字，请使用命令分段查看')
   result=dict(path=path,text=text,size=len(data),digest=hashlib.sha256(data).hexdigest())
  finally:os.close(fd)
 else:raise ValueError('未知只读操作')
 print(json.dumps(dict(ok=True,value=result),ensure_ascii=True),flush=True)
except Exception as e:print(json.dumps(dict(ok=False,error=str(e)),ensure_ascii=True),flush=True)
