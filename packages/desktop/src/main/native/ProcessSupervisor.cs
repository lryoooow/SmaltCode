// Windows console supervisor: children inherit a kill-on-close Job Object.
// Only the host supplies this configuration; no project script runs before assignment.
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.IO;

class LaunchConfig { public string file; public string[] args; public int parentPid; public double parentStartedAt; public bool stdio; }
class ProcessSupervisor {
  static void Pump(Stream from, Stream to) { byte[] buffer=new byte[8192]; int count; while((count=from.Read(buffer,0,buffer.Length))>0) { to.Write(buffer,0,count); to.Flush(); } }
  [StructLayout(LayoutKind.Sequential)] struct BasicLimits {
    public long ProcessTime, JobTime; public uint Flags;
    public UIntPtr MinWorkingSet, MaxWorkingSet; public uint ActiveProcessLimit;
    public UIntPtr Affinity; public uint PriorityClass, SchedulingClass;
  }
  [StructLayout(LayoutKind.Sequential)] struct IoCounters { public ulong a,b,c,d,e,f; }
  [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits {
    public BasicLimits Basic; public IoCounters Io;
    public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
  }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr security, string name);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref ExtendedLimits limits, uint size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateJobObject(IntPtr job, uint code);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);

  static string Quote(string value) {
    var output = new StringBuilder("\""); int slashes=0;
    foreach(char c in value) {
      if(c=='\\') { slashes++; continue; }
      if(c=='"') output.Append('\\', slashes*2+1).Append('"');
      else output.Append('\\', slashes).Append(c);
      slashes=0;
    }
    return output.Append('\\', slashes*2).Append('"').ToString();
  }
  static int Main(string[] argv) {
    IntPtr job=IntPtr.Zero;
    try {
      Console.OutputEncoding = new UTF8Encoding(false);
      if(argv.Length!=1 || argv[0].Length>24000) throw new Exception("Invalid launch configuration");
      var config=new JavaScriptSerializer().Deserialize<LaunchConfig>(Encoding.UTF8.GetString(Convert.FromBase64String(argv[0])));
      if(config==null || String.IsNullOrWhiteSpace(config.file) || config.args==null || config.parentPid<=0) throw new Exception("Invalid launch fields");
      var parent=Process.GetProcessById(config.parentPid);
      double born=(parent.StartTime.ToUniversalTime()-new DateTime(1970,1,1,0,0,0,DateTimeKind.Utc)).TotalMilliseconds;
      if(Math.Abs(born-config.parentStartedAt)>10000 || parent.HasExited) throw new Exception("Parent process identity changed");
      job=CreateJobObject(IntPtr.Zero,null);
      var limits=new ExtendedLimits(); limits.Basic.Flags=0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE; no breakaway.
      if(job==IntPtr.Zero || !SetInformationJobObject(job,9,ref limits,(uint)Marshal.SizeOf(limits)) || !AssignProcessToJobObject(job,Process.GetCurrentProcess().Handle)) throw new Exception("Cannot establish process job: "+Marshal.GetLastWin32Error());
      IntPtr ownedJob=job;
      var monitor=new Thread(()=> { try { parent.WaitForExit(); } finally { TerminateJobObject(ownedJob,126); } });
      monitor.IsBackground=true; monitor.Start();
      Console.CancelKeyPress+=(sender,e)=>{ e.Cancel=true; }; // Let the child receive Ctrl+C without losing its supervisor.
      string arguments=String.Join(" ",Array.ConvertAll(config.args,Quote));
      // cmd /s /c parses its final argument itself, rather than CRT backslash escaping.
      if(Path.GetFileName(config.file).Equals("cmd.exe",StringComparison.OrdinalIgnoreCase)) {
        if(config.args.Length!=4 || config.args[0]!="/d" || config.args[1]!="/s" || config.args[2]!="/c") throw new Exception("Invalid shell wrapper");
        arguments="/d /s /c "+config.args[3];
      }
      var info=new ProcessStartInfo(config.file,arguments) { UseShellExecute=false };
      if(config.stdio) { info.RedirectStandardInput=true; info.RedirectStandardOutput=true; info.RedirectStandardError=true; info.CreateNoWindow=true; }
      var child=Process.Start(info);
      if(child==null) throw new Exception("Child process did not start");
      Thread output=null, errors=null;
      if(config.stdio) {
        var input=new Thread(()=>{try { Pump(Console.OpenStandardInput(),child.StandardInput.BaseStream); child.StandardInput.Close(); } catch {} }); input.IsBackground=true; input.Start();
        output=new Thread(()=>{try { Pump(child.StandardOutput.BaseStream,Console.OpenStandardOutput()); } catch {} }); output.IsBackground=true; output.Start();
        errors=new Thread(()=>{try { Pump(child.StandardError.BaseStream,Console.OpenStandardError()); } catch {} }); errors.IsBackground=true; errors.Start();
      }
      if(!config.stdio) { Console.Write("\x1b]777;smalt-ready\x07"); Console.Out.Flush(); }
      child.WaitForExit(); int code=child.ExitCode;
      if(output!=null) output.Join(500); if(errors!=null) errors.Join(500);
      // This also reaps descendants left behind by a parent that exited early.
      TerminateJobObject(job,unchecked((uint)code));
      return code;
    } catch(Exception error) {
      Console.Error.WriteLine("[SmaltCode process error] "+error.Message);
      if(job!=IntPtr.Zero) TerminateJobObject(job,125);
      return 125;
    } finally { if(job!=IntPtr.Zero) CloseHandle(job); }
  }
}
