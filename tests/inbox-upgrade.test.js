import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync} from 'node:fs';
import path from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import {Store} from '../src/store.js';
import {XInbox} from '../src/x-inbox.js';
import {InboxQueue} from '../src/inbox-queue.js';
import {postMetadata} from '../src/x-metadata.js';
const temp=()=>{mkdirSync('work',{recursive:true});return mkdtempSync(path.resolve(process.env.PW_TEST_ROOT||'work','inbox-upgrade-'));};
const id='1923016036120658122',url='https://x.com/artist/status/'+id;
const post=(text='Prompt: 保留光照和构图。',likes=0)=>({id,text,author:{screen_name:'artist'},created_timestamp:1700000000,likes,reposts:0,replies:0,quotes:0,views:null,lang:'zh',media:{photos:[],videos:[{url:'https://video.twimg.com/amplify_video/123/vid/avc1/1920x1080/result.mp4?tag=29'}]}});

test('原帖刷新保留发布时间/收录时间与人工收藏，正文hash和统计变化独立',async()=>{
  const store=new Store(temp());let text='原文提示词：完整的光照与构图要求。',likes=0,calls=0;const inbox=new XInbox(store,{fetcher:async()=>{calls++;return new Response(JSON.stringify({code:200,status:post(text,likes),thread:[]}));}});
  try{const a=await inbox.capture(url);assert.equal(a.metrics.likes,0);assert.equal(a.metrics.views,null);assert.equal(a.growth,null);assert.equal(a.videos.length,1);const asset=inbox.collect(id,{postId:id,title:'个人修订',content:'人工整理正文'});const captured=a.capturedAt,hash=a.contentHash;likes=12;const b=await inbox.capture(url,{refresh:true});assert.equal(b.capturedAt,captured);assert.equal(b.publishedAt,a.publishedAt);assert.equal(b.contentHash,hash);assert.equal(b.metrics.likes,12);assert.equal(b.metricHistory.length,2);text='作者更新后的正文';const c=await inbox.capture(url,{refresh:true});assert.notEqual(c.contentHash,hash);assert.equal(store.get('assets',asset.id).content,'人工整理正文');await inbox.capture(url);assert.equal(calls,3);
  }finally{store.close();}
});

test('趋势要求同来源24小时基线，未知/计数下降不伪造增速，历史有界',()=>{
  const previous={metricHistory:[{provider:'fxembed',at:'2026-10-11T00:00:00Z',metrics:{likes:0,reposts:0,replies:0,quotes:0,views:10}}]};const p={...post(),views:40};const a=postMetadata(p,previous,'2026-10-12T00:00:00Z');assert.equal(a.growth.views,30);assert.equal(a.growth.hours,24);assert.equal(postMetadata({...p,views:null},previous,'2026-10-12T00:00:00Z').growth,null);assert.equal(postMetadata({...p,views:9},previous,'2026-10-12T00:00:00Z').growth,null);assert.equal(postMetadata(p,previous,'2026-10-11T12:00:00Z').growth,null);assert.equal(postMetadata(p,{metricHistory:previous.metricHistory.map(s=>({...s,provider:'other'}))},'2026-10-12T00:00:00Z').growth,null);assert.equal(postMetadata(p,{metricHistory:Array(35).fill(previous.metricHistory[0])},'2026-10-12T00:00:00Z').metricHistory.length,30);assert.equal(postMetadata({...p,likes:undefined}).heat,null);
});

test('持久队列停止保留已完成项，失败单独重试，重启和导入不自动执行',async()=>{
  const dir=temp();let store=new Store(dir),release,calls=[];const inbox={busy:new Set(),capture:async u=>{calls.push(u);if(u===url)await new Promise(r=>release=r);return {id};}};let queue=new InboxQueue(store,inbox);
  try{const two='https://x.com/artist/status/1923016036120658123';const b=queue.start({urls:[url,two,url]});assert.equal(b.items.length,2);queue.cancel(b.id);release();await queue.work;assert.deepEqual(queue.status(b.id).items.map(i=>i.status),['succeeded','cancelled']);assert.equal(calls.length,1);
    const retry=queue.retry(b.id);await queue.work;assert.equal(queue.status(retry.id).items[0].status,'succeeded');assert.deepEqual(calls,[url,two]);store.put('inboxBatches',{id:'interrupted-fixture',status:'running',items:[{id,url,status:'running'}]});const exported=store.export();store.close();store=new Store(dir);queue=new InboxQueue(store,inbox);assert.equal(queue.status('interrupted-fixture').status,'interrupted');assert.equal(calls.length,2);const restore=new Store(temp());try{restore.import(exported);assert.equal(restore.get('inboxBatches','interrupted-fixture').status,'interrupted');}finally{restore.close();}
  }finally{store.close();}
});

