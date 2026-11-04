import {createHash,randomUUID} from 'node:crypto';
import {mkdirSync, writeFileSync, readFileSync, existsSync,renameSync,unlinkSync} from 'node:fs';
import path from 'node:path';

// 任务参考图外置：与资产媒体共用 SHA-256 内容寻址目录（data/media/assets），
// 备份 JSON 只存 {id,type,bytes,name} 引用，不再重复 base64；生成/回显时按 id 读回 dataUrl。
const dir = store => path.join(store.dir, 'media', 'assets');
const file = (store, id) => {if(!/^[a-f0-9]{64}$/.test(id||''))throw Error('任务图片引用无效');return path.join(dir(store), id + '.bin');};
const digest = data => createHash('sha256').update(data).digest('hex');
function readVerified(store,img){const data=readFileSync(file(store,img.id));if(digest(data)!==img.id||img.bytes!==undefined&&data.length!==img.bytes)throw Error('任务图片字节校验失败');return data;}

export function externalizeImages(store, images, createdFiles){
  if(!Array.isArray(images) || !images.length) return images || [];
  mkdirSync(dir(store), {recursive:true});
  return images.map(img => {
    if(img && img.id && !img.dataUrl){readVerified(store,img);return img;}
    const match=String(img?.dataUrl||'').match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/);
    if(!match)throw Error('任务图片格式无效');
    const data = Buffer.from(match[2], 'base64');if(!data.length||data.toString('base64')!==match[2])throw Error('任务图片编码无效');
    const id = digest(data),type=match[1];
    const target = file(store, id);
    if(existsSync(target))readVerified(store,{id,bytes:data.length});
    else {const temp=target+'.'+randomUUID()+'.tmp';try{writeFileSync(temp,data,{flag:'wx'});renameSync(temp,target);createdFiles?.push(target);}finally{if(existsSync(temp))unlinkSync(temp);}}
    return {id, type, bytes: data.length, name: String(img.name || '').slice(0, 180)};
  });
}

export function hydrateImages(store, images){
  if(!Array.isArray(images)) return images || [];
  return images.map(img => {
    if(!img || img.dataUrl) return img; // 旧格式或已含 dataUrl
    const data = readVerified(store,img);
    const {id,type,bytes,...metadata}=img;return {...metadata,dataUrl:'data:'+type+';base64,'+data.toString('base64')};
  });
}

// Explicit maintenance operation; the caller must first save a consistent rollback set and ensure no writer is active.
export function migrateInlineJobImages(store){
  const created=[];let jobs=0,images=0,beforeBytes=0,afterBytes=0;
  store.db.exec('BEGIN IMMEDIATE');
  try{
    if(store.db.prepare("SELECT 1 FROM records WHERE kind='jobs' AND json_extract(body,'$.status') IN ('running','queued','cancelling') LIMIT 1").get())throw Error('任务未空闲，不能迁移图片');
    const rows=store.db.prepare("SELECT id,body FROM records WHERE kind='jobs' AND EXISTS(SELECT 1 FROM json_each(body,'$.images') WHERE json_extract(value,'$.dataUrl') IS NOT NULL)").all();
    const update=store.db.prepare("UPDATE records SET body=? WHERE kind='jobs' AND id=?");
    for(const row of rows){const job=JSON.parse(row.body),old=job.images;const inline=old.filter(i=>i?.dataUrl).length;
      job.images=externalizeImages(store,old,created).map((ref,n)=>{const {dataUrl,...metadata}=old[n],result={...metadata,...ref};if(Object.hasOwn(old[n],'name'))result.name=old[n].name;else delete result.name;return result;});
      const hydrated=hydrateImages(store,job.images);for(let n=0;n<old.length;n++)if(old[n].dataUrl&&hydrated[n].dataUrl!==old[n].dataUrl)throw Error('迁移图片读回不一致');
      const body=JSON.stringify(job);update.run(body,row.id);jobs++;images+=inline;beforeBytes+=Buffer.byteLength(row.body);afterBytes+=Buffer.byteLength(body);
    }
    store.db.exec('COMMIT');if(jobs)store.changed?.('jobs');return {jobs,images,createdFiles:created.length,beforeBytes,afterBytes};
  }catch(e){store.db.exec('ROLLBACK');for(const target of created)if(existsSync(target))unlinkSync(target);throw e;}
}
