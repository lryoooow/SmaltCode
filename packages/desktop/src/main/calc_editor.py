"""Finite Calc operations over a host-owned private workbook. No UNO dispatch or external paths."""
import hashlib,secrets,re,math,datetime
SAFE_FUNCTIONS=set('SUM AVERAGE MIN MAX COUNT COUNTA IF IFERROR ROUND ROUNDUP ROUNDDOWN ABS INT MOD AND OR NOT LEN LEFT RIGHT MID CONCAT CONCATENATE TEXT VALUE DATE YEAR MONTH DAY TODAY NOW VLOOKUP HLOOKUP XLOOKUP INDEX MATCH COUNTIF COUNTIFS SUMIF SUMIFS PRODUCT SUMPRODUCT SQRT POWER TRIM UPPER LOWER ISNUMBER ISTEXT ISBLANK TRUE FALSE'.split())
def integer(v,low,high):
 if type(v)is not int or not low<=v<=high:raise RuntimeError('calc-invalid-index')
 return v
def formula(v):
 if not isinstance(v,str)or not v.startswith('=')or len(v)>4000 or re.search(r'[\x00-\x1f\[\]{}\\]|(?:https?|file|ftp):|\|',v,re.I):raise RuntimeError('calc-formula-blocked')
 clean=re.sub(r'"(?:[^"]|"")*"','""',v)
 if any(x.upper()not in SAFE_FUNCTIONS for x in re.findall(r'([A-Z_][A-Z0-9_.]*)\s*\(',clean,re.I)):raise RuntimeError('calc-formula-blocked')
 return v
