import {qualityRules} from './quality.js';
export function snippetData(value){
  if(!value||typeof value!=='object'||Array.isArray(value))throw Error('片段格式无效');
  const text=(key,max,required=false)=>{if(value[key]!==undefined&&typeof value[key]!=='string')throw Error('片段字段无效');const v=(value[key]||'').trim();if(v.length>max||required&&!v)throw Error('片段名称和正文不能为空且不能超长');return v;};
  return {name:text('name',80,true),category:text('category',40)||'通用',content:text('content',10000,true),note:text('note',500)};
}
export function saveSnippet(store,value){
  const old=value.id?store.get('snippets',value.id):null;
  if(value.id&&(!old||old.deletedAt))throw Error('片段不存在或在回收站');
  if(old&&value.expectedUpdatedAt&&old.updatedAt!==value.expectedUpdatedAt)throw Error('片段已更改，请重新打开后编辑');
  const data=snippetData(value);if(store.list('snippets').some(s=>!s.deletedAt&&s.id!==old?.id&&s.name.toLocaleLowerCase()===data.name.toLocaleLowerCase()))throw Error('片段名称已存在');
  store.backup();return store.put('snippets',{...old,...data});
}
export function snippetSnapshots(store,ids=[]){
  if(!Array.isArray(ids)||ids.length>20||ids.some(id=>typeof id!=='string'))throw Error('一次最多组合20个片段');
  return [...new Set(ids)].map(id=>{const s=store.get('snippets',id);if(!s||s.deletedAt)throw Error('所选片段不存在或在回收站，请重新选择');return {id:s.id,name:s.name,category:s.category,content:s.content,updatedAt:s.updatedAt};});
}
export function composeInput(store,input,ids=[],versions={}){
  if(typeof input!=='string'||input.length>60000)throw Error('输入超过60000字');
  if(!versions||typeof versions!=='object'||Array.isArray(versions))throw Error('片段版本格式无效');
  const snippets=snippetSnapshots(store,ids);if(snippets.some(s=>versions[s.id]!==undefined&&versions[s.id]!==s.updatedAt))throw Error('片段在预览后已更改，请重新预览组合');
  const text=[input,...snippets.map(s=>'【'+s.name+'】\n'+s.content)].filter(Boolean).join('\n\n');
  if(text.length>60000)throw Error('组合后的输入超过60000字，请减少片段');
  return {text,snippets};
}
export function iterationSnapshot(store,parentId,instruction){
  const parent=store.get('jobs',parentId);
  if(!parent||parent.deletedAt||parent.status!=='succeeded'||!parent.output?.trim())throw Error('只能继续优化未删除的成功结果');
  if(typeof instruction!=='string'||!instruction.trim()||instruction.length>6000)throw Error('请填写1–6000字的修改要求');
  if(!parent.compiled||typeof parent.compiled.system!=='string'||typeof parent.compiled.user!=='string')throw Error('父任务缺少指令快照，无法继续优化');
  if(parent.output.length>60000||(parent.iterationDepth||0)>=100)throw Error('结果过长或迭代超过100轮，请保存后另建任务');
  return {rootCompiled:parent.rootCompiled||parent.compiled,parentJobId:parent.id,chainId:parent.chainId||parent.id,iterationDepth:(parent.iterationDepth||0)+1,rootInput:parent.rootInput??parent.input,instruction:instruction.trim(),parentSnapshot:{id:parent.id,output:parent.output,model:parent.model,templateName:parent.templateName,templateRevision:parent.templateRevision},source:parent.source,images:parent.images||[],variables:parent.variables,templateId:parent.templateId,templateName:parent.templateName,templateRevision:parent.templateRevision,compiled:{system:parent.compiled.system,user:'原始需求（保留约束）：\n'+(parent.rootInput??parent.input)+'\n\n首次完整用户指令（保留变量与输出约束）：\n'+(parent.rootCompiled||parent.compiled).user+'\n\n上一版结果：\n'+parent.output+'\n\n本轮修改要求：\n'+instruction.trim()+'\n\n请根据本轮要求修订上一版，保留未要求改变的事实和约束，仅输出完整修订结果。'}};
}
export function compareJobs(store,leftId,rightId){
  if(!leftId||!rightId||leftId===rightId)throw Error('请选择两条不同任务');
  const rows=[leftId,rightId].map(id=>store.get('jobs',id));if(rows.some(j=>!j||j.deletedAt||j.status!=='succeeded'))throw Error('只能比较未删除的成功任务');
  const [a,b]=rows,eq=(x,y)=>JSON.stringify(x)===JSON.stringify(y);
  const sameInput=a.input===b.input,sameVariables=eq(a.variables,b.variables),sameImages=eq(a.images||[],b.images||[]),sameInstructions=eq(a.compiled,b.compiled);
  const clean=j=>{const {images,...rest}=j;return {...rest,imageCount:(images||[]).length};};
  return {left:clean(a),right:clean(b),sameInput,sameVariables,sameImages,sameInstructions,controlled:sameInput&&sameVariables&&sameImages&&sameInstructions,related:(a.chainId||a.id)===(b.chainId||b.id)};
}
export function iterationChain(store,id){
  const target=store.get('jobs',id);if(!target||target.deletedAt)throw Error('任务不存在或在回收站');
  const chainId=target.chainId||target.id;
  return {chainId,items:store.list('jobs').filter(j=>!j.deletedAt&&(j.chainId||j.id)===chainId).map(j=>({id:j.id,parentJobId:j.parentJobId,depth:j.iterationDepth||0,status:j.status,model:j.model,createdAt:j.createdAt,instruction:j.instruction||'首次任务'})).sort((a,b)=>a.depth-b.depth||a.createdAt.localeCompare(b.createdAt))};
}
export {qualityRules};
