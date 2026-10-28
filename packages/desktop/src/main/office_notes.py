"""Native comments. Anchors live only inside this owned worker and expire with file changes."""
import secrets,hashlib
class Notes:
 def __init__(self,doc,path,format,checkpoint):self.doc=doc;self.path=path;self.format=format;self.checkpoint=checkpoint;self.token=None;self.anchor=None;self.items=[]
 def hash(self):return hashlib.sha256(self.path.read_bytes()).hexdigest()
 def view(self,v):
  if v.get('expectedDigest')and(self.doc.isModified()or self.hash()!=v['expectedDigest']):raise RuntimeError('notes-source-version-changed')
  self.checkpoint();target=v['target'];kind=target['kind'];doc=self.doc;self.anchor=None;self.items=[];quote=''
  if self.format=='xlsx'and kind=='cell':
   sheet=doc.Sheets.getByIndex(target['sheet']);cell=sheet.getCellByPosition(target['column'],target['row']);self.anchor=cell;quote=cell.String
   for j in range(sheet.Annotations.Count):
    a=sheet.Annotations.getByIndex(j);pos=a.Position
    if pos.Row==target['row']and pos.Column==target['column']:
     a.getAnnotationShape();self.items.append(a)
   label=sheet.Name+' · '+cell.AbsoluteName
  elif self.format=='pptx'and kind=='slide':
   page=doc.DrawPages.getByIndex(target['slide']);self.anchor=page;enum=page.createAnnotationEnumeration()
   while enum and enum.hasMoreElements():
    self.items.append(enum.nextElement())
    if len(self.items)>100:raise RuntimeError('notes-limit')
   quote=page.Name;label='幻灯片 '+str(target['slide']+1)
  elif self.format=='docx'and kind=='selection':
   import word_editor
   selected=word_editor.selection(doc,self.path,self.checkpoint);self.anchor=word_editor._selection['range'];quote=selected['before'];label='原生 Writer 选段';enum=doc.TextFields.createEnumeration()
   while enum.hasMoreElements():
    field=enum.nextElement()
    if field.supportsService('com.sun.star.text.TextField.Annotation'):
     self.items.append(field)
     if len(self.items)>100:raise RuntimeError('notes-limit')
  else:raise RuntimeError('notes-anchor-invalid')
  self.target=target;self.quote=quote;self.checkpoint();self.digest=self.hash();self.token=secrets.token_hex(24);items=[];budget=12000
  for i,n in enumerate(self.items):
   text=n.Content if self.format=='docx'else n.String if self.format=='xlsx'else n.TextRange.String;cap=min(4000,max(0,budget));shown=text[:cap];budget-=len(shown);author=n.Author if hasattr(n,'Author')else''
   items.append({'index':i,'text':shown,'author':author[:200],'truncated':len(shown)!=len(text)})
  return {'token':self.token,'digest':self.digest,'target':target,'quote':quote[:8000],'truncated':len(quote)>8000,'label':label,'items':items}
 def edit(self,v):
  if not self.token or v.get('token')!=self.token or self.doc.isModified()or self.hash()!=self.digest:raise RuntimeError('notes-stale-snapshot')
  if v.get('quote')is not None:
   expected=v['quote']
   if not expected or self.quote[:len(expected)]!=expected:raise RuntimeError('notes-anchor-changed')
   if self.format=='docx':
    desc=self.doc.createSearchDescriptor();desc.SearchString=expected;desc.SearchRegularExpression=False
    if self.doc.findAll(desc).Count!=1:raise RuntimeError('notes-anchor-ambiguous')
  op=v['operation'];anchor=self.anchor;self.token=None
  if op=='add':
   text=v['text']
   if not isinstance(text,str)or not text.strip()or len(text)>4000:raise RuntimeError('notes-text-invalid')
   if self.format=='xlsx':
    if anchor.Annotation.String:raise RuntimeError('notes-cell-already-commented')
    self.doc.Sheets.getByIndex(anchor.CellAddress.Sheet).Annotations.insertNew(anchor.CellAddress,text)
   elif self.format=='pptx':n=anchor.createAndInsertAnnotation();n.Author='SmaltCode';n.Initials='SC';n.TextRange.String=text
   else:n=self.doc.createInstance('com.sun.star.text.TextField.Annotation');n.Author='SmaltCode';n.Content=text;anchor.Text.insertTextContent(anchor,n,False)
  elif op=='delete':
   index=v['index']
   if type(index)is not int or not 0<=index<len(self.items):raise RuntimeError('notes-index-invalid')
   note=self.items[index]
   if self.format=='pptx':anchor.removeAnnotation(note)
   elif self.format=='docx':note.dispose()
   else:
    annotations=self.doc.Sheets.getByIndex(anchor.CellAddress.Sheet).Annotations
    for i in range(annotations.Count):
     a=annotations.getByIndex(i).Position
     if a.Row==anchor.CellAddress.Row and a.Column==anchor.CellAddress.Column:annotations.removeByIndex(i);break
  else:raise RuntimeError('notes-operation-invalid')
  self.doc.setModified(True);self.checkpoint()
  # Writer selection can collapse after inserting its comment. Do not silently move it.
  return {'applied':True,'refreshRequired':True,'digest':self.hash()}
