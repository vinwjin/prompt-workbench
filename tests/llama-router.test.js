import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,symlinkSync,unlinkSync} from 'node:fs';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {scanLlamaModels,prepareManagedRouter,readLlamaDefaults} from '../src/llama-router.js';
import {Lifecycle} from '../src/lifecycle.js';
import {createWorkbench} from './source-fixtures.js';
import {validateProvider} from '../src/providers.js';

const root=()=>{const base=path.resolve(process.env.PW_TEST_ROOT||'work/llama-router-unit');mkdirSync(base,{recursive:true});return mkdtempSync(path.join(base,'router-'));};
const gguf=file=>writeFileSync(file,Buffer.concat([Buffer.from('GGUF'),Buffer.alloc(20)]));
function modelFixture(dir){mkdirSync(dir,{recursive:true});const models=path.join(dir,'models'),repo=path.join(models,'repo');mkdirSync(repo,{recursive:true});const main=path.join(repo,'Model-A.gguf'),mmproj=path.join(repo,'mmproj-f16.gguf');gguf(main);gguf(mmproj);gguf(path.join(repo,'Bad-00001-of-00002.gguf'));gguf(path.join(repo,'Model-mtp.gguf'));return {models,main,mmproj};}

test('GGUF 扫描只登记完整主模型，并为唯一同目录投影生成安全 preset',()=>{
  const dir=root(),f=modelFixture(dir),found=scanLlamaModels(f.models);
  assert.equal(found.length,1);assert.equal(found[0].id,'Model-A');assert.equal(found[0].modelPath,f.main);assert.equal(found[0].mmprojPath,f.mmproj);assert.equal(found[0].source,'local-file');
  const prepared=prepareManagedRouter(path.join(dir,'workbench-data'),{id:'router-1',exePath:path.join(dir,'llama-server.exe'),modelsDir:f.models});
  const ini=readFileSync(prepared.iniPath,'utf8');assert.match(ini,/^version = 1/m);assert.match(ini,/^load-on-startup = false$/m);assert.ok(ini.includes(`[${found[0].id}]`));assert.ok(ini.includes(`model = ${f.main.replaceAll('\\','/')}`));assert.ok(ini.includes(`mmproj = ${f.mmproj.replaceAll('\\','/')}`));assert.equal((ini.match(/^\[Model-A\]$/gm)||[]).length,1);
});

test('不跟随符号链接、不接受路径注入，缺省defaults保持本机Router地址',()=>{
  const dir=root(),f=modelFixture(dir);assert.throws(()=>prepareManagedRouter(path.join(dir,'data'),{id:'../x',exePath:path.join(dir,'llama-server.exe'),modelsDir:f.models}),/ID无效/);
  assert.deepEqual(readLlamaDefaults(path.join(dir,'absent')),{exePath:'',modelsDir:'',baseUrl:'http://127.0.0.1:18180/v1'});
  const managed={name:'本机Router',protocol:'router',managedRouter:true,baseUrl:'http://127.0.0.1:18181/v1'};assert.doesNotThrow(()=>validateProvider(managed));
  for(const baseUrl of ['http://example.com:18181/v1','http://127.0.0.1/v1','http://127.0.0.1:18181/v2','http://127.0.0.1:18181/v1?x=1'])assert.throws(()=>validateProvider({...managed,baseUrl}));
  mkdirSync(path.join(dir,'llama'),{recursive:true});writeFileSync(path.join(dir,'llama','defaults.json'),JSON.stringify({baseUrl:'http://127.0.0.1:18181/v1'}));assert.equal(readLlamaDefaults(dir).baseUrl,'http://127.0.0.1:18181/v1');
  const link=path.join(dir,'linked');let created=false;try{symlinkSync(f.models,link,'dir');created=true;assert.throws(()=>scanLlamaModels(link),/符号链接/);}catch(e){if(e.code!=='EPERM'&&e.code!=='EACCES')throw e;}finally{if(created)unlinkSync(link);}
  const caps=new Lifecycle(dir).capabilities({id:'missing',protocol:'router',managedRouter:true,baseUrl:'http://127.0.0.1:18181/v1',model:'Model-A',exePath:path.join(dir,'missing','llama-server.exe'),modelsDir:f.models});assert.equal(caps.load.enabled,false);assert.match(caps.load.reason,/llama-server.exe/);
});

