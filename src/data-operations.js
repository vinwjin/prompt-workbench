import {backup,DatabaseSync} from 'node:sqlite';
import {lstat,readdir,mkdir,rename,unlink} from 'node:fs/promises';
import {existsSync,lstatSync} from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {VERSION} from '../public/version.js';

const snapshotName=/^snapshot-\d{13}-[a-f0-9]{8}\.sqlite$/;
const labels={assets:'我的提示词',jobs:'任务历史',templates:'任务模板',drafts:'创作草稿',inbox:'采集记录',folders:'归档文件夹',snippets:'常用片段',shared:'公共案例',providers:'模型连接',galleryNotes:'人工筛选修正'};
export class DataOperations {
  constructor(store){this.store=store;this.dir=path.join(store.dir,'database-snapshots');this.pending=null;this.cached=null;}
  safe(target){const relative=path.relative(this.store.dir,target);if(relative.startsWith('..')||path.isAbsolute(relative))throw Error('数据路径越界');let p=this.store.dir;if(lstatSync(p).isSymbolicLink())throw Error('数据目录不允许使用链接');for(const part of relative.split(path.sep).filter(Boolean)){p=path.join(p,part);if(existsSync(p)&&lstatSync(p).isSymbolicLink())throw Error('数据统计与快照拒绝目录链接');}return target;}
  async size(file){try{this.safe(file);const s=await lstat(file);return s.isFile()?s.size:0;}catch(e){if(e.code==='ENOENT')return 0;throw e;}}
  async inventory(directory){this.safe(directory);let count=0,bytes=0,skippedLinks=0;const walk=async dir=>{let rows;try{rows=await readdir(dir,{withFileTypes:true});}catch(e){if(e.code==='ENOENT')return;throw e;}for(const r of rows){const f=path.join(dir,r.name);if(r.isSymbolicLink()){skippedLinks++;continue;}if(r.isDirectory())await walk(f);else if(r.isFile()){try{bytes+=(await lstat(f)).size;count++;}catch(e){if(e.code!=='ENOENT')throw e;}}}};await walk(directory);return {count,bytes,skippedLinks};}
  async files(directory,pattern){this.safe(directory);let rows;try{rows=await readdir(directory,{withFileTypes:true});}catch(e){if(e.code==='ENOENT')return [];throw e;}const result=[];for(const r of rows){if(!r.isFile()||r.isSymbolicLink()||!pattern.test(r.name))continue;try{const s=await lstat(path.join(directory,r.name));result.push({name:r.name,bytes:s.size,createdAt:s.mtime.toISOString()});}catch(e){if(e.code!=='ENOENT')throw e;}}return result.sort((a,b)=>b.name.localeCompare(a.name));}
  async overview({fresh=false}={}){
    // Filesystem counts are deliberately on demand, with a short bounded cache.
    if(!fresh&&this.cached&&Date.now()-this.cached.time<15000&&this.cached.revision===this.store.revision)return {...this.cached.value,snapshotBusy:!!this.pending};
    const revision=this.store.revision,db=this.store.db;const pageSize=db.prepare('PRAGMA page_size').get().page_size,pageCount=db.prepare('PRAGMA page_count').get().page_count,freePages=db.prepare('PRAGMA freelist_count').get().freelist_count;
    const records=db.prepare('SELECT kind,count(*) AS count FROM records GROUP BY kind').all().map(r=>({...r,label:labels[r.kind]||r.kind,group:r.kind==='shared'||r.kind==='cacheImages'?'public':'business'}));
    const [mainBytes,walBytes,privateMedia,publicCache,backups,snapshots]=await Promise.all([
      this.size(path.join(this.store.dir,'workbench.sqlite')),this.size(path.join(this.store.dir,'workbench.sqlite-wal')),
      this.inventory(path.join(this.store.dir,'media')),this.inventory(path.join(this.store.dir,'cache','plaza-images')),
      this.files(path.join(this.store.dir,'backups'),/^backup-.*\.json$/),this.files(this.dir,snapshotName)
    ]);
    const value={version:VERSION,checkedAt:new Date().toISOString(),database:{mainBytes,walBytes,logicalBytes:pageSize*pageCount,reusableBytes:pageSize*freePages,schema:db.prepare('PRAGMA user_version').get().user_version,journalMode:db.prepare('PRAGMA journal_mode').get().journal_mode},records,privateMedia,publicCache,backups,snapshots,snapshotBusy:!!this.pending};
    this.cached={time:Date.now(),revision,value};return value;
  }
  async snapshot(){
    if(this.pending)throw Error('数据库快照正在保存，请等待完成');
    this.pending=this.createSnapshot();try{return await this.pending;}finally{this.pending=null;this.cached=null;}
  }
  async createSnapshot(){
    this.safe(this.dir);await mkdir(this.dir,{recursive:true});if((await this.files(this.dir,snapshotName)).length>=3)throw Error('已保留3份数据库快照，请先妥善保存并管理已有文件');
    const name=`snapshot-${Date.now()}-${randomUUID().slice(0,8)}.sqlite`,file=path.join(this.dir,name),temp=file+'.tmp';this.safe(temp);
    try{await backup(this.store.db,temp,{rate:100});const copy=new DatabaseSync(temp,{readOnly:true});try{if(copy.prepare('PRAGMA quick_check').get().quick_check!=='ok')throw Error('快照快速完整性检查未通过');}finally{copy.close();}await rename(temp,file);return {name,bytes:await this.size(file),createdAt:new Date().toISOString(),includesMedia:false,includesEncryptedCredentials:true};}catch(e){await unlink(temp).catch(()=>{});throw e;}
  }
  snapshotFile(name){if(!snapshotName.test(name))throw Error('快照名称无效');const file=this.safe(path.join(this.dir,name));if(!existsSync(file)||!lstatSync(file).isFile())throw Error('快照不存在');return file;}
  async settle(){await this.pending?.catch(()=>{});}
}
