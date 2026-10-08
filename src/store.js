import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, writeFileSync, renameSync, readdirSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { BUILTINS } from './catalog.js';
import {schema}from'./template-studio.js';
import{coverUrl}from'./image-cache.js';
import{xId}from'./x-inbox.js';
import {snippetData} from './prompt-lab.js';
import {qualityRules,checkQuality} from './quality.js';
import {mediaMetadata} from './asset-media.js';

export class Store {
  constructor(dir) {
    this.dir=path.resolve(dir); mkdirSync(this.dir,{recursive:true});
    this.db=new DatabaseSync(path.join(this.dir,'workbench.sqlite'));
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
    const version=this.db.prepare('PRAGMA user_version').get().user_version;
    if(version>2) throw new Error('数据版本比当前程序新，请使用对应版本程序');
    this.db.exec('CREATE TABLE IF NOT EXISTS records(kind TEXT NOT NULL,id TEXT NOT NULL,body TEXT NOT NULL,updated TEXT NOT NULL,PRIMARY KEY(kind,id)); PRAGMA user_version=2;');
    this.db.exec("CREATE INDEX IF NOT EXISTS records_kind_updated ON records(kind,updated DESC,id); CREATE INDEX IF NOT EXISTS records_shared_source ON records(json_extract(body,'$.sourceId')) WHERE kind='shared';");
    this.revision=0;
    if(version===0)for(const t of BUILTINS) this.put('templates',{...t,builtin:true});
    for(const j of this.list('jobs')) if(['running','queued','cancelling'].includes(j.status)) this.put('jobs',{...j,status:'interrupted',error:'上次运行中断，结果未知；请确认后手动重试',finishedAt:new Date().toISOString()});
    this.backup();
  }
  get(kind,id){const r=this.db.prepare('SELECT body FROM records WHERE kind=? AND id=?').get(kind,id);return r?JSON.parse(r.body):null;}
  list(kind){return this.db.prepare('SELECT body FROM records WHERE kind=? ORDER BY updated DESC').all(kind).map(r=>JSON.parse(r.body));}
  jobPage({offset=0,limit=100,query='',status='',providerId='',trash=false}={}){
    const filter="kind='jobs' AND (?='' OR instr(lower(coalesce(json_extract(body,'$.input'),'')||' '||coalesce(json_extract(body,'$.output'),'')||' '||coalesce(json_extract(body,'$.status'),'')||' '||coalesce(json_extract(body,'$.model'),'')||' '||coalesce(json_extract(body,'$.providerName'),'')||' '||coalesce(json_extract(body,'$.templateName'),'')),lower(?))>0) AND (?='' OR json_extract(body,'$.status')=?) AND (?='' OR json_extract(body,'$.providerId')=?) AND ((?=1 AND json_extract(body,'$.deletedAt') IS NOT NULL) OR (?=0 AND json_extract(body,'$.deletedAt') IS NULL))";
    const args=[query,query,status,status,providerId,providerId,trash?1:0,trash?1:0];
    const total=this.db.prepare(`SELECT count(*) AS total FROM records WHERE ${filter}`).get(...args).total;
    const jobs=this.db.prepare(`SELECT json_remove(body,'$.images') AS body,coalesce(json_array_length(body,'$.images'),0) AS imageCount FROM records WHERE ${filter} ORDER BY updated DESC,id LIMIT ? OFFSET ?`).all(...args,limit,offset).map(r=>({...JSON.parse(r.body),imageCount:r.imageCount}));
    return {jobs,total,offset,limit};
  }
  put(kind,value){const id=value.id||randomUUID(),previous=this.get(kind,id);const row={...value,id,updatedAt:new Date(Math.max(Date.now(),(Date.parse(previous?.updatedAt)||0)+1)).toISOString()};this.db.prepare('INSERT INTO records VALUES(?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET body=excluded.body,updated=excluded.updated').run(kind,row.id,JSON.stringify(row),row.updatedAt);this.revision++;return row;}
  remove(kind,id){this.db.prepare('DELETE FROM records WHERE kind=? AND id=?').run(kind,id);this.revision++;}
  diagnostics(){return {integrity:Object.values(this.db.prepare('PRAGMA quick_check').get())[0],schema:this.db.prepare('PRAGMA user_version').get().user_version,journalMode:this.db.prepare('PRAGMA journal_mode').get().journal_mode,bytes:this.db.prepare('PRAGMA page_count').get().page_count*this.db.prepare('PRAGMA page_size').get().page_size,counts:this.db.prepare('SELECT kind,count(*) AS total,sum(json_extract(body,\'$.deletedAt\') IS NOT NULL) AS trash FROM records GROUP BY kind').all(),indexes:this.db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'records_%'").all().map(r=>r.name)};}
  publicProvider(p){if(!p)return null;const {sealedKey,...rest}=p;return {...rest,hasKey:!!sealedKey};}
  export(){return {schema:'prompt-workbench/v1',exportedAt:new Date().toISOString(),templates:this.list('templates'),inbox:this.list('inbox'),assets:this.list('assets'),snippets:this.list('snippets'),jobs:this.list('jobs'),drafts:this.list('drafts'),folders:this.list('folders'),providers:this.list('providers').map(p=>this.publicProvider(p))};}
  import(data){
    if(data?.schema!=='prompt-workbench/v1')throw new Error('不是提示词工坊 v1 备份');
    const kinds=['templates','assets','jobs','drafts','providers','folders','inbox','snippets'];
    data={...data,folders:data.folders||[],inbox:data.inbox||[],snippets:data.snippets||[]};
    for(const k of kinds){
      if(!Array.isArray(data[k])||data[k].length>10000)throw new Error(`备份 ${k} 列表无效`);
      for(const row of data[k]){
        if(!row||Array.isArray(row)||typeof row.id!=='string'||!row.id||row.id.length>100||!/^[A-Za-z0-9_-]+$/.test(row.id))throw new Error('备份记录格式无效');
        const text=key=>typeof row[key]==='string';
        if(k==='templates'&&(!text('name')||!text('system')||!text('user')))throw new Error('备份模板无效');
        if(k==='templates'){const validVersion=v=>v===undefined||Number.isSafeInteger(v)&&v>0&&v<1e9;if(!validVersion(row.revision))throw Error('备份模板版本号无效');schema(row.variableSchema);if(row.revisions!==undefined&&(!Array.isArray(row.revisions)||row.revisions.length>30||row.revisions.some(v=>!v||typeof v.system!=='string'||typeof v.user!=='string'||!validVersion(v.revision))))throw Error('备份模板版本无效');for(const v of row.revisions||[])schema(v.variableSchema);}
        if(k==='assets'&&(!text('title')||!text('content')||(row.versions!==undefined&&(!Array.isArray(row.versions)||row.versions.some(v=>!v||typeof v.content!=='string')))))throw new Error('备份资产无效');
        if(k==='assets')mediaMetadata(row.media||[]);
        if(k==='jobs'&&(!text('input')||!text('createdAt')||!['queued','running','cancelling','cancelled','succeeded','failed','interrupted'].includes(row.status)))throw new Error('备份任务无效');
        if(k==='jobs'&&row.images!==undefined&&(!Array.isArray(row.images)||row.images.length>4||row.images.some(i=>!i||typeof i.dataUrl!=='string'||i.dataUrl.length>3e6||!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(i.dataUrl))))throw new Error('备份任务图片无效');
        if(k==='providers'&&(!text('name')||!text('model')||!text('baseUrl')||!text('protocol')))throw new Error('备份连接无效');
        if(k==='drafts'&&!text('input'))throw new Error('备份草稿无效');
        if(k==='folders'&&!text('name'))throw new Error('备份文件夹无效');
        if(k==='snippets')snippetData(row);
        if(['jobs','drafts'].includes(k)&&row.qualityRules!==undefined)qualityRules(row.qualityRules);
        if(k==='inbox'&&(!/^\d{10,25}$/.test(row.id)||!text('url')||!Array.isArray(row.posts)||row.posts.length>31||row.posts.some(p=>!p||typeof p.text!=='string'||typeof p.id!=='string'||!Array.isArray(p.images))))throw Error('备份收件箱无效');
        if(k==='inbox'){if(xId(row.url)!==row.id)throw Error('备份X链接无效');for(const p of row.posts)if(xId(p.sourceUrl)!==p.id||p.images.length>4||p.images.some(u=>!coverUrl(u)))throw Error('备份X帖子或图片地址无效');}
      }
    }
    this.backup();let imported=0;this.db.exec('BEGIN IMMEDIATE');
    try{for(const k of kinds)for(const row of data[k]){
      if(this.get(k,row.id))continue; // 合并恢复：不覆盖当前记录与凭据
      const safe={...row};delete safe.sealedKey;delete safe.apiKey;delete safe.hasKey;
      if(k==='templates'){safe.variableSchema=schema(row.variableSchema);if(row.revisions)safe.revisions=row.revisions.map(v=>({...v,variableSchema:schema(v.variableSchema)}));}
      if(k==='jobs'&&row.quality!==undefined){try{safe.quality=checkQuality(typeof row.output==='string'?row.output:'',row.qualityRules);}catch{safe.quality={error:'检查不可用，正文仍保留'};}}
      if(k==='jobs'&&['running','queued','cancelling'].includes(safe.status)){safe.status='interrupted';safe.error='导入的未完成任务不会自动执行';}
      this.put(k,safe);imported++;
    }this.db.exec('COMMIT');}catch(e){this.db.exec('ROLLBACK');throw e;}return {imported,mode:'merge-preserve-existing'};
  }
  backup(){const dir=path.join(this.dir,'backups');mkdirSync(dir,{recursive:true});const file=path.join(dir,`backup-${Date.now()}-${randomUUID().slice(0,8)}.json`);writeFileSync(file+'.tmp',JSON.stringify(this.export(),null,2));renameSync(file+'.tmp',file);const files=readdirSync(dir).filter(n=>/^backup-.*\.json$/.test(n)).sort();for(const n of files.slice(0,-20))unlinkSync(path.join(dir,n));return file;}
  close(){this.db.close();}
}
