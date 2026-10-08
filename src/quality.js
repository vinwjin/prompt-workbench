// Deterministic checks only: no scripts, network, model calls or semantic grading.
export function qualityRules(value={}){
  if(!value||typeof value!=='object'||Array.isArray(value))throw Error('检查规则格式无效');
  const words=key=>{const v=value[key]??[];if(!Array.isArray(v)||v.length>50||v.some(w=>typeof w!=='string'||!w.trim()||w.length>200))throw Error('检查词需要1–200字，每类最多50条');return [...new Set(v.map(w=>w.trim()))];};
  const number=key=>{const v=value[key];if(v===undefined||v===null||v==='')return null;if(!Number.isSafeInteger(Number(v))||Number(v)<0||Number(v)>60000)throw Error('长度范围须为0–60000的整数');return Number(v);};
  const minLength=number('minLength'),maxLength=number('maxLength');if(minLength!==null&&maxLength!==null&&minLength>maxLength)throw Error('最小长度不能大于最大长度');
  if(value.json!==undefined&&typeof value.json!=='boolean')throw Error('JSON规则格式无效');
  return {include:words('include'),exclude:words('exclude'),minLength,maxLength,json:value.json===true};
}
export function checkQuality(text,value={}){
  if(typeof text!=='string'||text.length>2000000)throw Error('待检查正文无效或超过2000000字');
  const rules=qualityRules(value),length=Array.from(text).length,items=[];
  for(const word of rules.include)items.push({label:'必须包含：'+word,pass:text.includes(word)});
  for(const word of rules.exclude)items.push({label:'不得包含：'+word,pass:!text.includes(word)});
  if(rules.minLength!==null)items.push({label:'至少 '+rules.minLength+' 字',pass:length>=rules.minLength});
  if(rules.maxLength!==null)items.push({label:'最多 '+rules.maxLength+' 字',pass:length<=rules.maxLength});
  if(rules.json){let pass=true;try{JSON.parse(text);}catch{pass=false;}items.push({label:'完整正文为合法JSON',pass});}
  return {length,items,passed:items.filter(i=>i.pass).length,total:items.length,pass:items.length?items.every(i=>i.pass):null};
}
