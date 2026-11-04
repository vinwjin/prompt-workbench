import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync} from 'node:fs';
import path from 'node:path';
import {Store} from '../src/store.js';
import {RefLibrary,parseFaceImages,parseCostumePage,REF_LIBRARIES} from '../src/ref-library.js';
import {coverUrl} from '../src/image-cache.js';
import {createWorkbench} from './source-fixtures.js';
const temp=()=>{mkdirSync('work',{recursive:true});return mkdtempSync(path.resolve(process.env.PW_TEST_ROOT||'work','ref-test-'));};
const png=readFileSync('public/icon-256.png');

// 夹具：脸库 120 条（满足「条目数明显偏少即视为结构异常」护栏），服装库 120 条。
const FACE_ROWS=Array.from({length:120},(_,i)=>({id:'f'+String(i).padStart(3,'0')+'abc',section:i%2?'styling':'face',hair:i%2?'ロング':'ショート',style:i%5?'样例'+i:'',w:1122,h:1402,full:'img/full/f'+String(i).padStart(3,'0')+'abc.png',thumb:'img/thumb/f'+String(i).padStart(3,'0')+'abc.webp',bytes:1000+i}));
const faceJs=rows=>`window.GALLERY_IMAGES = ${JSON.stringify(rows)};`;
const COSTUME_ROWS=Array.from({length:120},(_,i)=>({id:'SPR-'+String(i+1).padStart(4,'0'),'カテゴリ':i%2?'夏':'春','キーワード':'ivory frill knit','サムネ':'thumbs/SPR-'+String(i+1).padStart(4,'0')+'.webp','画像':'img/SPR-'+String(i+1).padStart(4,'0')+'.webp','原寸':'png/SPR-'+String(i+1).padStart(4,'0')+'.png'}));
const costumePage=rows=>`<!doctype html><html><body><script>\nconst META=${JSON.stringify({cats:['春','夏']})};\nconst D=${JSON.stringify(rows)};\n</script></body></html>`;

const faceFetcher=js=>async(url,opts)=>{assert.equal(url,REF_LIBRARIES.face.url+'data/images.js');assert.equal(opts.redirect,'error');assert.ok(opts.signal);return new Response(js);};
const costumeFetcher=html=>async(url,opts)=>{assert.equal(url,REF_LIBRARIES.costume.url);assert.equal(opts.redirect,'error');assert.ok(opts.signal);return new Response(html);};

test('解析脸库 GALLERY_IMAGES 与服装库 META/D：字段、分类与图片路径校验',()=>{
  assert.equal(parseFaceImages(faceJs(FACE_ROWS)).length,120);
  assert.equal(parseFaceImages(faceJs(FACE_ROWS))[0].section,'face');
  assert.throws(()=>parseFaceImages(''),/数据为空/);
  assert.throws(()=>parseFaceImages('x'.repeat(33e6)),/32MB/);
  assert.throws(()=>parseFaceImages('window.OTHER=[]'),/找不到 GALLERY_IMAGES/);
  assert.throws(()=>parseFaceImages('window.GALLERY_IMAGES = []'),/数量异常/);
  assert.throws(()=>parseFaceImages(faceJs(FACE_ROWS.slice(0,10))),/数量异常/);
  assert.throws(()=>parseFaceImages(faceJs(FACE_ROWS.map((r,i)=>i?r:{...r,section:'bad'}))),/section 无效/);
  assert.throws(()=>parseFaceImages(faceJs(FACE_ROWS.concat([FACE_ROWS[0]]))),/重复编号/);

  const {cats,rows}=parseCostumePage(costumePage(COSTUME_ROWS));
  assert.deepEqual(cats,['春','夏']);assert.equal(rows.length,120);
  assert.throws(()=>parseCostumePage(''),/页面为空/);
  assert.throws(()=>parseCostumePage('<html>no</html>'),/找不到 META/);
  assert.throws(()=>parseCostumePage(costumePage(COSTUME_ROWS.slice(0,10))),/数量异常/);
  assert.throws(()=>parseCostumePage(costumePage(COSTUME_ROWS.map((r,i)=>i?r:{...r,'カテゴリ':'秋'}))),/分类不在分类列表内/);
  assert.throws(()=>parseCostumePage(costumePage(COSTUME_ROWS.concat([COSTUME_ROWS[0]]))),/重复编号/);
});

