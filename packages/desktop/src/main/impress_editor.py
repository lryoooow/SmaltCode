"""Bounded native slide operations on a single owned private presentation."""
import hashlib,secrets,json
from pathlib import Path
class Editor:
 def __init__(self,doc,path,checkpoint,prop,ctx):self.doc=doc;self.path=path;self.checkpoint=checkpoint;self.prop=prop;self.ctx=ctx;self.token=None;self.digest=None
 def page(self,i):
  if type(i)is not int or not 0<=i<self.doc.DrawPages.Count or self.doc.DrawPages.Count>500:raise RuntimeError('slide-index-invalid')
  return self.doc.DrawPages.getByIndex(i)
 def hash(self):return hashlib.sha256(self.path.read_bytes()).hexdigest()
 def notes(self,page):
  n=page.getNotesPage()
  for i in range(n.Count):
   s=n.getByIndex(i)
   if s.ShapeType=='com.sun.star.presentation.NotesShape':return s
  return None
 def snapshot(self,v,version):
  i=v['slide'];p=self.page(i);self.checkpoint();self.digest=self.hash();self.token=secrets.token_hex(24);shapes=[];budget=8000
  for j in range(min(p.Count,128)):
   s=p.getByIndex(j);text=s.String if hasattr(s,'String')else'';shown=text[:min(2000,budget)];budget-=len(shown);pos=s.Position;size=s.Size
   shapes.append({'index':j,'kind':s.ShapeType.split('.')[-1],'text':shown,'truncated':len(shown)!=len(text),'x':pos.X,'y':pos.Y,'width':size.Width,'height':size.Height})
  n=self.notes(p);note=n.String if n else''
  data={'token':self.token,'digest':self.digest,'slide':i,'count':self.doc.DrawPages.Count,'name':p.Name[:100],'layout':int(p.Layout),'width':p.Width,'height':p.Height,'shapes':shapes,'shapeCount':p.Count,'notes':note[:8000],'notesTruncated':len(note)>8000,'masters':[{'index':j,'name':self.doc.MasterPages.getByIndex(j).Name[:100]}for j in range(min(100,self.doc.MasterPages.Count))],'slides':[{'index':j,'name':self.doc.DrawPages.getByIndex(j).Name[:80]}for j in range(self.doc.DrawPages.Count)],'version':version}
  if p.Count>128:data['notice']='本页只列前 128 个对象；其他对象请在原生编辑器处理。'
  # Keep metadata useful even in a 500-page deck with large per-object text.
  # Never let a truncated candidate become editable as if it were complete.
  while len(json.dumps(data,ensure_ascii=False).encode('utf-8'))>58*1024:
   for item in data['slides']+data['masters']:item['name']=item['name'][:len(item['name'])//2]
   for item in data['shapes']:
    if item['text']:item['text']=item['text'][:len(item['text'])//2];item['truncated']=True
   if data['notes']:data['notes']=data['notes'][:len(data['notes'])//2];data['notesTruncated']=True
   data['notice']='文档摘要已按容量限制；截断文字和其他对象请在原生编辑器查看，不以截断内容覆盖。'
  return data
 def edit(self,v,version):
  if not self.token or v.get('token')!=self.token or self.doc.isModified()or self.hash()!=self.digest:raise RuntimeError('slide-stale-snapshot')
  import uno
  i=v['slide'];page=self.page(i);op=v['operation'];shape=None
  if 'shape'in v:
   if type(v['shape'])is not int or not 0<=v['shape']<page.Count:raise RuntimeError('slide-shape-invalid')
   shape=page.getByIndex(v['shape'])
  self.token=None
  if op=='add':
   if self.doc.DrawPages.Count>=500:raise RuntimeError('slide-limit')
   i=v['index'];self.doc.DrawPages.insertNewByIndex(i)
  elif op=='delete':
   if self.doc.DrawPages.Count<=1:raise RuntimeError('slide-last-page')
   self.doc.DrawPages.remove(page);i=min(i,self.doc.DrawPages.Count-1)
  elif op=='duplicate':
   if self.doc.DrawPages.Count>=500:raise RuntimeError('slide-limit')
   self.doc.duplicate(page);i=min(i+1,self.doc.DrawPages.Count-1)
  elif op=='move':
   if not 0<=v['index']<self.doc.DrawPages.Count:raise RuntimeError('slide-index-invalid')
   controller=self.doc.CurrentController;controller.setCurrentPage(page);controller.select(page);helper=self.ctx.ServiceManager.createInstanceWithContext('com.sun.star.frame.DispatchHelper',self.ctx)
   # Native move uses the slide sorter; no arbitrary dispatch from the renderer.
   raise RuntimeError('slide-move-use-native-sorter')
  elif op=='layout':page.Layout=v['layout']
  elif op=='master':page.setMasterPage(self.doc.MasterPages.getByIndex(v['master']))
  elif op=='text':
   if not hasattr(shape,'String')or shape.supportsService('com.sun.star.drawing.GroupShape')or shape.supportsService('com.sun.star.drawing.TableShape'):raise RuntimeError('slide-complex-text-use-native')
   shape.String=v['text']
  elif op=='notes':
   note=self.notes(page)
   if note is None:
    note=self.doc.createInstance('com.sun.star.presentation.NotesShape');point=uno.createUnoStruct('com.sun.star.awt.Point');point.X=1000;point.Y=10000;size=uno.createUnoStruct('com.sun.star.awt.Size');size.Width=18000;size.Height=12000;note.Position=point;note.Size=size;page.getNotesPage().add(note)
   note.String=v['text']
  elif op in('shape-add','image'):
   kind='GraphicObjectShape'if op=='image'else{'text':'TextShape','rectangle':'RectangleShape','ellipse':'EllipseShape'}[v['kind']];s=self.doc.createInstance('com.sun.star.drawing.'+kind);point=uno.createUnoStruct('com.sun.star.awt.Point');point.X=1000;point.Y=1000;size=uno.createUnoStruct('com.sun.star.awt.Size');size.Width=8000;size.Height=3000;s.Position=point;s.Size=size
   if op=='image':
    path=self.path.parent/'insert-image.png'
    if not path.is_file()or path.is_symlink()or path.stat().st_size>8*1024*1024:raise RuntimeError('slide-image-invalid')
    provider=self.ctx.ServiceManager.createInstanceWithContext('com.sun.star.graphic.GraphicProvider',self.ctx);s.Graphic=provider.queryGraphic((self.prop('URL',path.resolve().as_uri()),))
   page.add(s)
   if op!='image':s.String=v['text']
  elif op=='shape-delete':page.remove(shape)
  elif op=='shape-format':
   point=uno.createUnoStruct('com.sun.star.awt.Point');point.X=v['x'];point.Y=v['y'];size=uno.createUnoStruct('com.sun.star.awt.Size');size.Width=v['width'];size.Height=v['height'];shape.Position=point;shape.Size=size
   if hasattr(shape,'CharHeight'):shape.CharHeight=float(v['font']);shape.CharColor=v['color']
   if hasattr(shape,'FillColor'):shape.FillColor=v['background']
  else:raise RuntimeError('slide-operation-invalid')
  self.doc.setModified(True);self.checkpoint();return self.snapshot({'slide':i},version)
