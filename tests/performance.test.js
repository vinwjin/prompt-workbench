import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync} from 'node:fs';
import path from 'node:path';
import {Store} from '../src/store.js';
import {Sources} from './source-fixtures.js';
import {ImageCache} from '../src/image-cache.js';
import {galleryEligible} from '../src/gallery-policy.js';

test('图片命中不刷新业务状态，个人编辑不重建公共目录，来源变更及时失效',async()=>{
  mkdirSync('work',{recursive:true});const store=new Store(mkdtempSync(path.resolve(process.env.PW_TEST_ROOT||'work','perf-test-')));
  try{
    const sources=new Sources(store),cache=new ImageCache(store,{fetcher:async()=>new Response(readFileSync('public/icon-256.png'))});
    sources.ingestRows('s05',[{id:'one',title:'案例',content:'保留真实正文和原始条件，明确材质、光照与画面细节。',frontCover:'https://img.alicdn.com/perf.png'}]);
    const revision=store.revision;
    const page=sources.galleryList();assert.equal(page.items.length,1);assert.equal(sources.galleryCache,undefined,'正常列表不能建立全库常驻对象缓存');assert.equal(page.items[0].content,undefined);const before=sources.galleryRows();
    await cache.get('https://img.alicdn.com/perf.png');await cache.get('https://img.alicdn.com/perf.png');
    assert.equal(store.revision,revision,'图片下载和访问时间更新不能触发完整状态轮询');
    assert.strictEqual(sources.galleryRows(),before,'图片访问不能失效公共目录');
    store.put('assets',{title:'个人编辑',content:'个人正文'});
    assert.strictEqual(sources.galleryRows(),before,'个人编辑不能失效公共目录');
    sources.ingestRows('s05',[{id:'two',title:'新案例',content:'另一条完整提示词正文，保留约束和原始条件以及光照。',frontCover:'https://img.alicdn.com/perf.png'}]);
    assert.notStrictEqual(sources.galleryRows(),before);assert.equal(sources.galleryList().items[0].title,'新案例');
    sources.ingestRows('s05',[{id:'unicode',title:'CAFÉ ЖУК',content:'另一条完整提示词正文，保留约束和原始条件以及光照。',frontCover:'https://img.alicdn.com/perf.png'}]);
    assert.equal(sources.galleryList({query:'café'}).total,1);assert.equal(sources.galleryList({query:'жук'}).total,1);
  }finally{store.close();}
});
test('首屏目录摘要不读取原文；投影与原策略一致、删除/回滚/旧版写入与重启修复',()=>{
  const dir=mkdtempSync(path.resolve(process.env.PW_TEST_ROOT||'work','summary-test-'));let store=new Store(dir);
  try{const examples=[{id:'yes',sourceId:'s05',coverUrl:'https://img.alicdn.com/perf.png',content:'保留真实可见事实和原始条件，明确画面材质光照。'},{id:'bad',sourceId:'s05',coverUrl:'https://evil.example/image.png',content:'保留真实可见事实和原始条件，明确画面材质光照。'},{id:'short',sourceId:'s05',coverUrl:'https://img.alicdn.com/perf.png',content:'短文'},{id:'reference',sourceId:'s05',coverUrl:'https://img.alicdn.com/perf.png',content:'保留真实可见事实和原始条件，明确画面材质光照。',referenceOnly:true},{id:'video',sourceId:'s39',content:'保留真实可见事实和原始条件，明确画面材质光照。',videoUrl:'https://video.twimg.com/amplify_video/123/vid/avc1/1920x1080/test.mp4',sourceUrl:'https://x.com/artist/status/1923016036120658122'}];
    for(const row of examples)store.put('shared',row);const sources=new Sources(store);sources.galleryRows=()=>{throw Error('首屏不应解析所有正文');};assert.equal(sources.galleryCandidates().find(f=>f.id==='s05').count,1);assert.equal(sources.galleryCandidates().find(f=>f.id==='s39').count,1);for(const row of examples)assert.equal(store.db.prepare('SELECT eligible FROM shared_summary WHERE id=?').get(row.id).eligible,Number(galleryEligible(row)));
    store.db.exec('BEGIN');store.put('shared',{...examples[0],referenceOnly:true});store.db.exec('ROLLBACK');assert.equal(sources.galleryCandidates().find(f=>f.id==='s05').count,1);store.db.prepare("DELETE FROM records WHERE kind='shared' AND id='yes'").run();assert.equal(store.db.prepare("SELECT count(*) AS n FROM shared_summary WHERE id='yes'").get().n,0);
    const edited={...store.get('shared','short'),content:examples[0].content,updatedAt:'2030-01-01'};store.db.prepare("UPDATE records SET body=?,updated=? WHERE kind='shared' AND id='short'").run(JSON.stringify(edited),'2030-01-01');store.close();store=new Store(dir);assert.equal(store.db.prepare("SELECT eligible FROM shared_summary WHERE id='short'").get().eligible,1);assert.equal(new Sources(store).galleryCandidates().find(f=>f.id==='s05').count,1);
  }finally{store.close();}
});