test('手动同步：首次入库、幂等重同步与移除按内嵌 id 差集；失败保留已有目录',async()=>{
  const store=new Store(temp());
  const face=new RefLibrary(store,{fetcher:faceFetcher(faceJs(FACE_ROWS))});
  const f1=await face.sync('face');assert.equal(f1.total,120);assert.equal(f1.added,120);assert.deepEqual(f1.groups,['脸部特写','造型']);
  assert.equal(face.status('face').count,120);assert.equal(face.status('face').groups[1],'造型');
  const f2=await face.sync('face');assert.equal(f2.added,0);assert.equal(f2.removed,0);
  // 列表与详情（删除前验证）
  const list=face.list({id:'face',group:'脸部特写',limit:3});assert.equal(list.items[0].hair,'短发');
  const detail=face.detail('face-f000abc');assert.equal(detail.section,'脸部特写');assert.ok(detail.thumbUrl.includes('/img/thumb/'));
  assert.throws(()=>face.detail('missing'),/参考图不存在/);
  // 删一条（去掉 f000abc）再同步
  const shrunk=new RefLibrary(store,{fetcher:faceFetcher(faceJs(FACE_ROWS.slice(1)))});
  const f3=await shrunk.sync('face');assert.equal(f3.removed,1);assert.equal(shrunk.status('face').count,119);
  assert.throws(()=>shrunk.detail('face-f000abc'),/参考图不存在/);
  // 失败保留目录
  const broken=new RefLibrary(store,{fetcher:async()=>{throw new Error('网络中断');}});
  await assert.rejects(()=>broken.sync('face'),/网络中断/);
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM records WHERE kind='refItems' AND json_extract(body,'$.lib')='face'").get().n,119);
  assert.match(face.status('face').lastError,/同步失败，保留已有目录/);
  store.close();
});

test('服装库同步：分类翻译、列表筛选、分组下拉与关闭护栏',async()=>{
  const store=new Store(temp());
  const costume=new RefLibrary(store,{fetcher:costumeFetcher(costumePage(COSTUME_ROWS))});
  const r=await costume.sync('costume');assert.equal(r.total,120);assert.deepEqual(r.groups,['春','夏']);
  assert.equal(costume.status('costume').count,120);
  const list=costume.list({id:'costume',group:'春',limit:5});assert.equal(list.items[0].category,'春');
  const detail=costume.detail('costume-SPR-0002');assert.equal(detail.category,'夏');assert.ok(detail.fullUrl.includes('/png/'));
  // 不接受不存在的库（同步抛出）
  assert.throws(()=>costume.lib('nope'),/参考素材库不存在/);
  // 并发与关闭
  const running=costume.sync('costume');await assert.rejects(()=>costume.sync('costume'),/正在同步/);await running;
  costume.close();await assert.rejects(()=>costume.sync('costume'),/正在关闭/);
  store.close();
});

