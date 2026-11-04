const text=(value,max=180)=>typeof value==='string'?value.replace(/[\u0000-\u001f\u007f]/g,'').trim().slice(0,max):'';
const positive=value=>typeof value==='number'&&Number.isSafeInteger(value)&&value>0&&value<=1e9?value:undefined;
export function modelMetadata(m={}){
  const result={displayName:text(m.displayName)||text(m.id)};
  const description=text(m.description,1200);if(description)result.description=description;
  for(const key of ['contextWindow','maxOutputTokens']){const n=positive(m[key]);if(n)result[key]=n;}
  if(Array.isArray(m.contextWindows)){const ns=[...new Set(m.contextWindows.map(positive).filter(Boolean))].slice(0,8);if(ns.length)result.contextWindows=ns;}
  if(Array.isArray(m.inputModalities)){const types=[...new Set(m.inputModalities.filter(v=>['text','image','audio','video'].includes(v)))];if(types.length)result.inputModalities=types;}
  if(Array.isArray(m.reasoningEfforts)){const seen=new Set(),efforts=[];for(const v of m.reasoningEfforts.slice(0,12)){const value=text(typeof v==='string'?v:v?.value,40);if(!value||seen.has(value))continue;seen.add(value);efforts.push({value,label:text(v?.label,100)||value,...(v?.default===true?{default:true}:{})});}if(efforts.length)result.reasoningEfforts=efforts;}
  return result;
}
export function accountModel(platform,raw,idHint){
  if(!raw||typeof raw!=='object'||Array.isArray(raw))return null;
  const id=platform==='chatgpt'?raw.slug||raw.id:platform==='grok'?raw.model||raw.id:idHint||raw.id;
  if(typeof id!=='string'||!id.trim()||id.trim().length>180||/[\u0000-\u001f\u007f]/.test(id))return null;
  const inputModalities=raw.input_modalities||raw.inputModalities;
  let vision=typeof raw.supportsImages==='boolean'?raw.supportsImages:Array.isArray(inputModalities)?inputModalities.includes('image'):undefined;
  if(platform==='workbuddy'&&raw.disabledMultimodal===true)vision=false;
  return {id:id.trim(),status:'available',...modelMetadata({id,displayName:raw.display_name||raw.displayName||raw.name,description:raw.description,contextWindow:raw.context_window??raw.maxInputTokens??raw.inputTokenLimit,contextWindows:raw.context_windows,maxOutputTokens:raw.maxOutputTokens??raw.outputTokenLimit,inputModalities,reasoningEfforts:raw.reasoning_efforts||raw.reasoning?.supportedEfforts}),...(typeof vision==='boolean'?{vision}:{})};
}
export function uniqueModels(rows){const seen=new Set();return rows.filter(m=>{if(!m||seen.has(m.id))return false;seen.add(m.id);return true;});}
