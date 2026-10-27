import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync} from 'node:fs';
import path from 'node:path';
import {Store} from '../src/store.js';
import {Sources} from './source-fixtures.js';
import {GalleryDiscovery} from '../src/gallery-discovery.js';
import {metadata,day} from '../src/gallery-metadata.js';
import {createWorkbench} from './source-fixtures.js';
import {EXTRA_FEEDS} from '../src/source-catalog.js';
mkdirSync('work',{recursive:true});
const dir=()=>mkdtempSync(path.resolve(process.env.PW_TEST_ROOT||'work','gallery-discovery-'));
const content='A cinematic hotel lobby with natural light and clear circulation. 酒店大堂，电影感，自然采光。';
const row=(id,extra={})=>({id,title:'酒店大堂 '+id,content,frontCover:'https://img.alicdn.com/test.png',author:'Alice',modelHint:'FLUX',publishedAt:'2026-09-12',...extra});
test('广场规则依据与未知值：不把来源收录日期当原帖日期，不猜作者',()=>{
  const m=metadata({content,syncedAt:'2026-10-19T03:00:00Z'});assert.ok(m.purposes.includes('建筑与室内'));assert.ok(m.styles.includes('电影感'));assert.ok(m.evidence.every(e=>content.includes(e.quote)));assert.equal(m.publishedAt,null);assert.equal(m.author,'');assert.equal(m.collectedAt,null);assert.equal(metadata({firstSyncedAt:'2026-10-19T03:00:00Z'}).collectedAt,'2026-10-19');assert.throws(()=>day('2026-02-30'));assert.equal(metadata({content:'不要动漫'}).styles.length,0);
  const feed=EXTRA_FEEDS.find(f=>f.id==='s05');assert.deepEqual(metadata({sourceId:'s05',author:feed.name,modelHint:'原案例模型见出处'}).models,[]);assert.equal(metadata({sourceId:'s05',author:feed.name}).author,'');
});
test('失败批次不沿用上次新增计数',async()=>{
  const store=new Store(dir()),sources=new Sources(store,{fetcher:async()=>{throw Error('本轮读取失败');}});try{store.put('feeds',{id:'mother',lastAdded:42,lastUnchanged:90});sources.startBatch(['mother'],{mode:'incremental'});await sources.batchTask;assert.equal(sources.batchStatus().items[0].added,0);assert.equal(sources.batchStatus().items[0].unchanged,0);}finally{await sources.close();store.close();}
});
test('OpenNana增量失败从当前页续做，既有正文不重取，历史游标独立',async()=>{
  const store=new Store(dir());let fail=true;const pages=[],details=[];
  const post=slug=>({slug,title:slug,media_type:'video',access_type:0,is_unlocked:true,source_url:'https://x.com/artist/status/123',source_name:'Alice',prompts:[{text:content}],images:['https://img.opennana.com/prompts/images/1.jpeg'],video_urls:['https://img.opennana.com/prompts/assets/videos/202603/a.mp4']});
  const sources=new Sources(store,{fetcher:async u=>{const url=new URL(u);if(url.pathname==='/api/prompts'){const page=Number(url.searchParams.get('page'));assert.equal(url.searchParams.get('order'),'DESC');pages.push(page);return Response.json({status:200,data:{items:[{slug:page===1?'new-a':page===2?'new-b':'old',access_type:0}],pagination:{page,limit:100,total:201,has_more:page<3}}});}const slug=url.pathname.split('/').at(-1);details.push(slug);if(slug==='new-b'&&fail)return new Response('',{status:503});return Response.json({status:200,data:post(slug)});}});
  try{sources.ingestRows('s39',[row('old')],'old',201,{incrementalSeen:['old'],nextPage:15,lastPage:14,scanVersion:'free-id-asc-100-v1'});await assert.rejects(sources.sync('s39',{mode:'incremental'}));assert.deepEqual(pages,[1,2]);assert.equal(store.get('feeds','s39').incrementalNextPage,2);assert.equal(store.get('feeds','s39').nextPage,15);assert.equal(store.count('shared'),2);
    fail=false;await sources.sync('s39',{mode:'incremental'});assert.deepEqual(pages,[1,2,2,3]);assert.equal(details.includes('old'),false);assert.equal(store.get('feeds','s39').incrementalNextPage,null);assert.equal(store.get('feeds','s39').nextPage,15);assert.equal(store.count('shared'),3);
  }finally{await sources.close();store.close();}
});
test('广场整理API有会话保护，只读筛选不生成，作者未知可筛选',async()=>{
  let calls=0;const app=await createWorkbench({port:0,dataDir:dir(),generator:async()=>{calls++;throw Error('不应调用');}});try{app.sources.ingestRows('s05',[row('a',{author:''})]);const id=app.sources.galleryList().items[0].id,base='http://127.0.0.1:'+app.port;
    assert.equal((await fetch(base+'/api/gallery/'+id+'/metadata')).status,401);const home=await fetch(base),cookie=home.headers.get('set-cookie').split(';')[0];const response=await fetch(base+'/api/gallery?author=__unknown__',{headers:{cookie}});assert.equal((await response.json()).total,1);assert.equal(calls,0);
    assert.equal((await fetch(base+'/api/gallery/'+id+'/metadata',{method:'POST',headers:{cookie,'Content-Type':'application/json'},body:JSON.stringify({overrides:{styles:['新风格']},revision:''})})).status,200);assert.equal(app.sources.galleryList({style:'新风格'}).total,1);assert.equal(calls,0);
  }finally{await app.close();}
});
test('组合筛选与关键词取交集，日期范围／未知独立，列表不带正文',async()=>{
  const store=new Store(dir()),sources=new Sources(store);try{
    sources.ingestRows('s05',[row('a'),row('b',{title:'产品包装',author:'Bob',modelHint:'SDXL',publishedAt:null,content:'A minimalist product packaging photo with clear materials.'})]);
    const list=sources.galleryList({query:'酒店',model:'FLUX',purpose:'建筑与室内',style:'电影感',author:'ali',from:'2026-09-01',to:'2026-09-30'});assert.equal(list.total,1);assert.equal(list.items[0].content,undefined);assert.ok(list.facets.models.includes('SDXL'));assert.equal(sources.galleryList({model:'SDXL',purpose:'建筑与室内'}).total,0);assert.equal(sources.galleryList({unknownDate:true}).total,1);assert.equal(sources.galleryList({from:'2000-01-01',timeField:'collected'}).total,1+1);assert.equal(sources.galleryList({from:'2026-09-12',to:'2026-09-12'}).total,1);assert.equal(sources.galleryList({sort:'published'}).items[0].metadata.publishedAt,'2026-09-12');assert.equal(sources.galleryList({sort:'published'}).items.at(-1).metadata.publishedAt,null);assert.throws(()=>sources.galleryList({from:'2026-10-19',to:'2026-01-01'}));assert.throws(()=>sources.galleryList({unknownDate:true,from:'2026-01-01'}));assert.equal(sources.galleryCache,undefined);
  }finally{await sources.close();store.close();}
});
test('用户停止增量后当前页不提交，手动续做从同页开始',async()=>{
  const store=new Store(dir());let release,reached,block=true;const hold=new Promise(r=>release=r),started=new Promise(r=>reached=r);const pages=[];
  const sources=new Sources(store,{fetcher:async u=>{const url=new URL(u);if(url.pathname==='/api/prompts'){pages.push(Number(url.searchParams.get('page')));return Response.json({status:200,data:{items:Array.from({length:8},(_,i)=>({slug:'new-'+i,access_type:0})),pagination:{page:1,limit:100,total:8,has_more:false}}});}if(block){reached();await hold;}const slug=url.pathname.split('/').at(-1);return Response.json({status:200,data:{slug,title:slug,media_type:'image',access_type:0,is_unlocked:true,source_url:'https://x.com/artist/status/123',prompts:[{text:content}],images:['https://img.opennana.com/prompts/images/1.jpeg']}});}});
  try{sources.ingestRows('s38',[row('old')],'old',8,{nextPage:9});const batch=sources.startBatch(['s38'],{mode:'incremental'});await started;sources.cancelBatch(batch.id);release();await sources.batchTask;assert.equal(sources.batchStatus().cancelled,1);assert.equal(store.count('shared'),1);assert.equal(store.get('feeds','s38').incrementalNextPage,1);assert.equal(store.get('feeds','s38').nextPage,9);block=false;await sources.sync('s38',{mode:'incremental'});assert.deepEqual(pages,[1,1]);assert.equal(store.count('shared'),9);
  }finally{await sources.close();store.close();}
});
test('模型分析失败只调用一次，不写筛选修正',async()=>{
  let calls=0;const app=await createWorkbench({port:0,dataDir:dir(),generator:async()=>{calls++;throw Error('模拟上游失败');}});try{app.sources.ingestRows('s05',[row('a')]);const id=app.sources.galleryList().items[0].id,provider=app.store.put('providers',{name:'模拟失败服务',model:'mock',protocol:'openai',baseUrl:'http://127.0.0.1:9999/v1'}),g=new GalleryDiscovery(app.store,app.jobs),job=g.analyze(id,{providerId:provider.id,model:'mock'});while(app.jobs.active||app.jobs.queue.length)await new Promise(r=>setTimeout(r,10));assert.equal(calls,1);assert.equal(g.analysis(id,job.id).status,'failed');assert.equal(app.store.get('galleryNotes',id),null);}finally{await app.close();}
});
test('人工修正独立保存，重同步和备份恢复保留，乐观版本防止覆盖',async()=>{
  const store=new Store(dir()),sources=new Sources(store),g=new GalleryDiscovery(store,{}),copy=new Store(dir());try{
    sources.ingestRows('s05',[row('a')]);const item=sources.galleryList().items[0],original=store.get('shared',item.id),detail=g.detail(item.id);
    g.save(item.id,{overrides:{styles:['人工风格'],author:'人工作者'},revision:detail.revision});assert.throws(()=>g.save(item.id,{overrides:{},revision:''}),/已被修改/);
    sources.ingestRows('s05',[row('a',{author:'上游新作者'})]);const replacement=sources.galleryList({style:'人工风格',author:'人工作者'});assert.equal(replacement.total,1);assert.equal(store.get('shared',item.id).firstSyncedAt,original.firstSyncedAt);assert.equal(store.get('shared',item.id).author,'上游新作者');
    copy.import(store.export());assert.deepEqual(copy.get('galleryNotes',item.id).overrides,{styles:['人工风格'],author:'人工作者'});assert.equal(copy.count('shared'),0);
    assert.throws(()=>copy.import({...store.export(),galleryNotes:[{id:'bad',overrides:{styles:'invalid'}}]}));
  }finally{await sources.close();store.close();copy.close();}
});
test('快照增量只新增：已有正文及旧条目保留，再次更新新增为零',async()=>{
  const store=new Store(dir()),sources=new Sources(store);try{
    sources.ingestRows('s40',[row('a'),row('old')]);const old=JSON.stringify(store.list('shared'));
    let result=sources.ingestRows('s40',[row('a',{content:'上游修改，增量不能替换已有正文'}),row('b')],'snapshot',undefined,{}, {incremental:true});assert.equal(result.lastAdded,1);assert.equal(result.lastUnchanged,1);assert.equal(store.count('shared'),3);
    assert.equal(store.list('shared').find(r=>r.originId==='a').content,content);result=sources.ingestRows('s40',[row('a'),row('b')],'snapshot',undefined,{}, {incremental:true});assert.equal(result.lastAdded,0);assert.equal(store.count('shared'),3);assert.ok(old.includes('old'));
  }finally{await sources.close();store.close();}
});
test('母版增量从最新页读新正文，已有条目不再读详情，首次仅一页',async()=>{
  const store=new Store(dir());let calls=[];
  const sources=new Sources(store,{fetcher:async(url,options)=>{calls.push(url);if(url.endsWith('/list'))return Response.json({success:true,result:{total:200,datas:[{id:2,frontCover:'https://img.alicdn.com/test.png'},{id:1,frontCover:'https://img.alicdn.com/test.png'}]}});return Response.json({success:true,result:{positive:content,author:{nickname:'Alice'}}});}});
  try{await sources.sync('mother',{mode:'incremental'});assert.equal(calls.filter(u=>u.endsWith('/list')).length,1);assert.equal(store.count('shared'),2);calls=[];const result=await sources.sync('mother',{mode:'incremental'});assert.equal(result.lastAdded,0);assert.equal(result.lastUnchanged,2);assert.equal(calls.length,1);}finally{await sources.close();store.close();}
});
test('置顶旧项不能让增量在新内容之前提前停止',async()=>{
  const store=new Store(dir()),pages=[],details=[];
  const sources=new Sources(store,{fetcher:async(url,options)=>{if(url.endsWith('/list')){const page=JSON.parse(options.body).pageNumber;pages.push(page);return Response.json({success:true,result:{total:60,datas:(page===1?[1,2]:[3,9]).map(id=>({id,frontCover:'https://img.alicdn.com/test.png'}))}});}const id=new URL(url).searchParams.get('id');details.push(id);return Response.json({success:true,result:{positive:content}});}});
  try{sources.ingestRows('mother',[row(1),row(9)],'old',60,{incrementalSeen:['1','9']});await sources.sync('mother',{mode:'incremental'});assert.deepEqual(pages,[1,2]);assert.deepEqual(details,['2','3']);assert.equal(store.count('shared'),4);}finally{await sources.close();store.close();}
});
test('OpenNana最新审核排序使用独立基线，置顶旧项不阻断后页新增',async()=>{
  const store=new Store(dir()),pages=[],details=[];const sources=new Sources(store,{fetcher:async u=>{const url=new URL(u);if(url.pathname==='/api/prompts'){assert.equal(url.searchParams.get('sort'),'reviewed_at');const page=Number(url.searchParams.get('page'));pages.push(page);return Response.json({status:200,data:{items:(page===1?['pinned','new-a']:['new-b','old']).map(slug=>({slug,access_type:0})),pagination:{page,limit:100,total:101,has_more:page===1}}});}const slug=url.pathname.split('/').at(-1);details.push(slug);return Response.json({status:200,data:{slug,title:slug,media_type:'image',access_type:0,is_unlocked:true,source_url:'https://x.com/artist/status/123',prompts:[{text:content}],images:['https://img.opennana.com/prompts/images/1.jpeg']}});}});
  try{sources.ingestRows('s38',[row('pinned'),row('old')],'old',101,{incrementalSeen:['pinned','old']});await sources.sync('s38',{mode:'incremental'});assert.deepEqual(pages,[1,2]);assert.deepEqual(details,['new-a','new-b']);assert.equal(store.count('shared'),4);}finally{await sources.close();store.close();}
});
test('模型补充分析必须显式发起，来源依据验证、过期结果拒绝，不自动修改标签',async()=>{
  let calls=0;const app=await createWorkbench({port:0,dataDir:dir(),generator:async()=>{calls++;return {output:JSON.stringify({suggestions:[{field:'styles',value:'电影风格',quote:'cinematic'}]})};}});
  try{
    app.sources.ingestRows('s05',[row('a')]);const item=app.sources.galleryList().items[0],g=new GalleryDiscovery(app.store,app.jobs),provider=app.store.put('providers',{name:'模拟分析',model:'mock',protocol:'openai',baseUrl:'http://127.0.0.1:9999/v1'});
    assert.equal(g.detail(item.id).analysis,null);assert.equal(calls,0);assert.throws(()=>g.analyze(item.id,{providerId:provider.id}),/请选择/);
    const job=g.analyze(item.id,{providerId:provider.id,model:'mock'});while(app.jobs.active||app.jobs.queue.length)await new Promise(r=>setTimeout(r,10));
    assert.equal(calls,1);const result=g.analysis(item.id,job.id);assert.equal(result.status,'succeeded');assert.equal(result.suggestions[0].quote,'cinematic');assert.equal(app.store.get('galleryNotes',item.id),null);
    app.store.put('jobs',{...app.store.get('jobs',job.id),output:JSON.stringify({suggestions:[{field:'styles',value:'幻觉',quote:'不存在的依据'}]})});assert.equal(g.analysis(item.id,job.id).status,'invalid');
    app.store.put('shared',{...app.store.get('shared',item.id),content:content+' changed'});assert.equal(g.analysis(item.id,job.id).status,'stale');assert.throws(()=>g.save(item.id,{overrides:{styles:['电影风格']},revision:'',analysisJobId:job.id}),/原文已改变/);
  }finally{await app.close();}
});
