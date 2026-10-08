import {execFileSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,existsSync,writeFileSync,readFileSync} from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
mkdirSync('work',{recursive:true});const stage=mkdtempSync(path.resolve('work','package-中文 空格-'));
const zip=path.join(stage,'source.zip');execFileSync('git',['archive','--format=zip','-o',zip,'HEAD']);
if(process.platform==='win32')execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',"Expand-Archive -LiteralPath $env:PW_SMOKE_ZIP -DestinationPath $env:PW_SMOKE_DIR"],{env:{...process.env,PW_SMOKE_ZIP:zip,PW_SMOKE_DIR:path.join(stage,'解压副本')}});
else {mkdirSync(path.join(stage,'解压副本'));execFileSync('unzip',['-q',zip,'-d',path.join(stage,'解压副本')]);}
const extracted=path.join(stage,'解压副本');for(const f of ['data','work','archives','.workbuddy','.git'])assert(!existsSync(path.join(extracted,f)),'包含私人目录');
const probe=path.join(stage,'probe.mjs');writeFileSync(probe,`import {createWorkbench} from './解压副本/src/server.js';import assert from 'node:assert/strict';import path from 'node:path';const app=await createWorkbench({port:0,dataDir:path.resolve('work','smoke-data'),generator:async()=>({output:'synthetic'})});try{const url='http://127.0.0.1:'+app.port;const health=await(await fetch(url+'/health')).json();assert.equal(health.version,'${JSON.parse(readFileSync('package.json','utf8')).version}');const home=await fetch(url);const cookie=home.headers.get('set-cookie').split(';')[0];const state=await(await fetch(url+'/api/state',{headers:{cookie}})).json();assert.equal(state.providers.length,0);assert.equal(state.assets.length,0);assert.equal(state.jobs.length,0);assert.equal(state.feeds.length,37);}finally{await app.close();}console.log('源码ZIP在中文/空格路径空数据启动通过；未调用真实模型');`);
execFileSync(process.execPath,[probe],{cwd:stage,stdio:'inherit',env:{...process.env,PW_ROUTER_INI:'',PW_ROUTER_MANAGER:''}});
