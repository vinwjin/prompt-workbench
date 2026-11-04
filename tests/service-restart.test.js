import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import path from 'node:path';
import { waitForRestart } from '../public/service-exit.js';
import { createWorkbench, restartCommand } from './source-fixtures.js';
import { setTimeout as sleep } from 'node:timers/promises';
const dir=()=>{mkdirSync('work',{recursive:true});return mkdtempSync(path.resolve(process.env.PW_TEST_ROOT||'work','restart-'));};
async function session(app){const url=`http://127.0.0.1:${app.port}`;const root=await fetch(url);const cookie=root.headers.get('set-cookie').split(';')[0];return async(route,body,options={})=>{const response=await fetch(url+'/api/'+route,{method:body?'POST':'GET',headers:{Cookie:cookie,...(body?{'Content-Type':'application/json'}:{}),...options.headers},body:body?JSON.stringify(body):undefined});return {status:response.status,data:await response.json()};};}
async function until(fn,timeout=5000){const end=Date.now()+timeout;while(Date.now()<end){const r=await fn();if(r)return r;await sleep(20);}throw new Error('test timeout');}

test('waitForRestart：先观察到退出、再同版本上线判定 restarted',async()=>{
  let n=0;
  const fetcher=async()=>{if(++n<=3)throw new TypeError('down');return {ok:true,json:async()=>({app:'prompt-workbench',version:'0.4.2-dev.25'})};};
  assert.equal(await waitForRestart('0.4.2-dev.25',{fetcher,pause:async()=>{},attempts:10}),'restarted');
});

test('waitForRestart：持续不可达判定 closed；始终在线判定 still-running',async()=>{
  assert.equal(await waitForRestart('v',{fetcher:async()=>{throw new TypeError('down');},pause:async()=>{},attempts:5}),'closed');
  assert.equal(await waitForRestart('v',{fetcher:async()=>({ok:true,json:async()=>({app:'prompt-workbench',version:'v'})}),pause:async()=>{},attempts:5}),'still-running');
});

test('restartCommand 构造等待端口释放后调用启动器',()=>{
  const {file,args}=restartCommand(path.join('E:','proj'));
  assert.equal(file,'powershell.exe');
  const script=args[args.length-1];
  assert.ok(script.includes('start.ps1'));
  assert.ok(script.includes('-NoBrowser'));
  assert.ok(script.includes('Get-NetTCPConnection'));
  assert.ok(script.includes('-State Listen'));
  assert.ok(args.includes('-ExecutionPolicy'));
});

test('/api/restart 返回重启中并触发关闭；关闭失败时不拉起新进程',async()=>{
  const app=await createWorkbench({port:0,dataDir:dir(),generator:async()=>({output:'x'})});const call=await session(app);
  let shutdownCalled=0;const original=app.jobs.shutdown.bind(app.jobs);
  try{
    app.jobs.shutdown=async()=>{shutdownCalled++;app.jobs.closing=true;return false;};
    const r=await call('restart',{});
    assert.equal(r.status,200);assert.equal(r.data.restarting,true);
    await until(()=>shutdownCalled>0);
    await until(()=>!app.jobs.closing);
    assert.equal(shutdownCalled,1);
  }finally{app.jobs.shutdown=original;await app.close();}
});