test('托管 Router start 生成空载参数；进程退出清除此服务下全部模型租约',async()=>{
  const dir=root(),f=modelFixture(dir),exe=path.join(dir,'llama-server.exe');writeFileSync(exe,'fixture');
  const lifecycle=new Lifecycle(path.join(dir,'data'));let count=0,args;
  lifecycle.status=async p=>{if(count++===0)return {online:false,models:[]};lifecycle.observe(p,true);return {online:true,models:[{id:'Model-A',status:'unloaded'}],loaded:[],startedByWorkbench:true};};
  lifecycle.spawnOwned=(p,a)=>{args=a;lifecycle.children.set(p.id,{exitCode:null});lifecycle.started.add(p.id);};
  const p={id:'router-1',protocol:'router',managedRouter:true,baseUrl:'http://127.0.0.1:18181/v1',model:'',exePath:exe,modelsDir:f.models};
  const result=await lifecycle.start(p);assert.equal(result.online,true);assert.equal(result.models[0].status,'unloaded');assert.ok(args.includes('--no-models-autoload'));assert.ok(args.includes('--models-max'));assert.ok(args.includes('1'));assert.ok(args.includes('--fit'));assert.ok(args.includes('on'));assert.ok(args.some((a,i)=>a==='--port'&&args[i+1]==='18181'));assert.ok(args.some((a,i)=>a==='-c'&&args[i+1]==='4096'));assert.ok(args.some((a,i)=>a==='-np'&&args[i+1]==='1'));assert.ok(args.includes('--models-preset'));assert.ok(args.some(a=>a.endsWith('models.ini')));
  const states={'Model-A':'unloaded','Model-B':'unloaded','Model-C':'unloaded'},actions=[];let failNextC=true;const originalFetch=globalThis.fetch;globalThis.fetch=async(url,options={})=>{const target=String(url);if(target.endsWith('/v1/models'))return new Response(JSON.stringify({data:Object.entries(states).map(([id,status])=>({id,status:{value:status}}))}),{status:200});if(target.includes('/slots'))return new Response(JSON.stringify([{is_processing:false}]),{status:200});if(target.endsWith('/models/load')&&options.method==='POST'){const model=JSON.parse(options.body).model;if(model==='Model-C'&&failNextC){failNextC=false;return new Response(JSON.stringify({error:{message:'mock failure'}}),{status:500});}states[model]='loaded';actions.push('load:'+model);return new Response('{}',{status:200});}if(target.endsWith('/models/unload')&&options.method==='POST'){const model=JSON.parse(options.body).model;states[model]='unloaded';actions.push('unload:'+model);return new Response('{}',{status:200});}return new Response('{}',{status:404});};
  try{
    p.model='Model-A';const loadResult=await lifecycle.load(p,false);assert.equal(loadResult.online,true);assert.equal(lifecycle.owned.has('http://127.0.0.1:18181|Model-A'),true);
    p.model='Model-B';await lifecycle.load(p,false);assert.deepEqual(actions,['load:Model-A','unload:Model-A','load:Model-B']);assert.equal(lifecycle.owned.has('http://127.0.0.1:18181|Model-A'),false);assert.equal(lifecycle.owned.has('http://127.0.0.1:18181|Model-B'),true);
    p.model='Model-C';await assert.rejects(lifecycle.load(p,false),/HTTP 500/);assert.equal(lifecycle.owned.has('http://127.0.0.1:18181|Model-C'),true);await lifecycle.load(p,false);assert.equal(states['Model-C'],'loaded');assert.equal(actions.at(-1),'load:Model-C');
    states['Model-C']='unloaded';lifecycle.owned.delete('http://127.0.0.1:18181|Model-C');
    states['Model-A']='loaded';lifecycle.owned.add('http://127.0.0.1:18181|Model-A');states['Model-C']='loaded';const beforeExternal=actions.slice();await assert.rejects(lifecycle.load(p,false),/外部加载模型/);assert.deepEqual(actions,beforeExternal);
  }finally{globalThis.fetch=originalFetch;}
  const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.exitCode=null;child.kill=()=>child.emit('exit',0,null);lifecycle.children.set(p.id,child);lifecycle.spawnProcess=()=>child;
  // Exercise normal spawnOwned's process-exit cleanup without launching a binary.
  Lifecycle.prototype.spawnOwned.call(lifecycle,p,args,process.env);child.emit('exit',0,null);assert.equal(lifecycle.started.has(p.id),false);assert.equal([...lifecycle.owned].some(key=>key.startsWith('http://127.0.0.1:18181|')),false);
});

