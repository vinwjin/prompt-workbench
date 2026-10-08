import { spawn } from 'node:child_process';

export function runProcess(file,args,{input='',timeout=180000}={}){
  return new Promise((resolve,reject)=>{
    const child=spawn(file,args,{windowsHide:true,stdio:['pipe','pipe','pipe']});let out='',err='';
    const timer=setTimeout(()=>{child.kill();reject(new Error('操作超时，请检查本地服务状态'));},timeout);
    child.stdout.on('data',b=>{out+=b.toString();if(out.length>2e6){child.kill();reject(new Error('服务输出过大'));}});
    child.stderr.on('data',b=>{err=(err+b.toString()).slice(-4000);});
    child.on('error',e=>{clearTimeout(timer);reject(e);});child.on('exit',code=>{clearTimeout(timer);if(code!==0)reject(new Error(err||'本地操作失败'));else resolve(out.trim());});child.stdin.end(input);
  });
}
export class SecretVault {
  async transform(value,protect){
    if(process.platform!=='win32')throw new Error('当前版本的凭据保护需要 Windows DPAPI；请在 Windows 使用在线密钥');
    const script=`Add-Type -AssemblyName System.Security; $v=[Console]::In.ReadToEnd(); $b=[Convert]::FromBase64String($v); $r=[System.Security.Cryptography.ProtectedData]::${protect?'Protect':'Unprotect'}($b,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($r))`;
    const result=await runProcess('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{input:protect?Buffer.from(value).toString('base64'):value,timeout:20000});
    return protect?result:Buffer.from(result,'base64').toString('utf8');
  }
  seal(v){return this.transform(v,true);}
  async open(v){return v?this.transform(v,false):'';}
}
