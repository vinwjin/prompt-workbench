import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {createWorkbench} from './source-fixtures.js';
import {Lifecycle} from '../src/lifecycle.js';

function directory(){const root=path.resolve(process.env.PW_TEST_ROOT||'work');mkdirSync(root,{recursive:true});return mkdtempSync(path.join(root,'connections-'));}
async function client(app){const base='http://127.0.0.1:'+app.port,cookie=(await fetch(base)).headers.get('set-cookie').split(';')[0];return async(route,body,method)=>{const response=await fetch(base+'/api/'+route,{method:method||(body?'POST':'GET'),headers:{cookie,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});return {status:response.status,data:await response.json()};};}

test('连接模型目录支持手动添加、常用及视觉标注，重启保留且不生成',async()=>{
  const dataDir=directory();let generated=0,app=await createWorkbench({port:0,dataDir,generator:async()=>{generated++;return {output:'不应调用'};}});
  let call=await client(app);const provider=(await call('providers',{name:'测试API',protocol:'openai',baseUrl:'http://127.0.0.1:9/v1',model:'Model/A'})).data;
  try{
    const initial=await call('providers/'+provider.id+'/catalog');assert.equal(initial.status,200);assert.equal(initial.data.models[0].id,'Model/A');assert.equal(initial.data.models[0].vision,null);
    const saved=await call('providers/'+provider.id+'/model-preferences',{model:'Model/B',manual:true,favorite:true,vision:false});assert.equal(saved.status,200);
    const row=saved.data.models.find(m=>m.id==='Model/B');assert.equal(row.favorite,true);assert.equal(row.vision,false);assert.equal(row.visionSource,'manual');
    assert.equal((await call('providers/'+provider.id+'/model-preferences',{model:'Model/B',vision:'yes'})).status,400);
    await app.close();app=await createWorkbench({port:0,dataDir});call=await client(app);
    const reopened=(await call('providers/'+provider.id+'/catalog')).data;assert.equal(reopened.models.find(m=>m.id==='Model/B').favorite,true);assert.equal(reopened.models.find(m=>m.id==='Model/B').vision,false);assert.equal(generated,0);
    const removed=await call('providers/'+provider.id+'/model-preferences',{model:'Model/B',removeManual:true});assert.equal(removed.status,200);assert.equal(removed.data.models.some(m=>m.id==='Model/B'),false);
  }finally{await app.close();}
});

test('本机配置目录不冒充接口目录，概览返回无探测生命周期能力及可恢复原因',async()=>{
  const app=await createWorkbench({port:0,dataDir:directory()}),call=await client(app);
  try{
    const p=(await call('providers',{name:'本机 Router',protocol:'router',baseUrl:'http://127.0.0.1:18181/v1',model:'configured-model'})).data;
    app.store.put('modelLists',{id:p.id,models:[{id:'configured-model',status:'configured'}],source:'local-configuration',checkedAt:new Date().toISOString()});
    let catalog=(await call('providers/'+p.id+'/catalog')).data;
    assert.equal(catalog.models[0].source,'local-configuration');
    assert.equal(catalog.capabilities.load.enabled,false);assert.match(catalog.capabilities.load.reason,/PW_ROUTER_URL/);
    assert.equal(catalog.capabilities.unload.enabled,false);
    assert.match(catalog.capabilities.start.reason,/PW_ROUTER_URL/);
    assert.match(JSON.stringify(await call('providers/overview')),/PW_ROUTER_URL/);
    app.lifecycle.locked=true;catalog=(await call('providers/'+p.id+'/catalog')).data;
    assert.equal(catalog.capabilities.busy,true);assert.match(catalog.capabilities.start.reason,/执行/);
    app.lifecycle.locked=false;
    const api=(await call('providers',{name:'回环兼容 API',protocol:'openai',baseUrl:'http://127.0.0.1:8080/v1',model:'m'})).data;
    const overview=(await call('providers/overview')).data.items.find(x=>x.id===api.id);
    assert.equal(overview.local,false);assert.equal(Object.values(overview.capabilities).filter(v=>typeof v==='object').every(v=>!v.enabled),true);
  }finally{await app.close();}
});

test('独立 llama 能力按文件配置判断，配置完整时离线仍允许启动和加载',()=>{
  const root=directory(),exe=path.join(root,'llama-server.exe'),gguf=path.join(root,'model.gguf');writeFileSync(exe,'');writeFileSync(gguf,'');
  const lifecycle=new Lifecycle(root),provider={id:'standalone',protocol:'llama',baseUrl:'http://127.0.0.1:18443/v1',model:'offline-model',exePath:exe,modelPath:gguf,mmprojPath:''};
  const caps=lifecycle.capabilities(provider);assert.equal(caps.start.enabled,true);assert.equal(caps.load.enabled,true);
  assert.equal(caps.unload.enabled,false);assert.match(caps.unload.reason,/控制权/);
  const missing=lifecycle.capabilities({...provider,modelPath:path.join(root,'missing.gguf')});assert.equal(missing.start.enabled,false);assert.match(missing.start.reason,/GGUF/);assert.equal(missing.load.enabled,false);
  const noModel=lifecycle.capabilities({...provider,model:''});assert.equal(noModel.start.enabled,false);assert.match(noModel.start.reason,/模型 ID/);
  const external=lifecycle.capabilities(provider,{online:true});assert.equal(external.start.enabled,false);assert.match(external.start.reason,/已运行/);assert.equal(external.load.enabled,false);assert.match(external.load.reason,/不是工作台启动/);
  const router=lifecycle.capabilities({...provider,id:'router',protocol:'router',baseUrl:(process.env.PW_ROUTER_URL||'http://127.0.0.1:18180').replace(/\/v1\/?$/,'')+'/v1',exePath:'',modelPath:''},{online:true});assert.equal(router.start.enabled,false);assert.match(router.start.reason,/已运行/);assert.equal(router.load.enabled,true);
  const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=()=>child.emit('exit',0);const ownedLifecycle=new Lifecycle(root,{spawnProcess:()=>child});ownedLifecycle.spawnOwned(provider,['--fake'],{});ownedLifecycle.observe(provider,true);assert.equal(ownedLifecycle.capabilities(provider).start.enabled,false);child.kill();assert.equal(ownedLifecycle.capabilities(provider).start.enabled,true);
  const twin={...provider,id:'twin'};ownedLifecycle.owned.add(ownedLifecycle.key(provider));ownedLifecycle.children.set(provider.id,child);assert.equal(ownedLifecycle.capabilities(twin).unload.enabled,false);
  child.stdout.destroy();child.stderr.destroy();
});

test('启动成功后同步并持久化实时目录，失败时保留原本地文件目录',async()=>{
  const upstream=http.createServer((req,res)=>{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({data:[{id:'Live/Model'}]}));});await new Promise(r=>upstream.listen(0,'127.0.0.1',r));
  const dataDir=directory(),lifecycle=new Lifecycle(dataDir);let fail=false;lifecycle.start=async()=>{if(fail)throw Error('模拟启动失败');return {online:true};};lifecycle.load=async()=>({online:true,models:[{id:'Loaded/Model',status:'loaded'}],loaded:['Loaded/Model']});
  const app=await createWorkbench({port:0,dataDir,lifecycle}),call=await client(app);
  try{
    const p=(await call('providers',{name:'启动同步',protocol:'router',baseUrl:'http://127.0.0.1:'+upstream.address().port+'/v1',model:'selected'})).data;
    app.store.put('modelLists',{id:p.id,models:[{id:'File/Model'}],source:'local-file',checkedAt:new Date().toISOString()});
    assert.equal((await call('providers/'+p.id+'/start',{})).status,200);
    let catalog=(await call('providers/'+p.id+'/catalog')).data;assert.equal(catalog.models.some(m=>m.id==='Live/Model'&&m.source==='upstream'),true);assert.equal(catalog.models.some(m=>m.id==='File/Model'),false);
    app.store.put('modelLists',{id:p.id,models:[{id:'File/Model'}],source:'local-file',checkedAt:new Date().toISOString()});assert.equal((await call('providers/'+p.id+'/load',{})).status,200);catalog=(await call('providers/'+p.id+'/catalog')).data;assert.equal(catalog.models.some(m=>m.id==='Loaded/Model'&&m.source==='upstream'),true);assert.equal(catalog.models.some(m=>m.id==='File/Model'),false);
    app.store.put('modelLists',{id:p.id,models:[{id:'File/Model'}],source:'local-file',checkedAt:new Date().toISOString()});fail=true;
    assert.equal((await call('providers/'+p.id+'/start',{})).status,400);catalog=(await call('providers/'+p.id+'/catalog')).data;assert.equal(catalog.models.some(m=>m.id==='File/Model'&&m.source==='local-file'),true);assert.equal(catalog.models.some(m=>m.id==='Live/Model'),false);
  }finally{await app.close();await new Promise(r=>upstream.close(r));}
});

