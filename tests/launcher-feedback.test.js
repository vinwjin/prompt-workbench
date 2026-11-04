import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {mkdirSync,mkdtempSync,readFileSync,writeFileSync,existsSync,rmSync} from 'node:fs';
import {removeOwnedArtifact} from '../scripts/test-artifacts.mjs';

test('隐藏启动入口显示失败原因，旧版仅打开恢复页面，非交互启动仍拒绝旧版', {skip:process.platform!=='win32',timeout:30000}, async()=>{
  const root=process.env.PW_TEST_ROOT||path.resolve('work');mkdirSync(root,{recursive:true});
  const dir=mkdtempSync(path.join(root,'launcher-feedback-')),scripts=path.join(dir,'scripts'),data=path.join(dir,'data');
  mkdirSync(scripts);mkdirSync(data);
  writeFileSync(path.join(dir,'package.json'),JSON.stringify({version:'new-test'}));
  writeFileSync(path.join(scripts,'start.ps1'),readFileSync('scripts/start.ps1'));
  const browser=path.join(dir,'browser.txt'),popup=path.join(dir,'popup.txt');
  // 仅替换桌面副作用；真实 start.ps1、health 请求、版本/实例保护和错误处理均执行。
  const wrapper=path.join(dir,'probe.ps1');
  writeFileSync(wrapper,`param([switch]$NoBrowser)
function Start-Process { param($FilePath) [IO.File]::WriteAllText($env:PW_PROBE_BROWSER,[string]$FilePath) }
function New-Object {
  param($ComObject)
  if($ComObject -ne 'WScript.Shell'){throw 'Unexpected COM object'}
  $shell=[pscustomobject]@{}
  $shell | Add-Member -MemberType ScriptMethod -Name Popup -Value {
    param($message,$seconds,$title,$flags)
    [IO.File]::WriteAllText($env:PW_PROBE_POPUP,[string]$message)
    return 1
  }
  return $shell
}
& (Join-Path $PSScriptRoot 'scripts/start.ps1') -NoBrowser:$NoBrowser
exit $LASTEXITCODE
`, 'utf8');
  let instance=createHash('sha256').update((dir+'|'+data).toLowerCase()).digest('hex').slice(0,16);
  const server=http.createServer((req,res)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({app:'prompt-workbench',instance,version:'old-test'}));});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const port=server.address().port;
  const run=async(noBrowser=false)=>{
    for(const file of [browser,popup])if(existsSync(file))rmSync(file);
    const child=spawn('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',wrapper,...(noBrowser?['-NoBrowser']:[])],{windowsHide:true,stdio:'ignore',env:{...process.env,PW_PORT:String(port),PW_DATA_DIR:data,PW_PROBE_BROWSER:browser,PW_PROBE_POPUP:popup}});
    return await new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',resolve);});
  };
  let pass=false;
  try{
    assert.equal(await run(),1);
    assert.equal(readFileSync(browser,'utf8'),'http://127.0.0.1:'+port);
    assert.match(readFileSync(popup,'utf8'),/old-test.*new-test/);
    assert.equal(await run(true),1);
    assert.equal(existsSync(browser),false);assert.equal(existsSync(popup),false);
    instance='foreign-instance';
    assert.equal(await run(),1);
    assert.equal(existsSync(browser),false);
    assert.match(readFileSync(popup,'utf8'),/其他实例/);
    pass=true;
  }finally{
    await new Promise(r=>server.close(r));
    if(pass)removeOwnedArtifact(dir);
  }
});
