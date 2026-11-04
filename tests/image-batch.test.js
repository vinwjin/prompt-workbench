import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,readFileSync} from 'node:fs';
import path from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import {randomUUID,createHash} from 'node:crypto';
import {createWorkbench} from './source-fixtures.js';
import {buildGeneration} from '../src/providers.js';
const png=readFileSync('public/icon-256.png'),url='data:image/png;base64,'+png.toString('base64');
const temp=()=>{mkdirSync('work',{recursive:true});return mkdtempSync(path.resolve(process.env.PW_TEST_ROOT||'work','image-batch-test-'));};
async function client(app){const root='http://127.0.0.1:'+app.port,cookie=(await fetch(root)).headers.get('set-cookie').split(';')[0];return async(route,body)=>{const r=await fetch(root+'/api/'+route,{headers:{cookie,...(body?{'Content-Type':'application/json'}:{})},...(body?{method:'POST',body:JSON.stringify(body)}:{})});return {status:r.status,body:await r.json()};};}
async function upload(app,name,bytes=png){const root='http://127.0.0.1:'+app.port,cookie=(await fetch(root)).headers.get('set-cookie').split(';')[0];const r=await fetch(root+'/api/media/upload?name='+encodeURIComponent(name),{method:'POST',headers:{cookie,'Content-Type':'application/octet-stream'},body:bytes});assert.equal(r.status,200);return {uploadId:(await r.json()).uploadId};}
async function ended(app){for(let i=0;i<200;i++){if(!app.jobs.active&&!app.jobs.queue.length)return;await sleep(10);}throw Error('批次未结束');}
function connection(app,protocol='openai'){return app.store.put('providers',{name:'模拟视觉',protocol,baseUrl:'http://127.0.0.1:18180/v1',model:'vision'});}
const lifecycle=verified=>({owned:new Set(),started:new Set(),lastRelease:null,key:p=>p.baseUrl+'|'+p.model,async withModel(p,fn,autoUnload){assert.equal(autoUnload,true);this.lastRelease=null;const r=await fn();this.lastRelease={released:verified,verified,error:verified?undefined:'未确认释放'};return {...r,release:this.lastRelease};}});

test('逐张独立识别及核实释放，原图与正文自动收录；同批重复提交不会再次生成',async()=>{
  const calls=[],app=await createWorkbench({port:0,dataDir:temp(),lifecycle:lifecycle(true),generator:async(p,b)=>{calls.push(b);return {output:'独立图片提示词 '+calls.length};}});
  try{const p=connection(app,'router'),api=await client(app),originals=[png,Buffer.concat([png,Buffer.from('second')])];const items=[];for(let i=0;i<2;i++)items.push({media:await upload(app,'图'+i+'.png',originals[i]),dataUrl:'data:image/png;base64,'+originals[i].toString('base64')});
    const body={requestId:randomUUID(),providerId:p.id,model:p.model,input:'只描述当前图',items};const r=await api('image-batch',body);assert.equal(r.status,202);await ended(app);
    assert.equal(calls.length,2);for(const c of calls){assert.equal(c.images.length,1);assert.equal(c.freshContext,true);assert.equal(c.autoUnload,true);assert.ok(!c.user.includes('独立图片提示词'));}
    const jobs=app.store.list('jobs'),assets=app.store.list('assets');assert.equal(assets.length,2);assert.ok(jobs.every(j=>j.status==='succeeded'&&j.contextReset.verified&&j.archiveAssetId));
    for(const j of jobs){const a=assets.find(a=>a.id===j.archiveAssetId);assert.equal(a.content,j.output);assert.deepEqual(a.media,j.originalMedia);assert.deepEqual(readFileSync(app.assetMedia.file(a.media[0].id)),originals[Number(a.media[0].name[1])]);}
    assert.equal((await api('image-batch',body)).status,202);await ended(app);assert.equal(calls.length,2);const status=await api('image-batch/'+body.requestId);assert.ok(status.body.jobs.every(j=>!j.images&&!j.compiled&&!j.output));
    const backup=(await api('export')).body;assert.equal(backup.mediaFiles.length,2);const restored=await createWorkbench({port:0,dataDir:temp()});try{const restore=await client(restored);assert.equal((await restore('import',backup)).status,200);assert.equal(restored.store.list('assets').length,2);assert.equal(restored.store.list('jobs').length,2);}finally{await restored.close();}
  }finally{await app.close();}
});

