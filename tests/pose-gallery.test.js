import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync} from 'node:fs';
import path from 'node:path';
import {Store} from '../src/store.js';
import {PoseGallery,parsePosePage,POSE_SOURCE} from '../src/pose-gallery.js';
import {coverUrl} from '../src/image-cache.js';
import {createWorkbench} from './source-fixtures.js';
const temp=()=>{mkdirSync('work',{recursive:true});return mkdtempSync(path.resolve(process.env.PW_TEST_ROOT||'work','pose-test-'));};
const png=readFileSync('public/icon-256.png');
const LINES=['全身1人・セクシー系','2人絡み'];
const ANGLES=[['front','正面'],['high','上から'],['low','下から'],['side','横'],['diag','斜め']];
const row=(prefix,series,no,category,name,suffix,angle)=>({id:prefix+'_'+no.toLowerCase()+'_'+suffix,'系統':series,'ポーズ番号':no,'分類':category,'ポーズ名':name,'アングル':angle,'サムネ':'thumbs/'+prefix+'_'+no.toLowerCase()+'_'+suffix+'.jpg','原寸':'img/'+prefix+'_'+no.toLowerCase()+'_'+suffix+'.png'});
const pose=(prefix,series,no,category,name)=>ANGLES.map(([suffix,angle])=>row(prefix,series,no,category,name,suffix,angle));
const no=n=>'P'+String(n).padStart(3,'0');
// 夹具 12 个姿势 / 60 条，满足解析层「条目数明显偏少即视为结构异常」的护栏（原站 288 姿势 / 1439 条）。
const ROWS=[
  ...Array.from({length:10},(_,i)=>pose('full_sexy','全身1人・セクシー系',no(i+1),'立ち',i?'姿势样例'+no(i+1):'振り返る')).flat(),
  ...pose('pair60','2人絡み',no(1),'密着','寄り添う'),...pose('pair60','2人絡み',no(2),'密着','重なる')
];
const page=(rows=ROWS,lines=LINES)=>`<!doctype html><html><body><script>\nconst META=${JSON.stringify({lines})};\nconst D=${JSON.stringify(rows)};\n</script></body></html>`;
const htmlFetcher=html=>async(url,opts)=>{assert.equal(url,POSE_SOURCE.url);assert.equal(opts.redirect,'error');assert.ok(opts.signal);return new Response(html);};

test('解析内嵌目录：字段、系列、视角数量与图片路径校验',()=>{
  const parsed=parsePosePage(page());
  assert.deepEqual(parsed.lines,LINES);assert.equal(parsed.rows.length,60);
  assert.equal(parsed.rows[0]['ポーズ名'],'振り返る');assert.equal(parsed.rows[0]['アングル'],'正面');
  // 字符串里的括号、引号与转义不能截断数组
  const tricky=page(ROWS.map(r=>({...r,'ポーズ名':'括号 ] } " 与转义 \\ 保留'})));
  const kept=parsePosePage(tricky);assert.equal(kept.rows.length,60);assert.match(kept.rows[0]['ポーズ名'],/括号/);
  // 编号可以不连续：只信内嵌 id 集合，不按编号穷举
  assert.equal(parsePosePage(page(ROWS.slice(0,55))).rows.length,55);
});

test('拒绝结构变化、非法图片路径、越界路径、重复编号与异常条目数量',()=>{
  assert.throws(()=>parsePosePage(''),/为空/);assert.throws(()=>parsePosePage('x'.repeat(17e6)),/16MB/);
  assert.throws(()=>parsePosePage('<html>no data</html>'),/找不到 META/);
  assert.throws(()=>parsePosePage('<script>const META={"lines":[]};const D=[];</script>'),/系列列表无效/);
  assert.throws(()=>parsePosePage(page(ROWS.slice(0,45))),/数量异常/);
  assert.throws(()=>parsePosePage(page([])),/数量异常/);
  // 图片路径：只允许 thumbs/<名字>.jpg 与 img/<名字>.png，不接受子目录、越界、外域、查询串、其他扩展名
  for(const bad of ['thumbs/../secret.jpg','thumbs/sub/a.jpg','https://evil.example/a.png','img/a.png?x=1','thumbs/a.gif','/thumbs/a.jpg','img//a.png']){
    assert.throws(()=>parsePosePage(page(ROWS.map((r,i)=>i?r:{...r,'サムネ':bad}))),/图片路径不合规/,bad);
    assert.throws(()=>parsePosePage(page(ROWS.map((r,i)=>i?r:{...r,'原寸':bad}))),/图片路径不合规/,bad);
  }
  assert.throws(()=>parsePosePage(page(ROWS.concat([ROWS[0]]))),/重复编号/);
  assert.throws(()=>parsePosePage(page(ROWS.map(r=>({...r,'系統':'未知系列'})))),/系列不在系列列表内/);
  assert.throws(()=>parsePosePage(page(ROWS.map(r=>({...r,'分類':'','ポーズ名':'x','ポーズ番号':'P001','アングル':'正面'})))),/分類字段无效/);
});