test('生命周期按钮操作后更新只读检查状态，停止后可再次启动',async()=>{
  const upstream=http.createServer((req,res)=>{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({data:[{id:'Router/Model'}]}));});await new Promise(r=>upstream.listen(0,'127.0.0.1',r));
  const oldUrl=process.env.PW_ROUTER_URL,oldManager=process.env.PW_ROUTER_MANAGER,dataDir=directory();process.env.PW_ROUTER_URL='http://127.0.0.1:'+upstream.address().port;process.env.PW_ROUTER_MANAGER=process.execPath;
  const lifecycle=new Lifecycle(dataDir);let online=false;lifecycle.start=async p=>{online=true;lifecycle.observe(p,true);lifecycle.started.add(p.id);return {online:true};};lifecycle.status=async p=>{lifecycle.observe(p,online);return {online,models:[],loaded:[],startedByWorkbench:online,busy:lifecycle.locked};};lifecycle.unload=async p=>{lifecycle.observe(p,true);return {released:true,verified:true};};lifecycle.stop=async p=>{online=false;lifecycle.observe(p,false);lifecycle.started.delete(p.id);return {stopped:true};};
  let app;
  try{
    app=await createWorkbench({port:0,dataDir,lifecycle});const call=await client(app),p=(await call('providers',{name:'模拟 Router',protocol:'router',baseUrl:process.env.PW_ROUTER_URL+'/v1',model:'Router/Model'})).data;
    assert.equal((await call('providers/'+p.id+'/start',{})).status,200);let caps=(await call('providers/'+p.id+'/catalog')).data.capabilities;assert.equal(caps.start.enabled,false);assert.match(caps.start.reason,/已运行/);
    assert.equal((await call('providers/'+p.id+'/unload',{})).status,200);assert.equal((await call('providers/'+p.id+'/stop',{})).status,200);
    caps=(await call('providers/'+p.id+'/catalog')).data.capabilities;assert.equal(caps.start.enabled,true);assert.equal(caps.stop.enabled,false);
  }finally{await app?.close();await new Promise(r=>upstream.close(r));if(oldUrl===undefined)delete process.env.PW_ROUTER_URL;else process.env.PW_ROUTER_URL=oldUrl;if(oldManager===undefined)delete process.env.PW_ROUTER_MANAGER;else process.env.PW_ROUTER_MANAGER=oldManager;}
});

