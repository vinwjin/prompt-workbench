import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,existsSync} from 'node:fs';
import path from 'node:path';
import {Store} from '../src/store.js';
import {ImageCache,coverUrl} from '../src/image-cache.js';
import {Sources,parseCurated} from '../src/sources.js';
import {createWorkbench} from '../src/server.js';
const temp=()=>{mkdirSync('work',{recursive:true});return mkdtempSync(path.resolve('work','image-test-'));};
const png=readFileSync('public/icon-256.png'),url='https://img.alicdn.com/sample.png';
test('X 精选保留对应原帖、正文、作者与效果图，重复原帖去重；不执行源 HTML',()=>{
  const block='### No. 1: 示例\n#### 📝 Prompt\n```\n保留建筑材料与光照\n```\n<img src="https://cms-assets.youmind.com/media/example.jpg">\n- **Author:** [作者](https://x.com/author)\n- **Source:** [Twitter Post](https://x.com/author/status/123)\n';
  const rows=parseCurated(block+block.replace('No. 1','No. 2'));assert.equal(rows.length,1);assert.equal(rows[0].sourceUrl,'https://x.com/author/status/123');assert.equal(rows[0].content,'保留建筑材料与光照');assert.equal(rows[0].author,'作者');assert.equal(rows[0].frontCover,'');assert.throws(()=>parseCurated(block.replace('https://x.com/author/status/123','javascript:alert(1)')),/格式/);
  const store=new Store(temp());const sources=new Sources(store);assert.throws(()=>sources.ingest('xbanana',block),/不存在/);store.put('shared',{id:'retired',sourceId:'xbanana',title:'已移除源',content:'缓存'});const asset=store.put('assets',{title:'已收藏',content:'个人内容',source:{sourceId:'xbanana',url:rows[0].sourceUrl}});assert.equal(sources.list().total,0);assert.equal(sources.catalog().some(f=>f.id==='xbanana'),false);assert.equal(store.get('assets',asset.id).content,'个人内容');store.close();
});
test('广场分页支持 20/50/100 条，限制最大值，隔离退休来源的缓存与读取',async()=>{
  const app=await createWorkbench({port:0,dataDir:temp()});try{for(let i=0;i<121;i++)app.store.put('shared',{id:'page-'+i,sourceId:'mother',originId:String(i),title:'卡片'+i,coverUrl:url});app.store.put('shared',{id:'old-source',sourceId:'xbanana',coverUrl:'https://cms-assets.youmind.com/media/x.jpg',content:'旧正文'});
    const root='http://127.0.0.1:'+app.port,home=await fetch(root),cookie=home.headers.get('set-cookie').split(';')[0];const get=async route=>fetch(root+'/api/'+route,{headers:{cookie}});
    for(const size of [20,50,100]){const r=await (await get('shared?limit='+size)).json();assert.equal(r.items.length,size);assert.equal(r.limit,size);assert.equal(r.total,121);}assert.equal((await (await get('shared?limit=999999')).json()).items.length,100);assert.equal((await (await get('shared?limit=50&offset=100')).json()).items.length,21);
    assert.equal((await get('shared/old-source')).status,400);assert.equal((await get('shared/old-source/image')).status,400);assert.equal((await (await get('shared?source=xbanana')).json()).total,0);
  }finally{await app.close();}
});

