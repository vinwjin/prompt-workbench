import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {mkdirSync,existsSync,readFileSync,writeFileSync,renameSync,unlinkSync,statSync} from 'node:fs';
import {open,unlink} from 'node:fs/promises';
const MB=1024*1024;
export function mediaType(b){
  if(b.length>=24&&b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return 'image/png';
  if(b.length>=4&&b[0]===255&&b[1]===216&&b[2]===255)return 'image/jpeg';
  if(b.length>=12&&b.toString('ascii',0,4)==='RIFF'&&b.toString('ascii',8,12)==='WEBP')return 'image/webp';
  if(b.length>=10&&['GIF87a','GIF89a'].includes(b.toString('ascii',0,6)))return 'image/gif';
  if(b.length>=16&&b.toString('ascii',4,8)==='ftyp'){const brand=b.toString('ascii',8,12);if(brand==='qt  ')return 'video/quicktime';if(['isom','iso2','iso4','iso5','iso6','mp41','mp42','avc1','M4V ','MSNV','dash'].includes(brand))return 'video/mp4';}
  if(b.length>=8&&b.subarray(0,4).equals(Buffer.from([26,69,223,163])))return 'video/webm';
  throw Error('素材不是支持的PNG/JPEG/WebP/GIF或MP4/WebM/MOV文件');
}
export function mediaMetadata(rows=[]){
  if(!Array.isArray(rows)||rows.length>8)throw Error('一条提示词最多8个素材');
  const result=rows.map(r=>{if(!r||!/^[a-f0-9]{64}$/.test(r.id)||!['image/png','image/jpeg','image/webp','image/gif','video/mp4','video/webm','video/quicktime'].includes(r.type)||!Number.isSafeInteger(r.bytes)||r.bytes<=0||r.bytes>(r.type?.startsWith('image/')?20:100)*MB||typeof r.name!=='string'||r.name.length>180)throw Error('素材信息无效');return {id:r.id,type:r.type,bytes:r.bytes,name:r.name};});if(result.reduce((n,r)=>n+r.bytes,0)>200*MB)throw Error('单条素材合计最多200MB');return result;
}
export class AssetMedia{
  constructor(store){this.store=store;this.dir=path.join(store.dir,'media','assets');mkdirSync(this.dir,{recursive:true});this.staged=new Map();this.pending=new Set();this.transient=new Set();}
  file(id){if(!/^[a-f0-9]{64}$/.test(id))throw Error('素材ID无效');return path.join(this.dir,id+'.bin');}
  metadata(id,name){const file=this.file(id),data=readFileSync(file);if(createHash('sha256').update(data).digest('hex')!==id)throw Error('素材文件校验失败');return {id,name:name.slice(0,180),type:mediaType(data.subarray(0,512)),bytes:data.length};}
  async upload(req,name){const task=this.receive(req,name);this.pending.add(task);try{return await task;}finally{this.pending.delete(task);}}
  async receive(req,name){
    this.expire();if(this.staged.size+this.pending.size>=24)throw Error('待确认素材过多，请完成或取消当前导入');
    const temp=path.join(this.dir,randomUUID()+'.part'),hash=createHash('sha256'),handle=await open(temp,'wx');let bytes=0,head=Buffer.alloc(0),type;
    try{for await(const c of req){bytes+=c.length;if(bytes>100*MB)throw Error('视频最多100MB，图片最多20MB');if(head.length<512)head=Buffer.concat([head,c.subarray(0,512-head.length)]);if(head.length>=24&&!type)type=mediaType(head);if(type?.startsWith('image/')&&bytes>20*MB)throw Error('图片最多20MB');hash.update(c);let offset=0;while(offset<c.length){const written=await handle.write(c,offset,c.length-offset);offset+=written.bytesWritten;}}type=type||mediaType(head);if(!bytes)throw Error('素材文件为空');const id=hash.digest('hex');await handle.close();if(existsSync(this.file(id)))await unlink(temp);else{renameSync(temp,this.file(id));this.transient.add(id);}const row={id,name:String(name||'素材').replace(/[\\/\x00-\x1f]/g,'_').slice(0,180),type,bytes},uploadId=randomUUID();this.staged.set(uploadId,{row,expires:Date.now()+2*3600000});return {...row,uploadId};}catch(e){await handle.close().catch(()=>{});await unlink(temp).catch(()=>{});throw e;}
  }
  resolve(rows,assetId,copyOf){
    if(rows===undefined)return undefined;if(!Array.isArray(rows)||rows.length>8)throw Error('一条提示词最多8个素材');this.expire();
    const allowed=[...(this.store.get('assets',assetId||'')?.media||[]),...(this.store.get('assets',copyOf||'')?.media||[])];
    const result=rows.map(r=>{const value=r.uploadId?this.staged.get(r.uploadId)?.row:allowed.find(a=>a.id===r.id);if(!value||!existsSync(this.file(value.id)))throw Error('素材已失效，请重新添加');return {...value};});if(result.reduce((n,r)=>n+r.bytes,0)>200*MB)throw Error('单条素材合计最多200MB');return mediaMetadata(result);
  }
  committed(rows=[]){for(const r of rows)if(r.uploadId){const value=this.staged.get(r.uploadId)?.row;if(value)this.transient.delete(value.id);this.staged.delete(r.uploadId);}}
  discard(token){const row=this.staged.get(token)?.row;this.staged.delete(token);if(row&&this.transient.has(row.id)&&!Array.from(this.staged.values()).some(s=>s.row.id===row.id)&&!this.store.list('assets').some(a=>a.media?.some(m=>m.id===row.id))){try{unlinkSync(this.file(row.id));this.transient.delete(row.id);}catch(e){if(e.code!=='ENOENT')throw e;}}}
  expire(){for(const [token,s]of this.staged)if(s.expires<Date.now())this.discard(token);}
  linked(assetId,id){const a=this.store.get('assets',assetId),row=a?.media?.find(m=>m.id===id);if(!row||!existsSync(this.file(id)))throw Error('素材不存在，可在编辑中重新添加');return {...row,file:this.file(id),bytes:statSync(this.file(id)).size};}
  exportFiles(assets){const ids=[...new Set(assets.flatMap(a=>(a.media||[]).map(m=>m.id)))];let total=0;return ids.map(id=>{const data=readFileSync(this.file(id));total+=data.length;if(total>200*MB)throw Error('素材备份超过200MB，请分批导出，或复制整个data目录备份');return {id,base64:data.toString('base64')};});}
  importFiles(files=[]){if(!Array.isArray(files)||files.length>8000)throw Error('素材备份无效');let total=0;const prepared=files.map(f=>{if(!f||!/^[a-f0-9]{64}$/.test(f.id)||typeof f.base64!=='string'||!/^[A-Za-z0-9+/]*={0,2}$/.test(f.base64)||f.base64.length>140*MB)throw Error('素材备份内容无效');const data=Buffer.from(f.base64,'base64');total+=data.length;if(total>200*MB)throw Error('素材备份合计最多200MB');const type=mediaType(data.subarray(0,512));if(data.length>(type.startsWith('image/')?20:100)*MB)throw Error('素材超过图片20MB或视频100MB限制');if(createHash('sha256').update(data).digest('hex')!==f.id)throw Error('素材备份校验失败');return {id:f.id,data};});const created=[];try{for(const f of prepared)if(!existsSync(this.file(f.id))){const temp=this.file(f.id)+'.part';writeFileSync(temp,f.data);renameSync(temp,this.file(f.id));created.push(f.id);}return created;}catch(e){this.rollbackImport(created);throw e;}}
  validateReferences(assets){for(const a of assets)for(const m of mediaMetadata(a.media||[])){const r=this.metadata(m.id,m.name);if(r.type!==m.type||r.bytes!==m.bytes)throw Error('素材文件缺失或与备份信息不一致');}}
  rollbackImport(ids){for(const id of ids)if(!this.store.list('assets').some(a=>a.media?.some(m=>m.id===id))){try{unlinkSync(this.file(id));}catch(e){if(e.code!=='ENOENT')throw e;}}}
}
