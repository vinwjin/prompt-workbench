import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync,mkdtempSync } from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { createWorkbench } from '../src/server.js';
import { Lifecycle } from '../src/lifecycle.js';
import { setTimeout as sleep } from 'node:timers/promises';
const dir=()=>{mkdirSync('work',{recursive:true});return mkdtempSync(path.resolve('work','integration-'));};
async function session(app){const url=`http://127.0.0.1:${app.port}`;const root=await fetch(url);const cookie=root.headers.get('set-cookie').split(';')[0];return async(route,body,options={})=>{const response=await fetch(url+'/api/'+route,{method:body?'POST':'GET',headers:{Cookie:cookie,...(body?{'Content-Type':'application/json'}:{}),...options.headers},body:body?JSON.stringify(body):undefined});return {status:response.status,data:await response.json()};};}
async function until(fn,timeout=5000){const end=Date.now()+timeout;while(Date.now()<end){const r=await fn();if(r)return r;await sleep(20);}throw new Error('test timeout');}

test('工作台会话防跨站；密钥不回传；任务/资产/草稿跨重启保存',async()=>{
  const dataDir=dir();const generator=async()=>({output:'优化后的中文提示词',usage:{completion_tokens:12}});let app=await createWorkbench({port:0,dataDir,generator});let call=await session(app);
  try{
    const anon=await fetch(`http://127.0.0.1:${app.port}/api/state`);assert.equal(anon.status,401);
    assert.equal((await call('state',null,{headers:{Origin:'https://example.org'}})).status,403);
    const r=await call('providers',{name:'测试连接',protocol:'openai',baseUrl:'http://127.0.0.1:9999/v1',model:'mock',apiKey:'fake-test-key'});assert.equal(r.status,200);assert.equal(r.data.hasKey,true);assert.equal(r.data.apiKey,undefined);assert.equal(r.data.sealedKey,undefined);
    const p=r.data;const j=(await call('jobs',{providerId:p.id,templateId:'optimize',input:'测试中文数据',variables:{language:'中文'}})).data;
    await until(async()=>{const r=await call('jobs/'+j.id);return r.data.status==='succeeded'&&r.data;});
    const saved=await call('assets',{title:'收藏',content:'版本一'});await call('assets',{...saved.data,content:'版本二'});
    assert.equal((await call('state')).data.assets[0].versions[0].content,'版本一');
    await call('draft',{input:'未完成的草稿',providerId:p.id,templateId:'optimize'});
    const exported=(await call('export')).data;assert.ok(!JSON.stringify(exported).includes('fake-test-key'));
    await app.close();app=await createWorkbench({port:0,dataDir,generator});call=await session(app);
    const state=(await call('state')).data;assert.equal(state.assets[0].content,'版本二');assert.equal(state.draft.input,'未完成的草稿');assert.equal(state.jobs[0].output,'优化后的中文提示词');assert.equal(state.providers.find(x=>x.id===p.id).hasKey,true);
  }finally{await app.close();}
});
test('取消运行与排队任务；不会自动重试；运行期间配置不可覆写',async()=>{
  let calls=0;const app=await createWorkbench({port:0,dataDir:dir(),generator:async(p,b,signal)=>{calls++;await sleep(1000,null,{signal});return {output:'结果'};}});const call=await session(app);
  try{const p=(await call('providers',{name:'mock',protocol:'openai',baseUrl:'http://127.0.0.1:9999/v1',model:'test'})).data;
    const input={providerId:p.id,templateId:'optimize',input:'测试'};const a=(await call('jobs',input)).data;const b=(await call('jobs',input)).data;
    assert.equal((await call('providers',{...p,name:'覆盖'})).status,400);
    await call('jobs/'+b.id+'/cancel',{});await call('jobs/'+a.id+'/cancel',{});
    await until(async()=>(await call('jobs/'+a.id)).data.status==='cancelled');assert.equal((await call('jobs/'+b.id)).data.status,'cancelled');assert.equal(calls,1);
  }finally{await app.close();}
});
test('Router 使用权、任务后释放读回、取消后繁忙拒绝卸载',async()=>{
  let state='unloaded',busy=false,unloads=0;const server=http.createServer(async(req,res)=>{let b='';for await(const c of req)b+=c;const body=b?JSON.parse(b):{};res.setHeader('Content-Type','application/json');
    if(req.url==='/v1/models')return res.end(JSON.stringify({data:[{id:'model-a',status:{value:state}}]}));
    if(req.url==='/models/load'){assert.equal(body.model,'model-a');state='loaded';return res.end('{}');}
    if(req.url==='/models/unload'){unloads++;state='unloaded';return res.end('{}');}
    if(req.url.startsWith('/slots'))return res.end(JSON.stringify([{is_processing:busy}]));res.statusCode=404;res.end('{}');});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const p={id:'r',protocol:'router',baseUrl:`http://127.0.0.1:${server.address().port}/v1`,model:'model-a'},l=new Lifecycle(dir());
  try{const result=await l.withModel(p,async()=>({output:'test'}),true);assert.equal(result.release.verified,true);assert.equal(state,'unloaded');assert.equal(unloads,1);
    state='loaded';await assert.rejects(l.load(p),/外部/);assert.equal((await l.unload(p)).released,false);assert.equal(unloads,1);
    state='unloaded';await l.load(p);busy=true;await assert.rejects(l.unload(p),/空闲/);assert.equal(unloads,1);assert.equal(l.owned.has(l.key(p)),true);
    busy=false;await l.unload(p);assert.equal(state,'unloaded');
    const keep=await l.withModel(p,async()=>({output:'kept'}),false);assert.equal(keep.release.released,false);assert.equal(l.lastRelease.released,false);await l.unload(p);
  }finally{await new Promise(r=>server.close(r));}
});
test('停止自启动 Ollama 前再次拒绝外部已加载模型',async()=>{
  const server=http.createServer((req,res)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({models:[{name:'external-model'}]}));});await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const p={id:'ollama-test',protocol:'ollama',baseUrl:`http://127.0.0.1:${server.address().port}`,model:'own-model'},l=new Lifecycle(dir());let stopped=false;l.started.add(p.id);l.children.set(p.id,{});l.stopChild=async()=>{stopped=true;};
  try{await assert.rejects(l.stop(p),/外部模型/);assert.equal(stopped,false);assert.equal(l.started.has(p.id),true);}finally{await new Promise(r=>server.close(r));}
});
test('生命周期期间不能删除连接；上游密钥回显被隐藏；关闭超时后能继续生成',async()=>{
  const server=http.createServer((req,res)=>{res.writeHead(401,{'Content-Type':'application/json'});res.end(JSON.stringify({error:{message:'echo fake-review-key'}}));});await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const app=await createWorkbench({port:0,dataDir:dir(),vault:{seal:async s=>s,open:async s=>s||''},generator:async()=>({output:'关闭恢复结果'})});const call=await session(app);const shutdown=app.jobs.shutdown.bind(app.jobs);
  try{
    const p=(await call('providers',{name:'test',protocol:'openai',baseUrl:`http://127.0.0.1:${server.address().port}/v1`,model:'mock',apiKey:'fake-review-key'})).data;
    const state=await call(`providers/${p.id}/status`);assert.equal(state.status,200);assert.ok(!JSON.stringify(state).includes('fake-review-key'));assert.ok(state.data.error.includes('密钥已隐藏'));
    app.lifecycle.start=async provider=>({error:provider.apiKey});assert.ok(!JSON.stringify(await call(`providers/${p.id}/start`,{})).includes('fake-review-key'));
    app.lifecycle.locked=true;const root=await fetch(`http://127.0.0.1:${app.port}`),cookie=root.headers.get('set-cookie').split(';')[0];const deletion=await fetch(`http://127.0.0.1:${app.port}/api/providers/${p.id}`,{method:'DELETE',headers:{Cookie:cookie}});assert.equal(deletion.status,400);assert.ok(app.store.get('providers',p.id));app.lifecycle.locked=false;
    app.jobs.shutdown=async()=>{app.jobs.closing=true;return false;};await call('shutdown',{});await until(()=>!app.jobs.closing);app.jobs.shutdown=shutdown;
    const j=(await call('jobs',{providerId:p.id,templateId:'optimize',input:'恢复队列'})).data;await until(async()=>(await call('jobs/'+j.id)).data.status==='succeeded');
  }finally{app.lifecycle.locked=false;app.jobs.shutdown=shutdown;await app.close();await new Promise(r=>server.close(r));}
});
