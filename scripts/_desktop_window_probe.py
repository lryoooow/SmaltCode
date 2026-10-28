"""Native-window conditions for CDP tests; isolated profile only, no product IPC."""
import json,time,uuid

class WindowProbe:
 def __init__(self,directory,root):
  self.paths={name:directory/('native-window-'+name+('.jsonl'if name=='events'else'.json'))for name in ['control','ack','state','events']}
  self.hook='require('+json.dumps(str(root/'scripts/fixtures/native-window-probe.cjs'))+')('+json.dumps({k:str(v)for k,v in self.paths.items()})+');'
 def read(self):
  try:return json.loads(self.paths['state'].read_text(encoding='utf8'))
  except(FileNotFoundError,json.JSONDecodeError):return None
 def wait(self,test,seconds=10):
  end=time.monotonic()+seconds
  while time.monotonic()<end:
   value=self.read()
   if value and test(value):return value
   time.sleep(.03)
  raise AssertionError('Native window condition not met: '+json.dumps(self.read(),ensure_ascii=False))
 def command(self,action,**kwargs):
  sequence=uuid.uuid4().hex;path=self.paths['control'];temporary=path.with_suffix('.tmp');temporary.write_text(json.dumps({'sequence':sequence,'action':action,**kwargs}),encoding='utf8');temporary.replace(path)
  end=time.monotonic()+10
  while time.monotonic()<end:
   try:
    value=json.loads(self.paths['ack'].read_text(encoding='utf8'))
    if value.get('sequence')==sequence:return value
   except(FileNotFoundError,json.JSONDecodeError):pass
   time.sleep(.03)
  raise AssertionError('Native window command not acknowledged: '+action)
 def restore(self):
  self.command('restore')
  return self.wait(lambda value:value['visible']and not value['minimized']and min(value['size'])>40)
