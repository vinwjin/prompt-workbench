import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync,mkdtempSync } from 'node:fs';
import path from 'node:path';
import { Store } from '../src/store.js';
import { bulkManage,saveAsset } from '../src/library.js';
import { Sources,parseCSV } from '../src/sources.js';
import { createWorkbench } from '../src/server.js';
import http from 'node:http';
const temp=()=>{mkdirSync('work',{recursive:true});return mkdtempSync(path.resolve('work','collection-'));};

test('CSV 支持多行与双引号；格式变动不静默导入',()=>{
  assert.equal(parseCSV('act,prompt\r\n"名称","第一行\n第二行，""引号"""\r\n')[0].prompt,'第一行\n第二行，“引号”'.replace('“','"').replace('”','"'));
  assert.throws(()=>parseCSV('title,body\na,b'),/格式/);assert.throws(()=>parseCSV('act,prompt\na,"unfinished'),/引号/);
});
test('文件夹、星标与回收站持久保存；清理不改变运行任务；旧备份兼容',()=>{
  const dir=temp();let s=new Store(dir);const f=s.put('folders',{name:'视频'}),a=saveAsset(s,{title:'镜头',content:'慢推',negative:'抖动',folderId:f.id});
  bulkManage(s,'assets',{ids:[a.id],action:'favorite'});assert.equal(s.get('assets',a.id).favorite,true);
  s.put('jobs',{id:'active',status:'running',input:'正在运行',createdAt:new Date().toISOString()});s.put('jobs',{id:'done',status:'succeeded',input:'已完成',createdAt:new Date().toISOString()});
  assert.deepEqual(bulkManage(s,'jobs',{ids:['active','done'],action:'trash'}),{changed:1,skipped:1});assert.equal(s.jobPage().total,1);assert.equal(s.jobPage({trash:true}).jobs[0].id,'done');
  bulkManage(s,'assets',{ids:[a.id],action:'trash'});s.close();s=new Store(dir);assert.ok(s.get('assets',a.id).deletedAt);assert.equal(s.get('folders',f.id).name,'视频');
  bulkManage(s,'assets',{ids:[a.id],action:'restore'});assert.equal(s.get('assets',a.id).negative,'抖动');assert.equal(s.get('assets',a.id).favorite,true);bulkManage(s,'jobs',{ids:['done'],action:'restore'});assert.equal(s.jobPage({status:'succeeded'}).total,1);
  const old=s.export();delete old.folders;assert.doesNotThrow(()=>s.import(old));s.close();
});
test('公开版同步失败保留缓存；受限来源详情不联网，人工内容可读取',async()=>{const s=new Store(temp());let calls=0;const sources=new Sources(s,{fetcher:async()=>{calls++;throw Error('offline');}});try{sources.ingest('shortcut',JSON.stringify([{id:1,zh:{title:'写作',prompt:'正文',remark:'描述'}}]));await assert.rejects(sources.sync('shortcut'),/缓存/);assert.equal(sources.list({source:'shortcut'}).total,1);const before=calls;sources.ingest('mother',JSON.stringify({success:true,result:{total:1,datas:[{id:1,title:'合成画面'}]}}));const id=sources.list({source:'mother'}).items[0].id;await assert.rejects(sources.detail(id),/权限/);assert.equal(calls,before);sources.importFile('mother',{text:'完整的合成测试正文，仅用于本地验证。',fileName:'synthetic.txt'});const row=sources.list({source:'mother'}).items[0];assert.equal((await sources.detail(row.id)).importedFrom,'local-file');assert.equal(calls,before);}finally{await sources.close();s.close();}});

test('公开版受限来源单个及批量同步拒绝且零网络，既有缓存保留',async()=>{const s=new Store(temp());let calls=0;const sources=new Sources(s,{fetcher:async()=>{calls++;throw Error('unexpected');}});try{sources.ingest('mother',JSON.stringify({success:true,result:{total:1,datas:[{id:1,title:'合成记录'}]}}));await assert.rejects(sources.sync('mother'),/权限/);sources.startBatch(['mother','s09','s12','s30']);await sources.batchTask;assert.equal(sources.batchStatus().skipped,4);assert.equal(calls,0);assert.equal(sources.list({source:'mother'}).total,1);}finally{await sources.close();s.close();}});

