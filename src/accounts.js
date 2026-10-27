import {randomBytes,randomUUID} from 'node:crypto';
import {callbackListener,validateIdentity,CHATGPT_CLIENT,CHATGPT_TOKEN,CHATGPT_SCOPES,ANTIGRAVITY_CLIENT,ANTIGRAVITY_CLIENT_SECRET,ANTIGRAVITY_TOKEN,ANTIGRAVITY_SCOPES,ANTIGRAVITY_USER_AGENT} from './account-oauth.js';

const PLATFORMS=new Set(['grok','chatgpt','workbuddy','antigravity']);
export const ACCOUNT_BASES={grok:'https://cli-chat-proxy.grok.com/v1',chatgpt:'https://api.openai.com/v1',workbuddy:'https://www.workbuddy.cn/v2',antigravity:'https://cloudcode-pa.googleapis.com'};
export function accountBase(platform,region='cn'){if(!PLATFORMS.has(platform))throw Error('账号平台无效');return platform==='workbuddy'&&region==='intl'?'https://www.workbuddy.ai/v2':ACCOUNT_BASES[platform];}
export function trustedUrl(value,hosts){const u=new URL(value);if(u.protocol!=='https:'||u.username||u.password||u.hash||!hosts.includes(u.hostname)||u.port)throw Error('授权服务返回了不受信任的地址');return u.href;}
export function workbuddyOrigin(c,region){const fallback=accountBase('workbuddy',region).replace(/\/v2$/,'');if(!c.domain)return fallback;const u=new URL(c.domain.includes('://')?c.domain:'https://'+c.domain),suffix=region==='intl'?'workbuddy.ai':'workbuddy.cn';if(u.protocol!=='https:'||u.username||u.password||u.port||u.search||u.hash||u.pathname!=='/'||!(u.hostname===suffix||u.hostname.endsWith('.'+suffix)))throw Error('WorkBuddy 账号区域或服务域名不匹配，请重新登录');return u.origin;}
const wbLoginHeaders=base=>({'User-Agent':'CLI/2.63.2 CodeBuddy/2.63.2','X-Requested-With':'XMLHttpRequest',Origin:base,Referer:base+'/','X-Product':'SaaS','X-No-Authorization':'true','X-No-User-Id':'1','X-No-Enterprise-Id':'1','X-No-Department-Info':'1'});
class AccountRequestError extends Error{
  constructor(message,{code='ACCOUNT_NETWORK',retryable=true,retryAfter=0}={}){super(message);this.code=code;this.retryable=retryable;this.retryAfter=retryAfter;}
}
export class Accounts{
  constructor(store,vault,{fetcher=fetch,busy=()=>false,now=Date.now}={}){this.store=store;this.vault=vault;this.fetcher=fetcher;this.busy=busy;this.now=now;this.attempts=new Map();this.refreshes=new Map();}
  async request(url,{method='GET',headers={},body,form,signal}={}){
    let res;try{res=await this.fetcher(url,{method,headers:{...headers,...(form?{'Content-Type':'application/x-www-form-urlencoded'}:body?{'Content-Type':'application/json'}:{})},body:form?new URLSearchParams(form).toString():body?JSON.stringify(body):undefined,redirect:'error',signal:AbortSignal.any([AbortSignal.timeout(30000),...(signal?[signal]:[])])});}catch{throw new AccountRequestError(signal?.aborted?'此次授权已取消':'账号服务连接失败或超时，请检查网络后重试',{retryable:!signal?.aborted,code:signal?.aborted?'ACCOUNT_CANCELLED':'ACCOUNT_NETWORK'});}
    if([408,429,500,502,503,504].includes(res.status)){await res.body?.cancel();throw new AccountRequestError('账号服务暂不可用（HTTP '+res.status+'）',{code:'ACCOUNT_HTTP_'+res.status,retryAfter:Math.min(60,Math.max(0,Number(res.headers.get('retry-after'))||0))});}
    let raw;try{raw=await res.text();}catch{throw new AccountRequestError('账号服务响应在读取时中断');}signal?.throwIfAborted();
    let data;try{if(raw.length>2e6)throw Error();data=JSON.parse(raw);if(!data||typeof data!=='object'||Array.isArray(data))throw Error();}catch{throw Error('账号服务响应格式无效');}
    return {ok:res.ok,status:res.status,data};
  }
  publicAttempt(a){return {id:a.id,platform:a.platform,status:a.status,phase:a.phase||'waiting-authorization',authorizationUrl:a.authorizationUrl,userCode:a.userCode,expiresAt:a.expiresAt,interval:a.interval,providerId:a.savedId,message:a.message,retryable:a.retryable===true,retryCount:a.retryCount||0,errorCode:a.errorCode,nextPollAt:a.nextPoll};}
  pollFailed(a,error){if(a.status!=='pending'){a.tokenResponse=null;return;}const count=(a.retryCount||0)+1;a.retryCount=count;a.errorCode=error instanceof AccountRequestError?error.code:'ACCOUNT_LOGIN_FAILED';if(error instanceof AccountRequestError&&error.retryable&&count<=3){a.retryable=true;const seconds=Math.max(a.interval,Math.min(60,2**count*2),error.retryAfter);a.nextPoll=this.now()+seconds*1000;a.message=error.message+'；'+seconds+'秒后继续检查（'+count+'/3）。';}else{a.status='failed';a.retryable=false;a.message=error instanceof AccountRequestError?'账号服务连续检查失败，请重新登录':error.message;clearTimeout(a.expiryTimer);a.listener?.close();a.tokenResponse=null;}}
  async start(input={}){
    if(!PLATFORMS.has(input.platform))throw Error('账号平台无效');if(this.busy())throw Error('请等待当前任务结束后登录账号');
    for(const [id,a]of this.attempts)if(a.expiresAt<=this.now()||a.status!=='pending'){a.ctrl.abort();a.listener?.close();clearTimeout(a.expiryTimer);this.attempts.delete(id);}
    if(this.attempts.size>=8)throw Error('待授权登录过多，请先取消其他登录');
    if(input.platform==='antigravity'&&(!ANTIGRAVITY_CLIENT||!ANTIGRAVITY_CLIENT_SECRET))throw Error('Antigravity 需要维护者配置自己的 OAuth 客户端注册后使用，详见公开版说明');
    const old=input.providerId?this.store.get('providers',String(input.providerId)):null;
    if(input.providerId&&(!old||old.accountPlatform!==input.platform))throw Error('账号连接不存在或平台不匹配');
    const a={id:randomUUID(),platform:input.platform,region:old?.accountRegion||(input.region==='intl'?'intl':'cn'),name:String(input.name||old?.name||input.platform).trim().slice(0,100),providerId:old?.id,previous:old?.accountEpoch,status:'pending',expiresAt:this.now()+900000,interval:5,ctrl:new AbortController(),state:randomBytes(32).toString('base64url')};
    this.attempts.set(a.id,a);
    try{
      if(a.platform==='grok'){
        const {data:d,ok}=await this.request('https://auth.x.ai/.well-known/openid-configuration',{signal:a.ctrl.signal});if(!ok||d.issuer!=='https://auth.x.ai')throw Error('Grok 授权元数据无效');
        a.tokenUrl=trustedUrl(d.token_endpoint,['auth.x.ai']);a.userinfoUrl=d.userinfo_endpoint?trustedUrl(d.userinfo_endpoint,['auth.x.ai']):null;a.jwksUrl=d.jwks_uri?trustedUrl(d.jwks_uri,['auth.x.ai']):null;a.algorithms=Array.isArray(d.id_token_signing_alg_values_supported)?d.id_token_signing_alg_values_supported.filter(v=>['RS256','ES256'].includes(v)):['ES256','RS256'];
        const {data:t,ok:started}=await this.request(trustedUrl(d.device_authorization_endpoint,['auth.x.ai']),{method:'POST',form:{client_id:'b1a00492-073a-47ea-816f-4c329264a828',scope:'openid profile email offline_access grok-cli:access api:access conversations:read conversations:write workspaces:read workspaces:write'},signal:a.ctrl.signal});
        if(!started||!t.device_code||!t.user_code)throw Error('Grok 设备授权未能开始');
        a.deviceCode=t.device_code;a.userCode=String(t.user_code).slice(0,40);a.authorizationUrl=trustedUrl(t.verification_uri_complete||t.verification_uri,['accounts.x.ai','auth.x.ai']);a.interval=Math.max(5,Math.min(60,Number(t.interval)||5));a.expiresAt=this.now()+Math.min(1800,Number(t.expires_in)||900)*1000;a.nextPoll=this.now()+a.interval*1000;
      }else if(a.platform==='chatgpt'){
        const oldCredential=old?.sealedKey?JSON.parse(await this.vault.open(old.sealedKey)):null;
        a.clientId=oldCredential?.clientId||CHATGPT_CLIENT;a.subject=oldCredential?.subject;
        let host=this.store.get('accountHost','local');if(!host)host=this.store.put('accountHost',{id:'local',value:'urn:uuid:'+randomUUID()});a.hostId=host.value;
        const params=await callbackListener(a,async query=>{
          this.live(a);a.phase='exchanging-code';if(query.get('error'))throw Error('ChatGPT 授权被拒绝');
          const clientId=query.get('client_id')||a.clientId;
          if(a.clientId===CHATGPT_CLIENT?!/^oaiapp_[A-Za-z0-9_-]{1,200}$/.test(clientId):clientId!==a.clientId)throw Error('ChatGPT 客户端注册不匹配');
          const code=query.get('code');if(!code||code.length>4000)throw Error('ChatGPT 授权码无效');
          const {ok,data:t}=await this.request(CHATGPT_TOKEN,{method:'POST',form:{grant_type:'authorization_code',client_id:clientId,code,code_verifier:a.verifier,redirect_uri:a.redirectUri,resource:'https://api.openai.com/v1'},signal:a.ctrl.signal});
          if(!ok||!t.access_token)throw Error('ChatGPT 授权码交换失败');
          a.phase='verifying-identity';const identity=await validateIdentity(t.id_token,{clientId,nonce:a.nonce,subject:a.subject,request:(...args)=>this.request(...args),now:this.now});
          const scopes=String(t.scope||'').split(/\s+/);if(!scopes.includes('chatgpt.tokens.use.direct'))throw Error('ChatGPT 未授予套餐模型使用权限');
          await this.save(a,{...identity,clientId,hostId:a.hostId,accessToken:t.access_token,refreshToken:t.refresh_token||'',idToken:t.id_token,scopes,expiresAt:this.now()+(Number(t.expires_in)||3600)*1000});
        });
        Object.assign(params,{client_id:a.clientId,ext_agent_host_id:a.hostId,scope:CHATGPT_SCOPES,resource:'https://api.openai.com/v1',...(a.clientId===CHATGPT_CLIENT?{agent_name_hint:'Prompt Workbench'}:{}),...(oldCredential?.label?{login_hint:oldCredential.label}:{})});
        a.authorizationUrl='https://auth.openai.com/api/accounts/authorize?'+new URLSearchParams(params);
      }else if(a.platform==='workbuddy'){
        a.authBase=workbuddyOrigin({},a.region);
        const {ok,data:t}=await this.request(a.authBase+'/v2/plugin/auth/state?platform=CLI&nonce='+a.state,{method:'POST',body:{nonce:a.state},headers:wbLoginHeaders(a.authBase),signal:a.ctrl.signal});
        if(!ok||![0,200].includes(t.code)||typeof t.data?.state!=='string'||!t.data.state)throw Error('WorkBuddy 登录未能开始');
        a.pluginState=t.data.state;a.authorizationUrl=trustedUrl(t.data.authUrl||a.authBase+'/login?state='+encodeURIComponent(a.pluginState),['www.workbuddy.cn','workbuddy.cn','www.workbuddy.ai','workbuddy.ai','copilot.tencent.com','accounts.tencent.com','aicoding.tencent.com']);a.interval=2;a.nextPoll=this.now()+2000;
      }else if(a.platform==='antigravity'){
        const oldCredential=old?.sealedKey?JSON.parse(await this.vault.open(old.sealedKey)):null;
        const params=await callbackListener(a,async query=>{
          this.live(a);a.phase='exchanging-code';if(query.get('error'))throw Error('Google 授权已拒绝，请重新登录');const code=query.get('code');if(!code||code.length>4000)throw Error('Google 授权码无效');
          const {ok,data:t}=await this.request(ANTIGRAVITY_TOKEN,{method:'POST',form:{grant_type:'authorization_code',client_id:ANTIGRAVITY_CLIENT,client_secret:ANTIGRAVITY_CLIENT_SECRET,code,code_verifier:a.verifier,redirect_uri:a.redirectUri},signal:a.ctrl.signal});
          if(!ok||!t.access_token)throw Error('Google 授权码交换失败，请重新登录');
          a.phase='verifying-identity';const headers={Authorization:'Bearer '+t.access_token,'User-Agent':ANTIGRAVITY_USER_AGENT};
          const {ok:identified,data:identity}=await this.request('https://www.googleapis.com/oauth2/v2/userinfo?alt=json',{headers,signal:a.ctrl.signal});
          if(!identified||!identity.id||!identity.email||identity.verified_email===false||oldCredential?.subject&&oldCredential.subject!==String(identity.id))throw Error('Google 账号身份验证失败或与所选账号不符');
          a.phase='discovering-project';const {ok:loaded,data:project}=await this.request(accountBase('antigravity')+'/v1internal:loadCodeAssist',{method:'POST',headers,body:{metadata:{ideType:'ANTIGRAVITY'}},signal:a.ctrl.signal});
          const projectId=typeof project.cloudaicompanionProject==='string'?project.cloudaicompanionProject:project.cloudaicompanionProject?.id;
          if(!loaded||!projectId)throw Error('账号尚无 Antigravity 项目，请先在官方 Antigravity 完成启用及条款确认，再返回工坊登录');
          await this.save(a,{accessToken:t.access_token,refreshToken:t.refresh_token||oldCredential?.refreshToken||'',expiresAt:this.now()+(Number(t.expires_in)||3600)*1000,clientId:ANTIGRAVITY_CLIENT,subject:String(identity.id),label:String(identity.email),projectId:String(projectId)});
        });
        Object.assign(params,{client_id:ANTIGRAVITY_CLIENT,scope:ANTIGRAVITY_SCOPES,access_type:'offline',prompt:'consent',...(oldCredential?.label?{login_hint:oldCredential.label}:{})});a.authorizationUrl='https://accounts.google.com/o/oauth2/v2/auth?'+new URLSearchParams(params);
      }else throw Error('此平台登录尚未配置');
      a.expiryTimer=setTimeout(()=>{if(a.status==='pending'){a.status='expired';a.retryable=false;a.tokenResponse=null;a.ctrl.abort();a.listener?.close();}},Math.max(1,a.expiresAt-this.now()));a.expiryTimer.unref();
      if(a.ctrl.signal.aborted)throw Error('登录已取消');return this.publicAttempt(a);
    }catch(e){a.status='failed';a.message=e.message;a.listener?.close();throw e;}
  }
  async status(id){
    const a=this.attempts.get(id);if(!a)throw Error('登录尝试不存在或已过期');
    if(a.status==='pending'&&a.expiresAt<=this.now()){a.status='expired';a.ctrl.abort();a.listener?.close();a.tokenResponse=null;}
    if(a.status==='pending'&&a.platform==='grok'&&this.now()>=a.nextPoll&&!a.polling){
      a.polling=true;a.nextPoll=this.now()+a.interval*1000;
      try{
        let t=a.tokenResponse;
        if(!t){const grant=await this.request(a.tokenUrl,{method:'POST',form:{grant_type:'urn:ietf:params:oauth:grant-type:device_code',device_code:a.deviceCode,client_id:'b1a00492-073a-47ea-816f-4c329264a828'},signal:a.ctrl.signal});t=grant.data;
          if(t.error==='slow_down'){a.interval=Math.min(60,a.interval+5);a.nextPoll=this.now()+a.interval*1000;a.retryCount=0;a.retryable=false;a.message='';a.errorCode=undefined;}
          else if(t.error==='authorization_pending'){a.retryCount=0;a.retryable=false;a.message='';a.errorCode=undefined;}
          else{if(!grant.ok||!t.access_token)throw Error(t.error==='access_denied'?'授权已拒绝，请重新发起登录':t.error==='expired_token'?'设备授权已过期，请重新登录':'Grok 授权失败，请重新登录');a.tokenResponse=t;a.tokenAcquiredAt=this.now();}
        }
        if(a.tokenResponse){
          a.phase='verifying-identity';
          let identity;if(a.userinfoUrl){const {data,ok:identified}=await this.request(a.userinfoUrl,{headers:{Authorization:'Bearer '+t.access_token},signal:a.ctrl.signal});if(!identified||!data.sub)throw Error('Grok 账号身份验证失败');identity={subject:String(data.sub),label:String(data.email||data.name||data.sub)};}
          else{if(!a.jwksUrl||!t.id_token)throw Error('Grok 未提供可验证的账号身份，请重新登录');identity=await validateIdentity(t.id_token,{clientId:'b1a00492-073a-47ea-816f-4c329264a828',issuer:'https://auth.x.ai',jwksUrl:a.jwksUrl,algorithms:a.algorithms,label:'Grok',request:(...args)=>this.request(...args),now:this.now});}
          await this.save(a,{...identity,accessToken:t.access_token,refreshToken:t.refresh_token||'',expiresAt:a.tokenAcquiredAt+(Number(t.expires_in)||3600)*1000,tokenUrl:a.tokenUrl,clientId:'b1a00492-073a-47ea-816f-4c329264a828'});
        }
      }catch(e){this.pollFailed(a,e);}finally{a.polling=false;}
    }
    if(a.status==='pending'&&a.platform==='workbuddy'&&this.now()>=a.nextPoll&&!a.polling){
      a.polling=true;a.nextPoll=this.now()+a.interval*1000;
      try{
        const {ok,data:t}=await this.request(a.authBase+'/v2/plugin/auth/token?state='+encodeURIComponent(a.pluginState),{headers:wbLoginHeaders(a.authBase),signal:a.ctrl.signal});
        if(t.code===11217){a.retryCount=0;a.retryable=false;a.message='';a.errorCode=undefined;}
        if(t.code!==11217){
          if(!ok||![0,200].includes(t.code)||!t.data?.accessToken)throw Error('WorkBuddy 授权失败或已过期，请重新登录');const data=t.data;
          // Only the token just issued by the fixed HTTPS login service supplies routing hints.
          let claims={};try{claims=JSON.parse(Buffer.from(data.accessToken.split('.')[1]||'','base64url'));}catch{}
          a.phase='verifying-identity';const uid=String(data.uid||data.uin||claims.uid||claims.sub||'');if(!uid)throw Error('WorkBuddy 未返回账号标识，请重新登录');
          const credential={accessToken:data.accessToken,refreshToken:data.refreshToken||'',expiresAt:this.now()+(Number(data.expiresIn)||3600)*1000,uid,subject:uid,domain:String(data.domain||new URL(a.authBase).hostname),enterpriseId:String(data.enterpriseId||''),label:String(data.nickname||claims.email||claims.name||uid)};workbuddyOrigin(credential,a.region);await this.save(a,credential);
        }
      }catch(e){this.pollFailed(a,e);}finally{a.polling=false;}
    }
    return this.publicAttempt(a);
  }
  live(a){if(a.status!=='pending'||a.ctrl.signal.aborted||a.expiresAt<=this.now())throw Error('登录已取消或过期');if(this.busy())throw Error('任务执行中，不能替换账号，请稍后重新登录');const old=a.providerId?this.store.get('providers',a.providerId):null;if(a.providerId&&(!old||old.accountEpoch!==a.previous))throw Error('账号连接已更改，请重新登录');return old;}
  async save(a,credential){
    this.live(a);a.phase='saving';const sealedKey=await this.vault.seal(JSON.stringify({version:1,platform:a.platform,region:a.region,...credential}));const old=this.live(a);
    const provider=this.store.put('providers',{...old,name:a.name||a.platform,protocol:'account',accountPlatform:a.platform,accountRegion:a.region,baseUrl:accountBase(a.platform,a.region),model:old?.model||'',accountEpoch:randomUUID(),accountLabel:credential.label.slice(0,150),accountStatus:'signed-in',sealedKey,timeoutMs:old?.timeoutMs||300000});
    this.store.remove('modelLists',provider.id);a.savedId=provider.id;a.status='succeeded';a.phase='completed';a.retryable=false;a.retryCount=0;a.message='';a.errorCode=undefined;a.tokenResponse=null;a.listener?.close();clearTimeout(a.expiryTimer);a.deviceCode='';
  }
  async resolve(p,signal){
    if(p.protocol!=='account')return {...p,apiKey:await this.vault.open(p.sealedKey)};
    if(!p.sealedKey)throw Error('此账号已退出或备份未包含凭据，请重新登录');
    let credential;try{credential=JSON.parse(await this.vault.open(p.sealedKey));}catch{throw Error('账号凭据无法解密，请重新登录');}
    const latest=this.store.get('providers',p.id);if(!latest||latest.accountEpoch!==p.accountEpoch||!latest.sealedKey)throw Error('账号连接已更改，请重新选择');if(latest.sealedKey!==p.sealedKey)return this.resolve({...latest,model:p.model},signal);
    if(credential.platform!==p.accountPlatform||credential.region!==p.accountRegion||!credential.accessToken)throw Error('账号凭据与连接不匹配，请重新登录');
    if(credential.expiresAt&&credential.expiresAt<=this.now()+60000){
      if(!this.refreshes.has(p.id))this.refreshes.set(p.id,this.refresh(p,credential).finally(()=>this.refreshes.delete(p.id)));
      credential=await this.refreshes.get(p.id);
    }
    signal?.throwIfAborted();const current=this.store.get('providers',p.id);if(!current||current.accountEpoch!==p.accountEpoch||!current.sealedKey)throw Error('账号连接已更改，请重新选择');
    return {...current,model:p.model,apiKey:credential.accessToken,accountCredentials:credential,accountFetcher:this.fetcher};
  }
  async refresh(p,c){
    if(!c.refreshToken)throw Error('账号授权已过期，请重新登录');
    if(p.accountPlatform==='workbuddy'){
      const base=workbuddyOrigin(c,p.accountRegion),{ok,data:t}=await this.request(base+'/v2/plugin/auth/token/refresh',{method:'POST',headers:{...wbLoginHeaders(base),'X-Refresh-Token':c.refreshToken,'X-Auth-Refresh-Source':'workbuddy',...(c.enterpriseId?{'X-Enterprise-Id':c.enterpriseId}:{})}});
      if(!ok||![0,200].includes(t.code)||!t.data?.accessToken)throw Error('WorkBuddy 授权刷新失败，请重新登录；生成请求尚未发送');
      const next={...c,accessToken:t.data.accessToken,refreshToken:t.data.refreshToken||c.refreshToken,domain:t.data.domain||c.domain,expiresAt:this.now()+(Number(t.data.expiresIn)||3600)*1000};workbuddyOrigin(next,p.accountRegion);return this.persistRefresh(p,next);
    }
    const {ok,data:t}=await this.request(p.accountPlatform==='chatgpt'?CHATGPT_TOKEN:p.accountPlatform==='antigravity'?ANTIGRAVITY_TOKEN:'https://auth.x.ai/oauth2/token',{method:'POST',form:{grant_type:'refresh_token',refresh_token:c.refreshToken,client_id:c.clientId,...(p.accountPlatform==='chatgpt'?{resource:'https://api.openai.com/v1'}:p.accountPlatform==='antigravity'?{client_secret:ANTIGRAVITY_CLIENT_SECRET}:{})}});
    if(!ok||!t.access_token)throw Error('账号凭据刷新失败，请重新登录；生成请求尚未发送');
    if(p.accountPlatform==='chatgpt'&&t.scope&&!String(t.scope).split(/\s+/).includes('chatgpt.tokens.use.direct'))throw Error('ChatGPT 模型使用权限已撤销，请重新登录');
    if(p.accountPlatform==='chatgpt'&&t.id_token)await validateIdentity(t.id_token,{clientId:c.clientId,subject:c.subject,request:(...args)=>this.request(...args),now:this.now});
    const next={...c,accessToken:t.access_token,refreshToken:t.refresh_token||c.refreshToken,...(t.id_token?{idToken:t.id_token}:{}),...(t.scope?{scopes:String(t.scope).split(/\s+/)}:{}),expiresAt:this.now()+(Number(t.expires_in)||3600)*1000};
    return this.persistRefresh(p,next);
  }
  async persistRefresh(p,next){const sealedKey=await this.vault.seal(JSON.stringify(next));const current=this.store.get('providers',p.id);if(!current||current.sealedKey!==p.sealedKey||current.accountEpoch!==p.accountEpoch)throw Error('账号连接已更改，刷新结果已丢弃');this.store.put('providers',{...current,sealedKey});return next;}
  signout(id){if(this.busy())throw Error('请等待当前任务结束后退出账号');const p=this.store.get('providers',id);if(p?.protocol!=='account')throw Error('账号连接不存在');for(const a of this.attempts.values())if(a.providerId===id)this.cancel(a.id);this.store.put('providers',{...p,sealedKey:null,accountEpoch:randomUUID(),accountLabel:'',accountStatus:'signed-out'});this.store.remove('modelLists',id);return {signedOut:true};}
  cancel(id){const a=this.attempts.get(id);if(!a)throw Error('登录尝试不存在');if(a.status==='pending'){a.status='cancelled';a.retryable=false;a.tokenResponse=null;a.ctrl.abort();a.listener?.close();clearTimeout(a.expiryTimer);}return this.publicAttempt(a);}
  async close(){for(const a of this.attempts.values())if(a.status==='pending')this.cancel(a.id);}
}
