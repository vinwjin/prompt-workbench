import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync} from 'node:fs';
import path from 'node:path';
import {createWorkbench} from './source-fixtures.js';
import {saveAsset} from '../src/library.js';
const png=readFileSync('public/icon-256.png');
const url='https://img.alicdn.com/collection-test.png';
async function fixture(options={}){
  const app=await createWorkbench({port:0,dataDir:mkdtempSync(path.resolve(process.env.PW_TEST_ROOT||'work','shared-collection-')),imageFetcher:async()=>new Response(png),...options});
  app.store.put('shared',{id:'case',sourceId:'s05',originId:'case',title:'原标题',content:'保留完整提示词正文与光线和材质条件。',negative:'模糊',tags:'空间',modelHint:'绘图模型',author:'作者',license:'保留许可',sourceUrl:'https://github.com/langgptai/awesome-gpt-4o-prompts',coverUrl:url,coverUrls:[url],imageLabels:['原效果图'],detailLoaded:true});
  const root='http://127.0.0.1:'+app.port,cookie=(await fetch(root)).headers.get('set-cookie').split(';')[0];
  const call=async(route,body,method)=>{const r=await fetch(root+'/api/'+route,{method:method||(body?'POST':'GET'),headers:{cookie,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});return {status:r.status,data:await r.json()};};
  return {app,root,cookie,call};
}
test('广场收藏保存独立图片；清理公共缓存和重启后个人图仍可读，导出包含原字节',async()=>{
  const {app,root,cookie,call}=await fixture();try{
    const {status,data:a}=await call('shared/case/collect',{});assert.equal(status,200);assert.equal(a.media.length,1,'收藏必须关联效果图');
    assert.equal(a.media[0].name,'原效果图');assert.equal(a.collectionMedia.images[0].url,url);
    await call('cache/clear',{});const image=await fetch(root+'/api/assets/'+a.id+'/media/'+a.media[0].id,{headers:{cookie}});assert.equal(image.status,200);assert.deepEqual(Buffer.from(await image.arrayBuffer()),png);
    const pack=(await call('assets/export',{ids:[a.id]})).data;assert.equal(pack.assets[0].collectionMedia.images.length,1);assert.deepEqual(Buffer.from(pack.mediaFiles[0].base64,'base64'),png);
    const dataDir=app.store.dir;await app.close();const reopened=await createWorkbench({dataDir,port:0,imageFetcher:async()=>{throw Error('不应联网');}});try{const base='http://127.0.0.1:'+reopened.port,session=(await fetch(base)).headers.get('set-cookie').split(';')[0];const r=await fetch(base+'/api/assets/'+a.id+'/media/'+a.media[0].id,{headers:{cookie:session}});assert.equal(r.status,200);assert.deepEqual(Buffer.from(await r.arrayBuffer()),png);}finally{await reopened.close();}
  }finally{await app.close();}
});
test('旧收藏补图保留所有编辑与归档，重复收藏和并发点击不重复加图，视频仅保留链接',async()=>{
  let reads=0;const {app,call}=await fixture({imageFetcher:async()=>{reads++;return new Response(png);}});try{
    const item=app.store.get('shared','case');app.store.put('shared',{...item,videoUrl:'https://img.opennana.com/prompts/assets/videos/test.mp4'});
    app.store.put('folders',{id:'personal',name:'我的文件夹'});
    const old=saveAsset(app.store,{title:'个人标题',content:'用户改写',negative:'个人负向',note:'自己的笔记',tags:'自己的标签',folderId:'personal',favorite:true,source:{sourceId:item.sourceId,originId:item.originId,url:item.sourceUrl,author:item.author,license:item.license}});
    const fills=await Promise.all([call('assets/'+old.id+'/fill-shared-media',{}),call('shared/case/collect',{})]);
    for(const r of fills){assert.equal(r.status,200);assert.equal(r.data.id,old.id);assert.equal(r.data.media.length,1);for(const key of ['title','content','negative','note','tags','folderId','favorite','source','versions','createdAt'])assert.deepEqual(r.data[key],old[key],key);assert.equal(r.data.collectionMedia.videoUrl,'https://img.opennana.com/prompts/assets/videos/test.mp4');}
    assert.equal(reads,1);const a=fills[1].data;
    const edited=(await call('assets',{...a,title:'再改标题',media:[],expectedUpdatedAt:a.updatedAt})).data;assert.equal(edited.collectionMedia.videoUrl,a.collectionMedia.videoUrl);
    const again=(await call('shared/case/collect',{})).data;assert.equal(again.media.length,0,'主动移除的素材不因收藏恢复');assert.equal(again.title,'再改标题');
    const pack=(await call('assets/export',{ids:[a.id]})).data;const imported=await call('assets/import',pack);assert.equal(imported.status,200);assert.equal(imported.data.skipped,1);
  }finally{await app.close();}
});
test('原图失败明确报告但保留正文，重试只补缺失图片；不下载未许可来源，不接受任意地址',async()=>{
  let fail=true,reads=0;const {app,call}=await fixture({imageFetcher:async()=>{reads++;return fail?new Response('',{status:503}):new Response(png);}});try{
    const a=(await call('shared/case/collect',{})).data;assert.equal(a.media.length,0);assert.equal(a.collectionMedia.failures.length,1);assert.ok(a.content);
    fail=false;const fixed=(await call('assets/'+a.id+'/fill-shared-media',{})).data;assert.equal(fixed.media.length,1);assert.equal(fixed.collectionMedia.failures.length,0);assert.equal(reads,2);
    const untrusted=await call('assets',{title:'任意URL',content:'正文',collectionMedia:{images:[],videoUrl:'http://127.0.0.1/secret',failures:[]}});assert.equal(untrusted.status,200);assert.equal(untrusted.data.collectionMedia,null,'普通表单不允许写入远端素材引用');
    const exported=(await call('assets/export',{ids:[fixed.id]})).data;
    const invalid=await call('assets/import',{...exported,assets:[{...fixed,id:undefined,title:'非法视频链接',collectionMedia:{images:[],videoUrl:'https://evil.example/video.mp4',failures:[]}}]});assert.equal(invalid.status,400);assert.match(invalid.data.error,/视频地址/);
  }finally{await app.close();}
});
test('多个原图保持顺序和标签；禁用来源只能取本地缓存；素材包迁移保留图片与视频链接',async()=>{
  let reads=0;const png2=Buffer.concat([png,Buffer.from('second')]);const {app,call}=await fixture({imageFetcher:async u=>{reads++;return new Response(u.includes('second')?png2:png);}});let other;
  try{
    const item=app.store.get('shared','case');app.store.put('shared',{...item,coverUrls:[url,'https://img.alicdn.com/second.png'],imageLabels:['第一张','第二张'],videoUrl:'https://img.opennana.com/prompts/assets/videos/test.mp4'});
    const a=(await call('shared/case/collect',{})).data;assert.deepEqual(a.media.map(m=>m.name),['第一张','第二张']);
    const pack=(await call('assets/export',{ids:[a.id]})).data;other=await fixture();const imported=await other.call('assets/import',pack);assert.equal(imported.status,200);const moved=(await other.call('state')).data.assets.find(r=>r.title===a.title);assert.deepEqual(moved.collectionMedia,a.collectionMedia);assert.equal(moved.media.length,2);
    const feed=app.sources.feed.bind(app.sources);app.sources.feed=id=>({...feed(id),syncable:false});app.store.put('shared',{...item,id:'blocked',originId:'blocked',coverUrls:['https://img.alicdn.com/not-cached.png']});
    const blocked=(await call('shared/blocked/collect',{})).data;assert.equal(blocked.media.length,0);assert.equal(blocked.collectionMedia.failures.length,1);assert.equal(reads,2);
    await call('assets/manage',{action:'trash',ids:[a.id]});const restored=(await call('shared/case/collect',{})).data;assert.equal(restored.id,a.id);assert.equal(restored.deletedAt,null);assert.equal(restored.media.length,2);
  }finally{await app.close();if(other)await other.app.close();}
});
test('主动移除的图片在素材包迁移新库后仍不因重复收藏被加回',async()=>{
  const {app,call}=await fixture();let target;
  try{
    const a=(await call('shared/case/collect',{})).data;const removed=await call('assets',{...a,media:[],expectedUpdatedAt:a.updatedAt});assert.equal(removed.status,200);
    const pack=(await call('assets/export',{ids:[a.id]})).data;assert.equal(pack.mediaFiles.length,0);
    let reads=0;target=await fixture({imageFetcher:async()=>{reads++;return new Response(png);}});assert.equal((await target.call('assets/import',pack)).status,200);
    const again=(await target.call('shared/case/collect',{})).data;assert.equal(again.media.length,0,'迁移不撤销用户主动移除');assert.equal(reads,0);
  }finally{await app.close();if(target)await target.app.close();}
});
test('来源详情等待前固定旧收藏，永久删除后迟到收藏及并发重复点击不得重建',async()=>{
  const {app,call}=await fixture();let release;
  try{
    const a=saveAsset(app.store,{title:'个人标题',content:'个人正文',source:{sourceId:'s05',originId:'case'}});
    let entered;const gate=new Promise(r=>entered=r),held=new Promise(r=>release=r),detail=app.sources.detail.bind(app.sources);app.sources.detail=async id=>{entered();await held;return detail(id);};
    const collecting=call('shared/case/collect',{});await gate;const repeat=call('shared/case/collect',{});await new Promise(r=>setTimeout(r,10));
    await call('assets/manage',{action:'trash',ids:[a.id]});assert.equal((await call('trash/manage',{kind:'assets',ids:[a.id],action:'purge',confirmation:'永久删除'})).status,200);release();
    assert.equal((await collecting).status,400);assert.equal((await repeat).status,400);assert.equal(app.store.list('assets').length,0);
  }finally{release?.();await app.close();}
});
test('补图等待期间的编辑、回收站与删除不会被旧快照覆盖或恢复',async()=>{
  let release,started;const gate=new Promise(r=>started=r);const {app,call}=await fixture({imageFetcher:async()=>{started();await new Promise(r=>release=r);return new Response(png);}});try{
    const collecting=call('shared/case/collect',{});await gate;
    const a=app.store.list('assets')[0];const edit=(await call('assets',{...a,title:'并发编辑',content:'并发正文',media:[],expectedUpdatedAt:a.updatedAt})).data;
    release();const saved=(await collecting).data;assert.equal(saved.title,edit.title);assert.equal(saved.content,edit.content);assert.equal(saved.media.length,1);
    const source=app.store.get('shared','case');app.store.put('shared',{...source,coverUrls:[url+'?new'],coverUrl:url+'?new'});
    let entered;const waiting=new Promise(r=>entered=r);app.imageCache.fetcher=async()=>{entered();await new Promise(r=>release=r);return new Response(png);};
    const again=call('assets/'+a.id+'/fill-shared-media',{});await waiting;await call('assets/manage',{action:'trash',ids:[a.id]});release();const result=await again;assert.equal(result.status,400);assert.ok(app.store.get('assets',a.id).deletedAt);
  }finally{release?.();await app.close();}
});
