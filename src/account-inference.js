import {ANTIGRAVITY_USER_AGENT} from './account-oauth.js';
import {randomUUID} from 'node:crypto';
import {readGenerationStream,StreamReadError} from './streaming.js';
import {accountBase,workbuddyOrigin} from './accounts.js';
import {accountModel,uniqueModels} from './model-catalog.js';

export function accountHeaders(p){
  const c=p.accountCredentials;if(!c?.accessToken)throw Error('账号尚未登录');
  const common={Authorization:'Bearer '+c.accessToken};
  if(p.accountPlatform==='grok')return {...common,'x-xai-token-auth':'xai-grok-cli','x-grok-cli-version':'1.0.52','x-grok-client-version':'1.0.52','x-grok-client-surface':'grok-cli','x-grok-client-identifier':'prompt-workbench','x-authenticateresponse':'authenticate-response','User-Agent':'grok-cli/1.0.52'};
  if(p.accountPlatform==='antigravity')return {...common,'User-Agent':ANTIGRAVITY_USER_AGENT};
  if(p.accountPlatform==='workbuddy'){const base=workbuddyOrigin(c,p.accountRegion);return {...common,Accept:'application/json, text/plain, */*','X-Requested-With':'XMLHttpRequest',Origin:base,Referer:base+'/','User-Agent':'CLI/2.63.2 CodeBuddy/2.63.2','X-Product':'SaaS',...(c.uid?{'X-User-Id':c.uid}:{'X-No-User-Id':'1'}),...(c.enterpriseId?{'X-Enterprise-Id':c.enterpriseId}:{'X-No-Enterprise-Id':'1'}),...(c.domain?{'X-Domain':c.domain}:{'X-No-Department-Info':'1'})};}
  return common;
}
export function buildAccountGeneration(p,{system='',user='',images=[],maxTokens=1024,temperature=0.6}){
  const base=p.accountPlatform==='workbuddy'?workbuddyOrigin(p.accountCredentials,p.accountRegion)+'/v2':accountBase(p.accountPlatform,p.accountRegion),headers=accountHeaders(p);
  if(p.accountPlatform==='workbuddy')return {url:base+'/chat/completions',headers,protocol:'openai',body:{model:p.model,messages:[{role:'system',content:system},{role:'user',content:images.length?[{type:'text',text:user},...images.map(i=>({type:'image_url',image_url:{url:i.dataUrl}}))]:user}],stream:true,stream_options:{include_usage:true},max_tokens:maxTokens,temperature}};
  if(p.accountPlatform==='antigravity')return {url:base+'/v1internal:streamGenerateContent?alt=sse',headers,protocol:'antigravity',body:{model:p.model,project:p.accountCredentials.projectId,userAgent:'antigravity',requestType:'agent',requestId:'agent-'+randomUUID(),request:{sessionId:'-'+BigInt('0x'+randomUUID().replaceAll('-','').slice(0,15)),systemInstruction:{role:'user',parts:[{text:system}]},contents:[{role:'user',parts:[{text:user},...images.map(i=>({inlineData:{mimeType:i.dataUrl.split(';')[0].slice(5),data:i.dataUrl.split(',')[1]}}))]}],generationConfig:{maxOutputTokens:maxTokens,temperature}}}};
  return {url:base+'/responses',headers,protocol:'responses',body:{model:p.model,store:false,stream:true,...(p.accountPlatform==='grok'?{max_output_tokens:maxTokens}:{}),instructions:system,input:[{role:'user',content:[{type:'input_text',text:user},...images.map(i=>({type:'input_image',image_url:i.dataUrl}))]}]}};
}
function failure(status){return `HTTP ${status}：${status===401||status===403?'账号授权或权限不可用，请重新登录并检查账号权限':status===429?'账号额度不足或服务限流，请稍后手动重试':'账号模型服务请求失败，请检查服务后手动重试'}`;}
export async function generateAccount(p,input,signal){
  const cfg=buildAccountGeneration(p,input),combined=AbortSignal.any([AbortSignal.timeout(Math.min(1800000,Number(p.timeoutMs)||300000)),...(signal?[signal]:[])]);let res;
  try{res=await (p.accountFetcher||fetch)(cfg.url,{method:'POST',headers:{...cfg.headers,'Content-Type':'application/json'},body:JSON.stringify(cfg.body),signal:combined,redirect:'error'});}catch{throw Error(signal?.aborted?'任务已取消':'账号模型连接失败或超时；未自动重发');}
  if(!res.ok){await res.body?.cancel();throw Error(failure(res.status));}
  if(!(res.headers.get('content-type')||'').includes('text/event-stream')){await res.body?.cancel();throw Error('账号模型未返回预期的实时响应；未自动重发');}
  try{return await readGenerationStream(res.body,cfg.protocol,input.onProgress);}catch(e){if(e instanceof StreamReadError)throw e;throw Error('账号模型生成失败或被服务拒绝；部分正文已保留，未自动重发');}
}
export async function accountModels(p){
  if(p.accountPlatform==='antigravity'){
    let res;try{res=await (p.accountFetcher||fetch)(accountBase('antigravity')+'/v1internal:fetchAvailableModels',{method:'POST',headers:{...accountHeaders(p),'Content-Type':'application/json'},body:JSON.stringify({project:p.accountCredentials.projectId}),signal:AbortSignal.timeout(15000),redirect:'error'});}catch{throw Error('Antigravity 模型目录读取失败或超时');}
    if(!res.ok){await res.body?.cancel();throw Error(failure(res.status));}const data=await res.json(),models=data.models;if(!models||typeof models!=='object'||Array.isArray(models))throw Error('Antigravity 模型目录格式无效，可手动填写模型 ID');
    return uniqueModels(Object.entries(models).slice(0,2000).map(([id,m])=>accountModel('antigravity',m,id)));
  }
  if(p.accountPlatform==='workbuddy'){
    const base=workbuddyOrigin(p.accountCredentials,p.accountRegion),paths=p.accountRegion==='intl'?['/v3/config','/v2/enterprises/personal/models','/console/enterprises/personal/models']:['/console/enterprises/personal/models','/v3/config'];
    for(const path of paths){
      let response;try{response=await (p.accountFetcher||fetch)(base+path,{headers:accountHeaders(p),signal:AbortSignal.timeout(15000),redirect:'error'});if(!response.ok){await response.body?.cancel();continue;}const data=await response.json();if(data.code!==undefined&&![0,200].includes(data.code))continue;const rows=data.data?.models||data.models;if(!Array.isArray(rows)||!rows.length)continue;const parsed=uniqueModels(rows.slice(0,2000).map(m=>accountModel('workbuddy',m)));if(parsed.length)return parsed;}catch{}
    }
    throw Error('WorkBuddy 模型目录读取失败；旧目录已保留，也可手动添加模型 ID');
  }
  const base=accountBase(p.accountPlatform,p.accountRegion);let res;
  try{res=await (p.accountFetcher||fetch)(base+'/models',{headers:accountHeaders(p),signal:AbortSignal.timeout(15000),redirect:'error'});}catch{throw Error('账号模型目录读取失败或超时');}
  if(!res.ok){await res.body?.cancel();throw Error(failure(res.status));}const data=await res.json(),rows=data.data||data.models;
  if(!Array.isArray(rows))throw Error('账号模型目录格式无效，可手动填写模型 ID');
  return uniqueModels(rows.slice(0,2000).filter(m=>p.accountPlatform!=='chatgpt'||m?.visibility==='list').map(m=>accountModel(p.accountPlatform,m)));
}
