import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import path from 'node:path';
import {createWorkbench} from '../src/server.js';
import {FEEDS} from '../src/sources.js';
import {ANTIGRAVITY_CLIENT,ANTIGRAVITY_CLIENT_SECRET} from '../src/account-oauth.js';

test('公开发行受限来源正文和图片均拒绝联网，文件导入仍可离线收藏',async()=>{
  let requests=0;const fail=async()=>{requests++;throw Error('不得请求外部');};
  const app=await createWorkbench({port:0,dataDir:mkdtempSync(path.resolve(process.env.PW_TEST_ROOT||'work','public-policy-')),sourceFetcher:fail,imageFetcher:fail});
  try{
    for(const id of ['mother','s31','s38','s39','s40']){assert.equal(FEEDS.find(f=>f.id===id).syncable,false);await assert.rejects(app.sources.sync(id),/未确认/);}
    await assert.rejects(app.sources.syncHistory(),/未确认/);
    const root='http://127.0.0.1:'+app.port,cookie=(await fetch(root)).headers.get('set-cookie').split(';')[0];
    assert.equal((await fetch(root+'/api/sources/s38/history',{method:'POST',headers:{cookie,'Content-Type':'application/json'},body:'{}'})).status,400);
    const a=app.store.put('shared',{sourceId:'mother',originId:'public-denied',title:'来源',content:'',coverUrl:'https://img.alicdn.com/test.png',detailLoaded:false});
    assert.equal((await fetch(root+'/api/shared/'+a.id,{headers:{cookie}})).status,400);
    assert.equal((await fetch(root+'/api/shared/'+a.id+'/image',{headers:{cookie}})).status,400);
    app.sources.importFile('mother',{text:'完整的人工确认文件导入正文。',fileName:'synthetic.txt'});
    const row=app.sources.list({source:'mother'}).items.find(r=>r.detailLoaded);assert.ok(row);
    const collected=await fetch(root+'/api/shared/'+row.id+'/collect',{method:'POST',headers:{cookie,'Content-Type':'application/json'},body:'{}'});assert.equal(collected.status,200);assert.equal(requests,0);
  }finally{await app.close();}
});
test('Antigravity公开注册仅来自维护者环境配置，不捆绑客户端秘密',()=>{
  assert.equal(ANTIGRAVITY_CLIENT,process.env.PW_ANTIGRAVITY_OAUTH_CLIENT_ID||'');
  assert.equal(ANTIGRAVITY_CLIENT_SECRET,process.env.PW_ANTIGRAVITY_OAUTH_CLIENT_SECRET||'');
});
