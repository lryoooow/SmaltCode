"""Fixed Writer operations for one approved private document. No arbitrary UNO dispatch or paths."""
import hashlib,secrets
from pathlib import Path
_selection=None

def digest(path):return hashlib.sha256(Path(path).read_bytes()).hexdigest()
def info(doc):
 stats={p.Name:p.Value for p in doc.DocumentProperties.DocumentStatistics}
 fields=doc.TextFields.createEnumeration();comments=0
 while fields.hasMoreElements():
  if fields.nextElement().supportsService('com.sun.star.text.TextField.Annotation'):comments+=1
 return {'pages':int(stats.get('PageCount',0)),'paragraphs':int(stats.get('ParagraphCount',0)),'tables':doc.TextTables.Count,'images':doc.GraphicObjects.Count,'comments':comments,'revisions':doc.Redlines.Count,'trackChanges':bool(doc.RecordChanges)}
def selection(doc,path,checkpoint):
 global _selection
 ranges=doc.CurrentController.getSelection()
 if not hasattr(ranges,'getCount')or ranges.getCount()!=1:raise RuntimeError('word-select-plain')
 selected=ranges.getByIndex(0);text=selected.String
 if selected.getText()!=doc.Text or not text or len(text)>12000 or any(c in text for c in '\r\n\t\x00'):raise RuntimeError('word-select-plain')
 cursor=doc.Text.createTextCursorByRange(selected.Start);cursor.gotoRange(selected.End,True)
 states=cursor.getPropertyStates(('CharWeight','CharPosture','CharHeight','CharFontName','CharUnderline','CharColor','CharStyleName'))
 if any(s.value=='AMBIGUOUS_VALUE'for s in states):raise RuntimeError('word-select-complex')
 paragraphs=cursor.createEnumeration()
 while paragraphs.hasMoreElements():
  paragraph=paragraphs.nextElement()
  if not paragraph.supportsService('com.sun.star.text.Paragraph'):raise RuntimeError('word-select-complex')
  parts=paragraph.createEnumeration()
  while parts.hasMoreElements():
   if parts.nextElement().TextPortionType!='Text':raise RuntimeError('word-select-complex')
 checkpoint();token=secrets.token_hex(24)
 _selection={'token':token,'range':cursor,'before':text,'digest':digest(path)}
 return {'token':token,'before':text,'digest':_selection['digest'],'style':str(cursor.ParaStyleName),'info':info(doc)}
def apply(doc,path,value,checkpoint):
 global _selection
 old=_selection
 if not old or value.get('token')!=old['token']:raise RuntimeError('word-selection-expired')
 after=value.get('after')
 if not isinstance(after,str)or not after or len(after)>12000 or any(ord(c)<32 for c in after):raise RuntimeError('word-replacement-invalid')
 if doc.isModified()or digest(path)!=old['digest']or old['range'].String!=old['before']:raise RuntimeError('word-selection-changed')
 _selection=None;record=bool(doc.RecordChanges);doc.RecordChanges=True
 try:
  doc.UndoManager.enterUndoContext('SmaltCode 选段候选')
  try:old['range'].String=after;doc.setModified(True)
  finally:doc.UndoManager.leaveUndoContext()
  checkpoint()
 finally:doc.RecordChanges=record
 return {'applied':True,'info':info(doc)}
def preview(doc,directory,checkpoint,prop):
 checkpoint();path=Path(directory)/'preview.pdf'
 doc.storeToURL(path.resolve().as_uri(),(prop('FilterName','writer_pdf_Export'),prop('Overwrite',True),prop('FilterData',(prop('PageRange','1-20'),))))
 return {'pagesLimit':20,'info':info(doc)}
def probe(doc,program):
 """Validation only: exercise real engine APIs used by Writer's native menus."""
 cursor=doc.Text.createTextCursor();cursor.gotoEnd(False);doc.Text.insertString(cursor,'\nENGINE_FORMATTED_PARAGRAPH\n',False);cursor.gotoPreviousParagraph(False);cursor.gotoEndOfParagraph(True);cursor.ParaStyleName='Heading 2';cursor.CharWeight=150;cursor.CharHeight=15;cursor.ParaLeftMargin=600
 table=doc.createInstance('com.sun.star.text.TextTable');table.initialize(3,2);doc.Text.insertTextContent(doc.Text.End,table,False);table.getCellByName('A1').String='ENGINE_TABLE';table.getCellByName('B1').String='中文表格'
 cursor=doc.Text.createTextCursor();cursor.gotoEnd(False);doc.Text.insertString(cursor,'\nENGINE_COMMENT_ANCHOR\n',False);cursor.gotoPreviousParagraph(False);cursor.gotoEndOfParagraph(True)
 note=doc.createInstance('com.sun.star.text.TextField.Annotation');note.Author='SmaltCode 验证';note.Content='ENGINE_NATIVE_COMMENT';doc.Text.insertTextContent(cursor,note,False)
 doc.RecordChanges=True;doc.Text.insertString(doc.Text.End,'\nENGINE_TRACKED_INSERTION',False);doc.RecordChanges=False;doc.setModified(True)
 return info(doc)
def select_probe(doc):
 found=doc.findFirst(_search(doc,'AI_SELECTION_TARGET'))
 if found is None:raise RuntimeError('word-fixture-target-missing')
 doc.CurrentController.select(found);return {'selected':True}
def _search(doc,text):
 desc=doc.createSearchDescriptor();desc.SearchString=text;return desc
def verify(doc):
 data=info(doc);data['text']=doc.Text.String[-24000:];data['header']=str(doc.StyleFamilies.getByName('PageStyles').getByName('Standard').HeaderText.String)if doc.StyleFamilies.getByName('PageStyles').getByName('Standard').HeaderIsOn else''
 data['tableText']='\n'.join(doc.TextTables.getByIndex(i).getCellByName('A1').String for i in range(doc.TextTables.Count))
 return data
