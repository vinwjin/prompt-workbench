import {createHash} from 'node:crypto';
import {saveAsset} from './library.js';

export class ImageBatch {
  constructor(store,jobs,media){this.store=store;this.jobs=jobs;this.media=media;}
  enqueue(b){
    if(typeof b.requestId!=='string'||! /^[a-f0-9-]{36}$/.test(b.requestId))throw Error('批次标识无效');
    const requestHash=createHash('sha256').update(JSON.stringify({items:b.items,providerId:b.providerId,model:b.model,input:b.input,language:b.language,folderId:b.folderId,temperature:b.temperature,maxTokens:b.maxTokens})).digest('hex');
    const existing=this.rows(b.requestId);if(existing.length){if(existing[0].imageBatchRequestHash!==requestHash)throw Error('本批已提交，请新建批次');return {batchId:b.requestId,jobs:existing};}
    if(!Array.isArray(b.items)||!b.items.length||b.items.length>20)throw Error('每批选择1–20张图片');
    if(typeof b.input!=='string'||b.input.length>2000)throw Error('读图要求最多2000字');
    if(b.folderId&&!this.store.get('folders',b.folderId))throw Error('文件夹不存在');
    const batchId=b.requestId,metadata=[],inputs=[];let total=0;
    for(const item of b.items){
      const original=this.media.resolve([item.media])[0];
      if(!['image/png','image/jpeg','image/webp'].includes(original.type))throw Error('批量读图仅支持PNG/JPEG/WebP');
      total+=original.bytes;if(total>200*1024*1024)throw Error('本批原图合计最多200MB');
      if(typeof item.dataUrl!=='string'||item.dataUrl.length>660000)throw Error('模型预览图过大，请重新选择');
      inputs.push({providerId:b.providerId,model:b.model,templateId:'reverse',input:b.input.trim()||'根据当前图片生成可复用的绘图提示词。',variables:{language:b.language||'中文'},images:[{name:original.name,dataUrl:item.dataUrl}],temperature:b.temperature,maxTokens:b.maxTokens,autoUnload:true,stream:true});
      metadata.push({imageBatchId:batchId,imageBatchRequestHash:requestHash,originalMedia:[original],archiveFolderId:b.folderId||''});
    }
    const jobs=this.jobs.enqueueBatch(inputs,{metadata});
    this.media.committed(b.items.map(i=>i.media));return {batchId,jobs:jobs.map(({images,compiled,...j})=>j)};
  }
  collect(job){
    if(!job.imageBatchId||job.status!=='succeeded'||!job.output?.trim())throw Error('仅可收录成功的批量读图结果');
    this.media.validateReferences([{media:job.originalMedia}]);
    this.store.db.exec('BEGIN IMMEDIATE');try{const asset=saveAsset(this.store,{title:job.originalMedia[0].name.replace(/\.[^.]+$/,'')||'读图提示词',content:job.output,resultJobId:job.id,folderId:this.store.get('folders',job.archiveFolderId)?job.archiveFolderId:'',category:'图片反推',modelHint:job.model,note:'根据上传图片生成，需核对可见事实；不是原始提示词还原。'},{mediaSelection:job.originalMedia});
    const saved=this.store.put('jobs',{...job,archiveAssetId:asset.id,archivePending:false,archiveError:null});this.store.db.exec('COMMIT');return saved;}catch(e){this.store.db.exec('ROLLBACK');throw e;}
  }
  cancel(batchId){const rows=this.store.list('jobs').filter(j=>j.imageBatchId===batchId&&['running','queued','cancelling'].includes(j.status));for(const j of rows)this.jobs.cancel(j.id);return {cancelled:rows.length};}
  rows(batchId){return this.store.db.prepare("SELECT json_remove(body,'$.images','$.compiled','$.variables','$.input','$.output','$.partialOutput','$.rawInput') AS body FROM records WHERE kind='jobs' AND json_extract(body,'$.imageBatchId')=? ORDER BY json_extract(body,'$.createdAt'),rowid").all(batchId).map(r=>JSON.parse(r.body));}
}
