import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync,mkdtempSync } from 'node:fs';
import path from 'node:path';
import { summarizeAsset } from '../src/store.js';
import { createWorkbench } from './source-fixtures.js';
const temp=()=>{mkdirSync('work',{recursive:true});return mkdtempSync(path.resolve(process.env.PW_TEST_ROOT||'work','assets-page-'));};

test('资产摘要去掉修订历史与导入原文，保留正文供筛选与预览',()=>{
  const s=summarizeAsset({id:'a',title:'标题',content:'正文',negative:'负向',versions:[{content:'旧版'}],importInfo:{raw:'导入原文',fileName:'x.txt'},tags:'标签',media:[{id:'m'}]});
  assert.equal(s.content,'正文');assert.equal(s.negative,'负向');assert.equal(s.title,'标题');
  assert.equal(s.versions,undefined);assert.equal(s.importInfo,undefined);assert.equal(s.versionsCount,1);
});

test('资产详情接口返回全文，state 列表只下发摘要',async()=>{
  const app=await createWorkbench({port:0,dataDir:temp()});
  try{
    const base='http://127.0.0.1:'+app.port,cookie=(await fetch(base)).headers.get('set-cookie').split(';')[0];
    const post=async body=>(await fetch(base+'/api/assets',{method:'POST',headers:{cookie,'Content-Type':'application/json'},body:JSON.stringify(body)})).json();
    const saved=await post({title:'资产',content:'正文一'});
    await post({...saved,content:'正文二'});
    const detail=await (await fetch(base+'/api/assets/'+saved.id,{headers:{cookie}})).json();
    assert.equal(detail.content,'正文二');assert.equal(detail.versions[0].content,'正文一');
    const state=await (await fetch(base+'/api/state',{headers:{cookie}})).json();
    assert.deepEqual(state.assets,[]);assert.equal(state.assetMeta.total,1);
    const page=await (await fetch(base+'/api/assets',{headers:{cookie}})).json();const summary=page.items.find(a=>a.id===saved.id);
    assert.equal(summary.excerpt,'正文二');assert.equal(summary.content,undefined);assert.equal(summary.versions,undefined);assert.equal(summary.importInfo,undefined);assert.equal(summary.versionsCount,1);
    assert.equal((await fetch(base+'/api/assets/nope',{headers:{cookie}})).status,400);
  }finally{await app.close();}
});
