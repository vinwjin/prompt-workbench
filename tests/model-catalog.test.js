import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync} from 'node:fs';
import path from 'node:path';
import {createWorkbench} from './source-fixtures.js';
function directory(){const root=path.resolve(process.env.PW_TEST_ROOT||'work');mkdirSync(root,{recursive:true});return mkdtempSync(path.join(root,'model-catalog-'));}
const vault={seal:async s=>s,open:async s=>s};
async function client(app){const base='http://127.0.0.1:'+app.port,cookie=(await fetch(base)).headers.get('set-cookie').split(';')[0];return async route=>{const r=await fetch(base+'/api/'+route,{headers:{cookie}});return {status:r.status,data:await r.json()};};}
function account(app,platform,extra={}){return app.store.put('providers',{protocol:'account',accountPlatform:platform,accountRegion:'cn',accountEpoch:'test-epoch',baseUrl:'https://example.invalid',model:'',sealedKey:JSON.stringify({platform,region:extra.accountRegion||'cn',accessToken:'synthetic-only',expiresAt:Date.now()+3600000,projectId:'test-project'}),...extra});}

test('Grok真实目录形状保留名称说明和上下文，不添预置模型或推测图片能力',async()=>{
  let calls=0;const app=await createWorkbench({port:0,dataDir:directory(),vault,accountFetcher:async(url)=>{calls++;assert.equal(url,'https://cli-chat-proxy.grok.com/v1/models');return Response.json({data:[{id:'grok-4.7',model:'grok-4.7',name:'Grok 4.7',description:'Server description',context_window:256000,context_windows:[256000,500000],supports_reasoning_effort:true,reasoning_efforts:[{value:'high',label:'High',default:true},{value:'low',label:'Low'}],access_token:'must-not-leak'}]});}}),call=await client(app);
  try{
    const p=account(app,'grok');assert.equal((await call('providers/'+p.id+'/models')).status,200);const catalog=(await call('providers/'+p.id+'/catalog')).data;
    assert.equal(catalog.models.length,1);const m=catalog.models[0];assert.equal(m.id,'grok-4.7');assert.equal(m.displayName,'Grok 4.7');assert.equal(m.description,'Server description');assert.equal(m.contextWindow,256000);assert.deepEqual(m.contextWindows,[256000,500000]);assert.equal(m.reasoningEfforts[0].value,'high');assert.equal(m.source,'upstream');assert.equal(m.vision,null);assert.equal(JSON.stringify(catalog).includes('must-not-leak'),false);assert.equal(calls,1);
  }finally{await app.close();}
});

test('ChatGPT保留账号目录顺序和显示名，模型调用使用slug且隐藏项不进入菜单',async()=>{
  const app=await createWorkbench({port:0,dataDir:directory(),vault,accountFetcher:async()=>Response.json({models:[{id:'internal-id',slug:'call-slug',display_name:'模型甲',visibility:'list',input_modalities:['text','image']},{slug:'hidden',visibility:'hide'},{slug:'second',display_name:'模型乙',visibility:'list'},{slug:'call-slug',visibility:'list'},{slug:{bad:true},visibility:'list'}]})}),call=await client(app);
  try{const p=account(app,'chatgpt');assert.equal((await call('providers/'+p.id+'/models')).status,200);const c=(await call('providers/'+p.id+'/catalog')).data;assert.deepEqual(c.models.map(m=>m.id),['call-slug','second']);assert.equal(c.models[0].displayName,'模型甲');assert.equal(c.models[0].vision,true);assert.equal(c.models[1].vision,null);}finally{await app.close();}
});