test('全批预验证拒绝无效图片，释放未确认停止后续且不收录',async()=>{
  let count=0;const app=await createWorkbench({port:0,dataDir:temp(),lifecycle:lifecycle(false),generator:async()=>{count++;return {output:'未释放的模拟提示词'};}});
  try{const p=connection(app,'router'),api=await client(app),media=await upload(app,'保留.png'),body={requestId:randomUUID(),providerId:p.id,input:'读图',items:[{media,dataUrl:url},{media,dataUrl:'invalid'}]};assert.equal((await api('image-batch',body)).status,400);assert.equal(app.store.list('jobs').length,0);assert.equal(count,0);
    body.items[1].dataUrl=url;assert.equal((await api('image-batch',body)).status,202);await ended(app);assert.equal(count,1);assert.equal(app.store.list('assets').length,0);assert.deepEqual(app.store.list('jobs').map(j=>j.status).sort(),['cancelled','failed']);assert.ok(app.store.list('jobs').find(j=>j.status==='failed').partialOutput);
  }finally{await app.close();}
});

test('收录失败保留成功结果，仅重试保存不重发识别；失败原图可跨库备份',async()=>{
  let count=0;const app=await createWorkbench({port:0,dataDir:temp(),generator:async()=>{count++;return {output:'已识别的画面提示词'};}});
  try{const p=connection(app),api=await client(app),media=await upload(app,'原图.png');app.jobs.onSuccess=()=>{throw Error('模拟保存失败');};
    const r=await api('image-batch',{requestId:randomUUID(),providerId:p.id,input:'读图',items:[{media,dataUrl:url}]});assert.equal(r.status,202);await ended(app);const job=app.store.list('jobs')[0];assert.equal(job.status,'succeeded');assert.ok(job.archiveError);assert.equal(app.store.list('assets').length,0);const backup=(await api('export')).body;assert.equal(backup.mediaFiles.length,1);assert.equal(backup.mediaFiles[0].id,createHash('sha256').update(png).digest('hex'));
    assert.equal((await api('jobs/'+job.id+'/archive',{})).status,200);assert.equal(count,1);assert.equal(app.store.list('assets').length,1);assert.equal((await api('jobs/'+job.id+'/archive',{})).status,200);assert.equal(app.store.list('assets').length,1);
  }finally{await app.close();}
});

test('本地禁用提示缓存，所有协议请求只带当前图片与独立消息',()=>{
  for(const protocol of ['router','llama','ollama','openai','anthropic','gemini']){const cfg=buildGeneration({protocol,baseUrl:'http://127.0.0.1:18180/v1',model:'vision'},{system:'系统',user:'当前图',images:[{dataUrl:url}],freshContext:true,autoUnload:true});if(['router','llama'].includes(protocol))assert.equal(cfg.body.cache_prompt,false);if(protocol==='ollama'){assert.equal(cfg.body.keep_alive,0);assert.equal(cfg.body.messages.length,2);}if(protocol==='openai')assert.equal(cfg.body.messages.length,2);assert.ok(!JSON.stringify(cfg.body).includes('previous_response_id'));}
});