test('手动同步：首次入库、幂等重同步、改名更新与移除按内嵌 id 差集计算',async()=>{
  const store=new Store(temp()),gallery=new PoseGallery(store,{fetcher:htmlFetcher(page())});
  const first=await gallery.sync();assert.equal(first.total,60);assert.equal(first.added,60);assert.equal(first.removed,0);assert.deepEqual(first.lines,['全身单人·性感系','双人互动']);
  const status=gallery.status();assert.equal(status.count,60);assert.equal(status.poses,12);assert.ok(status.lastSync);assert.equal(status.lastError,null);
  assert.deepEqual(status.categories,['站立','紧贴']);assert.equal(status.source.author,'ギア');
  const again=await gallery.sync();assert.equal(again.added,0);assert.equal(again.removed,0);assert.equal(again.updated,0);assert.equal(again.unchanged,60);
  // 原站删掉 pair60 P002 的五个视角，并把 full_sexy P001 改名
  const shrunk=ROWS.filter(r=>!r.id.startsWith('pair60_p002')).map(r=>r.id.startsWith('full_sexy_p001')?{...r,'ポーズ名':'振り返る改'}:r);
  const changed=new PoseGallery(store,{fetcher:htmlFetcher(page(shrunk))});
  const diff=await changed.sync();assert.equal(diff.total,55);assert.equal(diff.added,0);assert.equal(diff.removed,5);assert.equal(diff.updated,5);
  assert.equal(changed.status().count,55);assert.equal(changed.status().poses,11);
  assert.equal(changed.detail('full_sexy_p001_front').poseName,'振り返る改');
  assert.throws(()=>changed.detail('pair60_p002_front'),/姿势不存在/);
  store.close();
});

test('同步失败保留已有目录并记录错误；关闭后不再写入；不接受并发同步',async()=>{
  const store=new Store(temp()),ok=new PoseGallery(store,{fetcher:htmlFetcher(page())});await ok.sync();
  for(const [broken,pattern] of [[async()=>{throw new Error('网络中断');},/网络中断/],[async()=>new Response('nope',{status:503}),/HTTP 503/],[async()=>new Response('<html>改版</html>'),/找不到 META/]]){
    const gallery=new PoseGallery(store,{fetcher:broken});
    await assert.rejects(()=>gallery.sync(),pattern);
    assert.equal(store.db.prepare("SELECT count(*) AS n FROM records WHERE kind='poseRefs'").get().n,60);
    assert.match(gallery.status().lastError,/同步失败，保留已有目录/);
    assert.equal(gallery.status().count,60);
  }
  const slow=new PoseGallery(store,{fetcher:htmlFetcher(page())});
  const running=slow.sync();await assert.rejects(()=>slow.sync(),/正在同步/);await running;
  slow.close();await assert.rejects(()=>slow.sync(),/正在关闭/);
  store.close();
});

test('列表按姿势聚合五个视角、支持筛选搜索与分页，逐张模式按视角展开',async()=>{
  const store=new Store(temp()),gallery=new PoseGallery(store,{fetcher:htmlFetcher(page())});await gallery.sync();
  const grouped=gallery.list();assert.equal(grouped.total,12);assert.equal(grouped.items.length,12);assert.equal(grouped.items[0].poseNo,'P001');
  assert.equal(grouped.items[0].angles.length,5);assert.equal(grouped.items[0].coverUrl,POSE_SOURCE.url+'thumbs/full_sexy_p001_front.jpg');
  assert.equal(grouped.items[0].fullUrl,POSE_SOURCE.url+'img/full_sexy_p001_front.png');
  assert.equal(gallery.list({series:'双人互动'}).total,2);
  assert.equal(gallery.list({category:'站立'}).total,10);
  assert.equal(gallery.list({query:'振り返'}).total,1);
  assert.equal(gallery.list({query:'p010'}).total,1);
  assert.equal(gallery.list({query:'不存在的名字'}).total,0);
  // 引号与关键字不能破坏查询
  assert.equal(gallery.list({query:"' OR 1=1 --"}).total,0);
  const paged=gallery.list({offset:2,limit:3});assert.equal(paged.items.length,3);assert.equal(paged.items[0].poseNo,'P003');
  const flat=gallery.list({group:'angle',angle:'正面'});assert.equal(flat.total,12);assert.equal(flat.items[0].angle,'正面');
  const flatAll=gallery.list({group:'angle',limit:4});assert.equal(flatAll.total,60);assert.equal(flatAll.items.length,4);
  assert.equal(gallery.list({limit:9999}).limit,120);
  assert.throws(()=>gallery.list({group:'bad'}),/浏览方式无效/);
  const detail=gallery.detail('pair60_p001_side');assert.equal(detail.poseName,'寄り添う');assert.equal(detail.category,'紧贴');assert.equal(detail.angles.length,5);
  assert.throws(()=>gallery.detail(''),/请选择姿势/);
  store.close();
});