test('图片按 URL 去重、本地复用、重启离线命中；拒绝任意地址与假图片',async()=>{
  const dir=temp();let store=new Store(dir),calls=0;let cache=new ImageCache(store,{fetcher:async(u,opts)=>{calls++;assert.equal(u,url);assert.equal(opts.redirect,'error');assert.equal(opts.headers.Authorization,undefined);return new Response(png);}});
  const [a,b]=await Promise.all([cache.get(url),cache.get(url)]);assert.deepEqual(a.data,b.data);assert.equal(calls,1);assert.ok(cache.dir.startsWith(dir+path.sep));assert.equal(cache.stats().count,1);store.close();
  store=new Store(dir);cache=new ImageCache(store,{fetcher:async()=>{throw Error('offline');}});assert.equal((await cache.get(url)).cached,true);await cache.clear();assert.equal(cache.stats().bytes,0);assert.equal(cache.stats().count,0);assert.equal(store.list('cacheImages').length,0);
  assert.equal(coverUrl('https://img.alicdn.com.evil.test/image.png'),'');assert.equal(coverUrl('http://127.0.0.1/image.png'),'');assert.equal(coverUrl('https://user:password@img.alicdn.com/image.png'),'');await assert.rejects(cache.get('https://other.test/a'),/地址/);
  cache.fetcher=async()=>new Response('<html>oops</html>');await assert.rejects(cache.get(url),/图片/);assert.equal(cache.stats().count,0);store.close();
});

test('缓存容量按最久未访问清理，过期清理不动资产；清理等待下载并阻止新增',async()=>{
  const store=new Store(temp()),cache=new ImageCache(store);cache.configure({limitMB:64,maxAgeDays:1});const asset=store.put('assets',{title:'保留',content:'个人提示词'});
  const older='a'.repeat(64),newer='b'.repeat(64);for(const [id,lastUsed]of [[older,Date.now()-1000],[newer,Date.now()]]){writeFileSync(path.join(cache.dir,id+'.img'),png);store.put('cacheImages',{id,bytes:40*1048576,lastUsed,type:'image/png'});}cache.trim();assert.equal(store.get('cacheImages',older),null);assert.equal(existsSync(path.join(cache.dir,older+'.img')),false);assert.ok(store.get('cacheImages',newer));
  store.put('cacheImages',{...store.get('cacheImages',newer),lastUsed:Date.now()-2*86400000});await cache.clear({expiredOnly:true});assert.equal(cache.stats().count,0);assert.equal(store.get('assets',asset.id).content,'个人提示词');
  let release,started;const ready=new Promise(r=>started=r);cache.fetcher=async()=>{started();await new Promise(r=>release=r);return new Response(png);};const pending=cache.get(url);await ready;const clearing=cache.clear();await assert.rejects(cache.get('https://img.alicdn.com/second.png'),/清理/);release();await pending;await clearing;assert.equal(cache.stats().count,0);store.close();
});

test('母版保留效果图和统计，图文筛选排序正确；图片 API 使用会话并禁止浏览器磁盘缓存',async()=>{
  let downloads=0;const app=await createWorkbench({port:0,dataDir:temp(),imageFetcher:async()=>{downloads++;return new Response(png);}});
  try{app.sources.ingest('mother',JSON.stringify({success:true,result:{total:2,datas:[{id:1,title:'有图',frontCover:url,viewCount:10,copyCount:2},{id:2,title:'无图'}]}}));const id=app.sources.list({kind:'images'}).items[0].id;assert.equal(app.sources.list({kind:'images'}).total,1);assert.equal(app.sources.list({kind:'text'}).total,1);assert.equal(app.sources.list({sort:'views'}).items[0].viewCount,10);
    const root='http://127.0.0.1:'+app.port;assert.equal((await fetch(root+'/api/shared/'+id+'/image')).status,401);const home=await fetch(root),cookie=home.headers.get('set-cookie').split(';')[0];const get=()=>fetch(root+'/api/shared/'+id+'/image',{headers:{cookie}});
    assert.equal((await get()).status,400);assert.equal(downloads,0,'受限来源不下载远程图片');
    // 模拟既有本地缓存；不访问真实来源。
    await app.imageCache.get(url);const image=await get();assert.equal(image.status,200);assert.equal(image.headers.get('Content-Type'),'image/png');assert.equal(image.headers.get('Cache-Control'),'no-store');assert.deepEqual(Buffer.from(await image.arrayBuffer()),png);await get();assert.equal(downloads,1);assert.equal(app.imageCache.stats().count,1);
  }finally{await app.close();}
});
