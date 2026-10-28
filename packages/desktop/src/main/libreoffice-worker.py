"""Owned LibreOffice profile + random local UNO pipe. Fixed document/operations; never a public bridge."""
import os,sys,json,time,subprocess,secrets,tempfile
from pathlib import Path
sys.stdin.reconfigure(encoding="utf-8");sys.stdout.reconfigure(encoding="utf-8")
config=None;document=None;desktop=None;process=None;job=None;calc=None;slides=None;notes=None;profile=None
def reply(ident,ok,value):print(json.dumps({'id':ident,'nonce':config['nonce'],'ok':ok,'value':value},ensure_ascii=False),flush=True)
def prop(name,value):
 p=PropertyValue();p.Name=name;p.Value=value;return p
def opened():
 try:return document is not None and document.getURL()==file_url
 except Exception:return False
def checkpoint():
 if not opened():raise RuntimeError('document-replaced')
 if document.isModified():document.store()
 return {'saved':not document.isModified(),'version':version}
def title_shape():
 page=document.getDrawPages().getByIndex(0)
 for n in range(page.getCount()):
  shape=page.getByIndex(n)
  if shape.supportsService('com.sun.star.presentation.TitleTextShape'):return shape
 raise RuntimeError('title-not-found')
def close_owned():
 global document,desktop,process
 if document is not None:
  if opened():checkpoint();document.close(False)
  document=None
 if desktop is not None:
  enum=desktop.getComponents().createEnumeration()
  empty=not enum.hasMoreElements()
  if not empty:raise RuntimeError('office-other-documents')
  service=desktop;desktop=None
  if empty:
   if not service.terminate():raise RuntimeError('office-close-unconfirmed')
   if process is not None:process.wait(timeout=10);process=None