test('主页面选择的模型进入任务；列表只读不计费；分享收藏去重并保留来源',async()=>{
  let generatedModel='',generations=0;const modelServer=http.createServer((req,res)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({data:[{id:'model-a'},{id:'model-b'}]}));});await new Promise(r=>modelServer.listen(0,'127.0.0.1',r));
  const app=await createWorkbench({port:0,dataDir:temp(),generator:async p=>{generatedModel=p.model;generations++;return {output:'结果'};}});const home=await fetch('http://127.0.0.1:'+app.port);const cookie=home.headers.get('set-cookie').split(';')[0];
  const call=async(route,body)=>{const r=await fetch('http://127.0.0.1:'+app.port+'/api/'+route,{method:body?'POST':'GET',headers:{cookie,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});assert.equal(r.status<400,true,await r.clone().text());return r.json();};
  try{const p=await call('providers',{name:'模型入口',protocol:'openai',baseUrl:'http://127.0.0.1:'+modelServer.address().port+'/v1',model:'model-a'});assert.equal((await call('providers/'+p.id+'/models')).models.length,2);assert.equal(generations,0);
    const j=await call('jobs',{providerId:p.id,templateId:'optimize',model:'model-b',input:'测试'});for(let i=0;i<100&&(await call('jobs/'+j.id)).status!=='succeeded';i++)await new Promise(r=>setTimeout(r,10));assert.equal(generatedModel,'model-b');
    app.sources.ingest('prompts','act,prompt\nSample,Shared text\n');const item=(await call('shared')).items[0];const a=await call('shared/'+item.id+'/collect',{}),b=await call('shared/'+item.id+'/collect',{});assert.equal(a.id,b.id);assert.equal(a.source.license,'CC0-1.0 · 提示词数据');assert.equal(a.content,'Shared text');
    const t=await call('shared/'+item.id+'/template',{});assert.equal(t.source.originId,a.source.originId);assert.equal(t.user,'{{input}}');
    assert.equal((await call('templates',{...t,system:'修改后正文'})).source.license,a.source.license);
    const imported=await call('assets/import',{schema:'prompt-workbench/assets/v1',assets:[a,{title:'新导入',content:'正文',negative:'负向',source:a.source}]});assert.deepEqual(imported,{imported:1,skipped:1});
    assert.deepEqual(await call('assets/import',{schema:'prompt-workbench/assets/v1',assets:[{...a,negative:'另一种负向词'}]}),{imported:1,skipped:0});
    const bad=await fetch('http://127.0.0.1:'+app.port+'/api/assets/import',{method:'POST',headers:{cookie,'Content-Type':'application/json'},body:JSON.stringify({schema:'prompt-workbench/assets/v1',assets:[{title:'不得部分写入',content:'文本'},{title:'无正文'}]})});assert.equal(bad.status,400);assert.ok(!app.store.list('assets').some(a=>a.title==='不得部分写入'));
  }finally{await app.close();await new Promise(r=>modelServer.close(r));}
});