test('managedRouter 可空模型保存，defaults 与 preset 下发；start 成功目录写入 upstream 缓存',async()=>{
  const dir=root(),f=modelFixture(dir);mkdirSync(path.join(dir,'llama'),{recursive:true});writeFileSync(path.join(dir,'llama','defaults.json'),JSON.stringify({exePath:'C:\\tools\\llama-server.exe',modelsDir:f.models,baseUrl:'http://127.0.0.1:18181/v1'}));
  const directory=[{id:'Model-A',status:'unloaded'}],fake={owned:new Set(),started:new Set(),locked:false,key:p=>`${p.baseUrl}|${p.model}`,exclusive:fn=>fn(),status:async()=>({online:true,models:directory}),start:async()=>({online:true,models:directory}),capabilities:()=>({})};
  const app=await createWorkbench({port:0,dataDir:dir,lifecycle:fake});
  try{
    const base=`http://127.0.0.1:${app.port}`,home=await fetch(base),cookie=home.headers.get('set-cookie').split(';')[0],call=async(route,body,method='GET')=>fetch(base+route,{method,headers:{cookie,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});
    const defaults=await (await call('/api/llama/defaults')).json();assert.equal(defaults.modelsDir,f.models);assert.equal(defaults.baseUrl,'http://127.0.0.1:18181/v1');
    const state=await (await call('/api/state')).json(),preset=state.presets.find(p=>p.id==='router');assert.equal(preset.managedRouter,true);assert.equal(preset.model,'');assert.equal(preset.baseUrl,'http://127.0.0.1:18181/v1');assert.equal(preset.exePath,'C:\\tools\\llama-server.exe');
    const savedResponse=await call('/api/providers',{name:'本机 llama.cpp',protocol:'router',managedRouter:true,baseUrl:defaults.baseUrl,model:'',exePath:defaults.exePath,modelsDir:f.models},'POST');assert.equal(savedResponse.status,200);const saved=await savedResponse.json();assert.equal(saved.managedRouter,true);assert.equal(saved.modelsDir,f.models);assert.equal(saved.model,'');
    const started=await call(`/api/providers/${saved.id}/start`,{},'POST');assert.equal(started.status,200);assert.deepEqual((await started.json()).models,directory);const cache=app.store.get('modelLists',saved.id);assert.equal(cache.source,'upstream');assert.deepEqual(cache.models,directory);
    const jobInput={providerId:saved.id,templateId:'optimize',input:'明确的提示词请求'};assert.throws(()=>app.jobs.prepare({...jobInput,model:''}),/选择模型/);
    app.store.put('providers',{...app.store.get('providers',saved.id),model:'Model-A'});fake.status=async()=>({online:false,models:[]});assert.equal(app.jobs.prepare(jobInput).model,'Model-A');assert.throws(()=>app.jobs.prepare({...jobInput,model:'stale-model'}),/服务目录/);
    assert.equal((await call('/api/jobs',{...jobInput,model:''},'POST')).status,400);assert.equal((await call('/api/batch',{...jobInput,model:'',inputs:['另一条有效输入']},'POST')).status,400);
    app.store.put('modelLists',{...cache,source:'local-configuration'});assert.throws(()=>app.jobs.prepare(jobInput),/服务目录/);app.store.put('modelLists',cache);
    assert.equal((await call('/api/locmodel/models')).status,404);
  }finally{await app.close();}
});