try:
 line=sys.stdin.readline(32769)
 if len(line)>32768:raise RuntimeError('config-large')
 config=json.loads(line)
 if len(config.get('nonce',''))!=64 or config['format']not in['docx','xlsx','pptx']:raise RuntimeError('config-invalid')
 directory=Path(config['directory']).resolve();path=Path(config['path'])
 if path.resolve()!=directory/('working.'+config['format'])or path.is_symlink()or directory.is_symlink():raise RuntimeError('path-invalid')
 program=Path(config['executable']).resolve().parent
 sys.path.insert(0,str(program));os.environ['URE_BOOTSTRAP']='vnd.sun.star.pathname:'+str(program/'fundamental.ini')
 import uno
 from com.sun.star.beans import PropertyValue
 # LibreOffice's own nested extension/cache paths can exceed Windows path
 # limits even when the working document path itself is short enough.
 profile_hint='smalt-o-'+__import__('hashlib').sha256(str(directory).casefold().encode()).hexdigest()[:24]+'-'
 profile=Path(tempfile.mkdtemp(prefix=profile_hint))
 pipe='smalt_office_'+secrets.token_hex(24)
 args=[str(program/'soffice.exe'),'-env:UserInstallation='+profile.as_uri(),'--accept=pipe,name='+pipe+';urp;StarOffice.ServiceManager','--nologo','--nodefault','--norestore','--nofirststartwizard']
 if not config['visible']:args.append('--headless')
 if not config['visible']:
  from office_job import HeadlessJob
  job=HeadlessJob()
 process=subprocess.Popen(args,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
 if job:job.assign(process)
 local=uno.getComponentContext();resolver=local.ServiceManager.createInstanceWithContext('com.sun.star.bridge.UnoUrlResolver',local);ctx=None;deadline=time.monotonic()+40;launcher_exited=None
 while time.monotonic()<deadline:
  try:ctx=resolver.resolve('uno:pipe,name='+pipe+';urp;StarOffice.ComponentContext');break
  except Exception:
   if process.poll()is not None:
    # On Windows the launcher may return zero before soffice.bin exposes the
    # already-created private pipe. Wait for that same launch, never relaunch.
    if process.returncode!=0:raise RuntimeError('libreoffice-start-exit-'+str(process.returncode))
    if launcher_exited is None:launcher_exited=time.monotonic()
    if time.monotonic()-launcher_exited>5:raise RuntimeError('libreoffice-start-exit-0')
   time.sleep(.1)
 if ctx is None:raise RuntimeError('libreoffice-unavailable')
 desktop=ctx.ServiceManager.createInstanceWithContext('com.sun.star.frame.Desktop',ctx)
 provider=ctx.ServiceManager.createInstanceWithContext('com.sun.star.configuration.ConfigurationProvider',ctx)
 product=provider.createInstanceWithArguments('com.sun.star.configuration.ConfigurationAccess',(prop('nodepath','/org.openoffice.Setup/Product'),));version=str(product.getPropertyValue('ooSetupVersionAboutBox'))
 file_url=path.resolve().as_uri();legacy=config.get('legacy');load_url=(directory/('input.'+legacy)).as_uri()if legacy in ['doc','xls']else file_url;document=desktop.loadComponentFromURL(load_url,'_blank',0,(prop('Hidden',not config['visible']),prop('ReadOnly',False),prop('MacroExecutionMode',0),prop('UpdateDocMode',0),prop('AddToRecentDocuments',False)))
 if document is None or document.isReadonly():raise RuntimeError('working-copy-readonly')
 if legacy:
  if (legacy,config['format'])not in [('doc','docx'),('xls','xlsx')]:raise RuntimeError('legacy-format-invalid')
  document.storeAsURL(file_url,(prop('FilterName','Office Open XML Text'if legacy=='doc'else'Calc MS Excel 2007 XML'),prop('Overwrite',False)))
 reply('ready',True,{'version':version,'saved':not document.isModified(),'engine':'libreoffice'})
 for line in sys.stdin:
  request=None
  try:
   if len(line)>65536:raise RuntimeError('request-large')
   request=json.loads(line)
   if request.get('nonce')!=config['nonce']:raise RuntimeError('nonce-invalid')
   action=request['action'];value=None
   if action=='status':value={'closed':not opened(),'saved':not document.isModified()if opened()else True,'version':version}
   elif action=='checkpoint':value=checkpoint()
   elif action=='probe-edit':
    if not config.get('validation'):raise RuntimeError('probe-disabled')
    if config['format']=='docx':document.Text.insertString(document.Text.End,'\nSMALT_OFFICE_ROUNDTRIP',False)
    elif config['format']=='xlsx':sheet=document.Sheets.getByIndex(0);sheet.getCellRangeByName('A1').Value=21;sheet.getCellRangeByName('B1').Formula='=A1*2';document.calculateAll()
    else:title_shape().String='SMALT_OFFICE_ROUNDTRIP'
    document.setModified(True)
    value={'saved':not document.isModified()}
   elif action=='probe-legacy':
    if not config.get('validation')or config['format']not in ['docx','xlsx']:raise RuntimeError('probe-disabled')
    target=directory/('legacy.doc'if config['format']=='docx'else'legacy.xls');document.storeToURL(target.as_uri(),(prop('FilterName','MS Word 97'if config['format']=='docx'else'MS Excel 97'),prop('Overwrite',True)));value={'created':True}
   elif action=='probe-office-details':
    if not config.get('validation'):raise RuntimeError('probe-disabled')
    if config['format']=='xlsx':
     sheet=document.Sheets.getByIndex(0);a=sheet.Annotations.getByIndex(0);shape=a.getAnnotationShape();value={'getString':a.getString(),'getText':a.getText().getString(),'property':a.String,'services':list(a.SupportedServiceNames)}
    else:
     page=document.DrawPages.getByIndex(0).getNotesPage();value={'shapes':[{'type':page.getByIndex(i).ShapeType,'services':list(page.getByIndex(i).SupportedServiceNames),'text':page.getByIndex(i).getString()if hasattr(page.getByIndex(i),'getString')else''}for i in range(page.Count)]}
   elif action=='verify':
    if not config.get('validation'):raise RuntimeError('probe-disabled')
    if config['format']=='docx':value={'text':document.Text.String}
    elif config['format']=='xlsx':cell=document.Sheets.getByIndex(0).getCellRangeByName('B1');value={'value':str(cell.Value),'formula':cell.Formula}
    else:value={'title':title_shape().String}
   elif action in ['slide-view','slide-edit']:
    if config['format']!='pptx' or not opened():raise RuntimeError('slide-document-required')
    if slides is None:
     import impress_editor
     slides=impress_editor.Editor(document,path,checkpoint,prop,ctx)
    value=slides.snapshot(request.get('value',{}),version)if action=='slide-view'else slides.edit(request.get('value',{}),version)
   elif action in ['notes-view','notes-edit']:
    if not opened():raise RuntimeError('notes-document-required')
    if notes is None:
     import office_notes
     notes=office_notes.Notes(document,path,config['format'],checkpoint)
    value=notes.view(request.get('value',{}))if action=='notes-view'else notes.edit(request.get('value',{}))
   elif action=='office-pdf':
    checkpoint();limit=request.get('value',{}).get('limit',20)
    if type(limit)is not int or not 1<=limit<=100:raise RuntimeError('office-pdf-limit')
    output=directory/'export.pdf';filters={'docx':'writer_pdf_Export','xlsx':'calc_pdf_Export','pptx':'impress_pdf_Export'}
    document.storeToURL(output.as_uri(),(prop('FilterName',filters[config['format']]),prop('Overwrite',True),prop('FilterData',(prop('PageRange','1-'+str(limit)),prop('ExportNotes',True)))))
    value={'limit':limit,'workingDigest':__import__('hashlib').sha256(path.read_bytes()).hexdigest()}
   elif action in ['calc-view','calc-edit']:
    if config['format']!='xlsx' or not opened():raise RuntimeError('calc-document-required')
    if calc is None:
     import calc_editor
     calc=calc_editor.Editor(document,path,checkpoint,prop)
    data=request.get('value',{})
    value=calc.snapshot(data,version)if action=='calc-view'else calc.edit(data,version)
   elif action in ['word-info','word-selection','word-apply','word-preview','probe-word','verify-word','probe-select','probe-manual','probe-accept-revisions','probe-reject-revisions']:
    if config['format']!='docx' or not opened():raise RuntimeError('word-document-required')
    import word_editor
    if action.startswith('probe-')or action=='verify-word':
     if not config.get('validation'):raise RuntimeError('probe-disabled')
    if action=='word-info':value=word_editor.info(document)
    elif action=='word-selection':value=word_editor.selection(document,path,checkpoint)
    elif action=='word-apply':value=word_editor.apply(document,path,request.get('value',{}),checkpoint)
    elif action=='word-preview':value=word_editor.preview(document,directory,checkpoint,prop)
    elif action=='probe-word':value=word_editor.probe(document,program)
    elif action=='verify-word':value=word_editor.verify(document)
    elif action=='probe-select':value=word_editor.select_probe(document)
    elif action in ['probe-accept-revisions','probe-reject-revisions']:
     command='.uno:AcceptAllTrackedChanges'if action=='probe-accept-revisions'else'.uno:RejectAllTrackedChanges'
     helper=ctx.ServiceManager.createInstanceWithContext('com.sun.star.frame.DispatchHelper',ctx);helper.executeDispatch(document.CurrentController.Frame,command,'',0,());value=word_editor.info(document)
    else:document.Text.insertString(document.Text.End,'MANUAL_CONCURRENT_CHANGE',False);value={'changed':True}
   elif action=='close':close_owned();reply(request['id'],True,{'closed':True});break
   else:raise RuntimeError('action-invalid')
   reply(request['id'],True,value)
  except Exception as error:reply(request.get('id','invalid')if request else'invalid',False,{'code':str(error)if str(error).startswith(('word-','calc-','slide-','notes-','office-other-documents'))else'office-operation-failed'})
except Exception as error:
 if config:reply('ready',False,{'code':str(error)[:300]})
finally:
 try:close_owned()
 except Exception:pass
 if job:job.close()
 if profile is not None and desktop is None and process is None and profile.parent.resolve()==Path(tempfile.gettempdir()).resolve()and profile.name.startswith('smalt-o-')and not profile.is_symlink():
  try:__import__('shutil').rmtree(profile)
  except OSError:pass
