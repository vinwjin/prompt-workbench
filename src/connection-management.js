import {createHash} from 'node:crypto';
import {modelMetadata} from './model-catalog.js';

const localProtocols=new Set(['router','llama','ollama']);
const modelId=value=>{if(typeof value!=='string'||!value.trim()||value.trim().length>180||/[\u0000-\u001f]/.test(value))throw Error('模型 ID 需要1–180字，且不能含控制字符');return value.trim();};
export function validateModelPreferences(value){if(value===undefined)return;if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length>200)throw Error('模型偏好备份格式无效，最多200项');for(const [id,pref]of Object.entries(value)){if(modelId(id)!==id||!pref||typeof pref!=='object'||Array.isArray(pref)||Object.keys(pref).some(k=>!['manual','favorite','vision'].includes(k))||['manual','favorite'].some(k=>pref[k]!==undefined&&typeof pref[k]!=='boolean')||pref.vision!==undefined&&pref.vision!==null&&typeof pref.vision!=='boolean')throw Error('模型偏好备份格式无效');}}
export const connectionFingerprint=p=>createHash('sha256').update(JSON.stringify([p.protocol,p.baseUrl,p.protocol==='account'?p.accountEpoch||'':p.sealedKey||''])).digest('hex');
export function connectionFailure(error){const message=String(error||'连接失败').slice(0,1000),httpStatus=Number(message.match(/HTTP\s+(\d{3})/)?.[1])||null;return {message,httpStatus,stage:httpStatus?'http':/JSON|响应.*格式|解析/.test(message)?'parse':/超时/.test(message)?'timeout':'network',suggestion:httpStatus===401||httpStatus===403?'检查密钥及访问权限':httpStatus===404?'检查服务地址与接口路径':httpStatus===429?'检查服务限流或额度':httpStatus?'查看服务状态及错误详情':'检查地址、网络与服务是否运行'};}

export class ConnectionManagement{
  constructor(store,jobs){this.store=store;this.jobs=jobs;}
  provider(id){const p=this.store.get('providers',id);if(!p)throw Error('连接不存在，请刷新');return p;}
  diagnostics(p){
    const fingerprint=connectionFingerprint(p),check=this.store.get('connectionChecks',p.id);
    const tests=this.store.db.prepare("SELECT body FROM records WHERE kind='jobs' AND json_extract(body,'$.connectionTest')=1 AND json_extract(body,'$.providerId')=? ORDER BY json_extract(body,'$.createdAt') DESC LIMIT 8").all(p.id).map(row=>{const j=JSON.parse(row.body);return {id:j.id,model:j.model,status:j.status,output:j.output||j.partialOutput||'',error:j.error||'',createdAt:j.createdAt,finishedAt:j.finishedAt,durationMs:j.metrics?.totalMs??null,currentConfig:j.connectionFingerprint===fingerprint};});
    return {check:check?{...check,currentConfig:check.fingerprint===fingerprint,fingerprint:undefined}:null,tests};
  }
  catalog(id){
    const p=this.provider(id),cached=this.store.get('modelLists',id);validateModelPreferences(p.modelPreferences);const preferences=Object.assign(Object.create(null),p.modelPreferences||{}),models=new Map();
    for(const m of (cached?.models||[]).slice(0,2000))if(m.id)models.set(m.id,{id:m.id,...modelMetadata(m),source:'upstream',status:m.status||'available',vision:typeof m.vision==='boolean'?m.vision:null,visionSource:typeof m.vision==='boolean'?'service':'unknown'});
    for(const [id,pref]of Object.entries(preferences))if((pref.manual||pref.favorite)&&!models.has(id))models.set(id,{id,displayName:id,source:pref.manual?'manual':'retained',status:'manual',vision:null,visionSource:'unknown'});
    if(p.model&&!models.has(p.model))models.set(p.model,{id:p.model,displayName:p.model,source:'retained',status:'selected',vision:null,visionSource:'unknown'});
    const diagnostics=this.diagnostics(p);
    return {providerId:id,updatedAt:p.updatedAt,defaultModel:p.model||'',fetchedAt:cached?.checkedAt||null,models:[...models.values()].map(m=>{const pref=preferences[m.id]||{},test=diagnostics.tests.find(t=>t.currentConfig&&t.model===m.id);return {...m,favorite:pref.favorite===true,manual:pref.manual===true,...(test?{lastTest:{status:test.status,at:test.finishedAt||test.createdAt}}:{}),...(typeof pref.vision==='boolean'?{vision:pref.vision,visionSource:'manual'}:{})};}),...diagnostics};
  }
  saveModel(id,input){
    const p=this.provider(id),model=modelId(input.model);if(input.expectedUpdatedAt&&input.expectedUpdatedAt!==p.updatedAt)throw Error('模型配置已更新，请刷新后重试');
    const preferences=Object.assign(Object.create(null),p.modelPreferences||{});
    if(input.removeManual===true){if(p.model===model)throw Error('请先更换默认模型，再移除手动项');delete preferences[model];}
    else{for(const key of ['manual','favorite'])if(input[key]!==undefined&&typeof input[key]!=='boolean')throw Error('模型设置格式无效');if(input.vision!==undefined&&input.vision!==null&&typeof input.vision!=='boolean')throw Error('视觉能力必须为支持、不支持或未知');if(!preferences[model]&&Object.keys(preferences).length>=200)throw Error('每个连接最多整理200个模型');const value={...(preferences[model]||{})};for(const key of ['manual','favorite','vision'])if(input[key]!==undefined)value[key]=input[key];preferences[model]=value;}
    this.store.put('providers',{...p,modelPreferences:preferences});return this.catalog(id);
  }
  recordCheck(p,result,latencyMs){
    if(connectionFingerprint(this.provider(p.id))!==connectionFingerprint(p))throw Error('连接已更改，请重新检查');
    const safeError=String(result.error||'').split(p.apiKey||'\u0000').join('[密钥已隐藏]');
    const check={id:p.id,fingerprint:connectionFingerprint(p),online:result.online===true,checkedAt:new Date().toISOString(),latencyMs:Math.round(latencyMs),modelCount:result.models?.length||0,...(result.online?{}:connectionFailure(safeError))};
    this.store.put('connectionChecks',check);return {...check,fingerprint:undefined,currentConfig:true};
  }
  test(id,{model,prompt}){
    const p=this.provider(id);model=modelId(model);if(typeof prompt!=='string'||!prompt.trim()||prompt.length>500)throw Error('测试消息需要1–500字');
    if(this.jobs.active||this.jobs.queue.length||this.jobs.lifecycle.locked)throw Error('请等当前任务或模型操作完成，再测试生成');
    const input=prompt.trim();return this.jobs.enqueueSnapshot({providerId:id,model,input,maxTokens:128,temperature:0,stream:true,autoUnload:true},{templateId:'connection-test',templateName:'连接测试',templateRevision:1,compiled:{system:'简短回应用户的连接测试消息，只输出测试所需内容。',user:input},variables:{},rawInput:input},{connectionTest:true,connectionFingerprint:connectionFingerprint(p)});
  }
  overview(){return {items:this.store.list('providers').map(p=>({id:p.id,local:localProtocols.has(p.protocol),modelCount:this.catalog(p.id).models.length,fetchedAt:this.store.get('modelLists',p.id)?.checkedAt||null,...this.diagnostics(p)}))};}
}
