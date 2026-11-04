import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,writeFileSync,symlinkSync,unlinkSync} from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {Store} from '../src/store.js';
import {DataOperations} from '../src/data-operations.js';
import {StateSnapshot} from '../src/state-snapshot.js';
import {createWorkbench} from './source-fixtures.js';

function directory(){const root=path.resolve(process.env.PW_TEST_ROOT||'work');mkdirSync(root,{recursive:true});return mkdtempSync(path.join(root,'data-operations-'));}
test('运维概览分开私人素材与公共缓存，只有统计且不执行生成或维护',async()=>{
  const store=new Store(directory()),ops=new DataOperations(store);try{
    store.put('providers',{id:'private-provider',protocol:'openai',sealedKey:'secret-must-never-appear',name:'private-name'});store.put('assets',{id:'a',title:'private-title',content:'private-content'});
    mkdirSync(path.join(store.dir,'media','assets'),{recursive:true});writeFileSync(path.join(store.dir,'media','assets','x.bin'),Buffer.alloc(13));mkdirSync(path.join(store.dir,'cache','plaza-images'),{recursive:true});writeFileSync(path.join(store.dir,'cache','plaza-images','x.bin'),Buffer.alloc(27));
    const before=store.db.prepare('PRAGMA data_version').get().data_version,r=await ops.overview();assert.equal(r.privateMedia.bytes,13);assert.equal(r.publicCache.bytes,27);assert.equal(r.records.find(x=>x.kind==='assets').count,1);assert.ok(r.database.mainBytes>0);assert.ok(r.database.walBytes>0);assert.ok(r.backups.length>0);assert.doesNotMatch(JSON.stringify(r),/private-title|private-content|private-name|secret-must-never-appear/);assert.equal(store.db.prepare('PRAGMA data_version').get().data_version,before);
  }finally{store.close();}
});
test('原生一致性快照包含WAL中已提交记录，快照下载拒绝路径与目录链接',async()=>{
  const store=new Store(directory()),ops=new DataOperations(store);try{
    store.put('assets',{id:'committed-in-wal',content:'must survive backup'});const pending=ops.snapshot();await assert.rejects(ops.snapshot(),/正在保存/);const r=await pending;const copy=new DatabaseSync(ops.snapshotFile(r.name),{readOnly:true});try{assert.equal(JSON.parse(copy.prepare("SELECT body FROM records WHERE kind='assets' AND id='committed-in-wal'").get().body).content,'must survive backup');assert.equal(copy.prepare('PRAGMA quick_check').get().quick_check,'ok');}finally{copy.close();}assert.equal(r.includesMedia,false);assert.equal(r.includesEncryptedCredentials,true);assert.throws(()=>ops.snapshotFile('../workbench.sqlite'),/无效/);assert.throws(()=>ops.snapshotFile('snapshot-1234567890123-12345678.sqlite%2F..'),/无效/);
    const other=directory();const link=path.join(store.dir,'linked-data');symlinkSync(other,link,'junction');try{assert.throws(()=>ops.safe(path.join(link,'secret')),/链接/);}finally{unlinkSync(link);}const overview=await ops.overview();assert.equal(overview.snapshots.length,1);
  }finally{await ops.settle();store.close();}
});
test('只保留本功能最多3份快照，拒绝继续创建且不删除历史',async()=>{
  const store=new Store(directory()),ops=new DataOperations(store);try{for(let i=0;i<3;i++)await ops.snapshot();await assert.rejects(ops.snapshot(),/3份/);assert.equal((await ops.overview()).snapshots.length,3);}finally{store.close();}
});
test('显式刷新绕过统计缓存并读到无revision变化的新备份',async()=>{
  const store=new Store(directory()),ops=new DataOperations(store);try{const first=await ops.overview(),revision=store.revision;store.backup();assert.equal(store.revision,revision);assert.equal((await ops.overview()).backups.length,first.backups.length);assert.equal((await ops.overview({fresh:true})).backups.length,first.backups.length+1);}finally{store.close();}
});
test('状态缓存按相关记录失效；资产摘要去修订与导入原文；密钥与任务图片剥离',()=>{
  const store=new Store(directory()),cache=new StateSnapshot(store);try{
    store.put('providers',{id:'p',sealedKey:'hidden',accountCredentials:{token:'hidden'},protocol:'openai'});store.put('jobs',{id:'j',status:'failed',createdAt:new Date().toISOString(),input:'task',images:[{data:'large'}]});store.put('assets',{id:'a',source:{sourceId:'s38'},resultJobId:'j',content:'全文正文',versions:[{content:'版本一'}]});
    let reads=0;const original=store.jobSummaryPage.bind(store);store.jobSummaryPage=(...args)=>{reads++;return original(...args);};const first=cache.get();assert.deepEqual(first.assets,[]);assert.equal(first.assetMeta.total,1);assert.ok(!JSON.stringify(first).includes('全文正文'));assert.equal(first.providers[0].sealedKey,undefined);assert.equal(first.providers[0].accountCredentials,undefined);assert.equal(first.jobs[0].images,undefined);assert.equal(first.jobs[0].output,undefined);assert.equal(first.jobs[0].input,'task');cache.get();assert.equal(reads,1);
    store.put('drafts',{id:'workbench',input:'latest'});store.put('cacheImages',{id:'image',bytes:100});const second=cache.get();assert.equal(second.draft.input,'latest');assert.equal(second.jobs,first.jobs);assert.equal(second.assetMeta,first.assetMeta);assert.equal(reads,1);
    store.put('jobs',{...store.get('jobs','j'),status:'succeeded'});const third=cache.get();assert.equal(reads,2);store.remove('assets','a');assert.equal(cache.get().assetMeta.total,0);  }finally{store.close();}
});
test('运维HTTP需要本机会话，概览与快照无推理，下载真实SQLite而非JSON',async()=>{
  let generated=0;const app=await createWorkbench({port:0,dataDir:directory(),generator:async()=>{generated++;return {output:'unexpected'};}});try{
    const base='http://127.0.0.1:'+app.port;assert.equal((await fetch(base+'/api/database/overview')).status,401);const cookie=(await fetch(base)).headers.get('set-cookie').split(';')[0],headers={cookie};const overview=await (await fetch(base+'/api/database/overview',{headers})).json();assert.ok(overview.database);const r=await fetch(base+'/api/database/snapshots',{method:'POST',headers:{...headers,'content-type':'application/json'},body:'{}'});assert.equal(r.status,200);const snapshot=await r.json();const response=await fetch(base+'/api/database/snapshots/'+snapshot.name,{headers});assert.equal(response.status,200);assert.equal(response.headers.get('content-type'),'application/vnd.sqlite3');assert.equal(Buffer.from(await response.arrayBuffer()).subarray(0,16).toString(),'SQLite format 3\0');assert.equal((await fetch(base+'/api/database/snapshots/invalid',{headers})).status,400);assert.equal(generated,0);
  }finally{await app.close();}
});
test('历史列表摘要兼容筛选/分页/总数/图片数，去 output/compiled/完整 input，详情按需取全文',async()=>{
  const store=new Store(directory());try{
    const longInput='输入'.repeat(40000),longOutput='结果'.repeat(40000);const put=(id,extra)=>{store.put('jobs',{id,status:'succeeded',providerId:'p1',providerName:'服务',model:'m',templateName:'模板',createdAt:new Date().toISOString(),input:longInput,output:longOutput,compiled:{big:'x'.repeat(50000)},images:[{id:'img',type:'image/png',bytes:100,name:'a.png'}],...extra});};
    put('a');put('b',{status:'failed',deletedAt:new Date().toISOString()});put('c',{providerId:'p2'});
    const page=store.jobHistoryPage({limit:100});assert.equal(page.total,2);assert.equal(page.jobs.length,2);
    const j=page.jobs[0];assert.equal(j.output,undefined);assert.equal(j.compiled,undefined);assert.equal(j.images,undefined);assert.equal(j.imageCount,1);assert.equal(j.input.length,130);assert.equal(j.status,'succeeded');
    assert.equal(store.jobHistoryPage({status:'failed'}).total,0);assert.equal(store.jobHistoryPage({status:'failed',trash:true}).total,1);assert.equal(store.jobHistoryPage({providerId:'p2'}).total,1);assert.equal(store.jobHistoryPage({trash:true}).total,1);assert.equal(store.jobHistoryPage({query:'结果'}).total,2);assert.equal(store.jobHistoryPage({query:'结果',trash:true}).total,1);
    assert.equal(store.jobHistoryPage({offset:0,limit:2}).jobs.length,2);assert.equal(store.jobHistoryPage({offset:1,limit:2}).jobs.length,1);
    const full=store.get('jobs','a');assert.equal(full.output,longOutput);assert.equal(full.input,longInput);assert.ok(full.compiled);
  }finally{store.close();}
});
