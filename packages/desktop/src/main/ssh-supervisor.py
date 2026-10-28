"""Fixed Linux-only SSH run supervisor. No service installation; stdin is a bounded lease protocol."""
import os,sys,json,time,base64,hashlib,signal,subprocess,select,ctypes,stat,fcntl,termios,pty,struct,tempfile
MAX=512*1024
def emit(kind,**data):
 sys.stdout.write(json.dumps(dict(type=kind,**data),ensure_ascii=True)+'\n');sys.stdout.flush()
def digest(data):return hashlib.sha256(data).hexdigest()
def info(pid):
 try:
  data=open('/proc/%d/stat'%pid).read();fields=data[data.rfind(')')+2:].split()
  return dict(pid=pid,ppid=int(fields[1]),pgid=int(fields[2]),start=fields[19],state=fields[0])
 except (OSError,ValueError,IndexError):return None
def identity(pid,start):
 v=info(pid);return v is not None and v['start']==start and v['state']!='Z'
def safe_signal(pid,start,sig):
 fd=os.pidfd_open(pid,0)
 try:
  if identity(pid,start):signal.pidfd_send_signal(fd,sig)
 finally:os.close(fd)
def path_guard(root,relative='',missing=False):
 if not isinstance(root,str) or not root.startswith('/') or root!=os.path.realpath(root) or not os.path.isdir(root):raise ValueError('项目实际根目录已变化')
 if not isinstance(relative,str) or relative.startswith('/') or '\\' in relative or any(v=='..'for v in relative.split('/')) or any(ord(c)<32 for c in relative):raise ValueError('远程路径超出项目')
 path=os.path.normpath(os.path.join(root,relative));cursor='/'
 for part in path.split('/')[1:]:
  cursor=os.path.join(cursor,part)
  if missing and cursor==path and not os.path.lexists(cursor):break
  if stat.S_ISLNK(os.lstat(cursor).st_mode):raise ValueError('路径包含符号链接')
 if os.path.commonpath([root,path])!=root:raise ValueError('远程路径超出项目')
 return path
def private_dir(namespace):
 if not isinstance(namespace,str)or len(namespace)!=36 or any(c not in 'abcdef0123456789-'for c in namespace):raise ValueError('运行身份无效')
 # mkdtemp-like app namespace under the remote user's cache; never trust repo-provided scripts.
 home=os.path.expanduser('~');base=os.path.join(home,'.cache','SmaltCode','ssh-runs',namespace)
 cursor=home
 for part in ['.cache','SmaltCode','ssh-runs',namespace]:
  cursor=os.path.join(cursor,part)
  try:os.mkdir(cursor,0o700)
  except FileExistsError:pass
  s=os.lstat(cursor)
  if not stat.S_ISDIR(s.st_mode)or stat.S_ISLNK(s.st_mode)or s.st_uid!=os.getuid():raise ValueError('远端运行记录目录不安全')
  if part=='.cache'and s.st_mode&0o022:raise ValueError('远端用户缓存目录可被其他用户写入')
  if part in ['SmaltCode','ssh-runs',namespace]and s.st_mode&0o077:raise ValueError('远端运行记录目录权限过宽')
 return base
def load(file):
 fd=os.open(file,os.O_RDONLY|os.O_NOFOLLOW)
 try:
  s=os.fstat(fd)
  if not stat.S_ISREG(s.st_mode)or s.st_size>16384 or s.st_uid!=os.getuid():raise ValueError('运行记录不安全')
  return json.loads(os.read(fd,16385))
 finally:os.close(fd)
def write_all(fd,data):
 offset=0
 while offset<len(data):
  count=os.write(fd,data[offset:])
  if not count:raise OSError('写入未完成')
  offset+=count
def sync_dir(path):
 fd=os.open(path,os.O_RDONLY|os.O_DIRECTORY)
 try:os.fsync(fd)
 finally:os.close(fd)
def save(file,value):
 tmp=file+'.'+os.urandom(8).hex()+'.tmp';fd=os.open(tmp,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
 try:write_all(fd,json.dumps(value).encode());os.fsync(fd)
 finally:os.close(fd)
 os.replace(tmp,file);sync_dir(os.path.dirname(file))
def read_bytes(path):
 fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW)
 try:
  s=os.fstat(fd)
  if not stat.S_ISREG(s.st_mode)or s.st_size>MAX:raise ValueError('只允许小于 512 KB 的普通文件')
  data=os.read(fd,MAX+1)
  if len(data)>MAX:raise ValueError('文件过大')
  return data,s
 finally:os.close(fd)
