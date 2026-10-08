import path from 'node:path';
import {createHash} from 'node:crypto';
import {mkdirSync,readdirSync,statSync,unlinkSync,readFileSync} from 'node:fs';
import {writeFile,rename,unlink} from 'node:fs/promises';
import {repoImage} from './repo-gallery.js';
import {sourceImage} from './source-media.js';

const MB=1024*1024;
export function coverUrl(raw){try{const u=new URL(raw);const entries=[...u.searchParams],keys=new Set(entries.map(([k])=>k));const params=keys.size===entries.length&&entries.length<=2&&entries.every(([k,v])=>k==='name'?['thumb','small','medium','large','orig','4096x4096'].includes(v):k==='format'&&['jpg','jpeg','png','webp'].includes(v));const x=u.hostname==='pbs.twimg.com'&&/^\/media\/[A-Za-z0-9_-]+\.(jpg|jpeg|png|webp)$/.test(u.pathname)&&params&&!u.hash;return repoImage(raw)||sourceImage(raw)||(u.protocol==='https:'&&(u.hostname==='img.alicdn.com'||x)&&!u.username&&!u.password&&!u.port?u.href:'');}catch{return '';}}
function imageType(b){if(b.length>=24&&b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return 'image/png';if(b.length>=4&&b[0]===255&&b[1]===216&&b[2]===255)return 'image/jpeg';if(b.length>=12&&b.toString('ascii',0,4)==='RIFF'&&b.toString('ascii',8,12)==='WEBP')return 'image/webp';if(b.length>=10&&['GIF87a','GIF89a'].includes(b.toString('ascii',0,6)))return 'image/gif';throw new Error('来源未返回支持的图片');}
export class ImageCache{
  constructor(store,{fetcher=fetch}={}){this.store=store;this.fetcher=fetcher;this.dir=path.join(store.dir,'cache','plaza-images');this.pending=new Map();this.active=0;this.waiters=[];this.clearing=false;mkdirSync(this.dir,{recursive:true});this.reconcile();this.trim();}
  settings(){return {limitMB:512,maxAgeDays:30,...this.store.get('cacheSettings','images')};}
  reconcile(){const known=new Set();for(const row of this.store.list('cacheImages')){const file=path.join(this.dir,row.id+'.img');try{if(!/^[a-f0-9]{64}$/.test(row.id)||statSync(file).size!==row.bytes)throw Error();known.add(row.id+'.img');}catch{this.store.remove('cacheImages',row.id);}}for(const name of readdirSync(this.dir))if(/^[a-f0-9]{64}\.(img|part)$/.test(name)&&!known.has(name))unlinkSync(path.join(this.dir,name));}
  trim(extra=0){const s=this.settings(),deadline=Date.now()-s.maxAgeDays*86400000;const rows=this.store.list('cacheImages').sort((a,b)=>a.lastUsed-b.lastUsed);let bytes=rows.reduce((n,r)=>n+r.bytes,0);for(const row of rows)if(row.lastUsed<deadline||bytes+extra>s.limitMB*MB){try{unlinkSync(path.join(this.dir,row.id+'.img'));}catch(e){if(e.code!=='ENOENT')throw e;}this.store.remove('cacheImages',row.id);bytes-=row.bytes;}}
  stats(){const rows=this.store.list('cacheImages');return {directory:this.dir,count:rows.length,bytes:rows.reduce((n,r)=>n+r.bytes,0),pending:this.pending.size,publicEntries:this.store.list('shared').length,...this.settings()};}
  configure({limitMB,maxAgeDays}){if(!Number.isInteger(limitMB)||limitMB<64||limitMB>2048||!Number.isInteger(maxAgeDays)||maxAgeDays<1||maxAgeDays>180)throw new Error('缓存上限须为 64–2048 MB，保留天数须为 1–180');this.store.put('cacheSettings',{id:'images',limitMB,maxAgeDays});this.trim();return this.stats();}
  async clear({expiredOnly=false}={}){if(this.clearing)throw new Error('缓存正在清理');this.clearing=true;try{await Promise.allSettled([...this.pending.values()]);if(expiredOnly)this.trim();else{for(const row of this.store.list('cacheImages')){try{await unlink(path.join(this.dir,row.id+'.img'));}catch(e){if(e.code!=='ENOENT')throw e;}this.store.remove('cacheImages',row.id);}}return this.stats();}finally{this.clearing=false;}}
  async get(raw,{allowDownload=true}={}){const url=coverUrl(raw);if(!url)throw new Error('图片地址不受支持');if(this.clearing)throw new Error('缓存正在清理，请稍后刷新');this.trim();const id=createHash('sha256').update(url).digest('hex');const old=this.store.get('cacheImages',id);
    if(old){try{const data=readFileSync(path.join(this.dir,id+'.img'));if(data.length!==old.bytes)throw Error();this.store.put('cacheImages',{...old,lastUsed:Date.now()});return {data,type:old.type,cached:true};}catch{this.store.remove('cacheImages',id);}}
    if(!allowDownload)throw new Error('该来源未确认自动读取权限，仅可读取已有本地图片；请访问原站');
    if(this.pending.has(id))return this.pending.get(id);const task=this.download(url,id);this.pending.set(id,task);try{return await task;}finally{this.pending.delete(id);}
  }
  async download(url,id){if(this.active>=4)await new Promise(r=>this.waiters.push(r));this.active++;const temp=path.join(this.dir,id+'.part');try{
    let r;try{r=await this.fetcher(url,{redirect:'error',signal:AbortSignal.timeout(20000),headers:{Accept:'image/png,image/jpeg,image/webp,image/gif'}});}catch{throw new Error('原站图片连接失败，正文仍可查看；请稍后重试或访问原帖。');}if(!r.ok)throw new Error('图片来源暂不可用');if(Number(r.headers.get('content-length'))>8*MB)throw new Error('单张图片超过 8MB');const chunks=[];let bytes=0;for await(const chunk of r.body){bytes+=chunk.length;if(bytes>8*MB)throw new Error('单张图片超过 8MB');chunks.push(chunk);}const data=Buffer.concat(chunks),type=imageType(data);
    await writeFile(temp,data);this.trim(bytes);await rename(temp,path.join(this.dir,id+'.img'));this.store.put('cacheImages',{id,url,type,bytes,lastUsed:Date.now(),createdAt:Date.now()});this.trim();return {data,type,cached:false};
  }finally{await unlink(temp).catch(()=>{});this.active--;this.waiters.shift()?.();}}
}
