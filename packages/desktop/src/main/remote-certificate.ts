import { execFile } from 'node:child_process';
import { randomBytes,randomUUID,X509Certificate } from 'node:crypto';
import { mkdir,readFile,rm } from 'node:fs/promises';
import { join } from 'node:path';
export type RemoteCertificate={pfx:Buffer;passphrase:string;certificate:string;fingerprint:string;expiresAt:string};
/** The private key never enters command-line arguments, the certificate store, or renderer state. */
export async function generateRemoteCertificate(directory:string,hosts:string[],signal?:AbortSignal):Promise<RemoteCertificate>{
  if(process.platform!=='win32')throw new Error('当前系统请导入已有 HTTPS 证书；本机证书生成仅支持 Windows');
  await mkdir(directory,{recursive:true,mode:0o700});const file=join(directory,'certificate-'+randomUUID()+'.pfx'),passphrase=randomBytes(32).toString('base64url');
  const script=`$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
$inputData=[Console]::In.ReadToEnd() | ConvertFrom-Json
$rsa=[System.Security.Cryptography.RSACng]::new(2048)
if($rsa -is [System.Security.Cryptography.RSACryptoServiceProvider]){$rsa.PersistKeyInCsp=$false}
$request=[System.Security.Cryptography.X509Certificates.CertificateRequest]::new('CN=SmaltCode Remote',$rsa,[System.Security.Cryptography.HashAlgorithmName]::SHA256,[System.Security.Cryptography.RSASignaturePadding]::Pkcs1)
$san=[System.Security.Cryptography.X509Certificates.SubjectAlternativeNameBuilder]::new()
$san.AddDnsName('localhost')
foreach($address in $inputData.hosts){$ip=$null;if([System.Net.IPAddress]::TryParse($address,[ref]$ip)){$san.AddIpAddress($ip)}}
$request.CertificateExtensions.Add($san.Build())
$request.CertificateExtensions.Add([System.Security.Cryptography.X509Certificates.X509BasicConstraintsExtension]::new($false,$false,0,$true))
$request.CertificateExtensions.Add([System.Security.Cryptography.X509Certificates.X509KeyUsageExtension]::new([System.Security.Cryptography.X509Certificates.X509KeyUsageFlags]::DigitalSignature -bor [System.Security.Cryptography.X509Certificates.X509KeyUsageFlags]::KeyEncipherment,$true))
$oids=[System.Security.Cryptography.OidCollection]::new();$null=$oids.Add([System.Security.Cryptography.Oid]::new('1.3.6.1.5.5.7.3.1'))
$request.CertificateExtensions.Add([System.Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension]::new($oids,$true))
$cert=$request.CreateSelfSigned([DateTimeOffset]::UtcNow.AddMinutes(-5),[DateTimeOffset]::UtcNow.AddYears(1))
try{[IO.File]::WriteAllBytes($inputData.file,$cert.Export([System.Security.Cryptography.X509Certificates.X509ContentType]::Pfx,$inputData.password));[Console]::Out.Write([Convert]::ToBase64String($cert.RawData))}finally{$cert.Dispose();$rsa.Dispose()}`;
  try{
    const der=await new Promise<string>((accept,reject)=>{const child=execFile(join(process.env.SystemRoot??'C:\\Windows','System32/WindowsPowerShell/v1.0/powershell.exe'),['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{windowsHide:true,timeout:30000,maxBuffer:32768,signal,env:Object.fromEntries(Object.entries(process.env).filter(([k])=>!/(?:API_?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)|^NODE_OPTIONS$/i.test(k)))},(error,stdout,stderr)=>error?reject(new Error('本机证书生成失败：'+String(stderr||error.message).slice(-1600))):accept(stdout.trim()));child.stdin!.end(JSON.stringify({file,password:passphrase,hosts}));});
    const cert=new X509Certificate(Buffer.from(der,'base64'));return{pfx:await readFile(file),passphrase,certificate:cert.toString(),fingerprint:cert.fingerprint256,expiresAt:new Date(cert.validTo).toISOString()};
  }finally{await rm(file,{force:true});}
}
