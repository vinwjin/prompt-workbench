import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync} from 'node:fs';
import path from 'node:path';
import {createWorkbench} from './source-fixtures.js';
test('个人资产在服务端筛选分页，状态与列表不携带全库正文，详情保持原文',async()=>{
  mkdirSync('work',{recursive:true});const app=await createWorkbench({port:0,dataDir:mkdtempSync(path.resolve(process.env.PW_TEST_ROOT||'work','asset-query-'))});
  try{
    for(let n=0;n<121;n++)app.store.put('assets',{id:'a'+n,title:'标题'+n,content:'正文'.repeat(1000)+(n===120?'NEEDLE末尾':''),negative:n===119?'独立负向':'',tags:n===120?'街道，夜景':'夜景',folderId:n===120?'f1':'',favorite:n===120,deletedAt:n===118?'2026-01-01':null,versions:[{content:'旧正文'}],importInfo:{raw:'原始导入'},createdAt:'2026-01-01'});
    const base='http://127.0.0.1:'+app.port,cookie=(await fetch(base)).headers.get('set-cookie').split(';')[0];
    const get=async p=>{const r=await fetch(base+'/api/'+p,{headers:{cookie}});assert.equal(r.status,200);return r.json();};
    const first=await get('assets?limit=50'),second=await get('assets?limit=50&offset=50');
    assert.equal(first.total,120);assert.equal(first.items.length,50);assert.equal(second.items.length,50);
    assert.equal(new Set([...first.items,...second.items].map(a=>a.id)).size,100);
    for(const a of first.items){assert.equal(a.content,undefined);assert.equal(a.versions,undefined);assert.equal(a.importInfo,undefined);assert.ok(a.excerpt.length<=240);}
    assert.equal((await get('assets?q=needle')).items[0].id,'a120');
    assert.equal((await get('assets?q='+encodeURIComponent('独立负向'))).items[0].id,'a119');
    assert.equal((await get('assets?tag='+encodeURIComponent('街道')+'&folder=f1&scope=favorite')).total,1);
    assert.equal((await get('assets?scope=trash')).total,1);assert.equal((await get('assets?folder=unfiled')).total,119);
    const state=await get('state');assert.equal(state.assets.length,0);assert.equal(state.assetMeta.total,120);assert.equal(state.assetMeta.favorite,1);
    assert.equal(state.assetMeta.folders.f1.active,1);assert.ok(state.assetMeta.tags.includes('街道'));
    const detail=await get('assets/a120');assert.ok(detail.content.endsWith('NEEDLE末尾'));assert.equal(detail.importInfo.raw,'原始导入');
    assert.ok(JSON.stringify(first).length<60000);
    const titles=['中山','阿尔法','北京','Alpha'].map((title,n)=>app.store.put('assets',{id:'sort'+n,title,content:'排序专用'}));
    assert.deepEqual((await get('assets?q='+encodeURIComponent('排序专用')+'&sort=title')).items.map(a=>a.title),titles.map(a=>a.title).sort((a,b)=>a.localeCompare(b,'zh-CN')));
    app.store.put('assets',{...titles[0],title:'Aardvark'});
    assert.deepEqual((await get('assets?q='+encodeURIComponent('排序专用')+'&sort=title')).items.map(a=>a.title),['Aardvark',...titles.slice(1).map(a=>a.title)].sort((a,b)=>a.localeCompare(b,'zh-CN')));
    app.store.put('shared',{id:'collection-probe',sourceId:'s05',originId:'42'});
    app.store.put('assets',{id:'collected',source:{sourceId:'s05',originId:42},deletedAt:'2026-01-01'});
    assert.equal((await get('assets/collection-status?ids=collection-probe'))['collection-probe'].deletedAt,'2026-01-01');
    app.store.put('assets',{id:'collected',source:{sourceId:'s05',originId:42},deletedAt:null});
    assert.equal((await get('assets/collection-status?ids=collection-probe'))['collection-probe'].deletedAt,null);
    assert.equal(Object.keys(await get('assets/collection-status?ids='+['collection-probe',...Array.from({length:200},(_,i)=>'uncollected'+i)].join(','))).length,201,'200张卡片与独立详情状态仍有界可读');
  }finally{await app.close();}
});
