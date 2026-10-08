import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync} from 'node:fs';
import path from 'node:path';
import {createWorkbench} from '../src/server.js';
import {saveAsset,bulkManage} from '../src/library.js';
import {saveTemplate} from '../src/template-studio.js';

async function fixture(){
  mkdirSync('work',{recursive:true});
  const app=await createWorkbench({port:0,dataDir:mkdtempSync(path.resolve('work','refinement-')),generator:async()=>({output:'模拟正文'})});
  const root='http://127.0.0.1:'+app.port,cookie=(await fetch(root)).headers.get('set-cookie').split(';')[0];
  const call=async(route,b,method)=>{const r=await fetch(root+'/api/'+route,{method:method||(b?'POST':'GET'),headers:{cookie,...(b?{'Content-Type':'application/json'}:{})},body:b?JSON.stringify(b):undefined});return {status:r.status,data:await r.json()};};
  return {app,call};
}

test('X再次收藏恢复原有回收站资产而不覆盖编辑；广场同源收藏也恢复原记录',async()=>{
  const {app,call}=await fixture();try{
    const id='1923016036120658122';app.store.put('inbox',{id,posts:[{id,text:'原文',images:[],sourceUrl:'https://x.com/artist/status/'+id,author:'artist'}]});
    const a=app.inbox.collect(id,{postId:id,title:'收藏',content:'我的编辑'});bulkManage(app.store,'assets',{ids:[a.id],action:'trash'});
    const restored=app.inbox.collect(id,{postId:id,title:'新标题',content:'原文'});assert.equal(restored.id,a.id);assert.equal(restored.deletedAt,null);assert.equal(restored.content,'我的编辑');
    app.sources.ingest('shortcut',JSON.stringify([{id:1,zh:{title:'社区',prompt:'原文'}}]));const item=app.sources.list().items[0];
    const shared=(await call('shared/'+item.id+'/collect',{})).data;saveAsset(app.store,{...shared,content:'改写'});bulkManage(app.store,'assets',{ids:[shared.id],action:'trash'});
    const again=(await call('shared/'+item.id+'/collect',{})).data;assert.equal(again.id,shared.id);assert.equal(again.content,'改写');assert.equal(again.deletedAt,null);
  }finally{await app.close();}
});

test('失效/回收站编辑拒绝，旧表单不能覆盖新正文；任务收藏去重',async()=>{
  const {app}=await fixture();try{
    const a=saveAsset(app.store,{title:'记录',content:'一'});saveAsset(app.store,{...a,content:'二'});
    assert.throws(()=>saveAsset(app.store,{...a,expectedUpdatedAt:a.updatedAt,content:'旧表单'}),/更改/);
    bulkManage(app.store,'assets',{ids:[a.id],action:'trash'});assert.throws(()=>saveAsset(app.store,{id:a.id,title:'记录',content:'三'}),/回收站/);
    assert.throws(()=>saveAsset(app.store,{id:'gone',title:'失效',content:'正文'}),/不存在/);
    app.store.put('jobs',{id:'done',status:'succeeded',output:'成果'});const one=saveAsset(app.store,{title:'成果',content:'成果',resultJobId:'done'}),two=saveAsset(app.store,{title:'成果',content:'成果',resultJobId:'done'});assert.equal(one.id,two.id);
  }finally{await app.close();}
});

test('模板删除进入统一回收站可恢复；永久删除仅允许回收站及明确确认',async()=>{
  const {app,call}=await fixture();try{
    const t=saveTemplate(app.store,{name:'可恢复',system:'系统',user:'{{input}}'});
    assert.equal((await call('templates/'+t.id,null,'DELETE')).status,200);assert.ok(app.store.get('templates',t.id).deletedAt);
    assert.ok(!(await call('state')).data.templates.some(x=>x.id===t.id));
    assert.ok((await call('trash')).data.items.some(x=>x.id===t.id&&x.kind==='templates'));
    assert.equal((await call('trash/manage',{kind:'templates',ids:[t.id],action:'restore'})).status,200);
    assert.equal((await call('trash/manage',{kind:'templates',ids:[t.id],action:'purge',confirmation:'永久删除'})).status,400);
    await call('templates/'+t.id,null,'DELETE');assert.equal((await call('trash/manage',{kind:'templates',ids:[t.id],action:'purge'})).status,400);
    assert.equal((await call('trash/manage',{kind:'templates',ids:[t.id],action:'purge',confirmation:'永久删除'})).status,200);assert.equal(app.store.get('templates',t.id),null);
  }finally{await app.close();}
});