test('编辑托管Router配置会清除旧服务目录，模型目录只来自重新读取',async()=>{
  const dataDir=directory(),app=await createWorkbench({port:0,dataDir}),call=await client(app);
  try{
    const input={name:'本机 llama.cpp',protocol:'router',managedRouter:true,baseUrl:'http://127.0.0.1:18180/v1',model:'',exePath:path.join(dataDir,'llama-server.exe'),modelsDir:path.join(dataDir,'models')};
    const p=(await call('providers',input)).data;app.store.put('modelLists',{id:p.id,source:'upstream',models:[{id:'old-cache'}]});
    const edited=await call('providers',{...input,id:p.id,name:'已编辑托管Router',expectedUpdatedAt:p.updatedAt});assert.equal(edited.status,200);
    assert.equal(app.store.get('modelLists',p.id),null);const catalog=(await call('providers/'+p.id+'/catalog')).data;assert.deepEqual(catalog.models,[]);
  }finally{await app.close();}
});

test('任务自动释放后生命周期观察转为离线，start再次可用',async()=>{
  const dataDir=directory(),exePath=path.join(dataDir,'llama-server.exe'),modelPath=path.join(dataDir,'selected.gguf');writeFileSync(exePath,'');writeFileSync(modelPath,'');let generated=0;
  const lifecycle=new Lifecycle(dataDir);lifecycle.load=async p=>{lifecycle.owned.add(lifecycle.key(p));lifecycle.observe(p,true);return {online:true};};lifecycle.unload=async p=>{lifecycle.owned.delete(lifecycle.key(p));lifecycle.observe(p,false);return {released:true,verified:true};};
  const app=await createWorkbench({port:0,dataDir,lifecycle,generator:async()=>{generated++;return {output:'完成'};}}),call=await client(app);
  try{
    const p=(await call('providers',{name:'自动释放',protocol:'llama',baseUrl:'http://127.0.0.1:18443/v1',model:'Offline/Model',exePath,modelPath})).data;
    const job=(await call('providers/'+p.id+'/test',{model:p.model,prompt:'离线模拟'})).data;
    for(let i=0;i<100&&app.jobs.active;i++)await new Promise(r=>setTimeout(r,10));
    assert.equal(app.store.get('jobs',job.id).status,'succeeded');assert.equal(generated,1);
    const caps=(await call('providers/'+p.id+'/catalog')).data.capabilities;assert.equal(caps.start.enabled,true);assert.equal(caps.unload.enabled,false);
  }finally{await app.close();}
});

