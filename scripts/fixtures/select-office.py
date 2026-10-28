"""Prepare a selection through the actual UNO API in an explicitly owned UI-test working copy."""
import json,os,re,subprocess,sys,time,hashlib
from pathlib import Path
runtime=Path(sys.argv[1]);working=Path(sys.argv[2]).resolve();fixture=Path(sys.argv[3]).resolve()
assert fixture.name.startswith('artifact-ui-')and fixture in working.parents and working.name=='working.docx'
script="Get-CimInstance Win32_Process | Where-Object {$_.Name -eq 'soffice.exe'} | Select-Object -ExpandProperty CommandLine | ConvertTo-Json -Compress"
raw=subprocess.check_output(['powershell.exe','-NoProfile','-NonInteractive','-Command',script],encoding='utf-8',errors='replace',creationflags=subprocess.CREATE_NO_WINDOW)
values=json.loads(raw);values=[values]if isinstance(values,str)else values;profile_hint='smalt-o-'+hashlib.sha256(str(working.parent).casefold().encode()).hexdigest()[:24]+'-';commands=[v for v in values if profile_hint in v and '--accept=pipe,name='in v];assert commands,'owned engine pipe not found'
pipe=re.search(r'--accept=pipe,name=(smalt_office_[a-f0-9]{48});',commands[0]).group(1)
program=runtime.parent;sys.path.insert(0,str(program));os.environ['URE_BOOTSTRAP']='vnd.sun.star.pathname:'+str(program/'fundamental.ini')
import uno
local=uno.getComponentContext();resolver=local.ServiceManager.createInstanceWithContext('com.sun.star.bridge.UnoUrlResolver',local);ctx=resolver.resolve('uno:pipe,name='+pipe+';urp;StarOffice.ComponentContext');desktop=ctx.ServiceManager.createInstanceWithContext('com.sun.star.frame.Desktop',ctx);components=desktop.getComponents().createEnumeration();doc=None
while components.hasMoreElements():
 found=components.nextElement()
 if hasattr(found,'getURL')and found.getURL()==working.as_uri():doc=found;break
assert doc is not None
search=doc.createSearchDescriptor();search.SearchString='AI_SELECTION_TARGET';target=doc.findFirst(search);assert target is not None;doc.CurrentController.select(target);print('OWNED_SELECTION_READY')
