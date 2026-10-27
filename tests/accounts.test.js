import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync} from 'node:fs';
import path from 'node:path';
import {generateKeyPairSync,sign} from 'node:crypto';
import {createWorkbench} from './source-fixtures.js';

function directory(){const root=path.resolve(process.env.PW_TEST_ROOT||'work');mkdirSync(root,{recursive:true});return mkdtempSync(path.join(root,'accounts-'));}
async function client(app){const base='http://127.0.0.1:'+app.port,cookie=(await fetch(base)).headers.get('set-cookie').split(';')[0];return async(route,body,method)=>{const response=await fetch(base+'/api/'+route,{method:method||(body?'POST':'GET'),headers:{cookie,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});return {status:response.status,data:await response.json()};};}
const response=data=>Response.json(data);

test('Grok slow_down 是正常待授权响应，清除暂时错误并保留服务要求的间隔',async()=>{
  let now=Date.now(),fail=true;const app=await createWorkbench({port:0,dataDir:directory(),accountNow:()=>now,accountFetcher:async(url)=>{
    if(String(url).endsWith('openid-configuration'))return response({issuer:'https://auth.x.ai',device_authorization_endpoint:'https://auth.x.ai/oauth2/device/code',token_endpoint:'https://auth.x.ai/oauth2/token'});
    if(String(url).endsWith('device/code'))return response({device_code:'test-device',user_code:'TEST',verification_uri:'https://accounts.x.ai/oauth2/device',expires_in:1800,interval:5});
    if(fail)throw new TypeError('temporary network failure');return response({error:'slow_down'});
  }}),call=await client(app);
  try{
    const start=(await call('accounts/login',{platform:'grok'})).data;
    for(let i=0;i<4;i++){
      now+=65000;fail=true;let r=(await call('accounts/login/'+start.id)).data;assert.equal(r.status,'pending');assert.equal(r.retryCount,1);
      now+=65000;fail=false;r=(await call('accounts/login/'+start.id)).data;assert.equal(r.status,'pending');assert.equal(r.retryCount,0);assert.equal(r.retryable,false);assert.equal(r.message,'');assert.equal(r.errorCode,undefined);assert.equal(r.interval,10+i*5);assert.equal(r.nextPollAt,now+r.interval*1000);
    }
  }finally{await app.close();}
});

test('Grok 已取得令牌后身份服务短暂断网可继续验证，不重复申请令牌或泄露凭据',async()=>{
  let now=Date.now(),grants=0,identities=0;const vault={seal:async s=>Buffer.from(s).toString('base64'),open:async s=>s?Buffer.from(s,'base64').toString():''};
  const app=await createWorkbench({port:0,dataDir:directory(),vault,accountNow:()=>now,accountFetcher:async(url)=>{
    url=String(url);if(url.endsWith('openid-configuration'))return response({issuer:'https://auth.x.ai',device_authorization_endpoint:'https://auth.x.ai/oauth2/device/code',token_endpoint:'https://auth.x.ai/oauth2/token',userinfo_endpoint:'https://auth.x.ai/userinfo'});
    if(url.endsWith('device/code'))return response({device_code:'private-device',user_code:'ABCD-EFGH',verification_uri:'https://accounts.x.ai/oauth2/device',expires_in:1800,interval:5});
    if(url.endsWith('/token')){grants++;return response({access_token:'private-issued-access',refresh_token:'private-issued-refresh',expires_in:3600});}
    identities++;if(identities===1)throw new TypeError('network failed private-issued-access');return response({sub:'verified-account',email:'verified@example.test'});
  }}),call=await client(app);
  try{
    const start=(await call('accounts/login',{platform:'grok'})).data;now+=6000;
    const waiting=(await call('accounts/login/'+start.id)).data;assert.equal(waiting.status,'pending');assert.equal(waiting.phase,'verifying-identity');assert.equal(waiting.retryable,true);assert.equal(waiting.retryCount,1);assert.equal(JSON.stringify(waiting).includes('private-'),false);assert.equal(grants,1);
    now+=10000;const done=(await call('accounts/login/'+start.id)).data;assert.equal(done.status,'succeeded');assert.equal(grants,1);assert.equal(identities,2);assert.equal(app.store.list('providers').length,1);
  }finally{await app.close();}
});

test('WorkBuddy 临时503按服务间隔恢复，正常等待清零，连续失败有界且取消不继续轮询',async()=>{
  let now=Date.now(),polls=0,mode='unavailable';const app=await createWorkbench({port:0,dataDir:directory(),accountNow:()=>now,accountFetcher:async(url)=>{
    if(String(url).includes('/auth/state?'))return response({code:0,data:{state:'test-state',authUrl:'https://www.workbuddy.cn/login?state=test-state'}});
    polls++;return mode==='unavailable'?new Response('bad gateway private-error',{status:503,headers:{'retry-after':'12'}}):response({code:11217});
  }}),call=await client(app);
  try{
    const start=(await call('accounts/login',{platform:'workbuddy'})).data;now+=3000;let r=(await call('accounts/login/'+start.id)).data;assert.equal(r.status,'pending');assert.equal(r.retryCount,1);assert.equal(r.errorCode,'ACCOUNT_HTTP_503');assert.equal(r.nextPollAt,now+12000);assert.equal(JSON.stringify(r).includes('private-error'),false);
    await call('accounts/login/'+start.id);assert.equal(polls,1);now+=13000;mode='waiting';r=(await call('accounts/login/'+start.id)).data;assert.equal(r.retryCount,0);assert.equal(r.retryable,false);
    mode='unavailable';for(let i=0;i<4;i++){now+=65000;r=(await call('accounts/login/'+start.id)).data;}assert.equal(r.status,'failed');assert.equal(r.retryable,false);const count=polls;now+=65000;await call('accounts/login/'+start.id);assert.equal(polls,count);
    const second=(await call('accounts/login',{platform:'workbuddy'})).data;await call('accounts/login/'+second.id,undefined,'DELETE');now+=65000;assert.equal((await call('accounts/login/'+second.id)).data.status,'cancelled');assert.equal(polls,count);
  }finally{await app.close();}
});

test('Antigravity 内置 Google 授权发现账号项目，原图进入独立 Gemini 请求且读取目录不生成',async()=>{
  let authorization,generations=0;const vault={seal:async s=>Buffer.from(s).toString('base64'),open:async s=>s?Buffer.from(s,'base64').toString():''};
  const app=await createWorkbench({port:0,dataDir:directory(),vault,accountFetcher:async(url,options)=>{
    url=String(url);
    if(url==='https://oauth2.googleapis.com/token'){const form=new URLSearchParams(options.body);assert.ok(form.get('code_verifier'));assert.equal(form.get('redirect_uri'),authorization.searchParams.get('redirect_uri'));return response({access_token:'ag-private-access',refresh_token:'ag-private-refresh',expires_in:3600});}
    assert.equal(options.headers.Authorization,'Bearer ag-private-access');
    assert.match(options.headers['User-Agent'],/^antigravity\/hub\/2\.9\.1 /);
    if(url.startsWith('https://www.googleapis.com/oauth2/v2/userinfo'))return response({id:'google-sub',email:'ag@example.test',verified_email:true});
    if(url.endsWith(':loadCodeAssist'))return response({cloudaicompanionProject:{id:'account-project'}});
    if(url.endsWith(':fetchAvailableModels'))return response({models:{'gemini-test':{displayName:'Gemini',supportsImages:true}}});
    assert.equal(url,'https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse');generations++;const body=JSON.parse(options.body);assert.equal(body.project,'account-project');assert.equal(body.request.contents[0].parts[1].inlineData.data,'AAAA');assert.ok(body.request.sessionId);assert.equal(body.request.contents.length,1);
    return new Response('data: '+JSON.stringify({response:{candidates:[{content:{parts:[{text:'Antigravity 图片回复'}]},finishReason:'STOP'}],usageMetadata:{candidatesTokenCount:5}}})+'\n\n',{headers:{'content-type':'text/event-stream'}});
  }}),call=await client(app);
  try{
    const start=await call('accounts/login',{platform:'antigravity'});assert.equal(start.status,200);authorization=new URL(start.data.authorizationUrl);assert.equal(authorization.hostname,'accounts.google.com');
    const callback=new URL(authorization.searchParams.get('redirect_uri'));callback.searchParams.set('state',authorization.searchParams.get('state'));callback.searchParams.set('code','google-code');assert.equal((await fetch(callback)).status,200);
    const done=(await call('accounts/login/'+start.data.id)).data;assert.equal(done.status,'succeeded');const catalog=await call('providers/'+done.providerId+'/models');assert.equal(catalog.status,200);assert.equal(catalog.data.models[0].id,'gemini-test');assert.equal(catalog.data.models[0].vision,true);assert.equal(generations,0);
    const state=(await call('state')).data,job=(await call('jobs',{providerId:done.providerId,model:'gemini-test',templateId:state.templates[0].id,input:'读图',images:[{dataUrl:'data:image/png;base64,AAAA'}]})).data;for(let i=0;i<200&&app.jobs.active;i++)await new Promise(r=>setTimeout(r,5));assert.equal(app.store.get('jobs',job.id).status,'succeeded');assert.equal(generations,1);
  }finally{await app.close();}
});

test('WorkBuddy 国内与国际内置登录独立，凭据固定到所属区域且带图创作不重试',async()=>{
  let now=Date.now(),generations=0;const vault={seal:async s=>Buffer.from(s).toString('base64'),open:async s=>s?Buffer.from(s,'base64').toString():''};
  const app=await createWorkbench({port:0,dataDir:directory(),vault,accountNow:()=>now,accountFetcher:async(url,options)=>{
    const u=new URL(url),suffix=u.hostname.endsWith('.cn')?'cn':'intl';
    if(u.pathname.endsWith('/auth/state'))return response({code:0,data:{state:'wb-state-'+suffix,authUrl:'https://'+u.hostname+'/login?state=wb-state-'+suffix}});
    if(u.pathname.endsWith('/auth/token'))return response({code:0,data:{accessToken:'wb-access-'+suffix,refreshToken:'wb-refresh-'+suffix,expiresIn:3600,uid:'wb-'+suffix,domain:u.hostname,nickname:'WB '+suffix}});
    assert.equal(options.headers.Authorization,'Bearer wb-access-'+suffix);assert.equal(options.headers['X-User-Id'],'wb-'+suffix);
    if(u.pathname.endsWith('/models')||u.pathname==='/v3/config')return response({code:0,data:{models:[{id:'wb-model',name:'WB模型',supportsImages:true,maxInputTokens:10000,maxOutputTokens:4000}]}});
    assert.equal(u.pathname,'/v2/chat/completions');generations++;const body=JSON.parse(options.body);assert.equal(body.messages[1].content[1].image_url.url,'data:image/png;base64,AAAA');
    return new Response('data: '+JSON.stringify({choices:[{delta:{content:'WorkBuddy 回复'},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});
  }}),call=await client(app);
  try{
    const ids=[];for(const region of ['cn','intl']){
      const start=await call('accounts/login',{platform:'workbuddy',region});assert.equal(start.status,200);now+=6000;const done=(await call('accounts/login/'+start.data.id)).data;assert.equal(done.status,'succeeded');ids.push(done.providerId);
      const catalog=await call('providers/'+done.providerId+'/models');assert.equal(catalog.status,200);assert.equal(catalog.data.models[0].vision,true);
    }
    assert.equal(new Set(ids).size,2);assert.equal(generations,0);
    const state=(await call('state')).data;for(const id of ids){const job=(await call('jobs',{providerId:id,model:'wb-model',templateId:state.templates[0].id,input:'读图',images:[{dataUrl:'data:image/png;base64,AAAA'}]})).data;for(let i=0;i<200&&app.jobs.active;i++)await new Promise(r=>setTimeout(r,5));assert.equal(app.store.get('jobs',job.id).status,'succeeded');}
    assert.equal(generations,2);assert.equal(JSON.stringify((await call('export')).data).includes('wb-access-'),false);
  }finally{await app.close();}
});

test('Grok 内置设备登录可取消，设备凭据不下发，取消后不能保存迟到授权',async()=>{
  const calls=[];const app=await createWorkbench({port:0,dataDir:directory(),accountFetcher:async(url,options)=>{
    calls.push({url:String(url),options});
    if(String(url).endsWith('openid-configuration'))return response({issuer:'https://auth.x.ai',device_authorization_endpoint:'https://auth.x.ai/oauth2/device/code',token_endpoint:'https://auth.x.ai/oauth2/token',userinfo_endpoint:'https://auth.x.ai/userinfo'});
    return response({device_code:'private-device-code',user_code:'ABCD-EFGH',verification_uri:'https://accounts.x.ai/oauth2/device',verification_uri_complete:'https://accounts.x.ai/oauth2/device?user_code=ABCD-EFGH',expires_in:1800,interval:5});
  }}),call=await client(app);
  try{
    const started=await call('accounts/login',{platform:'grok',name:'我的 Grok'});
    assert.equal(started.status,200);assert.equal(started.data.status,'pending');assert.equal(started.data.userCode,'ABCD-EFGH');
    assert.equal(JSON.stringify(started).includes('private-device-code'),false);assert.match(started.data.authorizationUrl,/^https:\/\/accounts.x.ai\//);
    assert.equal((await call('accounts/login/'+started.data.id,undefined,'DELETE')).data.status,'cancelled');
    assert.equal((await call('accounts/login/'+started.data.id)).data.status,'cancelled');
    assert.equal(app.store.list('providers').length,0);assert.equal(calls.length,2);
    assert.equal((await call('accounts/login',{platform:'untrusted'})).status,400);
  }finally{await app.close();}
});

test('ChatGPT 动态注册核对 state、PKCE 和签名身份，账号目录与带图 Responses 完整接通',async()=>{
  const {privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:2048});let authorization,exchanges=0,inferences=0;
  const vault={seal:async s=>'sealed:'+Buffer.from(s).toString('base64'),open:async s=>s?Buffer.from(s.slice(7),'base64').toString():''};
  const app=await createWorkbench({port:0,dataDir:directory(),vault,accountFetcher:async(url,options)=>{
    url=String(url);
    if(url.endsWith('/oauth/token')){
      exchanges++;const form=new URLSearchParams(options.body);assert.equal(form.get('client_id'),'oaiapp_test');assert.equal(form.get('redirect_uri'),authorization.searchParams.get('redirect_uri'));assert.ok(form.get('code_verifier').length>=43);assert.equal(form.get('resource'),'https://api.openai.com/v1');
      const head=Buffer.from(JSON.stringify({alg:'RS256',kid:'test-key'})).toString('base64url'),claims=Buffer.from(JSON.stringify({iss:'https://auth.openai.com',aud:'oaiapp_test',sub:'chatgpt-sub',email:'chatgpt@example.test',nonce:authorization.searchParams.get('nonce'),exp:Math.floor(Date.now()/1000)+3600})).toString('base64url');const raw=head+'.'+claims;
      return response({access_token:'chatgpt-private-access',refresh_token:'chatgpt-private-refresh',id_token:raw+'.'+sign('RSA-SHA256',Buffer.from(raw),privateKey).toString('base64url'),expires_in:3600,scope:'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct'});
    }
    if(url.endsWith('/jwks.json'))return response({keys:[{...publicKey.export({format:'jwk'}),kid:'test-key',alg:'RS256',use:'sig'}]});
    assert.equal(options.headers.Authorization,'Bearer chatgpt-private-access');
    if(url.endsWith('/models'))return response({models:[{slug:'gpt-visible',visibility:'list',display_name:'Visible'},{slug:'hidden',visibility:'hidden'}]});
    inferences++;assert.equal(url,'https://api.openai.com/v1/responses');const body=JSON.parse(options.body);assert.equal(body.input[0].content[1].type,'input_image');assert.equal(body.max_output_tokens,undefined);assert.equal(body.temperature,undefined);
    return new Response('data: '+JSON.stringify({type:'response.output_text.delta',delta:'ChatGPT 图片回复'})+'\n\ndata: '+JSON.stringify({type:'response.completed',response:{status:'completed'}})+'\n\n',{headers:{'content-type':'text/event-stream'}});
  }}),call=await client(app);
  try{
    const attempt=(await call('accounts/login',{platform:'chatgpt',name:'ChatGPT账号'})).data;assert.equal(attempt.status,'pending');authorization=new URL(attempt.authorizationUrl);assert.equal(authorization.searchParams.get('client_id'),'dynamic_agent_client');assert.equal(authorization.searchParams.get('agent_name_hint'),'Prompt Workbench');
    const callback=new URL(authorization.searchParams.get('redirect_uri'));callback.searchParams.set('state','wrong');callback.searchParams.set('code','one-code');callback.searchParams.set('client_id','oaiapp_test');
    assert.equal((await fetch(callback)).status,400);assert.equal(exchanges,0);
    callback.searchParams.set('state',authorization.searchParams.get('state'));assert.equal((await fetch(callback)).status,200);
    const done=(await call('accounts/login/'+attempt.id)).data;assert.equal(done.status,'succeeded');assert.equal(exchanges,1);
    const catalog=await call('providers/'+done.providerId+'/models');assert.equal(catalog.status,200);assert.deepEqual(catalog.data.models.map(m=>m.id),['gpt-visible']);assert.equal(inferences,0);
    const state=(await call('state')).data;const started=await call('jobs',{providerId:done.providerId,model:'gpt-visible',templateId:state.templates[0].id,input:'读取图片',images:[{dataUrl:'data:image/png;base64,AAAA'}]});
    for(let i=0;i<200&&app.jobs.active;i++)await new Promise(r=>setTimeout(r,5));assert.equal(app.store.get('jobs',started.data.id).status,'succeeded');assert.equal(inferences,1);
    assert.equal(JSON.stringify((await call('export')).data).includes('chatgpt-private'),false);
  }finally{await app.close();}
});

test('Grok 登录独立加密保存，目录不生成，带图任务走账号 Responses 且退出保留历史',async()=>{
  let now=Date.now(),generations=0;const access='private-grok-access',refresh='private-grok-refresh';
  const vault={seal:async s=>'sealed:'+Buffer.from(s).toString('base64'),open:async s=>s?Buffer.from(s.slice(7),'base64').toString():''};
  const app=await createWorkbench({port:0,dataDir:directory(),vault,accountNow:()=>now,accountFetcher:async(url,options)=>{
    url=String(url);
    if(url.endsWith('openid-configuration'))return response({issuer:'https://auth.x.ai',device_authorization_endpoint:'https://auth.x.ai/oauth2/device/code',token_endpoint:'https://auth.x.ai/oauth2/token',userinfo_endpoint:'https://auth.x.ai/userinfo'});
    if(url.endsWith('device/code'))return response({device_code:'private-device',user_code:'AAAA-BBBB',verification_uri:'https://accounts.x.ai/oauth2/device',expires_in:1800,interval:5});
    if(url.endsWith('/token'))return response({access_token:access,refresh_token:refresh,expires_in:3600});
    assert.equal(options.headers.Authorization,'Bearer '+access);
    if(url.endsWith('/userinfo'))return response({sub:'subject-one',email:'grok@example.test'});
    if(url.endsWith('/models'))return response({data:[{id:'grok-test',input_modalities:['text','image']}]});
    assert.equal(url,'https://cli-chat-proxy.grok.com/v1/responses');generations++;
    const body=JSON.parse(options.body);assert.equal(body.model,'grok-test');assert.equal(body.store,false);assert.equal(body.max_output_tokens,1024);assert.equal(body.input[0].content[1].type,'input_image');assert.equal(body.input[0].content[1].image_url,'data:image/png;base64,AAAA');
    return new Response('data: '+JSON.stringify({type:'response.output_text.delta',delta:'账号图片测试回复'})+'\n\ndata: '+JSON.stringify({type:'response.completed',response:{status:'completed',usage:{output_tokens:4}}})+'\n\n',{headers:{'content-type':'text/event-stream'}});
  }}),call=await client(app);
  try{
    const attempt=(await call('accounts/login',{platform:'grok',name:'独立账号'})).data;now+=6000;
    const done=(await call('accounts/login/'+attempt.id)).data;assert.equal(done.status,'succeeded');assert.ok(done.providerId);
    const p=app.store.get('providers',done.providerId);assert.equal(p.accountPlatform,'grok');assert.ok(p.sealedKey);assert.equal(p.sealedKey.includes(access),false);
    const state=(await call('state')).data;assert.equal(JSON.stringify(state).includes(access),false);assert.equal(JSON.stringify(state).includes(refresh),false);
    assert.equal((await call('providers/'+p.id+'/models')).status,200);assert.equal(generations,0);
    const template=state.templates[0];const started=await call('jobs',{providerId:p.id,model:'grok-test',templateId:template.id,input:'请读图',images:[{dataUrl:'data:image/png;base64,AAAA'}]});assert.equal(started.status,202);
    for(let i=0;i<200&&app.jobs.active;i++)await new Promise(r=>setTimeout(r,5));
    assert.equal(app.store.get('jobs',started.data.id).status,'succeeded');assert.equal(generations,1);
    assert.equal((await call('accounts/'+p.id+'/signout',{})).status,200);assert.equal(app.store.get('providers',p.id).sealedKey,null);assert.equal(app.store.get('jobs',started.data.id).status,'succeeded');
    const backup=JSON.stringify((await call('export')).data);assert.equal(backup.includes(access),false);assert.equal(backup.includes(refresh),false);
  }finally{await app.close();}
});

test('账号刷新合并并发请求，轮换凭据不改变诊断身份，退出后迟到刷新不能恢复凭据',async()=>{
  let now=Date.now(),refreshes=0,hold=false,release;const vault={seal:async s=>Buffer.from(s).toString('base64'),open:async s=>s?Buffer.from(s,'base64').toString():''};
  const app=await createWorkbench({port:0,dataDir:directory(),vault,accountNow:()=>now,accountFetcher:async(url,options)=>{
    url=String(url);if(url.endsWith('openid-configuration'))return response({issuer:'https://auth.x.ai',device_authorization_endpoint:'https://auth.x.ai/oauth2/device/code',token_endpoint:'https://auth.x.ai/oauth2/token',userinfo_endpoint:'https://auth.x.ai/userinfo'});
    if(url.endsWith('device/code'))return response({device_code:'device',user_code:'AAAA-BBBB',verification_uri:'https://accounts.x.ai/oauth2/device',expires_in:1800,interval:5});
    if(url.endsWith('/token')){const form=new URLSearchParams(options.body);if(form.get('grant_type')==='refresh_token'){refreshes++;if(hold)await new Promise(r=>release=r);return response({access_token:'rotated-private-'+refreshes,refresh_token:'rotated-refresh-'+refreshes,expires_in:3600});}return response({access_token:'initial-private',refresh_token:'initial-refresh',expires_in:120});}
    if(url.endsWith('/userinfo'))return response({sub:'account',email:'account@example.test'});return response({data:[{id:'model'}]});
  }}),call=await client(app);
  try{
    const a=(await call('accounts/login',{platform:'grok'})).data;now+=6000;const done=(await call('accounts/login/'+a.id)).data;const id=done.providerId,epoch=app.store.get('providers',id).accountEpoch;
    now+=120000;const checked=await Promise.all([call('providers/'+id+'/models'),call('providers/'+id+'/status')]);assert.ok(checked.every(r=>r.status===200));assert.equal(refreshes,1);assert.equal(app.store.get('providers',id).accountEpoch,epoch);
    now+=3600000;hold=true;const late=call('providers/'+id+'/models');for(let i=0;i<100&&!release;i++)await new Promise(r=>setTimeout(r,5));assert.ok(release);assert.equal((await call('accounts/'+id+'/signout',{})).status,200);release();assert.equal((await late).status,400);assert.equal(app.store.get('providers',id).sealedKey,null);
  }finally{release?.();await app.close();}
});

test('取消授权阻止迟到 token 保存，模型失败和不完整流不重发且错误不泄露令牌',async()=>{
  let now=Date.now(),release,hold=true,generations=0,mode='error';const vault={seal:async s=>Buffer.from(s).toString('base64'),open:async s=>s?Buffer.from(s,'base64').toString():''};
  const app=await createWorkbench({port:0,dataDir:directory(),vault,accountNow:()=>now,accountFetcher:async(url)=>{
    url=String(url);if(url.endsWith('openid-configuration'))return response({issuer:'https://auth.x.ai',device_authorization_endpoint:'https://auth.x.ai/oauth2/device/code',token_endpoint:'https://auth.x.ai/oauth2/token',userinfo_endpoint:'https://auth.x.ai/userinfo'});
    if(url.endsWith('device/code'))return response({device_code:'device',user_code:'AAAA-BBBB',verification_uri:'https://accounts.x.ai/oauth2/device',expires_in:1800,interval:5});
    if(url.endsWith('/token')){if(hold)await new Promise(r=>release=r);return response({access_token:'sensitive-access-value',refresh_token:'sensitive-refresh-value',expires_in:3600});}
    if(url.endsWith('/userinfo'))return response({sub:'account'});generations++;
    return new Response('data: '+JSON.stringify({type:'response.output_text.delta',delta:'部分正文'})+'\n\n'+(mode==='error'?'data: '+JSON.stringify({error:{message:'格式无效 sensitive-access-value sensitive-refresh-value'}})+'\n\n':'data: [DONE]\n\n'),{headers:{'content-type':'text/event-stream'}});
  }}),call=await client(app);
  try{
    const a=(await call('accounts/login',{platform:'grok'})).data;now+=6000;const late=call('accounts/login/'+a.id);for(let i=0;i<100&&!release;i++)await new Promise(r=>setTimeout(r,5));assert.ok(release);await call('accounts/login/'+a.id,undefined,'DELETE');release();assert.equal((await late).data.status,'cancelled');assert.equal(app.store.list('providers').length,0);
    hold=false;const b=(await call('accounts/login',{platform:'grok'})).data;now+=6000;const done=(await call('accounts/login/'+b.id)).data;const template=(await call('state')).data.templates[0];
    for(const kind of ['error','incomplete']){mode=kind;const job=(await call('jobs',{providerId:done.providerId,model:'model',templateId:template.id,input:'测试'})).data;for(let i=0;i<200&&app.jobs.active;i++)await new Promise(r=>setTimeout(r,5));const result=app.store.get('jobs',job.id);assert.equal(result.status,'failed');assert.equal(result.partialOutput,'部分正文');assert.equal(JSON.stringify(result).includes('sensitive-'),false);}
    assert.equal(generations,2);
  }finally{release?.();await app.close();}
});

test('ChatGPT 拒绝无效签名、nonce、过期身份、缺少使用权限及身份替换，原账号保持',async()=>{
  const {privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:2048});let authorization,mode='valid';const vault={seal:async s=>Buffer.from(s).toString('base64'),open:async s=>s?Buffer.from(s,'base64').toString():''};
  const app=await createWorkbench({port:0,dataDir:directory(),vault,accountFetcher:async(url)=>{
    if(String(url).endsWith('/jwks.json'))return response({keys:[{...publicKey.export({format:'jwk'}),kid:'key'}]});
    const head=Buffer.from(JSON.stringify({alg:'RS256',kid:'key'})).toString('base64url'),claims=Buffer.from(JSON.stringify({iss:'https://auth.openai.com',aud:'oaiapp_test',sub:mode==='identity'?'other-sub':'selected-sub',email:'test@example.test',nonce:mode==='nonce'?'wrong':authorization.searchParams.get('nonce'),exp:Math.floor(Date.now()/1000)+(mode==='expired'?-30:3600)})).toString('base64url');const raw=head+'.'+claims,signature=sign('RSA-SHA256',Buffer.from(mode==='signature'?raw+'changed':raw),privateKey).toString('base64url');return response({access_token:'never-expose-access',refresh_token:'never-expose-refresh',id_token:raw+'.'+signature,scope:mode==='scope'?'openid email':'openid chatgpt.tokens.use.direct',expires_in:3600});
  }}),call=await client(app);
  try{
    let id,original;for(const value of ['valid','signature','nonce','expired','scope','identity']){mode=value;const started=(await call('accounts/login',{platform:'chatgpt',providerId:id})).data;authorization=new URL(started.authorizationUrl);const callback=new URL(authorization.searchParams.get('redirect_uri'));callback.searchParams.set('state',authorization.searchParams.get('state'));callback.searchParams.set('code','a-code');callback.searchParams.set('client_id','oaiapp_test');assert.equal((await fetch(callback)).status,value==='valid'?200:400);const done=(await call('accounts/login/'+started.id)).data;if(value==='valid'){id=done.providerId;original=app.store.get('providers',id).sealedKey;}else{assert.equal(done.status,'failed');assert.equal(app.store.get('providers',id).sealedKey,original);}assert.equal(JSON.stringify(done).includes('never-expose'),false);}
  }finally{await app.close();}
});

test('账号备份迁移不携带凭据，导入要求重新登录，拒绝把账号令牌改发到自定义地址',async()=>{
  const first=await createWorkbench({port:0,dataDir:directory()}),second=await createWorkbench({port:0,dataDir:directory()}),call=await client(second);
  try{
    first.store.put('providers',{id:'backup-account',name:'Grok 账号',protocol:'account',accountPlatform:'grok',accountRegion:'cn',baseUrl:'https://cli-chat-proxy.grok.com/v1',model:'model',sealedKey:'encrypted-credential',accountStatus:'signed-in',accountLabel:'saved@example.test',accountEpoch:'original-epoch'});
    const backup=first.store.export();assert.equal(JSON.stringify(backup).includes('encrypted-credential'),false);assert.equal((await call('import',backup)).status,200);const restored=second.store.get('providers','backup-account');assert.equal(restored.sealedKey,undefined);assert.equal(restored.accountStatus,'signed-out');assert.notEqual(restored.accountEpoch,'original-epoch');
    const malicious=structuredClone(backup);malicious.providers[0].id='other-account';malicious.providers[0].baseUrl='https://example.test/v1';assert.equal((await call('import',malicious)).status,400);
    const edit=await call('providers',{id:'backup-account',name:'edited',protocol:'openai',baseUrl:'https://example.test/v1',model:'m'});assert.equal(edit.status,400);
    assert.equal((await call('models/discover',{id:'backup-account',name:'leak',protocol:'openai',baseUrl:'https://example.test/v1'})).status,400);
    assert.equal((await call('providers/backup-account/models')).status,400);
  }finally{await first.close();await second.close();}
});

test('慢解密追上已轮换的账号凭据时不再次使用旧刷新令牌',async()=>{
  let delayed=true,release,refreshes=0;const encoded=Buffer.from(JSON.stringify({version:1,platform:'grok',region:'cn',accessToken:'old-access',refreshToken:'old-refresh',clientId:'client',expiresAt:1})).toString('base64');
  const vault={seal:async s=>Buffer.from(s).toString('base64'),open:async s=>{if(s===encoded&&delayed){delayed=false;await new Promise(r=>release=r);}return Buffer.from(s,'base64').toString();}};
  const app=await createWorkbench({port:0,dataDir:directory(),vault,accountFetcher:async(url)=>{if(String(url).endsWith('/token')){refreshes++;if(refreshes>1)return Response.json({error:'invalid_grant'},{status:400});return response({access_token:'new-access',refresh_token:'new-refresh',expires_in:3600});}return response({data:[{id:'model'}]});}}),call=await client(app);
  try{
    app.store.put('providers',{id:'slow-account',name:'慢解密账号',protocol:'account',accountPlatform:'grok',accountRegion:'cn',baseUrl:'https://cli-chat-proxy.grok.com/v1',model:'model',sealedKey:encoded,accountEpoch:'epoch'});
    const slow=call('providers/slow-account/models');for(let i=0;i<100&&!release;i++)await new Promise(r=>setTimeout(r,5));assert.ok(release);assert.equal((await call('providers/slow-account/models')).status,200);release();assert.equal((await slow).status,200);assert.equal(refreshes,1);
  }finally{release?.();await app.close();}
});

test('Grok 未提供 userinfo 时按发现的 JWKS 验证 ID token，缺少或伪造身份不保存',async()=>{
  const {privateKey,publicKey}=generateKeyPairSync('ec',{namedCurve:'P-256'});let now=Date.now(),mode='valid';const vault={seal:async s=>Buffer.from(s).toString('base64'),open:async s=>s?Buffer.from(s,'base64').toString():''};
  const app=await createWorkbench({port:0,dataDir:directory(),vault,accountNow:()=>now,accountFetcher:async(url)=>{
    url=String(url);if(url.endsWith('openid-configuration'))return response({issuer:'https://auth.x.ai',device_authorization_endpoint:'https://auth.x.ai/oauth2/device/code',token_endpoint:'https://auth.x.ai/oauth2/token',jwks_uri:'https://auth.x.ai/jwks',id_token_signing_alg_values_supported:['ES256']});
    if(url.endsWith('device/code'))return response({device_code:'device',user_code:'AAAA-BBBB',verification_uri:'https://accounts.x.ai/oauth2/device',expires_in:1800,interval:5});
    if(url.endsWith('/jwks'))return response({keys:[{...publicKey.export({format:'jwk'}),kid:'grok-key'}]});
    const head=Buffer.from(JSON.stringify({alg:'ES256',kid:'grok-key'})).toString('base64url'),claims=Buffer.from(JSON.stringify({iss:'https://auth.x.ai',aud:'b1a00492-073a-47ea-816f-4c329264a828',sub:'grok-verified',email:'grok@example.test',exp:Math.floor(now/1000)+3600})).toString('base64url'),raw=head+'.'+claims;return response({access_token:'private-access',refresh_token:'private-refresh',expires_in:3600,...(mode==='missing'?{}:{id_token:raw+'.'+sign('sha256',Buffer.from(mode==='forged'?raw+'tampered':raw),{key:privateKey,dsaEncoding:'ieee-p1363'}).toString('base64url')})});
  }}),call=await client(app);
  try{
    for(const value of ['valid','forged','missing']){mode=value;const start=await call('accounts/login',{platform:'grok'});assert.equal(start.status,200);now+=6000;const done=(await call('accounts/login/'+start.data.id)).data;assert.equal(done.status,value==='valid'?'succeeded':'failed');}assert.equal(app.store.list('providers').length,1);
  }finally{await app.close();}
});

test('Windows DPAPI 账号在后台重启后恢复并刷新，页面与JSON备份仍不含令牌',{skip:process.platform!=='win32'},async()=>{
  let now=Date.now(),refreshes=0;const dataDir=directory();
  const accountFetcher=async(url,options)=>{url=String(url);if(url.endsWith('openid-configuration'))return response({issuer:'https://auth.x.ai',device_authorization_endpoint:'https://auth.x.ai/oauth2/device/code',token_endpoint:'https://auth.x.ai/oauth2/token',userinfo_endpoint:'https://auth.x.ai/userinfo'});if(url.endsWith('device/code'))return response({device_code:'synthetic-device',user_code:'AAAA-BBBB',verification_uri:'https://accounts.x.ai/oauth2/device',expires_in:1800,interval:5});if(url.endsWith('/token')){const refreshing=new URLSearchParams(options.body).get('grant_type')==='refresh_token';if(refreshing)refreshes++;return response({access_token:refreshing?'synthetic-rotated-access':'synthetic-original-access',refresh_token:'synthetic-refresh-token',expires_in:120});}if(url.endsWith('/userinfo'))return response({sub:'synthetic-account',email:'synthetic@example.test'});assert.equal(options.headers.Authorization,'Bearer synthetic-rotated-access');return response({data:[{id:'synthetic-model'}]});};
  let app=await createWorkbench({port:0,dataDir,accountFetcher,accountNow:()=>now}),call=await client(app);
  try{
    const start=(await call('accounts/login',{platform:'grok'})).data;now+=6000;const done=(await call('accounts/login/'+start.id)).data;assert.equal(done.status,'succeeded');const p=app.store.get('providers',done.providerId);assert.equal(p.sealedKey.includes('synthetic-'),false);await app.close();now+=180000;
    app=await createWorkbench({port:0,dataDir,accountFetcher,accountNow:()=>now});call=await client(app);assert.equal((await call('providers/'+p.id+'/models')).status,200);assert.equal(refreshes,1);const backup=JSON.stringify((await call('export')).data);assert.equal(backup.includes('synthetic-original-access'),false);assert.equal(backup.includes('synthetic-rotated-access'),false);assert.equal(backup.includes('synthetic-refresh-token'),false);
  }finally{await app.close();}
});