test('保持历史所选模型时，切换与编辑被锁定；手动和关闭释放实际模型',async()=>{
  const released=[];const lifecycle={owned:new Set(),started:new Set(),locked:false,key:p=>p.baseUrl+'|'+p.model,exclusive:fn=>fn(),withModel:async(p,fn,auto)=>{lifecycle.owned.add(lifecycle.key(p));const result=await fn();if(auto)await lifecycle.unload(p);return result;},unload:async p=>{released.push(p.model);lifecycle.owned.delete(lifecycle.key(p));return {released:true,model:p.model};}};
  const app=await createWorkbench({port:0,dataDir:temp(),lifecycle,generator:async()=>({output:'模拟结果'})});const home=await fetch('http://127.0.0.1:'+app.port),cookie=home.headers.get('set-cookie').split(';')[0];
  const call=async(route,b)=>{const r=await fetch('http://127.0.0.1:'+app.port+'/api/'+route,{method:b?'POST':'GET',headers:{cookie,...(b?{'Content-Type':'application/json'}:{})},body:b?JSON.stringify(b):undefined});return {status:r.status,body:await r.json()};};
  try{const p=(await call('providers',{name:'模拟本地',protocol:'router',baseUrl:'http://127.0.0.1:19990/v1',model:'default-a'})).body;
    const run=async()=>{const j=(await call('jobs',{providerId:p.id,templateId:'optimize',model:'history-b',input:'输入',autoUnload:false})).body;for(let i=0;i<100&&(await call('jobs/'+j.id)).body.status!=='succeeded';i++)await new Promise(r=>setTimeout(r,10));};
    await run();assert.equal((await call('providers/'+p.id+'/selection',{model:'third-c'})).status,400);assert.equal((await call('providers',{...p,model:'third-c'})).status,400);
    assert.equal((await call('providers/'+p.id+'/unload',{})).body.model,'history-b');await run();
  }finally{await app.close();}assert.deepEqual(released,['history-b','history-b']);assert.equal(lifecycle.owned.size,0);
});

test('连接地址修改后拒绝旧模型列表响应，不污染新连接缓存',async()=>{
  let received,release;const requestArrived=new Promise(r=>received=r),responseAllowed=new Promise(r=>release=r);
  const upstream=http.createServer(async(req,res)=>{received();await responseAllowed;res.setHeader('Content-Type','application/json');res.end(JSON.stringify({data:[{id:'old-address-model'}]}));});await new Promise(r=>upstream.listen(0,'127.0.0.1',r));
  const app=await createWorkbench({port:0,dataDir:temp()});const home=await fetch('http://127.0.0.1:'+app.port),cookie=home.headers.get('set-cookie').split(';')[0];
  const call=async(route,b)=>fetch('http://127.0.0.1:'+app.port+'/api/'+route,{method:b?'POST':'GET',headers:{cookie,...(b?{'Content-Type':'application/json'}:{})},body:b?JSON.stringify(b):undefined});
  try{const p=await (await call('providers',{name:'原连接',protocol:'openai',baseUrl:'http://127.0.0.1:'+upstream.address().port+'/v1',model:'a'})).json();
    const pending=call('providers/'+p.id+'/models');await requestArrived;assert.equal((await call('providers',{...p,baseUrl:'http://127.0.0.1:19991/v1'})).status,200);release();const r=await pending;assert.equal(r.status,400);assert.match((await r.json()).error,/连接已更改/);assert.equal(app.store.get('modelLists',p.id),null);
  }finally{release();await app.close();await new Promise(r=>upstream.close(r));}
});

test('超大历史清理明确拒绝且零修改，避免静默清理部分记录',async()=>{
  const app=await createWorkbench({port:0,dataDir:temp()});
  try{const put=app.store.db.prepare('INSERT INTO records VALUES(?,?,?,?)');app.store.db.exec('BEGIN');for(let i=0;i<10001;i++)put.run('jobs','large-'+i,JSON.stringify({id:'large-'+i,input:'已结束任务',status:'succeeded'}),'2026-10-07');app.store.db.exec('COMMIT');
    const home=await fetch('http://127.0.0.1:'+app.port),cookie=home.headers.get('set-cookie').split(';')[0];const r=await fetch('http://127.0.0.1:'+app.port+'/api/history/manage',{method:'POST',headers:{cookie,'Content-Type':'application/json'},body:JSON.stringify({all:true,action:'trash',filters:{status:'succeeded'}})});assert.equal(r.status,400);assert.match((await r.json()).error,/10000/);assert.equal(app.store.jobPage().total,10001);assert.equal(app.store.jobPage({trash:true}).total,0);
  }finally{await app.close();}
});
