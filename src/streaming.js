// 原生Fetch读取SSE/NDJSON；请求失败不自动改协议或重复生成。
export function visibleText(text){return text.replace(/<think>[\s\S]*?(?:<\/think>|$)/g,'').replace(/<(?:t|th|thi|thin|think)?$/,'').trim();}
export async function readGenerationStream(body,protocol,onProgress=()=>{}){
  const decoder=new TextDecoder();let buffer='',event=[],output='',usage={},finishReason,done=false,bytes=0;
  const accept=raw=>{
    if(raw==='[DONE]'){done=true;return;}
    let data;try{data=JSON.parse(raw);}catch{throw Error('模型实时响应格式无效，已停止；不会自动重试');}
    if(data.error||data.type==='error')throw Error(data.error?.message||'模型实时生成失败');
    let delta='';
    if(protocol==='anthropic'){
      if(data.type==='message_start')usage={...usage,...data.message?.usage};
      if(data.type==='content_block_start'&&data.content_block?.type==='text')delta=data.content_block.text||'';
      if(data.delta?.type==='text_delta')delta=data.delta.text||'';
      if(data.type==='message_delta'){usage={...usage,...data.usage};finishReason=data.delta?.stop_reason;}
      if(data.type==='message_stop')done=true;
    }else if(protocol==='gemini'){
      const c=data.candidates?.[0];delta=c?.content?.parts?.filter(p=>!p.thought).map(p=>p.text||'').join('')||'';usage=data.usageMetadata||usage;if(c?.finishReason){finishReason=c.finishReason;done=true;}
    }else if(protocol==='ollama'){
      delta=data.message?.content||'';if(data.done){done=true;finishReason=data.done_reason;usage={input_tokens:data.prompt_eval_count,output_tokens:data.eval_count};}
    }else{
      const c=data.choices?.find(c=>c.index===0)||data.choices?.[0];delta=c?.delta?.content||'';if(c?.finish_reason){finishReason=c.finish_reason;done=true;}usage=data.usage||usage;
    }
    if(typeof delta!=='string')throw Error('模型实时正文格式无效');
    output+=delta;if(output.length>2e6)throw Error('模型输出超过安全长度');if(delta)onProgress(visibleText(output));
  };
  const line=text=>{if(protocol==='ollama'){if(text.trim())accept(text);return;}if(!text){if(event.length){accept(event.join('\n'));event=[];}}else if(text.startsWith('data:'))event.push(text.slice(5).trimStart());};
  for await(const chunk of body){bytes+=chunk.length;if(bytes>16e6)throw Error('模型实时响应过大');buffer+=decoder.decode(chunk,{stream:true});let end;while((end=buffer.indexOf('\n'))>=0){line(buffer.slice(0,end).replace(/\r$/,''));buffer=buffer.slice(end+1);}if(buffer.length>2e6)throw Error('模型实时响应帧过大');}
  buffer+=decoder.decode();if(buffer)line(buffer.replace(/\r$/,''));if(event.length)accept(event.join('\n'));
  if(!done)throw Error('模型实时响应意外中断，部分正文已保留；请人工决定是否重试');
  const text=visibleText(output);if(!text)throw Error('模型没有返回可用正文，请检查模型能力或输出上限');
  return {output:text,usage,finishReason,truncated:['length','MAX_TOKENS','max_tokens'].includes(finishReason)};
}
export async function streamGeneration(p,cfg,input,signal){
  const body={...cfg.body};let url=cfg.url;
  if(p.protocol==='gemini')url=url.replace(':generateContent',':streamGenerateContent')+'?alt=sse';else body.stream=true;
  const combined=AbortSignal.any([AbortSignal.timeout(Math.min(1800000,Number(p.timeoutMs)||300000)),...(signal?[signal]:[])]);
  let response;try{response=await fetch(url,{method:'POST',headers:{...cfg.headers,'Content-Type':'application/json'},body:JSON.stringify(body),signal:combined,redirect:'error'});}catch(e){if(signal?.aborted)throw e;throw Error(combined.aborted?'模型服务响应超时':'无法连接模型服务，请检查地址或网络');}
  if(!response.ok){const text=(await response.text()).slice(0,1000);let message;try{message=JSON.parse(text).error?.message;}catch{}throw Error(`HTTP ${response.status}：${message||'实时输出不可用，可关闭实时输出后手动再试'}`);}
  const type=response.headers.get('content-type')||'';
  if(type.includes('text/event-stream')||type.includes('ndjson'))return {result:await readGenerationStream(response.body,p.protocol,input.onProgress)};
  // 兼容同一次请求返回普通JSON的服务，不额外发送生成请求。
  let raw='',bytes=0;const decoder=new TextDecoder();for await(const chunk of response.body){bytes+=chunk.length;if(bytes>16e6)throw Error('模型响应过大');raw+=decoder.decode(chunk,{stream:true});}
  try{return {data:JSON.parse(raw+decoder.decode())};}catch{throw Error('模型响应不是有效JSON或实时数据');}
}