class Editor:
 def __init__(self,document,path,checkpoint,prop):self.doc=document;self.path=path;self.checkpoint=checkpoint;self.prop=prop;self.token=None;self.digest=None;self.window={'sheet':0,'row':0,'column':0,'rows':20,'columns':10}
 def hash(self):return hashlib.sha256(self.path.read_bytes()).hexdigest()
 def sheet(self,index):return self.doc.Sheets.getByIndex(integer(index,0,min(255,self.doc.Sheets.Count-1)))
 def rectangle(self,value):
  row=integer(value.get('row'),0,1048575);col=integer(value.get('column'),0,16383);rows=integer(value.get('rows'),1,2000);cols=integer(value.get('columns'),1,2000)
  if rows*cols>2000 or row+rows>1048576 or col+cols>16384:raise RuntimeError('calc-range-large')
  return row,col,rows,cols
 def snapshot(self,value,version):
  if self.doc.Sheets.Count>256:raise RuntimeError('calc-sheet-limit')
  self.window=value.copy();sheet=self.sheet(value['sheet']);row=integer(value['row'],0,1048575);col=integer(value['column'],0,16383);rows=integer(value['rows'],1,20);cols=integer(value['columns'],1,10)
  if row+rows>1048576 or col+cols>16384:raise RuntimeError('calc-range-large')
  self.doc.calculateAll();self.checkpoint();self.digest=self.hash();self.token=secrets.token_hex(24);cells=[];budget=8000
  for r in range(row,row+rows):
   for c in range(col,col+cols):
    cell=sheet.getCellByPosition(c,r);kind={'EMPTY':'empty','TEXT':'text','VALUE':'number','FORMULA':'formula'}.get(cell.getType().value,'text');text=cell.getString();expression=cell.getFormula()if kind=='formula'else'';cap=max(0,min(4000,budget));shown=text[:cap];budget-=len(shown);cap=max(0,min(4000,budget));expr=expression[:cap];budget-=len(expr)
    cells.append({'row':r,'column':c,'kind':kind,'text':shown,'formula':expr,'value':cell.getValue()if kind in('number','formula')and math.isfinite(cell.getValue())else None,'error':cell.getError(),'truncated':len(shown)!=len(text)or len(expr)!=len(expression)})
  cursor=sheet.createCursor();cursor.gotoEndOfUsedArea(False);used=cursor.RangeAddress
  return {'token':self.token,'digest':self.digest,'sheet':value['sheet'],'sheets':[{'index':i,'name':self.doc.Sheets.getByIndex(i).Name[:31]}for i in range(self.doc.Sheets.Count)],'row':row,'column':col,'rows':rows,'columns':cols,'usedRows':used.EndRow+1,'usedColumns':used.EndColumn+1,'cells':cells,'calculatedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'version':version}
 def put(self,cell,value):
  kind=value['kind'];v=value['value']
  if kind=='formula':cell.setFormula(formula(v))
  elif kind=='text':
   if not isinstance(v,str)or len(v)>4000:raise RuntimeError('calc-cell-invalid')
   cell.setString(v)
  elif kind=='number':
   if type(v)not in(int,float)or not math.isfinite(v):raise RuntimeError('calc-cell-invalid')
   cell.setValue(v)
  elif kind=='boolean':
   if type(v)is not bool:raise RuntimeError('calc-cell-invalid')
   cell.setValue(1 if v else 0)
  else:raise RuntimeError('calc-cell-invalid')
 def edit(self,v,version):
  if self.token is None or v.get('token')!=self.token or self.doc.isModified()or self.hash()!=self.digest:raise RuntimeError('calc-stale-snapshot')
  import uno
  sheet=self.sheet(v['sheet']);op=v['operation'];window=self.window.copy();window['sheet']=v['sheet'];rng=None
  if 'range'in v:
   row,col,rows,cols=self.rectangle(v['range']);rng=sheet.getCellRangeByPosition(col,row,col+cols-1,row+rows-1)
  # Validate every pasted cell before changing any position.
  if op in('set-cell','paste'):
   values=[[v['cell']]]if op=='set-cell'else v['values']
   if len(values)!=rows or any(len(a)!=cols for a in values)or sum(len(str(c['value']))for a in values for c in a)>8000:raise RuntimeError('calc-paste-invalid')
   for a in values:
    for cell in a:
     if cell['kind']=='formula':formula(cell['value'])
   for y,a in enumerate(values):
    for x,value in enumerate(a):self.put(sheet.getCellByPosition(col+x,row+y),value)
  elif op=='copy':
   dest=v['destination'];target=self.sheet(dest['sheet']);address=uno.createUnoStruct('com.sun.star.table.CellAddress');address.Sheet=dest['sheet'];address.Column=integer(dest['column'],0,16383-cols+1);address.Row=integer(dest['row'],0,1048576-rows);target.copyRange(address,rng.RangeAddress)
  elif op in('insert-rows','delete-rows','insert-columns','delete-columns'):
   isrow=op.endswith('rows');collection=sheet.Rows if isrow else sheet.Columns;index=integer(v['index'],0,collection.Count-1);count=integer(v['count'],1,200 if isrow else 100)
   if index+count>collection.Count:raise RuntimeError('calc-invalid-index')
   (collection.insertByIndex if op.startswith('insert')else collection.removeByIndex)(index,count)
  elif op in('sheet-add','sheet-rename'):
   name=v.get('name');names=self.doc.Sheets.getElementNames()
   if not isinstance(name,str)or not 1<=len(name)<=31 or re.search(r'[\\/*?:\[\]\x00-\x1f]',name)or name.lower()in[n.lower()for n in names]:raise RuntimeError('calc-sheet-name-invalid')
   if op=='sheet-add':
    if len(names)>=256:raise RuntimeError('calc-sheet-limit')
    self.doc.Sheets.insertNewByName(name,integer(v['index'],0,len(names)));window['sheet']=v['index']
   else:sheet.Name=name
  elif op=='sheet-delete':
   if self.doc.Sheets.Count<=1:raise RuntimeError('calc-last-sheet')
   self.doc.Sheets.removeByName(sheet.Name);window['sheet']=min(v['sheet'],self.doc.Sheets.Count-1)
  elif op=='format':
   style=v['style']
   if 'bold'in style:rng.CharWeight=150.0 if style['bold']else 100.0
   if 'italic'in style:rng.CharPosture=uno.Enum('com.sun.star.awt.FontSlant','ITALIC'if style['italic']else'NONE')
   if 'wrap'in style:rng.IsTextWrapped=style['wrap']
   if 'align'in style:rng.HoriJustify=uno.Enum('com.sun.star.table.CellHoriJustify',style['align'].upper())
   if 'color'in style:rng.CharColor=integer(style['color'],0,0xffffff)
   if 'background'in style:rng.CellBackColor=integer(style['background'],0,0xffffff)
   if 'numberFormat'in style:
    formats={'general':'General','integer':'0','decimal':'0.00','percent':'0.00%','date':'YYYY-MM-DD','thousands':'#,##0.00'};fmt=formats[style['numberFormat']];locale=uno.createUnoStruct('com.sun.star.lang.Locale');locale.Language='en';locale.Country='US';catalog=self.doc.getNumberFormats();key=catalog.queryKey(fmt,locale,True)
    if key<0:key=catalog.addNew(fmt,locale)
    rng.NumberFormat=key
  elif op=='sort':
   field=uno.createUnoStruct('com.sun.star.table.TableSortField');field.Field=integer(v['field'],0,cols-1);field.IsAscending=v['ascending']
   fields=uno.Any('[]com.sun.star.table.TableSortField',(field,))
   rng.sort((self.prop('SortFields',fields),self.prop('ContainsHeader',v['header']),self.prop('IsSortColumns',False),self.prop('BindFormatsToContent',True)))
  elif op in('filter','clear-filter'):
   descriptor=rng.createFilterDescriptor(True);descriptor.ContainsHeader=v.get('header',False);descriptor.UseRegularExpressions=False
   if op=='filter':
    cond=uno.createUnoStruct('com.sun.star.sheet.TableFilterField');cond.Field=integer(v['field'],0,cols-1);condition=v['filter'];cond.Operator=uno.Enum('com.sun.star.sheet.FilterOperator',{'equals':'EQUAL','greater':'GREATER','less':'LESS'}[condition['operator']]);cond.IsNumeric=type(condition['value'])in(int,float)
    if cond.IsNumeric:cond.NumericValue=condition['value']
    else:cond.StringValue=condition['value']
    descriptor.setFilterFields((cond,))
   else:descriptor.setFilterFields(())
   rng.filter(descriptor)
  elif op=='merge':
   if v['merge']and sum(1 for r in range(row,row+rows)for c in range(col,col+cols)if sheet.getCellByPosition(c,r).getType().value!='EMPTY')>1:raise RuntimeError('calc-merge-would-hide-data')
   rng.merge(v['merge'])
  else:raise RuntimeError('calc-operation-invalid')
  self.token=None;self.doc.calculateAll();self.checkpoint();return self.snapshot(window,version)
