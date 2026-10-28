<#
.SYNOPSIS
Read-only Windows taskbar/window identity verification for an already running SmaltCode.
.EXAMPLE
powershell -NoProfile -File scripts/test-desktop-window-identity.ps1 -ProcessId 1234 -ExpectedAppId app.smaltcode.desktop.development -RequireWindowIcon
.EXAMPLE
powershell -NoProfile -File scripts/test-desktop-window-identity.ps1 -ProcessId 5678 -ExpectedAppId app.smaltcode.desktop -ExpectedExecutable D:\Apps\SmaltCode\SmaltCode.exe -MinimumWindows 2
.NOTES
Run against a normally started visible app: hidden/offscreen smoke runs do not prove taskbar identity.
Enumerates only windows belonging to the supplied process. No UIAutomation, clicks, typing,
screenshots, shortcut/cache changes, property writes, or process termination are performed.
ReportPath is optional; without it, the script writes JSON only to stdout.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][ValidateRange(1,2147483647)][int]$ProcessId,
  [string]$ExpectedAppId,
  [string]$ExpectedExecutable,
  [string]$ExpectedIconPath,
  [ValidateRange(1,100)][int]$MinimumWindows=1,
  [switch]$IncludeHidden,
  [switch]$RequireWindowIcon,
  [string]$ReportPath
)
$ErrorActionPreference='Stop'
if([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT){throw 'This read-only verification requires Windows.'}

if(-not ('SmaltCode.WindowIdentityAudit' -as [type])){
  Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

namespace SmaltCode {
  [StructLayout(LayoutKind.Sequential)] internal struct PropertyKey {
    public Guid Format; public uint Id;
    public PropertyKey(uint id) { Format=new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"); Id=id; }
  }
  // The 24-byte allocation also safely accommodates the smaller x86 native value.
  [StructLayout(LayoutKind.Explicit,Size=24)] internal struct PropVariant {
    [FieldOffset(0)] public ushort Type;
    [FieldOffset(8)] public IntPtr Pointer;
  }
  [ComImport,Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  internal interface ReadOnlyPropertyStore {
    [PreserveSig] int GetCount(out uint count);
    [PreserveSig] int GetAt(uint index,out PropertyKey key);
    [PreserveSig] int GetValue(ref PropertyKey key,out PropVariant value);
  }
  public sealed class WindowIdentity {
    public string Handle {get;set;}
    public string Title {get;set;}
    public string ClassName {get;set;}
    public bool Visible {get;set;}
    public string OwnerHandle {get;set;}
    public string AppUserModelId {get;set;}
    public string RelaunchIconResource {get;set;}
    public string RelaunchCommand {get;set;}
    public string RelaunchDisplayName {get;set;}
    public string WindowSmallIcon {get;set;}
    public string WindowSmall2Icon {get;set;}
    public string WindowLargeIcon {get;set;}
    public string ClassSmallIcon {get;set;}
    public string ClassLargeIcon {get;set;}
    public bool HasSmallIcon {get;set;}
    public bool HasLargeIcon {get;set;}
    public string[] ReadErrors {get;set;}
  }
  public static class WindowIdentityAudit {
    private delegate bool EnumWindowCallback(IntPtr hwnd,IntPtr parameter);
    [DllImport("user32.dll",SetLastError=true)] private static extern bool EnumWindows(EnumWindowCallback callback,IntPtr parameter);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hwnd,out uint processId);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll",CharSet=CharSet.Unicode)] private static extern int GetWindowText(IntPtr hwnd,StringBuilder text,int maxCount);
    [DllImport("user32.dll",CharSet=CharSet.Unicode)] private static extern int GetClassName(IntPtr hwnd,StringBuilder name,int maxCount);
    [DllImport("user32.dll")] private static extern IntPtr GetWindow(IntPtr hwnd,uint command);
    [DllImport("user32.dll",SetLastError=true,CharSet=CharSet.Unicode)] private static extern IntPtr SendMessageTimeout(IntPtr hwnd,uint message,IntPtr wparam,IntPtr lparam,uint flags,uint timeout,out UIntPtr result);
    [DllImport("user32.dll",EntryPoint="GetClassLongPtrW")] private static extern IntPtr GetClassLongPtr64(IntPtr hwnd,int index);
    [DllImport("user32.dll",EntryPoint="GetClassLongW")] private static extern uint GetClassLong32(IntPtr hwnd,int index);
    [DllImport("shell32.dll")] private static extern int SHGetPropertyStoreForWindow(IntPtr hwnd,ref Guid iid,[MarshalAs(UnmanagedType.Interface)] out ReadOnlyPropertyStore store);
    [DllImport("ole32.dll")] private static extern int PropVariantClear(ref PropVariant value);
    private static string Hex(IntPtr value) { return "0x"+value.ToInt64().ToString("x"); }
    private static string Hex(UIntPtr value) { return "0x"+value.ToUInt64().ToString("x"); }
    private static string Property(ReadOnlyPropertyStore store,uint id,List<string> errors) {
      PropVariant value=new PropVariant();
      try {
        PropertyKey key=new PropertyKey(id); int hr=store.GetValue(ref key,out value);
        if(hr<0) { errors.Add("GetValue("+id+") HRESULT=0x"+hr.ToString("x8")); return null; }
        if(value.Type==0 || value.Type==1) return null;
        if(value.Type==31) return Marshal.PtrToStringUni(value.Pointer);
        if(value.Type==8) return Marshal.PtrToStringBSTR(value.Pointer);
        errors.Add("GetValue("+id+") returned non-string VT="+value.Type); return null;
      } finally { PropVariantClear(ref value); }
    }
    private static UIntPtr Icon(IntPtr hwnd,int kind,List<string> errors) {
      UIntPtr icon; IntPtr sent=SendMessageTimeout(hwnd,0x007f,new IntPtr(kind),IntPtr.Zero,3,1000,out icon);
      if(sent==IntPtr.Zero) errors.Add("WM_GETICON("+kind+") did not respond within the bounded read");
      return icon;
    }
    private static IntPtr ClassIcon(IntPtr hwnd,int index) { return IntPtr.Size==8?GetClassLongPtr64(hwnd,index):new IntPtr(unchecked((int)GetClassLong32(hwnd,index))); }
    public static WindowIdentity[] Read(int processId,bool includeHidden) {
      List<WindowIdentity> windows=new List<WindowIdentity>(); List<string> enumerationErrors=new List<string>();
      EnumWindowCallback callback=delegate(IntPtr hwnd,IntPtr unused) {
        uint owner; GetWindowThreadProcessId(hwnd,out owner); if(owner!=(uint)processId) return true;
        bool visible=IsWindowVisible(hwnd); if(!includeHidden&&!visible)return true;
        StringBuilder title=new StringBuilder(32768),name=new StringBuilder(256);
        GetWindowText(hwnd,title,title.Capacity);GetClassName(hwnd,name,name.Capacity);
        if(!name.ToString().StartsWith("Chrome_WidgetWin_",StringComparison.Ordinal)||title.Length==0)return true;
        try {
          List<string> errors=new List<string>();
          WindowIdentity item=new WindowIdentity {Handle=Hex(hwnd),Title=title.ToString(),ClassName=name.ToString(),Visible=visible,OwnerHandle=Hex(GetWindow(hwnd,4))};
          Guid iid=new Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99");ReadOnlyPropertyStore store=null;
          try {
            int hr=SHGetPropertyStoreForWindow(hwnd,ref iid,out store);
            if(hr<0||store==null)errors.Add("SHGetPropertyStoreForWindow HRESULT=0x"+hr.ToString("x8"));
            else { item.AppUserModelId=Property(store,5,errors);item.RelaunchCommand=Property(store,2,errors);item.RelaunchIconResource=Property(store,3,errors);item.RelaunchDisplayName=Property(store,4,errors); }
          } finally {if(store!=null&&Marshal.IsComObject(store))Marshal.FinalReleaseComObject(store);}
          UIntPtr small=Icon(hwnd,0,errors),large=Icon(hwnd,1,errors),small2=Icon(hwnd,2,errors);IntPtr classSmall=ClassIcon(hwnd,-34),classLarge=ClassIcon(hwnd,-14);
          item.WindowSmallIcon=Hex(small);item.WindowSmall2Icon=Hex(small2);item.WindowLargeIcon=Hex(large);item.ClassSmallIcon=Hex(classSmall);item.ClassLargeIcon=Hex(classLarge);
          item.HasSmallIcon=small!=UIntPtr.Zero||small2!=UIntPtr.Zero||classSmall!=IntPtr.Zero;item.HasLargeIcon=large!=UIntPtr.Zero||classLarge!=IntPtr.Zero;
          item.ReadErrors=errors.ToArray();windows.Add(item);
        } catch(Exception error) {enumerationErrors.Add(Hex(hwnd)+": "+error.GetType().Name+": "+error.Message);}
        return true;
      };
      if(!EnumWindows(callback,IntPtr.Zero))throw new InvalidOperationException("EnumWindows failed: "+Marshal.GetLastWin32Error());
      GC.KeepAlive(callback);
      if(enumerationErrors.Count>0)throw new InvalidOperationException(String.Join("; ",enumerationErrors.ToArray()));
      return windows.ToArray();
    }
  }
}
'@
}

$taskProcess=Get-Process -Id $ProcessId -ErrorAction Stop
$taskExecutable=$taskProcess.Path
$taskGlobalErrors=New-Object 'System.Collections.Generic.List[string]'
if($ExpectedExecutable -and -not [String]::Equals([IO.Path]::GetFullPath($ExpectedExecutable),[IO.Path]::GetFullPath($taskExecutable),[StringComparison]::OrdinalIgnoreCase)){
  $taskGlobalErrors.Add('The actual process executable differs from ExpectedExecutable.')
}
$taskRaw=@([SmaltCode.WindowIdentityAudit]::Read($ProcessId,$IncludeHidden.IsPresent))
if($taskRaw.Count -lt $MinimumWindows){$taskGlobalErrors.Add('Fewer matching application windows than MinimumWindows; run against a normal visible application.')}
$taskWindows=@(foreach($taskWindow in $taskRaw){
  $taskErrors=New-Object 'System.Collections.Generic.List[string]'
  foreach($taskError in $taskWindow.ReadErrors){$taskErrors.Add($taskError)}
  if([String]::IsNullOrWhiteSpace($taskWindow.AppUserModelId)){$taskErrors.Add('Window AppUserModel.ID is empty.')}
  if($ExpectedAppId -and $taskWindow.AppUserModelId -cne $ExpectedAppId){$taskErrors.Add('Window AppUserModel.ID differs from ExpectedAppId.')}
  if([String]::IsNullOrWhiteSpace($taskWindow.RelaunchCommand)){$taskErrors.Add('RelaunchCommand is empty.')}
  if([String]::IsNullOrWhiteSpace($taskWindow.RelaunchDisplayName)){$taskErrors.Add('RelaunchDisplayNameResource is empty.')}
  $taskIconPath=$null;$taskIconIndex=$null;$taskIconExists=$false
  if([String]::IsNullOrWhiteSpace($taskWindow.RelaunchIconResource)){$taskErrors.Add('RelaunchIconResource is empty.')}
  else{
    $taskResource=$taskWindow.RelaunchIconResource.Trim()
    if($taskResource.StartsWith('@')){$taskResource=$taskResource.Substring(1)}
    if($taskResource -match '^(.*),\s*(-?\d+)\s*$'){$taskIconPath=$Matches[1].Trim();$taskIconIndex=[int]$Matches[2]}else{$taskIconPath=$taskResource}
    if($taskIconPath.Length -ge 2 -and $taskIconPath.StartsWith('"') -and $taskIconPath.EndsWith('"')){$taskIconPath=$taskIconPath.Substring(1,$taskIconPath.Length-2)}
    $taskIconPath=[Environment]::ExpandEnvironmentVariables($taskIconPath)
    if($taskIconPath -match '[\\/]app\.asar([\\/]|$)'){$taskErrors.Add('Icon resource points inside virtual app.asar; Windows Shell cannot read it.')}
    elseif($taskIconPath.StartsWith('\\') -and $taskIconPath -notmatch '^\\\\\?\\[A-Za-z]:\\'){$taskErrors.Add('Network/device icon paths are not followed by this read-only verifier.')}
    elseif(-not [IO.Path]::IsPathRooted($taskIconPath)){$taskErrors.Add('Icon resource is not an absolute filesystem path.')}
    else{
      $taskIconExists=[IO.File]::Exists($taskIconPath)
      if(-not $taskIconExists){$taskErrors.Add('Shell-visible icon resource does not exist as a physical file.')}
      if($ExpectedIconPath -and -not [String]::Equals([IO.Path]::GetFullPath($ExpectedIconPath),[IO.Path]::GetFullPath($taskIconPath),[StringComparison]::OrdinalIgnoreCase)){$taskErrors.Add('Icon resource differs from ExpectedIconPath.')}
    }
  }
  if($RequireWindowIcon -and (-not $taskWindow.HasSmallIcon -or -not $taskWindow.HasLargeIcon)){$taskErrors.Add('Small or large native window icon is empty, including class fallback.')}
  [pscustomobject]@{handle=$taskWindow.Handle;title=$taskWindow.Title;className=$taskWindow.ClassName;visible=$taskWindow.Visible;ownerHandle=$taskWindow.OwnerHandle;appUserModelId=$taskWindow.AppUserModelId;relaunchIconResource=$taskWindow.RelaunchIconResource;relaunchCommand=$taskWindow.RelaunchCommand;relaunchDisplayName=$taskWindow.RelaunchDisplayName;physicalIconPath=$taskIconPath;iconIndex=$taskIconIndex;physicalIconExists=$taskIconExists;windowSmallIcon=$taskWindow.WindowSmallIcon;windowSmall2Icon=$taskWindow.WindowSmall2Icon;windowLargeIcon=$taskWindow.WindowLargeIcon;classSmallIcon=$taskWindow.ClassSmallIcon;classLargeIcon=$taskWindow.ClassLargeIcon;hasSmallIcon=$taskWindow.HasSmallIcon;hasLargeIcon=$taskWindow.HasLargeIcon;passed=($taskErrors.Count -eq 0);errors=@($taskErrors.ToArray())}
})
$taskPassed=$taskGlobalErrors.Count -eq 0 -and @($taskWindows|Where-Object{-not $_.passed}).Count -eq 0
$taskResult=[ordered]@{passed=$taskPassed;processId=$ProcessId;executable=$taskExecutable;expectedAppId=$ExpectedAppId;minimumWindows=$MinimumWindows;includeHidden=$IncludeHidden.IsPresent;windowIconRequired=$RequireWindowIcon.IsPresent;readOnly=$true;windows=$taskWindows;errors=@($taskGlobalErrors.ToArray())}
$taskJson=$taskResult|ConvertTo-Json -Depth 8
if($ReportPath){[IO.File]::WriteAllText([IO.Path]::GetFullPath($ReportPath),$taskJson+"`n",(New-Object Text.UTF8Encoding($false)))}
Write-Output $taskJson
if(-not $taskPassed){exit 1}
