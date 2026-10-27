import {initMetadata,projectMetadata,validateNote} from './gallery-metadata.js';
import {validateAuthorState} from './x-timeline.js';
import {sourceVideoUrl,galleryEligible} from './gallery-policy.js';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, writeFileSync, renameSync, readdirSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { BUILTINS } from './catalog.js';
import {schema}from'./template-studio.js';
import{coverUrl}from'./image-cache.js';
import{inboxLink}from'./inbox-link.js';
import {snippetData} from './prompt-lab.js';
import {qualityRules,checkQuality} from './quality.js';
import {mediaMetadata} from './asset-media.js';
import {collectionMedia} from './collection-media.js';
import {validateModelPreferences} from './connection-management.js';

export class Store {
  constructor(dir) {
    this.dir=path.resolve(dir); mkdirSync(this.dir,{recursive:true});
    this.db=new DatabaseSync(path.join(this.dir,'workbench.sqlite'));
    this.db.function('pw_lower',{deterministic:true},value=>String(value??'').toLowerCase());
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
    const version=this.db.prepare('PRAGMA user_version').get().user_version;
    if(version>2) throw new Error('数据版本比当前程序新，请使用对应版本程序');
    this.db.exec('CREATE TABLE IF NOT EXISTS records(kind TEXT NOT NULL,id TEXT NOT NULL,body TEXT NOT NULL,updated TEXT NOT NULL,PRIMARY KEY(kind,id)); PRAGMA user_version=2;');
    this.db.exec("CREATE INDEX IF NOT EXISTS records_kind_updated ON records(kind,updated DESC,id); CREATE INDEX IF NOT EXISTS records_shared_source ON records(json_extract(body,'$.sourceId')) WHERE kind='shared';");
    this.db.exec("CREATE INDEX IF NOT EXISTS records_inbox_state ON records(json_extract(body,'$.deletedAt'),json_extract(body,'$.status')) WHERE kind='inbox'; CREATE INDEX IF NOT EXISTS records_inbox_captured ON records(json_extract(body,'$.deletedAt'),json_extract(body,'$.capturedAt') DESC,id) WHERE kind='inbox'; CREATE INDEX IF NOT EXISTS records_inbox_published ON records(json_extract(body,'$.deletedAt'),json_extract(body,'$.publishedAt') DESC,id) WHERE kind='inbox';");
    this.db.exec("CREATE TABLE IF NOT EXISTS shared_summary(id TEXT PRIMARY KEY,source TEXT NOT NULL,hasCover INTEGER NOT NULL,eligible INTEGER NOT NULL,updated TEXT NOT NULL); CREATE INDEX IF NOT EXISTS shared_summary_source ON shared_summary(source,eligible,hasCover); CREATE TRIGGER IF NOT EXISTS shared_summary_delete AFTER DELETE ON records WHEN OLD.kind='shared' BEGIN DELETE FROM shared_summary WHERE id=OLD.id; END;");
    initMetadata(this);
    const stale=this.db.prepare("SELECT r.body,r.updated FROM records r LEFT JOIN shared_summary s ON s.id=r.id WHERE r.kind='shared' AND (s.id IS NULL OR s.updated<>r.updated)").all();
    this.db.exec('BEGIN');try{for(const r of stale)this.projectShared(JSON.parse(r.body),r.updated);this.db.exec("DELETE FROM shared_summary WHERE id NOT IN (SELECT id FROM records WHERE kind='shared'); COMMIT;");}catch(e){this.db.exec('ROLLBACK');throw e;}
    this.revision=0;this.kindRevisions=new Map();
    if(version===0)for(const t of BUILTINS) this.put('templates',{...t,builtin:true});
    for(const j of this.list('jobs')) if(['running','queued','cancelling'].includes(j.status)) this.put('jobs',{...j,status:'interrupted',error:'上次运行中断，结果未知；请确认后手动重试',finishedAt:new Date().toISOString()});
    this.backup();
  }
  get(kind,id){const r=this.db.prepare('SELECT body FROM records WHERE kind=? AND id=?').get(kind,id);return r?JSON.parse(r.body):null;}
  list(kind){return this.db.prepare('SELECT body FROM records WHERE kind=? ORDER BY updated DESC').all(kind).map(r=>JSON.parse(r.body));}
  recoverySummary(){const where="kind='jobs' AND json_extract(body,'$.status')='interrupted' AND json_extract(body,'$.deletedAt') IS NULL";return {total:this.db.prepare('SELECT count(*) AS n FROM records WHERE '+where).get().n,latestId:this.db.prepare('SELECT id FROM records WHERE '+where+' ORDER BY updated DESC,id LIMIT 1').get()?.id};}
  jobPage({offset=0,limit=100,query='',status='',providerId='',trash=false}={}){
    const filter="kind='jobs' AND (?='' OR instr(lower(coalesce(json_extract(body,'$.input'),'')||' '||coalesce(json_extract(body,'$.output'),'')||' '||coalesce(json_extract(body,'$.status'),'')||' '||coalesce(json_extract(body,'$.model'),'')||' '||coalesce(json_extract(body,'$.providerName'),'')||' '||coalesce(json_extract(body,'$.templateName'),'')),lower(?))>0) AND (?='' OR json_extract(body,'$.status')=?) AND (?='' OR json_extract(body,'$.providerId')=?) AND ((?=1 AND json_extract(body,'$.deletedAt') IS NOT NULL) OR (?=0 AND json_extract(body,'$.deletedAt') IS NULL))";
    const args=[query,query,status,status,providerId,providerId,trash?1:0,trash?1:0];
    const total=this.db.prepare(`SELECT count(*) AS total FROM records WHERE ${filter}`).get(...args).total;
    const jobs=this.db.prepare(`SELECT json_remove(body,'$.images') AS body,coalesce(json_array_length(body,'$.images'),0) AS imageCount FROM records WHERE ${filter} ORDER BY updated DESC,id LIMIT ? OFFSET ?`).all(...args,limit,offset).map(r=>({...JSON.parse(r.body),imageCount:r.imageCount}));
    return {jobs,total,offset,limit};
  }
  kindRevision(kind){return this.kindRevisions.get(kind)||0;}
  inboxPage({query='',scope='active',sort='captured',offset=0,limit=50}={}){
    limit=Math.min(100,Math.max(1,Math.floor(Number(limit)||50)));offset=Math.max(0,Math.floor(Number(offset)||0));
    if(!['active','pending','collected','trash'].includes(scope)||!['captured','published','likes','reposts','views','heat','growth'].includes(sort))throw Error('采集筛选或排序无效');
    let where="kind='inbox' AND json_extract(body,'$.deletedAt') IS "+(scope==='trash'?'NOT ':'')+'NULL';const args=[];
    if(['pending','collected'].includes(scope)){where+=" AND json_extract(body,'$.status')=?";args.push(scope);}
    if(query){where+=" AND instr(lower(coalesce(json_extract(body,'$.author'),'')||' '||coalesce(json_extract(body,'$.url'),'')||' '||coalesce(json_extract(body,'$.posts'),'')),lower(?))>0";args.push(String(query).slice(0,500));}
    const field=sort==='captured'?'capturedAt':sort==='published'?'publishedAt':sort==='heat'?'heat':sort==='growth'?'growth.views':'metrics.'+sort;
    const order="json_extract(body,'$."+field+"') DESC,id";const total=this.db.prepare('SELECT count(*) AS n FROM records INDEXED BY records_inbox_state WHERE '+where).get(...args).n;
    const listIndex=['active','trash'].includes(scope)&&['captured','published'].includes(sort)?' INDEXED BY records_inbox_'+sort:'';
    const items=this.db.prepare(`SELECT json_object('id',id,'url',json_extract(body,'$.url'),'author',json_extract(body,'$.author'),'platform',json_extract(body,'$.platform'),'status',json_extract(body,'$.status'),'deletedAt',json_extract(body,'$.deletedAt'),'readStatus',json_extract(body,'$.readStatus'),'warning',json_extract(body,'$.warning'),'candidateId',json_extract(body,'$.candidateId'),'capturedAt',json_extract(body,'$.capturedAt'),'publishedAt',json_extract(body,'$.publishedAt'),'metrics',json_extract(body,'$.metrics'),'metricsFetchedAt',json_extract(body,'$.metricsFetchedAt'),'heat',json_extract(body,'$.heat'),'growth',json_extract(body,'$.growth'),'excerpt',substr(coalesce((SELECT json_extract(p.value,'$.text') FROM json_each(body,'$.posts') p WHERE json_extract(p.value,'$.id')=json_extract(body,'$.candidateId') LIMIT 1),json_extract(body,'$.posts[0].text'),''),1,300),'postCount',(SELECT count(*) FROM json_each(body,'$.posts') p WHERE length(trim(json_extract(p.value,'$.text')))>0),'coverPostId',(SELECT json_extract(p.value,'$.id') FROM json_each(body,'$.posts') p WHERE json_array_length(p.value,'$.images')>0 LIMIT 1),'hasVideo',(SELECT max(json_array_length(p.value,'$.videos'))>0 FROM json_each(body,'$.posts') p)) AS body FROM records${listIndex} WHERE ${where} ORDER BY ${order} LIMIT ? OFFSET ?`).all(...args,limit,offset).map(r=>JSON.parse(r.body));
    return {items,total,limit,offset};
  }
  changed(kind){this.kindRevisions.set(kind,this.kindRevision(kind)+1);if(kind!=='cacheImages')this.revision++;}
  count(kind){return this.db.prepare('SELECT count(*) AS n FROM records WHERE kind=?').get(kind).n;}
  projectShared(row,updated=row.updatedAt||''){this.db.prepare('INSERT INTO shared_summary VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET source=excluded.source,hasCover=excluded.hasCover,eligible=excluded.eligible,updated=excluded.updated').run(row.id,row.sourceId||'',row.coverUrl?1:0,galleryEligible(row)?1:0,updated);projectMetadata(this,row);}
  put(kind,value){if(kind==='galleryNotes')validateNote(value);const id=value.id||randomUUID(),previous=this.get(kind,id);const projected=['shared','galleryNotes'].includes(kind);const row={...value,id,updatedAt:new Date(Math.max(Date.now(),(Date.parse(previous?.updatedAt)||0)+1)).toISOString()};if(projected)this.db.exec('SAVEPOINT shared_projection');try{this.db.prepare('INSERT INTO records VALUES(?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET body=excluded.body,updated=excluded.updated').run(kind,row.id,JSON.stringify(row),row.updatedAt);if(kind==='shared')this.projectShared(row);if(kind==='galleryNotes'){const item=this.get('shared',id);if(item)projectMetadata(this,item);}if(projected)this.db.exec('RELEASE shared_projection');}catch(e){if(projected)this.db.exec('ROLLBACK TO shared_projection; RELEASE shared_projection;');throw e;}this.changed(kind);return row;}
  remove(kind,id){this.db.prepare('DELETE FROM records WHERE kind=? AND id=?').run(kind,id);this.changed(kind);}
  diagnostics(){return {integrity:Object.values(this.db.prepare('PRAGMA quick_check').get())[0],schema:this.db.prepare('PRAGMA user_version').get().user_version,journalMode:this.db.prepare('PRAGMA journal_mode').get().journal_mode,bytes:this.db.prepare('PRAGMA page_count').get().page_count*this.db.prepare('PRAGMA page_size').get().page_size,counts:this.db.prepare('SELECT kind,count(*) AS total,sum(json_extract(body,\'$.deletedAt\') IS NOT NULL) AS trash FROM records GROUP BY kind').all(),indexes:this.db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'records_%'").all().map(r=>r.name)};}
  publicProvider(p){if(!p)return null;const {sealedKey,apiKey,accountCredentials,accountFetcher,accessToken,refreshToken,idToken,...rest}=p;return {...rest,hasKey:!!sealedKey};}
  export(){return {schema:'prompt-workbench/v1',exportedAt:new Date().toISOString(),templates:this.list('templates'),inbox:this.list('inbox'),inboxBatches:this.list('inboxBatches'),inboxAuthors:this.list('inboxAuthors'),assets:this.list('assets'),snippets:this.list('snippets'),jobs:this.list('jobs'),drafts:this.list('drafts'),folders:this.list('folders'),galleryNotes:this.list('galleryNotes'),providers:this.list('providers').map(p=>this.publicProvider(p))};}
  import(data){
    if(data?.schema!=='prompt-workbench/v1')throw new Error('不是提示词工坊 v1 备份');
    const kinds=['templates','assets','jobs','drafts','providers','folders','inbox','snippets','inboxBatches','inboxAuthors','galleryNotes'];
    data={...data,folders:data.folders||[],inbox:data.inbox||[],snippets:data.snippets||[],inboxBatches:data.inboxBatches||[],inboxAuthors:data.inboxAuthors||[],galleryNotes:data.galleryNotes||[]};
    for(const k of kinds){
      if(!Array.isArray(data[k])||data[k].length>10000)throw new Error(`备份 ${k} 列表无效`);
      for(const row of data[k]){
        if(!row||Array.isArray(row)||typeof row.id!=='string'||!row.id||row.id.length>100||!/^[A-Za-z0-9_-]+$/.test(row.id))throw new Error('备份记录格式无效');
        const text=key=>typeof row[key]==='string';
        if(k==='inboxBatches'&&(!['running','cancelling','completed','cancelled','interrupted','failed'].includes(row.status)||!Array.isArray(row.items)||row.items.length>100||row.items.some(i=>!i||typeof i.url!=='string'||!['queued','running','succeeded','needs-content','failed','cancelled','interrupted'].includes(i.status))))throw Error('采集批次备份无效');
        if(k==='inboxBatches')for(const i of row.items)if(inboxLink(i.url).id!==i.id)throw Error('采集批次链接无效');
        if(k==='inboxAuthors')validateAuthorState(row);if(k==='galleryNotes')validateNote(row);
        if(k==='templates'&&(!text('name')||!text('system')||!text('user')))throw new Error('备份模板无效');
        if(k==='templates'){const validVersion=v=>v===undefined||Number.isSafeInteger(v)&&v>0&&v<1e9;if(!validVersion(row.revision))throw Error('备份模板版本号无效');schema(row.variableSchema);if(row.revisions!==undefined&&(!Array.isArray(row.revisions)||row.revisions.length>30||row.revisions.some(v=>!v||typeof v.system!=='string'||typeof v.user!=='string'||!validVersion(v.revision))))throw Error('备份模板版本无效');for(const v of row.revisions||[])schema(v.variableSchema);}
        if(k==='assets'&&(!text('title')||!text('content')||(row.versions!==undefined&&(!Array.isArray(row.versions)||row.versions.some(v=>!v||typeof v.content!=='string')))))throw new Error('备份资产无效');
        if(k==='assets'){mediaMetadata(row.media||[]);collectionMedia(row.collectionMedia);}
        if(k==='jobs'&&(!text('input')||!text('createdAt')||!['queued','running','cancelling','cancelled','succeeded','failed','interrupted'].includes(row.status)))throw new Error('备份任务无效');
        if(k==='jobs'&&row.originalMedia!==undefined)mediaMetadata(row.originalMedia);
        if(k==='jobs'&&row.images!==undefined&&(!Array.isArray(row.images)||row.images.length>4||row.images.some(i=>!i||typeof i.dataUrl!=='string'||i.dataUrl.length>3e6||!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(i.dataUrl))))throw new Error('备份任务图片无效');
        if(k==='providers'&&(!text('name')||!text('model')||!text('baseUrl')||!text('protocol')))throw new Error('备份连接无效');
        if(k==='providers')validateModelPreferences(row.modelPreferences);
        if(k==='drafts'&&!text('input'))throw new Error('备份草稿无效');
        if(k==='folders'&&!text('name'))throw new Error('备份文件夹无效');
        if(k==='snippets')snippetData(row);
        if(['jobs','drafts'].includes(k)&&row.qualityRules!==undefined)qualityRules(row.qualityRules);
        if(k==='inbox'&&(!/^(?:\d{10,25}|hh-(?:[a-f\d]{12}|\d{5,25}))$/.test(row.id)||!text('url')||!Array.isArray(row.posts)||row.posts.length>31||row.posts.some(p=>!p||typeof p.text!=='string'||typeof p.id!=='string'||!Array.isArray(p.images))))throw Error('备份收件箱无效');
        if(k==='inbox'){for(const value of [row,...row.posts]){if(value.videos!==undefined&&(!Array.isArray(value.videos)||value.videos.length>4||value.videos.some(u=>!sourceVideoUrl(u))))throw Error('备份视频地址无效');if(value.metricHistory!==undefined&&(!Array.isArray(value.metricHistory)||value.metricHistory.length>30||value.metricHistory.some(s=>!s||!Number.isFinite(Date.parse(s.at))||s.provider!=='fxembed'||!s.metrics||['likes','reposts','replies','quotes','views'].some(k=>s.metrics[k]!==null&&(!Number.isSafeInteger(s.metrics[k])||s.metrics[k]<0)))))throw Error('互动快照备份无效');}}
        if(k==='inbox'){if(inboxLink(row.url).id!==row.id)throw Error('备份采集链接无效');for(const p of row.posts)if(inboxLink(p.sourceUrl).id!==p.id||p.images.length>(row.id.startsWith('hh-')?16:4)||p.images.some(u=>!coverUrl(u)))throw Error('备份采集帖子或图片地址无效');}
      }
    }
    this.backup();let imported=0;this.db.exec('BEGIN IMMEDIATE');
    try{for(const k of kinds)for(const row of data[k]){
      if(this.get(k,row.id))continue; // 合并恢复：不覆盖当前记录与凭据
      const safe=k==='providers'&&row.protocol==='account'?Object.fromEntries(Object.entries(row).filter(([key])=>['id','name','protocol','accountPlatform','accountRegion','baseUrl','model','timeoutMs','modelPreferences','accountLabel'].includes(key))):{...row};delete safe.sealedKey;delete safe.apiKey;delete safe.hasKey;
      if(k==='providers'&&safe.protocol==='account'){safe.accountStatus='signed-out';safe.accountEpoch=randomUUID();}
      if(k==='inboxBatches'&&['running','cancelling'].includes(safe.status)){safe.status='interrupted';safe.items=safe.items.map(i=>['queued','running'].includes(i.status)?{...i,status:'interrupted'}:i);}
      if(k==='templates'){safe.variableSchema=schema(row.variableSchema);if(row.revisions)safe.revisions=row.revisions.map(v=>({...v,variableSchema:schema(v.variableSchema)}));}
      if(k==='jobs'&&row.quality!==undefined){try{safe.quality=checkQuality(typeof row.output==='string'?row.output:'',row.qualityRules);}catch{safe.quality={error:'检查不可用，正文仍保留'};}}
      if(k==='jobs'&&['running','queued','cancelling'].includes(safe.status)){safe.status='interrupted';safe.error='导入的未完成任务不会自动执行';}
      this.put(k,safe);imported++;
    }this.db.exec('COMMIT');}catch(e){this.db.exec('ROLLBACK');throw e;}return {imported,mode:'merge-preserve-existing'};
  }
  backup(){const dir=path.join(this.dir,'backups');mkdirSync(dir,{recursive:true});const file=path.join(dir,`backup-${Date.now()}-${randomUUID().slice(0,8)}.json`);writeFileSync(file+'.tmp',JSON.stringify(this.export(),null,2));renameSync(file+'.tmp',file);const files=readdirSync(dir).filter(n=>/^backup-.*\.json$/.test(n)).sort();for(const n of files.slice(0,-20))unlinkSync(path.join(dir,n));return file;}
  close(){this.db.close();}
}
