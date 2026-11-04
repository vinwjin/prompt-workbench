import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,readFileSync} from 'node:fs';
import path from 'node:path';
import {createWorkbench} from './source-fixtures.js';
import {hydrateImages} from '../src/job-images.js';
import {externalizeImages} from '../src/job-images.js';
import {Readable} from 'node:stream';
const temp=()=>{mkdirSync('work',{recursive:true});return mkdtempSync(path.resolve(process.env.PW_TEST_ROOT||'work','job-images-'));};
const png=readFileSync('public/icon-256.png');
const dataUrl='data:image/png;base64,'+png.toString('base64');

test('取消、过期待确认素材和导入回滚均保留已持久任务引用的同哈希参考图',async()=>{
  for(const action of ['discard','expire','rollback']){
    const app=await createWorkbench({port:0,dataDir:temp()});
    try{
      const staged=await app.assetMedia.upload(Readable.from([png]),'fixture.png');
      const images=externalizeImages(app.store,[{name:'fixture.png',dataUrl}]);
      assert.equal(images[0].id,staged.id);
      const job=app.store.put('jobs',{status:'succeeded',input:'模拟输入',output:'模拟结果',images});
      if(action==='discard')app.assetMedia.discard(staged.uploadId);
      else if(action==='expire'){app.assetMedia.staged.get(staged.uploadId).expires=0;app.assetMedia.expire();}
      else app.assetMedia.rollbackImport([staged.id]);
      assert.equal(hydrateImages(app.store,app.store.get('jobs',job.id).images)[0].dataUrl,dataUrl);
      const base='http://127.0.0.1:'+app.port,cookie=(await fetch(base)).headers.get('set-cookie').split(';')[0];
      const exported=await(await fetch(base+'/api/export',{headers:{cookie}})).json();
      assert.ok(exported.mediaFiles.some(f=>f.id===staged.id&&f.base64===png.toString('base64')));
    }finally{await app.close();}
  }
});

test('任务参考图外置为哈希引用，生成读回字节一致；导出导入跨库字节一致',async()=>{
  const app=await createWorkbench({port:0,dataDir:temp(),generator:async(p,input)=>({output:'模拟结果'})});
  try{
    const base='http://127.0.0.1:'+app.port,cookie=(await fetch(base)).headers.get('set-cookie').split(';')[0];
    const call=async(route,b)=>{const r=await fetch(base+'/api/'+route,{method:b?'POST':'GET',headers:{cookie,...(b?{'Content-Type':'application/json'}:{})},body:b?JSON.stringify(b):undefined});return {status:r.status,data:await r.json()};};
    const p=(await call('providers',{name:'m',protocol:'openai',baseUrl:'http://127.0.0.1:19991/v1',model:'x'})).data;
    const j=(await call('jobs',{providerId:p.id,templateId:'optimize',input:'测试',images:[{name:'a.png',dataUrl}]})).data;
    for(let i=0;i<100&&app.store.get('jobs',j.id).status!=='succeeded';i++)await new Promise(r=>setTimeout(r,10));
    const saved=app.store.get('jobs',j.id);
    assert.ok(saved.images[0].id,'保存后应为哈希引用');assert.equal(saved.images[0].dataUrl,undefined,'不再保存 base64');
    const hydrated=hydrateImages(app.store,saved.images);assert.ok(Buffer.from(hydrated[0].dataUrl.split(',')[1],'base64').equals(png),'读回字节一致');
    // 导出并跨库导入
    const exported=(await call('export')).data;assert.ok(exported.mediaFiles.some(f=>f.base64.length>0),'导出含任务图片字节');
    const app2=await createWorkbench({port:0,dataDir:temp()});
    try{
      const b2='http://127.0.0.1:'+app2.port,c2=(await fetch(b2)).headers.get('set-cookie').split(';')[0];
      const r2=await fetch(b2+'/api/import',{method:'POST',headers:{cookie:c2,'Content-Type':'application/json'},body:JSON.stringify(exported)});assert.equal(r2.status,200);
      const moved=app2.store.get('jobs',j.id);const h2=hydrateImages(app2.store,moved.images);assert.ok(Buffer.from(h2[0].dataUrl.split(',')[1],'base64').equals(png),'跨库恢复字节一致');
    }finally{await app2.close();}
  }finally{await app.close();}
});

test('坏哈希与缺文件导入被拒；旧 dataUrl 备份读取兼容',async()=>{
  const app=await createWorkbench({port:0,dataDir:temp(),generator:async()=>({output:'x'})});
  try{
    const base='http://127.0.0.1:'+app.port,cookie=(await fetch(base)).headers.get('set-cookie').split(';')[0];
    const call=async(route,b)=>{const r=await fetch(base+'/api/'+route,{method:b?'POST':'GET',headers:{cookie,...(b?{'Content-Type':'application/json'}:{})},body:b?JSON.stringify(b):undefined});return {status:r.status,data:await r.json()};};
    const p=(await call('providers',{name:'m',protocol:'openai',baseUrl:'http://127.0.0.1:19992/v1',model:'x'})).data;
    await call('jobs',{providerId:p.id,templateId:'optimize',input:'x',images:[{name:'a.png',dataUrl}]});
    const exported=(await call('export')).data;
    // 旧 dataUrl 格式 job 仍可读（不经外置直接 put）
    app.store.put('jobs',{id:'legacy',status:'succeeded',input:'旧',images:[{name:'b.png',dataUrl}],createdAt:new Date().toISOString()});
    assert.equal(hydrateImages(app.store,app.store.get('jobs','legacy').images)[0].dataUrl,dataUrl,'旧格式原样保留');
    // 坏哈希导入拒绝
    const broken=structuredClone(exported);const img=broken.mediaFiles.find(f=>f.base64&&!f.base64.includes('bad'));if(img)img.base64=Buffer.from('<bad>').toString('base64');
    const b2=await createWorkbench({port:0,dataDir:temp()});const c2=(await fetch('http://127.0.0.1:'+b2.port)).headers.get('set-cookie').split(';')[0];
    try{const r=await fetch('http://127.0.0.1:'+b2.port+'/api/import',{method:'POST',headers:{cookie:c2,'Content-Type':'application/json'},body:JSON.stringify(broken)});assert.equal(r.status,400);}finally{await b2.close();}
  }finally{await app.close();}
});