test('HTTP 接口：目录、详情、同步与按需图片；图片经本地缓存不暴露原站直链',async()=>{
  const requests=[];let source=page();
  const app=await createWorkbench({port:0,dataDir:temp(),sourceFetcher:async()=>new Response(source),imageFetcher:async(url,opts)=>{requests.push(url);assert.equal(opts.redirect,'error');return new Response(png);}});
  try{
    const root='http://127.0.0.1:'+app.port,home=await fetch(root),cookie=home.headers.get('set-cookie').split(';')[0];
    const get=async route=>fetch(root+'/api/'+route,{headers:{cookie}}),post=async route=>fetch(root+'/api/'+route,{method:'POST',headers:{cookie,'Content-Type':'application/json'},body:'{}'});
    assert.equal((await (await get('pose')).json()).status.count,0);
    const sync=await (await post('pose/sync')).json();assert.equal(sync.total,60);assert.equal(sync.added,60);
    const list=await (await get('pose?group=pose&limit=2')).json();assert.equal(list.total,12);assert.equal(list.items.length,2);assert.equal(list.status.count,60);
    assert.equal((await (await get('pose?series='+encodeURIComponent('双人互动'))).json()).total,2);
    assert.equal((await get('pose/missing/detail')).status,400);
    const detail=await (await get('pose/full_sexy_p001_low/detail')).json();assert.equal(detail.angle,'仰视');assert.equal(detail.angles.length,5);
    // 缩略图：首次回源写入缓存，第二次命中本地
    const thumb=await get('pose/full_sexy_p001_front/image');assert.equal(thumb.status,200);assert.equal(thumb.headers.get('content-type'),'image/png');assert.equal(thumb.headers.get('x-image-cache'),'MISS');assert.deepEqual(Buffer.from(await thumb.arrayBuffer()),png);
    const hit=await get('pose/full_sexy_p001_front/image');assert.equal(hit.headers.get('x-image-cache'),'HIT');
    const full=await get('pose/full_sexy_p001_front/image?full=1');assert.equal(full.status,200);assert.equal(requests.length,2);
    assert.equal(requests[0],POSE_SOURCE.url+'thumbs/full_sexy_p001_front.jpg');
    assert.equal(requests[1],POSE_SOURCE.url+'img/full_sexy_p001_front.png');
    assert.equal((await get('pose/nope/image')).status,400);
    // 姿势目录与图片缓存不进 JSON 备份，避免随导出扩散
    const exported=app.store.export();assert.equal(exported.poseRefs,undefined);assert.equal(exported.poseFeed,undefined);
  }finally{await app.close();}
});

test('图片白名单：只放行姿势集原站的 thumbs/img 规范路径',()=>{
  assert.equal(coverUrl(POSE_SOURCE.url+'thumbs/full_sexy_P001_front.jpg'),POSE_SOURCE.url+'thumbs/full_sexy_P001_front.jpg');
  assert.equal(coverUrl(POSE_SOURCE.url+'img/full_sexy_P001_front.png'),POSE_SOURCE.url+'img/full_sexy_P001_front.png');
  // 路径里的 .. 会被 URL 解析规范化成合法路径（编码形式同样规范化），这是等价的合法地址；越界写法一律拒绝
  assert.equal(coverUrl('https://ai-pose-gallery.pages.dev/x/../thumbs/a.jpg'),'https://ai-pose-gallery.pages.dev/thumbs/a.jpg');
  assert.equal(coverUrl('https://ai-pose-gallery.pages.dev/../etc/thumbs/a.jpg'),'');
  for(const bad of ['http://ai-pose-gallery.pages.dev/thumbs/a.jpg','https://ai-pose-gallery.pages.dev/thumbs/a.jpg?x=1','https://ai-pose-gallery.pages.dev/img/a.gif','https://ai-pose-gallery.pages.dev/thumbs/a.webp','https://ai-pose-gallery.pages.dev.evil.example/img/a.png','https://evil.example/img/a.png','https://ai-pose-gallery.pages.dev/thumbs/sub/a.jpg','https://user:pw@ai-pose-gallery.pages.dev/thumbs/a.jpg','https://ai-pose-gallery.pages.dev:8443/thumbs/a.jpg'])assert.equal(coverUrl(bad),'',bad);
  assert.equal(coverUrl('not a url'),'');
});
