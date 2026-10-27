import {Readable} from 'node:stream';
import {existsSync} from 'node:fs';
import {saveAsset} from './library.js';
import {mediaMetadata} from './asset-media.js';
import {collectionMedia} from './collection-media.js';
import {coverUrl} from './image-cache.js';
import {sourceVideoUrl} from './gallery-policy.js';

export class SharedCollection{
  constructor(store,sources,imageCache,assetMedia){Object.assign(this,{store,sources,imageCache,assetMedia});this.pending=new Set();this.locks=new Map();this.targets=new Map();}
  existing(item){return item&&this.store.db.prepare("SELECT id FROM records WHERE kind='assets' AND json_extract(body,'$.source.sourceId')=? AND json_extract(body,'$.source.originId')=? LIMIT 1").get(item.sourceId,item.originId)?.id;}
  collect(id,options={}){
    // Serialize the same source; separate copies must still receive their own media.
    const assetId=options.assetId||this.existing(this.store.get('shared',id)),old=assetId&&this.store.get('assets',assetId),previous=this.locks.get(id);
    if(previous&&!options.assetId&&(!assetId||assetId===this.targets.get(id)))return previous;
    const pinned={assetId,restoreDeletedAt:!options.assetId?old?.deletedAt:null};
    const task=(previous||Promise.resolve()).catch(()=>{}).then(()=>this.save(id,pinned));
    this.locks.set(id,task);this.targets.set(id,assetId);this.pending.add(task);task.finally(()=>{this.pending.delete(task);if(this.locks.get(id)===task){this.locks.delete(id);this.targets.delete(id);}}).catch(()=>{});return task;
  }
  fill(assetId){
    const a=this.store.get('assets',assetId);if(!a||a.deletedAt||!a.source)throw Error('请选择有效的广场收藏');
    const row=this.store.db.prepare("SELECT id FROM records WHERE kind='shared' AND json_extract(body,'$.sourceId')=? AND json_extract(body,'$.originId')=? LIMIT 1").get(a.source.sourceId,a.source.originId);
    if(!row)throw Error('原广场案例已不在本机，保留现有收藏');
    return this.collect(row.id,{assetId});
  }
  async save(id,{assetId,restoreDeletedAt}={}){
    const {store,sources,imageCache,assetMedia}=this,item=await sources.detail(id);
    let old=assetId?store.get('assets',assetId):null;
    if(assetId&&(!old||(old.deletedAt&&old.deletedAt!==restoreDeletedAt)||old.source?.sourceId!==item.sourceId||old.source?.originId!==item.originId))throw Error('收藏已改变，请刷新后重试');
    if(!old){const found=this.existing(item);old=found&&store.get('assets',found);if(old?.deletedAt)throw Error('收藏已移入回收站，补图已停止');}
    store.backup();
    if(!old)old=saveAsset(store,{title:item.title,content:item.content,negative:item.negative,modelHint:item.modelHint,tags:item.tags,category:'分享收藏',note:item.description,source:{sourceId:item.sourceId,originId:item.originId,url:item.sourceUrl,author:item.author,license:item.license}});
    else if(old.deletedAt&&old.deletedAt===restoreDeletedAt)old=store.put('assets',{...old,deletedAt:null});
    const before=collectionMedia(old.collectionMedia)||{images:[],videoUrl:'',failures:[]},images=[...before.images],failures=[],staged=[];
    const covers=[...new Set(item.coverUrls?.length?item.coverUrls:item.coverUrl?[item.coverUrl]:[])];
    try{
      for(let i=0;i<Math.min(covers.length,8);i++){
        const url=coverUrl(covers[i]);if(!url){failures.push({url:'',message:'来源图片地址不受支持'});continue;}
        const prior=images.find(r=>r.url===url);
        const latest=store.get('assets',old.id);if(!latest||latest.deletedAt)throw Error('收藏已删除或移入回收站，补图已停止');
        // Removal remains intentional after export/import, even without a leftover file.
        if(prior&&(!latest.media?.some(m=>m.id===prior.id)||existsSync(assetMedia.file(prior.id))))continue;
        if((latest.media?.length||0)+new Set(staged.map(r=>r.id).filter(id=>!latest.media?.some(m=>m.id===id))).size>=8){failures.push({url,message:'个人素材已达8个上限，请整理后重试'});continue;}
        try{
          const image=await imageCache.get(url,{allowDownload:sources.feed(item.sourceId).syncable!==false});
          const label=String(item.imageLabels?.[i]||'原站效果图 '+(i+1)).slice(0,180),upload=await assetMedia.upload(Readable.from([image.data]),label);staged.push(upload);
          const entry={url,id:upload.id,label},index=images.findIndex(r=>r.url===url);if(index<0)images.push(entry);else images[index]=entry;
        }catch{failures.push({url,message:'原图保存失败，可稍后重试或访问来源'});}
      }
      if(covers.length>8)failures.push({url:'',message:'来源超过8张图片，本次仅处理前8张'});
      const latest=store.get('assets',old.id);if(!latest||latest.deletedAt)throw Error('收藏已删除或移入回收站，补图已停止');
      const media=[...new Map([...(latest.media||[]),...staged].map(m=>[m.id,m])).values()];
      const meta=collectionMedia({images:images.slice(0,8),videoUrl:before.videoUrl||sourceVideoUrl(item.videoUrl)||'',failures});
      // Read again after network waits; preserve all user-edited fields and revisions.
      const validated=mediaMetadata(media.map(({uploadId,...m})=>m));
      const saved=store.put('assets',{...latest,media:validated,collectionMedia:meta});
      assetMedia.committed(staged);return saved;
    }finally{for(const r of staged)assetMedia.discard(r.uploadId);}
  }
}