test('用户停止本批取消正在运行及排队项，保留原图与历史，不自动继续',async()=>{
  let release,count=0;const app=await createWorkbench({port:0,dataDir:temp(),generator:async()=>{count++;await new Promise(r=>release=r);return {output:'已取消任务的模拟结果'};}});
  try{const p=connection(app),api=await client(app),media=await upload(app,'取消原图.png'),body={requestId:randomUUID(),providerId:p.id,input:'读图',items:[{media,dataUrl:url},{media,dataUrl:url}]};assert.equal((await api('image-batch',body)).status,202);for(let i=0;i<100&&!release;i++)await sleep(10);assert.ok(release);assert.equal((await api('image-batch/'+body.requestId+'/cancel',{})).status,200);release();await ended(app);assert.equal(count,1);assert.ok(app.store.list('jobs').every(j=>j.status==='cancelled'));assert.equal(app.store.list('assets').length,0);assert.equal((await api('export')).body.mediaFiles.length,1);
  }finally{release?.();await app.close();}
});

test('本张未取得生命周期锁不能沿用前张释放证明，立即停止余下批项',async()=>{
  const manager=lifecycle(true);manager.lastRelease={verified:true};manager.withModel=async()=>{throw Error('模型生命周期正在操作');};let calls=0;
  const app=await createWorkbench({port:0,dataDir:temp(),lifecycle:manager,generator:async()=>{calls++;return {output:'不应生成'};}});
  try{const p=connection(app,'router'),api=await client(app),media=await upload(app,'锁冲突.png');assert.equal((await api('image-batch',{requestId:randomUUID(),providerId:p.id,input:'读图',items:[{media,dataUrl:url},{media,dataUrl:url}]})).status,202);await ended(app);assert.equal(calls,0);assert.deepEqual(app.store.list('jobs').map(j=>j.status).sort(),['cancelled','failed']);assert.equal(app.store.list('jobs').find(j=>j.status==='failed').release,null);
  }finally{await app.close();}
});

test('收录关联写入失败整体回滚，成功任务保留待收录状态；恢复后的任务原图不会被暂存清理删除',async()=>{
  const app=await createWorkbench({port:0,dataDir:temp(),generator:async()=>({output:'可恢复的识别结果'})});
  try{const p=connection(app),api=await client(app),media=await upload(app,'关联.png'),put=app.store.put.bind(app.store);let fail=true;app.store.put=(kind,value)=>{if(fail&&kind==='jobs'&&value.archiveAssetId){fail=false;throw Error('模拟关联落库失败');}return put(kind,value);};
    await api('image-batch',{requestId:randomUUID(),providerId:p.id,input:'读图',items:[{media,dataUrl:url}]});await ended(app);assert.equal(app.store.list('assets').length,0);const job=app.store.list('jobs')[0];assert.equal(job.status,'succeeded');assert.equal(job.archivePending,true);assert.ok(job.archiveError);
    const backup=(await api('export')).body,restored=await createWorkbench({port:0,dataDir:temp()});try{const restore=await client(restored),pending=await upload(restored,'暂存同图.png');assert.equal((await restore('import',backup)).status,200);restored.assetMedia.discard(pending.uploadId);assert.deepEqual(readFileSync(restored.assetMedia.file(job.originalMedia[0].id)),png);assert.equal((await restore('jobs/'+job.id+'/archive',{})).status,200);assert.equal(restored.store.list('assets').length,1);assert.equal(restored.store.get('jobs',job.id).archivePending,false);}finally{await restored.close();}
  }finally{await app.close();}
});

test('20张满批的手动重试仍出现在同批状态中，不遗漏第21条任务',async()=>{
  let calls=0;const app=await createWorkbench({port:0,dataDir:temp(),generator:async()=>({output:'模拟读图结果 '+(++calls)})});
  try{const p=connection(app),api=await client(app),media=await upload(app,'满批.png'),requestId=randomUUID();const r=await api('image-batch',{requestId,providerId:p.id,input:'读图',items:Array.from({length:20},()=>({media,dataUrl:url}))});assert.equal(r.status,202);await ended(app);const id=r.body.jobs[19].id;assert.equal((await api('jobs/'+id+'/retry',{})).status,202);await ended(app);const rows=(await api('image-batch/'+requestId)).body.jobs;assert.equal(rows.length,21);assert.equal(calls,21);assert.ok(rows.every(j=>j.archiveAssetId));
  }finally{await app.close();}
});