test('目录检查和真实测试分层，刷新失败保留目录，错误脱敏且不自动重发',async()=>{
  let unavailable=false,generated=0;const key='fake-test-secret-1234567890';
  const upstream=http.createServer((req,res)=>{assert.equal(req.headers.authorization,'Bearer '+key);res.writeHead(unavailable?503:200,{'Content-Type':'application/json'});res.end(JSON.stringify(unavailable?{error:{message:'服务失败 '+key}}:{data:[{id:'Model/A',input_modalities:['text','image']}]}));});
  await new Promise(r=>upstream.listen(0,'127.0.0.1',r));const baseUrl='http://127.0.0.1:'+upstream.address().port+'/v1';
  const vault={seal:async v=>'sealed:'+v,open:async v=>v?.slice(7)||''};
  const app=await createWorkbench({port:0,dataDir:directory(),vault,generator:async(p,input)=>{generated++;assert.equal(p.model,'Model/A');assert.equal(input.user,'请回复测试消息');return {output:'模拟测试回复'};}}),call=await client(app);
  try{
    const p=(await call('providers',{name:'隔离服务',baseUrl,protocol:'openai',model:'Model/A',apiKey:key})).data;
    assert.equal(JSON.stringify(p).includes(key),false);
    assert.equal((await call('providers/'+p.id+'/models')).status,200);
    let catalog=(await call('providers/'+p.id+'/catalog')).data;assert.equal(catalog.check.online,true);assert.equal(catalog.models[0].vision,true);assert.equal(catalog.tests.length,0);assert.equal(generated,0);
    unavailable=true;const failed=await call('providers/'+p.id+'/models');assert.equal(failed.status,400);assert.equal(JSON.stringify(failed).includes(key),false);
    catalog=(await call('providers/'+p.id+'/catalog')).data;assert.equal(catalog.models.length,1);assert.equal(catalog.check.httpStatus,503);assert.equal(catalog.check.online,false);assert.equal(JSON.stringify(catalog).includes(key),false);
    const start=await call('providers/'+p.id+'/test',{model:'Model/A',prompt:'请回复测试消息'});assert.equal(start.status,202);
    for(let i=0;i<100&&app.jobs.active;i++)await new Promise(r=>setTimeout(r,10));
    catalog=(await call('providers/'+p.id+'/catalog')).data;assert.equal(generated,1);assert.equal(catalog.tests[0].status,'succeeded');assert.equal(catalog.tests[0].model,'Model/A');assert.equal(catalog.tests[0].currentConfig,true);assert.equal(catalog.tests[0].output,'模拟测试回复');
    assert.equal((await call('providers/'+p.id+'/test',{model:'',prompt:'请回复测试消息'})).status,400);assert.equal(generated,1);
    const current=app.store.get('providers',p.id);app.store.put('providers',{...current,baseUrl:baseUrl+'/changed'});
    catalog=(await call('providers/'+p.id+'/catalog')).data;assert.equal(catalog.check.currentConfig,false);assert.equal(catalog.tests[0].currentConfig,false);
  }finally{await app.close();await new Promise(r=>upstream.close(r));}
});