test('队列整批验证、缓存去重、失败水位和关闭不丢已成功记录',async()=>{
  const store=new Store(temp());let calls=0,fail=true;const inbox=new XInbox(store,{fetcher:async u=>{calls++;if(fail&&u.endsWith('3'))return new Response('',{status:429});return new Response(JSON.stringify({code:200,status:{...post(),id:u.split('/').pop()},thread:[]}));}});const queue=new InboxQueue(store,inbox);
  try{assert.throws(()=>queue.start({urls:[url,'https://evil.test/']}));assert.equal(calls,0);const b=queue.start({urls:[url,'https://x.com/artist/status/1923016036120658123']});await queue.work;assert.equal(queue.status(b.id).items[1].status,'failed');assert.equal(store.list('inbox').length,1);fail=false;queue.retry(b.id);await queue.work;assert.equal(store.list('inbox').length,2);assert.equal(calls,3);queue.start({urls:[url]});await queue.work;assert.equal(calls,3);await queue.close();
  }finally{store.close();}
});

test('SQL卡片分页只返回摘要、搜索覆盖完整原文，未知热度排在真实零之后',()=>{
  const store=new Store(temp());try{for(let n=0;n<121;n++){const pid=String(BigInt(id)+BigInt(n));store.put('inbox',{id:pid,url:'https://x.com/artist/status/'+pid,author:'artist',posts:[{id:pid,text:'a'.repeat(4000)+'全文命中',images:[]}],candidateId:pid,status:'pending',capturedAt:new Date(1700000000000+n).toISOString(),heat:n===0?null:n===1?0:n});}const first=store.inboxPage();assert.equal(first.total,121);assert.equal(first.items.length,50);assert.equal(store.inboxPage({offset:100}).items.length,21);assert.equal(store.inboxPage({query:'全文命中'}).total,121);assert.ok(first.items.every(i=>!i.posts&&!i.metricHistory&&i.excerpt.length<=300));const heat=store.inboxPage({sort:'heat',offset:119});assert.deepEqual(heat.items.map(i=>i.heat),[0,null]);assert.ok(Buffer.byteLength(JSON.stringify(first))<256*1024);}
  finally{store.close();}
});

test('慢刷新不会覆盖期间新建的收藏关联，全量清理跨页但保留个人资产',async()=>{
  const store=new Store(temp());let release,hold=false;const inbox=new XInbox(store,{fetcher:async()=>{if(hold)await new Promise(r=>release=r);return new Response(JSON.stringify({code:200,status:post(),thread:[]}));}});
  try{await inbox.capture(url);hold=true;const pending=inbox.capture(url,{refresh:true});const a=inbox.collect(id,{postId:id,title:'期间收藏',content:'人工确认正文'});release();await pending;assert.equal(store.get('inbox',id).assetId,a.id);assert.equal(store.get('inbox',id).status,'collected');assert.equal(inbox.collect(id,{postId:id,title:'不应重复',content:'新正文'}).id,a.id);assert.equal(store.list('assets').length,1);
    for(let n=1;n<=60;n++)store.put('inbox',{...store.get('inbox',id),id:String(BigInt(id)+BigInt(n))});assert.equal(store.inboxPage().items.length,50);assert.equal(inbox.manage({allCollected:true,action:'trash'}).changed,61);assert.equal(store.inboxPage().total,0);assert.equal(store.get('assets',a.id).content,'人工确认正文');
  }finally{store.close();}
});
