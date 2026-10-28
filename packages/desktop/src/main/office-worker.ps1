param()
$ErrorActionPreference='Stop'
[Console]::InputEncoding=New-Object Text.UTF8Encoding($false)
[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false)
Add-Type @'
using System;using System.Runtime.InteropServices;
public static class SmaltOfficePid{[DllImport("user32.dll")]public static extern uint GetWindowThreadProcessId(IntPtr h,out uint p);}
'@
$taskConfig=$null;$taskApp=$null;$taskDoc=$null;$taskOwned=$false;$taskEnginePid=0
function Reply($id,$ok,$value){$response=@{id=$id;nonce=$taskConfig.nonce;ok=$ok;value=$value};[Console]::WriteLine(($response|ConvertTo-Json -Depth 8 -Compress))}
function DocumentOpen(){try{if($null -eq $taskDoc){throw 'document-closed'};if($taskConfig.engine -eq 'word'){return $taskDoc.FullName -eq $taskConfig.path};if($taskConfig.engine -eq 'excel'){return $taskDoc.FullName -eq $taskConfig.path};return $taskDoc.FullName -eq $taskConfig.path}catch{return $false}}
function Checkpoint(){if(-not (DocumentOpen)){throw 'document-replaced'};if(-not [bool]$taskDoc.Saved){$taskDoc.Save()};return @{saved=[bool]$taskDoc.Saved;pid=$taskEnginePid;version=[string]$taskApp.Version}}
function CloseOwned(){if($null -ne $taskDoc){if(DocumentOpen){$null=Checkpoint;if($taskConfig.engine -eq 'word'){$taskDoc.Close(0)}elseif($taskConfig.engine -eq 'excel'){$taskDoc.Close($false)}else{$taskDoc.Close()}};[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($taskDoc);$script:taskDoc=$null};if($taskOwned -and $null -ne $taskApp){$count=if($taskConfig.engine -eq 'word'){$taskApp.Documents.Count}elseif($taskConfig.engine -eq 'excel'){$taskApp.Workbooks.Count}else{$taskApp.Presentations.Count};if($count -eq 0){$taskApp.Quit()};[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($taskApp);$script:taskApp=$null}}
try{
 $taskConfig=([Console]::ReadLine()|ConvertFrom-Json)
 if($taskConfig.nonce -notmatch '^[a-f0-9]{64}$' -or $taskConfig.engine -notin @('word','excel','powerpoint')){throw 'config-invalid'}
 $taskPath=[IO.Path]::GetFullPath([string]$taskConfig.path);$taskDirectory=[IO.Path]::GetFullPath([string]$taskConfig.directory)
 $taskFormat=@{word='docx';excel='xlsx';powerpoint='pptx'}[$taskConfig.engine]
 if($taskPath -ne (Join-Path $taskDirectory ('working.'+$taskFormat)) -or -not (Test-Path -LiteralPath $taskPath -PathType Leaf)){throw 'path-invalid'}
 foreach($taskCheck in @($taskDirectory,$taskPath)){if(((Get-Item -LiteralPath $taskCheck).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'path-link'}}
 $taskConfig.path=$taskPath;$taskExe=@{word='WINWORD';excel='EXCEL';powerpoint='POWERPNT'}[$taskConfig.engine]
 $taskExisting=@(Get-Process -Name $taskExe -ErrorAction SilentlyContinue|ForEach-Object {$_.Id})
 if($taskConfig.engine -eq 'powerpoint' -and $taskExisting.Count -gt 0){throw 'powerpoint-in-use'}
 $taskProg=@{word='Word.Application';excel='Excel.Application';powerpoint='PowerPoint.Application'}[$taskConfig.engine]
 $taskClass=@{word='{000209FF-0000-0000-C000-000000000046}';excel='{00024500-0000-0000-C000-000000000046}';powerpoint='{91493441-5A91-11CF-8700-00AA0060263B}'}[$taskConfig.engine]
 $taskRegistered=(Get-Item -LiteralPath ('Registry::HKEY_CLASSES_ROOT\CLSID\'+$taskClass+'\LocalServer32')).GetValue('')
 if($taskRegistered -notmatch '\\Microsoft Office\\Root\\Office16\\(?:WINWORD|EXCEL|POWERPNT)[.]EXE'){throw 'office-registration-conflict'}
 $taskApp=New-Object -ComObject $taskProg
 [uint32]$taskPidValue=0
 if($taskConfig.engine -eq 'word'){$taskNew=@(Get-Process -Name WINWORD -ErrorAction SilentlyContinue|Where-Object {$_.Id -notin $taskExisting});if($taskNew.Count -ne 1 -or $taskApp.Documents.Count -ne 0){throw 'office-instance-not-isolated'};$taskPidValue=[uint32]$taskNew[0].Id}
 else{$taskHwnd=if($taskConfig.engine -eq 'powerpoint'){$taskApp.HWND}else{$taskApp.Hwnd};[void][SmaltOfficePid]::GetWindowThreadProcessId([IntPtr]$taskHwnd,[ref]$taskPidValue)}
 if($taskPidValue -eq 0 -or $taskPidValue -in $taskExisting){throw 'office-instance-not-isolated'}
 $taskEnginePid=[int]$taskPidValue;$taskOwned=$true
 $taskApp.AutomationSecurity=3
 if($taskConfig.engine -eq 'word'){$taskApp.DisplayAlerts=0;$taskApp.Visible=[bool]$taskConfig.visible;$taskDoc=$taskApp.Documents.Open($taskPath,$false,$false,$false)}
 elseif($taskConfig.engine -eq 'excel'){$taskApp.DisplayAlerts=$false;$taskApp.AskToUpdateLinks=$false;$taskApp.EnableEvents=$false;$taskApp.Visible=[bool]$taskConfig.visible;$taskDoc=$taskApp.Workbooks.Open($taskPath,0,$false)}
 else{$taskApp.DisplayAlerts=1;$taskDoc=$taskApp.Presentations.Open($taskPath,0,0,([int][bool]$taskConfig.visible)*-1)}
 if($taskConfig.engine -eq 'word'){[uint32]$taskDocumentPid=0;[void][SmaltOfficePid]::GetWindowThreadProcessId([IntPtr]$taskDoc.ActiveWindow.Hwnd,[ref]$taskDocumentPid);if($taskDocumentPid -ne $taskEnginePid){$taskOwned=$false;throw 'office-instance-not-isolated'}}
 if([bool]$taskDoc.ReadOnly){throw 'working-copy-readonly'}
 Reply 'ready' $true @{version=[string]$taskApp.Version;pid=$taskEnginePid;saved=[bool]$taskDoc.Saved}
 while($null -ne ($taskLine=[Console]::ReadLine())){
  $taskRequest=$null
  try{
   if($taskLine.Length -gt 16384){throw 'request-large'};$taskRequest=$taskLine|ConvertFrom-Json
   if($taskRequest.nonce -ne $taskConfig.nonce -or $taskRequest.id -notmatch '^[a-f0-9-]{36}$'){throw 'request-invalid'}
   $taskValue=$null
   switch($taskRequest.action){
    'status' {if(-not (DocumentOpen)){$taskValue=@{closed=$true;saved=$true};break};$taskValue=@{saved=[bool]$taskDoc.Saved;pid=$taskEnginePid;version=[string]$taskApp.Version}}
    'checkpoint' {$taskValue=Checkpoint}
    'probe-edit' {if(-not $taskConfig.validation){throw 'probe-disabled'};if($taskConfig.engine -eq 'word'){$taskDoc.Content.InsertAfter("`rSMALT_OFFICE_ROUNDTRIP")};if($taskConfig.engine -eq 'excel'){$taskDoc.Worksheets.Item(1).Range('A1').Value2=21;$taskDoc.Worksheets.Item(1).Range('B1').Formula='=A1*2';$taskApp.CalculateFull()};if($taskConfig.engine -eq 'powerpoint'){$taskDoc.Slides.Item(1).Shapes.Title.TextFrame.TextRange.Text='SMALT_OFFICE_ROUNDTRIP'};$taskValue=@{saved=[bool]$taskDoc.Saved}}
    'verify' {if(-not (DocumentOpen)){throw 'document-replaced'};$taskValue=if($taskConfig.engine -eq 'word'){@{text=[string]$taskDoc.Content.Text}}elseif($taskConfig.engine -eq 'excel'){@{value=[string]$taskDoc.Worksheets.Item(1).Range('B1').Value2;formula=[string]$taskDoc.Worksheets.Item(1).Range('B1').Formula}}else{@{title=[string]$taskDoc.Slides.Item(1).Shapes.Title.TextFrame.TextRange.Text}}}
    'close' {CloseOwned;$taskValue=@{closed=$true};Reply $taskRequest.id $true $taskValue;break}
    default {throw 'action-invalid'}
   }
   if($taskRequest.action -eq 'close'){break};Reply $taskRequest.id $true $taskValue
  }catch{Reply $(if($null -ne $taskRequest){$taskRequest.id}else{'invalid'}) $false @{code='office-operation-failed';hresult=[int]$_.Exception.HResult}}
 }
}catch{if($null -ne $taskConfig){Reply 'ready' $false @{code=([string]$_.Exception.Message);hresult=[int]$_.Exception.HResult}}}
finally{try{CloseOwned}catch{};[GC]::Collect();[GC]::WaitForPendingFinalizers()}
