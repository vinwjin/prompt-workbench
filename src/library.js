const ACTIVE=new Set(['running','queued','cancelling']);
import {mediaMetadata} from './asset-media.js';
export function normalizeTags(raw){const values=String(raw||'').split(/[,，;；\n]/).map(t=>t.trim()).filter(Boolean);const seen=new Set(),tags=[];for(const t of values){if(t.length>40)throw Error('单个标签最多40字');const key=t.toLocaleLowerCase();if(!seen.has(key)){tags.push(t);seen.add(key);}}if(tags.length>30||tags.join(', ').length>500)throw Error('标签最多30项，合计最多500字');return tags.join(', ');}
export function resultRecord(raw,content){if(!raw||raw.status!=='succeeded'||typeof raw.jobId!=='string'||! /^[A-Za-z0-9_-]{1,100}$/.test(raw.jobId)||raw.output!==content)return null;return {jobId:raw.jobId,status:'succeeded',output:content,model:String(raw.model||'').slice(0,200),templateName:String(raw.templateName||'').slice(0,100),finishedAt:String(raw.finishedAt||'').slice(0,100)};}
export function resultAsset(store,a){return !a.source||!!resultRecord(a.resultRecord,a.content)||!!a.resultJobId&&store.get('jobs',a.resultJobId)?.status==='succeeded';}
export function exportAssets(store,ids){if(!Array.isArray(ids)||ids.length>1000||ids.some(id=>typeof id!=='string'))throw Error('导出选择无效');return {schema:'prompt-workbench/assets/v1',assets:[...new Set(ids)].map(id=>store.get('assets',id)).filter(Boolean).map(a=>{const j=store.get('jobs',a.resultJobId||'');const record=j?.status==='succeeded'?resultRecord({jobId:j.id,status:j.status,output:a.content,model:j.model,templateName:j.templateName,finishedAt:j.finishedAt},a.content):resultRecord(a.resultRecord,a.content);return {...a,...(record?{resultRecord:record}:{})};})};}
export function provenance(raw){if(!raw||typeof raw!=='object')return null;return Object.fromEntries(['sourceId','originId','url','author','license'].map(k=>[k,String(raw[k]||'').slice(0,k==='url'?2000:250)]));}
export function bulkManage(store,kind,{ids,action,folderId='',favorite=true,tag=''}){
  if(!['assets','jobs'].includes(kind)||!['trash','restore','favorite','move','tag-add','tag-remove'].includes(action))throw new Error('批量操作无效');
  if(kind==='jobs'&&!['trash','restore'].includes(action))throw new Error('任务不支持该操作');
  if(!Array.isArray(ids)||!ids.length||ids.length>10000||ids.some(id=>typeof id!=='string'))throw new Error('请选择有效记录');
  if(action==='move'&&folderId&&!store.get('folders',folderId))throw new Error('文件夹不存在');
  const rows=[...new Set(ids)].map(id=>store.get(kind,id)).filter(Boolean);
  if(action.startsWith('tag-')&&(!normalizeTags(tag)||normalizeTags(tag).split(', ').length!==1))throw Error('请填写一个有效标签');
  if(action.startsWith('tag-'))tag=normalizeTags(tag);
  store.backup();let changed=0,skipped=0;store.db.exec('BEGIN IMMEDIATE');
  try{for(const row of rows){if(kind==='jobs'&&ACTIVE.has(row.status)){skipped++;continue;}
    const change=action==='trash'?{deletedAt:new Date().toISOString()}:action==='restore'?{deletedAt:null}:action==='move'?{folderId}:action==='tag-add'?{tags:normalizeTags((row.tags||'')+','+tag)}:action==='tag-remove'?{tags:normalizeTags(normalizeTags(row.tags).split(', ').filter(t=>t.toLocaleLowerCase()!==tag.trim().toLocaleLowerCase()).join(','))}:{favorite:favorite===true};
    store.put(kind,{...row,...change});changed++;
  }store.db.exec('COMMIT');}catch(e){store.db.exec('ROLLBACK');throw e;}return {changed,skipped};
}
export function saveAsset(store,b,{allowResultRecord=false,mediaSelection}={}){
  if(typeof b.title!=='string'||!b.title.trim()||typeof b.content!=='string'||!b.content.trim())throw new Error('标题和提示词正文不能为空');
  if(b.content.length>100000)throw new Error('资产正文过长');
  const old=store.get('assets',String(b.id||''));
  if(b.id&&!old)throw Error('记录不存在，请刷新后重新操作');
  if(old?.deletedAt)throw Error('记录在回收站，请先恢复');
  if(old&&b.expectedUpdatedAt&&b.expectedUpdatedAt!==old.updatedAt)throw Error('记录已被更改，请刷新后重新编辑');
  if(!old&&!b.copyOf&&b.resultJobId){const existing=store.list('assets').find(a=>a.resultJobId===b.resultJobId&&a.content===b.content);if(existing){const merged=mediaSelection?.length?mediaMetadata([...new Map([...(existing.media||[]),...mediaSelection].map(m=>[m.id,m])).values()]):existing.media||[];if(existing.deletedAt||JSON.stringify(merged)!==JSON.stringify(existing.media||[]))return store.put('assets',{...existing,media:merged,deletedAt:null});return existing;}}
  const copied=b.copyOf?store.get('assets',String(b.copyOf)):null,archiveSource=old||copied;
  const archived=allowResultRecord?resultRecord(b.resultRecord,b.content):archiveSource?.resultRecord?resultRecord({...archiveSource.resultRecord,output:b.content},b.content):null;if(allowResultRecord&&b.resultRecord&&!archived)throw Error('成果包记录无效');
  const resultJobId=b.resultJobId||old?.resultJobId;if(resultJobId&&store.get('jobs',resultJobId)?.status!=='succeeded'&&!archived)throw Error('只能保存已完成任务的优化成果');
  const task=resultJobId?store.get('jobs',resultJobId):null;const record=archived||(task?.status==='succeeded'?resultRecord({jobId:task.id,status:task.status,output:b.content,model:task.model,templateName:task.templateName,finishedAt:task.finishedAt},b.content):null);
  const folderId=String(b.folderId??old?.folderId??'');if(folderId&&!store.get('folders',folderId))throw new Error('文件夹不存在');
  const negative=String(b.negative??old?.negative??'').slice(0,50000);
  const media=mediaMetadata(mediaSelection??old?.media??copied?.media??[]);
  const versions=old&&(old.content!==b.content||(old.negative||'')!==negative)?[{content:old.content,negative:old.negative||'',at:old.updatedAt},...(old.versions||[])].slice(0,30):old?.versions||[];
  const importInfo=b.importInfo?{fileName:String(b.importInfo.fileName||'').slice(0,180),encoding:String(b.importInfo.encoding||'').slice(0,30),raw:String(b.importInfo.raw||'').slice(0,100000)}:old?.importInfo||copied?.importInfo||null;
  return store.put('assets',{...old,id:old?.id,resultRecord:record,resultJobId:resultJobId||null,title:b.title.trim().slice(0,150),content:b.content,negative,media,importInfo,category:String(b.category??old?.category??'未分类').slice(0,50),tags:normalizeTags(b.tags??old?.tags),note:String(b.note||'').slice(0,3000),modelHint:String(b.modelHint??old?.modelHint??'').slice(0,200),folderId,favorite:b.favorite===undefined?old?.favorite===true:b.favorite===true,source:provenance(old?.source||b.source),versions,createdAt:old?.createdAt||new Date().toISOString()});
}