test('批量任务与模板导入预验证整批原子性；数据诊断不含凭据',async()=>{
  const {app,call}=await fixture();try{
    const p=(await call('providers',{name:'模拟',protocol:'openai',baseUrl:'http://127.0.0.1:19991/v1',model:'mock'})).data;
    const template=saveTemplate(app.store,{name:'必填',system:'系统',user:'{{input}} {{required}}'});
    assert.equal((await call('batch',{providerId:p.id,templateId:template.id,inputs:['一','二']})).status,400);assert.equal(app.store.list('jobs').length,0);
    const before=app.store.list('templates').length;assert.equal((await call('templates/import',{schema:'prompt-workbench/templates/v1',templates:[{name:'合法',system:'系统',user:'{{input}}'},{name:'坏',system:42,user:'正文'}]})).status,400);assert.equal(app.store.list('templates').length,before);
    const data=(await call('database')).data;assert.equal(data.integrity,'ok');assert.ok(data.counts);assert.ok(!JSON.stringify(data).includes('sealedKey'));
  }finally{await app.close();}
});

test('轻量进度显示部分正文与阶段，不携带输入图片；失败和取消保留部分且不重试',async()=>{
 const {app,call}=await fixture();try{
  const p=app.store.put('providers',{id:'progress',name:'进度服务',protocol:'openai',baseUrl:'http://127.0.0.1:9999',model:'mock'});let calls=0,fail;
  app.jobs.generator=async(p,input,signal)=>{calls++;input.onProgress('部分正文');await new Promise((resolve,reject)=>{fail=()=>reject(Error('流意外中断'));signal.addEventListener('abort',()=>reject(Error('已取消')),{once:true});});};
  const start=await call('jobs',{providerId:p.id,templateId:'optimize',input:'私有输入',stream:true});while(!fail)await new Promise(r=>setTimeout(r,10));const progress=await call('progress?id='+start.data.id);assert.equal(progress.data.job.phase,'generating');assert.equal(progress.data.job.partialOutput,'部分正文');assert.equal(progress.data.job.input,undefined);assert.equal(progress.data.job.images,undefined);assert.ok(progress.data.job.metrics.firstTextMs>0);const full=await call('state');assert.ok(JSON.stringify(progress.data).length<JSON.stringify(full.data).length);fail();while(app.jobs.active)await new Promise(r=>setTimeout(r,10));assert.equal(app.store.get('jobs',start.data.id).status,'failed');assert.equal(app.store.get('jobs',start.data.id).partialOutput,'部分正文');assert.equal(calls,1);
  fail=null;const second=await call('jobs',{providerId:p.id,templateId:'optimize',input:'取消测试',stream:true});while(!fail)await new Promise(r=>setTimeout(r,10));await call('jobs/'+second.data.id+'/cancel',{});while(app.jobs.active)await new Promise(r=>setTimeout(r,10));assert.equal(app.store.get('jobs',second.data.id).status,'cancelled');assert.equal(calls,2);
  await call('draft',{temperature:0,maxTokens:2048,stream:false,input:'保存'});assert.equal((await call('state')).data.draft.temperature,0);
 }finally{await app.close();}
});

test('永久删除收藏解除采集关联，恢复原帖仍可再次收藏；不删除其他收藏',async()=>{
 const {app,call}=await fixture();try{const id='1923016036120658130';app.store.put('inbox',{id,status:'pending',posts:[{id,text:'保留原帖',images:[],sourceUrl:'https://x.com/artist/status/'+id}]});const a=app.inbox.collect(id,{postId:id,title:'旧收藏',content:'正文'});const other=saveAsset(app.store,{title:'其他收藏',content:'不受影响'});bulkManage(app.store,'assets',{ids:[a.id],action:'trash'});assert.equal((await call('trash/manage',{kind:'assets',ids:[a.id],action:'purge',confirmation:'永久删除'})).status,200);const item=app.store.get('inbox',id);assert.equal(item.status,'pending');assert.equal(item.assetId,null);assert.equal(item.posts[0].text,'保留原帖');assert.ok(app.store.get('assets',other.id));const recollect=app.inbox.collect(id,{postId:id,title:'重新收藏',content:'正文'});assert.notEqual(recollect.id,a.id);assert.equal(app.store.get('inbox',id).assetId,recollect.id);}finally{await app.close();}
});