def write_file(request):
 root=request['root'];path=path_guard(root,request['path'],True);data=base64.b64decode(request['content'],validate=True)
 if len(data)>MAX:raise ValueError('写入内容超过 512 KB')
 expected=request['expected'];exists=os.path.lexists(path);old,s=read_bytes(path)if exists else(b'',None)
 if (digest(old)if exists else'missing')!=expected:raise ValueError('远程文件版本冲突，未写入')
 parent=os.path.dirname(path);fd,tmp=tempfile.mkstemp(prefix='.smalt-write-',dir=parent)
 try:
  os.fchmod(fd,stat.S_IMODE(s.st_mode)&0o777 if s else 0o600);write_all(fd,data);os.fsync(fd);os.close(fd);fd=-1
  path_guard(root,request['path'],True);now=os.path.lexists(path)
  if (digest(read_bytes(path)[0])if now else'missing')!=expected:raise ValueError('远程文件在保存前变化，未覆盖')
  os.replace(tmp,path);tmp=None
  try:sync_dir(parent)
  except OSError:raise ValueError('原文件已替换，但目录同步未确认；请重新读取核对，勿重复保存')
 finally:
  if fd>=0:os.close(fd)
  if tmp:os.unlink(tmp)
 return digest(data)
def main():
 if sys.platform!='linux' or not os.path.isdir('/proc') or not hasattr(os,'pidfd_open') or not hasattr(signal,'pidfd_send_signal'):raise ValueError('远程执行需要 Linux pidfd、/proc 和 Python 3.9+；未执行命令')
 initial=b''
 while b'\n'not in initial:
  chunk=os.read(0,65536)
  if not chunk:raise ValueError('运行请求不完整，未执行命令')
  initial+=chunk
  if len(initial)>1024*1024:raise ValueError('运行请求过大')
 first,remaining=initial.split(b'\n',1)
 request=json.loads(first);run=request['runId'];token=request['token'];namespace=request['namespace'];operation=request['operation']
 if not isinstance(run,str)or len(run)!=36 or any(c not in 'abcdef0123456789-'for c in run)or not isinstance(token,str)or len(token)!=64:raise ValueError('运行标识无效')
 base=private_dir(namespace);file=os.path.join(base,run+'.json');proof=digest(token.encode());boot=open('/proc/sys/kernel/random/boot_id').read().strip()
 if operation in ['inspect','cleanup']:
  record=load(file)
  if record['proof']!=proof or record['runId']!=run or record['namespace']!=namespace or record['digest']!=request['digest'] or record['root']!=request['root']:raise ValueError('运行记录不属于本次任务')
  if record['status']in ['claimed','running']and record['boot']!=boot:record.update(status='interrupted',cleanup='confirmed',reason='远端已重启，原进程不再存在');save(file,record)
  if operation=='cleanup'and record['status']in ['claimed','running']:
   if identity(record['supervisor'],record['started']):safe_signal(record['supervisor'],record['started'],signal.SIGUSR1)
   else:record.update(status='unknown',cleanup='unconfirmed',reason='原监管身份不存在，无法确认派生进程');save(file,record)
   if operation=='cleanup':
    end=time.monotonic()+4
    while time.monotonic()<end:
     record=load(file)
     if record['status']not in ['claimed','running']:break
     time.sleep(.05)
  record.pop('proof',None);emit('receipt',record=record);return
 try:
  probe_fd=os.pidfd_open(os.getpid(),0)
  try:signal.pidfd_send_signal(probe_fd,0)
  finally:os.close(probe_fd)
 except OSError:raise ValueError('远端内核无法提供 pidfd 进程身份保护，未执行任务')
 root=path_guard(request['root']);record=dict(runId=run,namespace=namespace,proof=proof,root=root,digest=request['digest'],boot=boot,supervisor=os.getpid(),started=info(os.getpid())['start'],status='claimed',cleanup='unconfirmed',exitCode=None,signal=None)
 fd=os.open(file,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
 try:write_all(fd,json.dumps(record).encode());os.fsync(fd)
 finally:os.close(fd)
 sync_dir(base)
 # Fail closed if Linux cannot supervise detached descendants. No child has been started yet.
 libc=ctypes.CDLL(None,use_errno=True)
 if libc.prctl(36,1,0,0,0)!=0:raise ValueError('远端无法建立进程监管，未启动任务')
 if operation=='write':
  try:new_digest=write_file(request);record.update(status='exited',cleanup='confirmed',exitCode=0,fileDigest=new_digest)
  except Exception as e:record.update(status='failed',cleanup='confirmed',reason=str(e))
  save(file,record);public=dict(record);public.pop('proof');emit('receipt',record=public);return
 if operation not in ['command','terminal']:raise ValueError('运行类型无效')
 terminal=operation=='terminal';command=request.get('command','');cwd=path_guard(root,request.get('cwd',''))
 if not os.path.isdir(cwd)or not isinstance(command,str)or len(command.encode())>8192:raise ValueError('命令或目录无效')
 master=slave=None;child=None;known={};stopping=False;reason='';ended=False;last=time.monotonic();buf=remaining
 def stop_signal(*_):
  nonlocal stopping,reason
  stopping=True;reason='收到本次运行的停止请求'
 signal.signal(signal.SIGUSR1,stop_signal);signal.signal(signal.SIGTERM,stop_signal);signal.signal(signal.SIGHUP,stop_signal);signal.signal(signal.SIGPIPE,signal.SIG_IGN)
 def descendants():
  tree=[]
  for name in os.listdir('/proc'):
   if name.isdigit():
    v=info(int(name))
    if v:tree.append(v)
  parents={os.getpid()};changed=True
  while changed:
   changed=False
   for v in tree:
    if v['ppid']in parents and v['pid']not in parents:parents.add(v['pid']);known[v['pid']]=v['start'];changed=True
  return [(pid,start)for pid,start in known.items()if identity(pid,start)]
 def cleanup():
  # Identity-checked descendants only, including double-forked/setsid children adopted by subreaper.
  for sig in [signal.SIGTERM,signal.SIGKILL]:
   deadline=time.monotonic()+1.3
   while time.monotonic()<deadline:
    live=descendants()
    if not live:return True
    for pid,start in live:
     if identity(pid,start):
      try:safe_signal(pid,start,sig)
      except (ProcessLookupError,PermissionError):pass
    try:
     while os.waitpid(-1,os.WNOHANG)[0]:pass
    except ChildProcessError:pass
    time.sleep(.04)
  return not descendants()
 try:
  env={'PATH':'/usr/local/bin:/usr/bin:/bin','HOME':os.path.expanduser('~'),'USER':os.environ.get('USER',''),'TERM':'xterm-256color','COLORTERM':'truecolor','LANG':'C.UTF-8'}
  if terminal:
   master,slave=pty.openpty();fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',28,100,0,0))
   def setup():os.setsid();fcntl.ioctl(0,termios.TIOCSCTTY,0)
   child=subprocess.Popen(['/bin/sh','-i'],stdin=slave,stdout=slave,stderr=slave,cwd=cwd,env=env,preexec_fn=setup,close_fds=True);os.close(slave);slave=None;output=master
  else:
   child=subprocess.Popen(['/bin/sh','-c',command],stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,cwd=cwd,env=env,start_new_session=True,close_fds=True);output=child.stdout.fileno()
  known[child.pid]=info(child.pid)['start'];record.update(status='running');save(file,record);emit('ready',runId=run,leaseSeconds=12)
  os.set_blocking(output,False);os.set_blocking(0,False)
  while True:
   descendants()
   if stopping:break
   if time.monotonic()-last>12:reason='心跳租约到期，已执行清理';stopping=True;break
   if child.poll()is not None and ended:break
   ready,_,_=select.select(([0]if not ended else[0])+([]if ended else[output]),[],[],.15)
   if 0 in ready:
    data=os.read(0,65536)
    if not data:reason='SSH 输入通道关闭，已执行清理';stopping=True;break
    buf+=data
    if len(buf)>128*1024:raise ValueError('终端输入超过缓冲上限')
   while b'\n'in buf:
    line,buf=buf.split(b'\n',1);value=json.loads(line)
    if value.get('token')!=token:raise ValueError('控制请求不属于本次运行')
    last=time.monotonic();kind=value.get('type')
    if kind=='stop':stopping=True;reason='用户停止本次运行'
    elif kind=='input'and terminal:
     text=base64.b64decode(value['data'],validate=True)
     if len(text)>16384:raise ValueError('单次终端输入过大')
     os.write(master,text)
    elif kind=='resize'and terminal:fcntl.ioctl(master,termios.TIOCSWINSZ,struct.pack('HHHH',max(5,min(160,int(value['rows']))),max(20,min(400,int(value['columns']))),0,0))
   if output in ready:
    try:data=os.read(output,16384)
    except OSError:data=b''
    if data:emit('output',data=base64.b64encode(data).decode())
    else:ended=True
  result=child.poll();confirmed=cleanup();record.update(status='stopped'if stopping else'exited'if result==0 else'failed',cleanup='confirmed'if confirmed else'unconfirmed',exitCode=result if result is not None and result>=0 else None,signal=-result if result is not None and result<0 else None,reason=reason)
 except Exception as e:
  confirmed=cleanup();record.update(status='failed',cleanup='confirmed'if confirmed else'unconfirmed',reason=str(e))
 finally:
  if master is not None:os.close(master)
  if slave is not None:os.close(slave)
  save(file,record)
  try:public=dict(record);public.pop('proof');emit('receipt',record=public)
  except (BrokenPipeError,OSError):pass
try:main()
except Exception as error:
 try:emit('error',message=str(error)[:500])
 except (BrokenPipeError,OSError):pass
 sys.exit(1)
