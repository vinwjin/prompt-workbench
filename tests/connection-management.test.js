import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync} from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {createWorkbench} from './source-fixtures.js';

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