test('备份拒绝损坏的模型偏好，旧备份仍可恢复，特殊模型ID不污染其他模型',async()=>{
  const app=await createWorkbench({port:0,dataDir:directory()}),call=await client(app);
  try{
    const p=(await call('providers',{name:'测试连接',protocol:'openai',baseUrl:'http://127.0.0.1:9/v1',model:'Model/A'})).data;
    const backup=(await call('export')).data;
    for(const invalid of [null,[],{'Model/A':null},{'Model/A':{vision:'yes'}},Object.fromEntries(Array.from({length:201},(_,i)=>['m'+i,{manual:true}]))]){const broken=structuredClone(backup);broken.providers[0].modelPreferences=invalid;assert.equal((await call('import',broken)).status,400);}
    const saved=(await call('providers/'+p.id+'/model-preferences',{model:'__proto__',manual:true,favorite:true})).data;
    assert.equal(saved.models.find(m=>m.id==='__proto__').favorite,true);assert.equal(saved.models.find(m=>m.id==='Model/A').favorite,false);assert.equal({}.favorite,undefined);
    assert.equal((await call('import',backup)).status,200);
  }finally{await app.close();}
});

test('手动重试连接测试保留诊断身份，配置改变后要求重新选择测试',async()=>{
  let generated=0;const app=await createWorkbench({port:0,dataDir:directory(),generator:async()=>{generated++;if(generated===1)throw Error('模拟测试失败');return {output:'重试成功'};}}),call=await client(app);
  try{
    const p=(await call('providers',{name:'重试服务',protocol:'openai',baseUrl:'http://127.0.0.1:9/v1',model:'Model/A'})).data;
    const first=(await call('providers/'+p.id+'/test',{model:'Model/A',prompt:'请回复测试'})).data;
    for(let i=0;i<100&&app.jobs.active;i++)await new Promise(r=>setTimeout(r,10));
    assert.equal(app.store.get('jobs',first.id).status,'failed');assert.equal(generated,1);
    const retried=await call('jobs/'+first.id+'/retry',{});assert.equal(retried.status,202);assert.equal(retried.data.connectionTest,true);
    for(let i=0;i<100&&app.jobs.active;i++)await new Promise(r=>setTimeout(r,10));
    const catalog=(await call('providers/'+p.id+'/catalog')).data;assert.equal(catalog.tests.length,2);assert.equal(catalog.tests[0].status,'succeeded');assert.equal(catalog.tests[0].currentConfig,true);assert.equal(catalog.tests[0].output,'重试成功');assert.equal(generated,2);
    const current=app.store.get('providers',p.id);app.store.put('providers',{...current,baseUrl:current.baseUrl+'/changed'});
    assert.equal((await call('jobs/'+first.id+'/retry',{})).status,400);assert.equal(generated,2);
  }finally{await app.close();}
});