test('HTTP 接口：目录、详情、同步与按需图片；图片经本地缓存不暴露源站直链',async()=>{
  const requests=[];
  const app=await createWorkbench({port:0,dataDir:temp(),sourceFetcher:async(url)=>{if(url.endsWith('/data/images.js'))return new Response(faceJs(FACE_ROWS));return new Response(costumePage(COSTUME_ROWS));},imageFetcher:async(url,opts)=>{requests.push(url);assert.equal(opts.redirect,'error');return new Response(png);}});
  try{
    const root='http://127.0.0.1:'+app.port,home=await fetch(root),cookie=home.headers.get('set-cookie').split(';')[0];
    const get=async route=>fetch(root+'/api/'+route,{headers:{cookie}}),post=async route=>fetch(root+'/api/'+route,{method:'POST',headers:{cookie,'Content-Type':'application/json'},body:JSON.stringify({lib:'face'})});
    assert.equal((await (await get('ref?lib=face')).json()).status.count,0);
    const sync=await (await post('ref/sync')).json();assert.equal(sync.total,120);assert.equal(sync.added,120);
    const list=await (await get('ref?lib=face&group='+encodeURIComponent('脸部特写')+'&limit=2')).json();assert.equal(list.total,60);assert.equal(list.items.length,2);
    // 搜索只读 q 参数（前端必须传 q，传 query 会被忽略）——锁定审计 P1b 修复
    const qNoHit=await (await get('ref?lib=face&q='+encodeURIComponent('不存在的词xyz'))).json();assert.equal(qNoHit.total,0,'q 参数不存在的词应返回 0');
    const queryIgnored=await (await get('ref?lib=face&query='+encodeURIComponent('不存在的词xyz'))).json();assert.equal(queryIgnored.total,120,'query 参数应被后端忽略（返回全部 120 条）');
    const qHit=await (await get('ref?lib=face&q='+encodeURIComponent('样例1'))).json();assert.ok(qHit.total>0&&qHit.total<120,'q 参数应命中部分条目，实际 '+qHit.total);
    assert.equal((await get('ref/missing/detail')).status,400);
    const detail=await (await get('ref/face-f000abc/detail')).json();assert.equal(detail.section,'脸部特写');
    const thumb=await get('ref/face-f000abc/image');assert.equal(thumb.status,200);assert.equal(thumb.headers.get('x-image-cache'),'MISS');
    const hit=await get('ref/face-f000abc/image');assert.equal(hit.headers.get('x-image-cache'),'HIT');
    const full=await get('ref/face-f000abc/image?full=1');assert.equal(full.status,200);assert.equal(requests.length,2);
    assert.equal(requests[0],REF_LIBRARIES.face.url+'img/thumb/f000abc.webp');
    assert.equal(requests[1],REF_LIBRARIES.face.url+'img/full/f000abc.png');
    assert.equal((await get('ref/nope/image')).status,400);
    // 参考素材目录与缓存不进 JSON 备份
    const exported=app.store.export();assert.equal(exported.refItems,undefined);assert.equal(exported.refFeed,undefined);
  }finally{await app.close();}
});

test('图片白名单：只放行脸库与服装库源站的规范路径',()=>{
  assert.equal(coverUrl(REF_LIBRARIES.face.url+'img/thumb/f000abc.webp'),REF_LIBRARIES.face.url+'img/thumb/f000abc.webp');
  assert.equal(coverUrl(REF_LIBRARIES.face.url+'img/full/f000abc.png'),REF_LIBRARIES.face.url+'img/full/f000abc.png');
  assert.equal(coverUrl(REF_LIBRARIES.costume.url+'thumbs/SPR-0001.webp'),REF_LIBRARIES.costume.url+'thumbs/SPR-0001.webp');
  assert.equal(coverUrl(REF_LIBRARIES.costume.url+'png/SPR-0001.png'),REF_LIBRARIES.costume.url+'png/SPR-0001.png');
  for(const bad of ['http://ai-portrait-gallery.pages.dev/img/thumb/a.webp','https://ai-portrait-gallery.pages.dev/img/thumb/a.webp?x=1','https://ai-portrait-gallery.pages.dev/img/thumb/a.png','https://ai-portrait-gallery.pages.dev.evil.example/img/thumb/a.webp','https://evil.example/img/thumb/a.webp','https://ai-costume-gallery.pages.dev/thumbs/sub/a.webp','https://ai-costume-gallery.pages.dev/png/a.jpg'])assert.equal(coverUrl(bad),'',bad);
});
