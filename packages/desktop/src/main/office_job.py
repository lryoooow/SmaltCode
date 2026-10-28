"""Kill-on-close Job Object for headless, exclusively owned validation engines only."""
import os
class HeadlessJob:
 def __init__(self):
  self.handle=None
  if os.name!='nt':return
  import ctypes as c
  from ctypes import wintypes as w
  self.c=c;self.k=c.WinDLL('kernel32',use_last_error=True)
  class Basic(c.Structure):_fields_=[('ProcessTime',c.c_longlong),('JobTime',c.c_longlong),('Flags',w.DWORD),('MinWorkingSet',c.c_size_t),('MaxWorkingSet',c.c_size_t),('ActiveProcessLimit',w.DWORD),('Affinity',c.c_size_t),('PriorityClass',w.DWORD),('SchedulingClass',w.DWORD)]
  class Counters(c.Structure):_fields_=[(name,c.c_ulonglong)for name in ['ReadOperationCount','WriteOperationCount','OtherOperationCount','ReadTransferCount','WriteTransferCount','OtherTransferCount']]
  class Limits(c.Structure):_fields_=[('Basic',Basic),('IO',Counters),('ProcessMemory',c.c_size_t),('JobMemory',c.c_size_t),('PeakProcessMemory',c.c_size_t),('PeakJobMemory',c.c_size_t)]
  self.k.CreateJobObjectW.argtypes=[c.c_void_p,w.LPCWSTR];self.k.CreateJobObjectW.restype=w.HANDLE;self.k.SetInformationJobObject.argtypes=[w.HANDLE,c.c_int,c.c_void_p,w.DWORD];self.k.AssignProcessToJobObject.argtypes=[w.HANDLE,w.HANDLE];self.k.CloseHandle.argtypes=[w.HANDLE]
  self.handle=self.k.CreateJobObjectW(None,None)
  if not self.handle:raise RuntimeError('office-job-create-failed')
  limits=Limits();limits.Basic.Flags=0x2000
  if not self.k.SetInformationJobObject(self.handle,9,c.byref(limits),c.sizeof(limits)):self.close();raise RuntimeError('office-job-configure-failed')
 def assign(self,process):
  if self.handle and not self.k.AssignProcessToJobObject(self.handle,int(process._handle)):
   process.terminate();process.wait(timeout=5);raise RuntimeError('office-job-assign-failed')
 def close(self):
  if self.handle:self.k.CloseHandle(self.handle);self.handle=None
