import {streamGeneration,visibleText} from './streaming.js';
export function validateProvider(p){
  if(!p||!String(p.name||'').trim())throw new Error('连接名称不能为空');
  if(!['openai','anthropic','gemini','ollama','router','llama'].includes(p.protocol))throw new Error('接口协议无效');
  const url=new URL(p.baseUrl);const local=['127.0.0.1','localhost','[::1]'].includes(url.hostname);
  if(url.username||url.password||url.search||url.hash)throw new Error('服务地址不能包含凭据、查询参数或片段');
  if(url.protocol!=='https:'&&!(url.protocol==='http:'&&local))throw new Error('在线接口必须使用 HTTPS；HTTP 只允许本机地址');
  if(['router','ollama','llama'].includes(p.protocol)&&!local)throw new Error('托管本地模型仅允许本机回环地址');
  if(p.tokenField&&!['auto','max_tokens','max_completion_tokens'].includes(p.tokenField))throw new Error('输出长度参数无效');
  if(p.temperatureMode&&!['auto','send','omit'].includes(p.temperatureMode))throw new Error('采样参数模式无效');
  return {...p,name:String(p.name).trim().slice(0,100),baseUrl:url.href.replace(/\/$/,'')};
}
export function rootUrl(p){return p.baseUrl.replace(/\/(v1|v1beta)\/?$/,'');}
export async function request(url,{method='GET',headers={},body,signal,timeout=120000}={}){
  let res;try{res=await fetch(url,{method,headers:{...headers,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.any([AbortSignal.timeout(timeout),...(signal?[signal]:[])]),redirect:'error'});}catch(e){if(signal?.aborted)throw e;throw new Error(e.name==='TimeoutError'?'模型服务响应超时，请检查服务状态与超时设置。':'无法连接所选模型服务，请检查地址、服务是否运行及网络连接。');}
  const text=await res.text();let data;try{data=JSON.parse(text);}catch{data={error:{message:text.slice(0,200)}};}
  if(!res.ok)throw new Error(`HTTP ${res.status}：${data.error?.message||data.message||'模型服务请求失败'}`);
  return data;
}
export function buildGeneration(p,{system,user,images=[],temperature=0.6,maxTokens=1024,autoUnload=true}){
  const key=p.apiKey||'';const textParts=[{type:'text',text:user},...images.map(i=>({type:'image_url',image_url:{url:i.dataUrl}}))];
  const nativeOpenAI=new URL(p.baseUrl).hostname==='api.openai.com';
  const reasoning=nativeOpenAI&&/^(gpt-[5-9]|o[1-9])/.test(p.model);
  const includeTemperature=p.temperatureMode==='send'||(p.temperatureMode!=='omit'&&p.protocol!=='anthropic'&&!reasoning);
  if(p.protocol==='anthropic')return {url:p.baseUrl+'/messages',headers:{'x-api-key':key,'anthropic-version':'2023-06-01'},body:{model:p.model,system,max_tokens:maxTokens,...(includeTemperature?{temperature:Math.min(1,temperature)}:{}),messages:[{role:'user',content:[{type:'text',text:user},...images.map(i=>({type:'image',source:{type:'base64',media_type:i.dataUrl.split(';')[0].slice(5),data:i.dataUrl.split(',')[1]}}))]}]}};
  if(p.protocol==='gemini')return {url:p.baseUrl+`/models/${encodeURIComponent(p.model.replace(/^models\//,''))}:generateContent`,headers:{'x-goog-api-key':key},body:{systemInstruction:{parts:[{text:system}]},contents:[{role:'user',parts:[{text:user},...images.map(i=>({inlineData:{mimeType:i.dataUrl.split(';')[0].slice(5),data:i.dataUrl.split(',')[1]}}))]}],generationConfig:{...(includeTemperature?{temperature}:{}),maxOutputTokens:maxTokens}}};
  if(p.protocol==='ollama')return {url:rootUrl(p)+'/api/chat',headers:key?{Authorization:'Bearer '+key}:{},body:{model:p.model,stream:false,keep_alive:autoUnload?0:'5m',messages:[{role:'system',content:system},{role:'user',content:user,...(images.length?{images:images.map(i=>i.dataUrl.split(',')[1])}:{})}],options:{...(includeTemperature?{temperature}:{}),num_predict:maxTokens}}};
  const tokenField=p.tokenField&&p.tokenField!=='auto'?p.tokenField:nativeOpenAI?'max_completion_tokens':'max_tokens';
  return {url:p.baseUrl+'/chat/completions',headers:key?{Authorization:'Bearer '+key}:{},body:{model:p.model,stream:false,messages:[{role:'system',content:system},{role:'user',content:images.length?textParts:user}],...(includeTemperature?{temperature}:{}),[tokenField]:maxTokens,...(['router','llama'].includes(p.protocol)?{chat_template_kwargs:{enable_thinking:false}}:{})}};
}
export async function generate(p,input,signal){
  const cfg=buildGeneration(p,input);const streamed=input.stream?await streamGeneration(p,cfg,input,signal):null;if(streamed?.result)return streamed.result;const data=streamed?.data||await request(cfg.url,{method:'POST',headers:cfg.headers,body:cfg.body,signal,timeout:Math.min(1800000,Number(p.timeoutMs)||300000)});
  let output,usage,finishReason;
  if(p.protocol==='anthropic'){output=data.content?.filter(c=>c.type==='text').map(c=>c.text).join('\n');usage=data.usage;finishReason=data.stop_reason;}
  else if(p.protocol==='gemini'){output=data.candidates?.[0]?.content?.parts?.filter(c=>!c.thought).map(c=>c.text||'').join('\n');usage=data.usageMetadata;finishReason=data.candidates?.[0]?.finishReason;}
  else if(p.protocol==='ollama'){output=data.message?.content;usage={input_tokens:data.prompt_eval_count,output_tokens:data.eval_count};finishReason=data.done_reason;}
  else {const c=data.choices?.[0];output=c?.message?.content;usage=data.usage;finishReason=c?.finish_reason;}
  if(typeof output!=='string'||!output.trim())throw new Error('模型没有返回可用正文，请检查模型能力或 token 限制');
  output=visibleText(output);if(!output)throw Error('模型只有思考内容，没有可用正文');input.onProgress?.(output);return {output,usage,finishReason,truncated:['length','MAX_TOKENS','max_tokens'].includes(finishReason)};
}
export async function models(p){
  let url=p.baseUrl+'/models',headers=p.apiKey?{Authorization:'Bearer '+p.apiKey}:{};
  if(p.protocol==='anthropic')headers={'x-api-key':p.apiKey||'','anthropic-version':'2023-06-01'};
  if(p.protocol==='gemini')headers={'x-goog-api-key':p.apiKey||''};
  if(p.protocol==='ollama')url=rootUrl(p)+'/api/tags';
  const data=await request(url,{headers,timeout:15000});
  return (data.data||data.models||[]).map(m=>({id:m.id||m.name,status:m.status?.value||m.status||'available'}));
}