test('WorkBuddy国际目录优先真实v3配置，保留名称上限且禁用多模态优先于图片声明',async()=>{
  const urls=[];const app=await createWorkbench({port:0,dataDir:directory(),vault,accountFetcher:async url=>{urls.push(url);return Response.json({code:0,data:{models:[{id:'wb-a',name:'模型甲',maxInputTokens:64000,maxOutputTokens:4096,supportsImages:true,disabledMultimodal:true},{id:'wb-b',name:'模型乙',supportsImages:true}]}});}}),call=await client(app);
  try{const p=account(app,'workbuddy',{accountRegion:'intl'});assert.equal((await call('providers/'+p.id+'/models')).status,200);const c=(await call('providers/'+p.id+'/catalog')).data;assert.equal(urls[0],'https://www.workbuddy.ai/v3/config');assert.equal(urls.length,1);assert.equal(c.models[0].displayName,'模型甲');assert.equal(c.models[0].contextWindow,64000);assert.equal(c.models[0].maxOutputTokens,4096);assert.equal(c.models[0].vision,false);assert.equal(c.models[1].vision,true);}finally{await app.close();}
});

test('Antigravity项目目录保留显示名及ID，损坏模型结构失败且不替换旧缓存',async()=>{
  let broken=false;const app=await createWorkbench({port:0,dataDir:directory(),vault,accountFetcher:async()=>Response.json({models:broken?[{displayName:'伪模型'}]:{'ag-a':{displayName:'模型甲',supportsImages:true,inputTokenLimit:128000},'ag-b':{displayName:'模型乙',inputModalities:['text']}}})}),call=await client(app);
  try{const p=account(app,'antigravity');assert.equal((await call('providers/'+p.id+'/models')).status,200);let c=(await call('providers/'+p.id+'/catalog')).data;assert.equal(c.models[0].displayName,'模型甲');assert.equal(c.models[0].contextWindow,128000);assert.equal(c.models[1].vision,false);broken=true;assert.equal((await call('providers/'+p.id+'/models')).status,400);c=(await call('providers/'+p.id+'/catalog')).data;assert.deepEqual(c.models.map(m=>m.id),['ag-a','ag-b']);}finally{await app.close();}
});

test('同一账号重开读取时旧目录迟到不能覆盖新目录或检查记录',async()=>{
  let release,reads=0;const app=await createWorkbench({port:0,dataDir:directory(),vault,accountFetcher:async()=>{reads++;if(reads===1){await new Promise(r=>release=r);return Response.json({data:[{id:'old-model'}]});}return Response.json({data:[{id:'new-model'}]});}}),call=await client(app);
  try{const p=account(app,'grok'),old=call('providers/'+p.id+'/models');for(let i=0;i<100&&!release;i++)await new Promise(r=>setTimeout(r,5));assert.ok(release);assert.equal((await call('providers/'+p.id+'/models')).status,200);release();await old;const c=(await call('providers/'+p.id+'/catalog')).data;assert.deepEqual(c.models.map(m=>m.id),['new-model']);assert.equal(c.check.modelCount,1);}finally{release?.();await app.close();}
});

test('旧目录请求迟到失败不覆盖新成功检查，手动与历史默认不冒充上游',async()=>{
  let release,reads=0;const app=await createWorkbench({port:0,dataDir:directory(),vault,accountFetcher:async()=>{reads++;if(reads===1){await new Promise(r=>release=r);return new Response('',{status:503});}return Response.json({data:[{id:'live-model'}]});}}),call=await client(app);
  try{const p=account(app,'grok',{model:'retained-default',modelPreferences:{'manual-model':{manual:true}}}),old=call('providers/'+p.id+'/models');for(let i=0;i<100&&!release;i++)await new Promise(r=>setTimeout(r,5));assert.ok(release);assert.equal((await call('providers/'+p.id+'/models')).status,200);release();assert.equal((await old).status,400);const c=(await call('providers/'+p.id+'/catalog')).data;assert.equal(c.check.online,true);assert.deepEqual(c.models.map(m=>[m.id,m.source]),[['live-model','upstream'],['manual-model','manual'],['retained-default','retained']]);}finally{release?.();await app.close();}
});
