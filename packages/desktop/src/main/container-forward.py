"""One loopback-only stream, bounded framing and a twelve second stdin heartbeat lease."""
import os,sys,json,socket,select,time,base64
def emit(kind,**v):print(json.dumps(dict(type=kind,**v)),flush=True)
try:
 pending=b''
 while b'\n'not in pending:
  b=os.read(0,4096)
  if not b or len(pending)+len(b)>8192:raise ValueError('转发请求无效')
  pending+=b
 first,pending=pending.split(b'\n',1);req=json.loads(first);port=req['port'];token=req['token']
 if type(port)is not int or not 1<=port<=65535 or not isinstance(token,str)or len(token)!=64:raise ValueError('转发端口无效')
 stream=socket.create_connection(('127.0.0.1',port),timeout=5);stream.setblocking(False);last=time.monotonic();out=b'';emit('ready')
 while time.monotonic()-last<12:
  readers,write,unused=select.select([0,stream],[stream]if out else[],[],.2)
  if 0 in readers:
   data=os.read(0,32768)
   if not data:break
   pending+=data
   if len(pending)>128*1024:raise ValueError('转发帧过大')
   while b'\n'in pending:
    first,pending=pending.split(b'\n',1);frame=json.loads(first)
    if frame.get('token')!=token:raise ValueError('转发授权无效')
    last=time.monotonic()
    if frame.get('type')=='data':
     out+=base64.b64decode(frame['data'],validate=True)
     if len(out)>256*1024:raise ValueError('容器服务接收过慢')
  if write:
   n=stream.send(out);out=out[n:]
  if stream in readers:
   data=stream.recv(16384)
   if not data:break
   emit('data',data=base64.b64encode(data).decode())
except Exception as e:emit('error',message=str(e))
finally:
 try:stream.close()
 except:pass
