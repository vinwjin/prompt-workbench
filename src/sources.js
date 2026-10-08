import { createHash } from 'node:crypto';
import {coverUrl} from './image-cache.js';
import {parseRepoGallery} from './repo-gallery.js';
import {EXTRA_FEEDS} from './source-catalog.js';
import {parseSourceJson,parseSourceMarkdown,markdownFiles,parsePromptHtml,videoPages,parseVideoHtml,sourceLink} from './source-parsers.js';

const BASE_FEEDS=[
  {id:'xrepo',name:'X 图文精选 · GPT-4o 案例',url:'https://github.com/jamez-bondos/awesome-gpt4o-images',license:'CC BY 4.0 · 图片 jamez-bondos；提示词作者见原帖',description:'中文图文案例，保留 X 原帖与作者；图片来自公开仓库，同步时校验图片后才更新目录。'},
  {id:'mother',name:'提示词大师 · 原站广场',url:'https://comfyit.cn/article/487',license:'未声明开放许可 · 原作者保留权利',description:'公开列表与详情；保留作者、正负提示词及模型，不接管登录或投稿。'},
  {id:'shortcut',name:'ChatGPT Shortcut · 中文',url:'https://github.com/rockbenben/ChatGPT-Shortcut',license:'MIT · rockbenben',description:'中文任务说明与标签，保留许可和来源。'},
  {id:'prompts',name:'prompts.chat · 社区词库',url:'https://github.com/f/prompts.chat',license:'CC0-1.0 · 提示词数据',description:'社区共享提示词，缓存到本地后可离线浏览。'}
];
BASE_FEEDS.push(...EXTRA_FEEDS);
export const FEEDS=BASE_FEEDS.map(f=>/未声明|未确认|逐条许可/.test(f.license)?{...f,syncable:false,notice:'公开版未确认自动读取权限；请访问原站，或导入你有权使用的文件。'}:f);
const URLS={shortcut:['https://raw.githubusercontent.com/rockbenben/ChatGPT-Shortcut/main/src/data/prompt.json','https://cdn.jsdelivr.net/gh/rockbenben/ChatGPT-Shortcut@main/src/data/prompt.json'],prompts:['https://raw.githubusercontent.com/f/prompts.chat/main/prompts.csv','https://cdn.jsdelivr.net/gh/f/prompts.chat@main/prompts.csv']};
URLS.xrepo=['https://cdn.jsdelivr.net/gh/jamez-bondos/awesome-gpt4o-images@main/README.md','https://raw.githubusercontent.com/jamez-bondos/awesome-gpt4o-images/main/README.md'];
function safeSource(raw){return sourceLink(raw);}
export function parseCurated(text){const rows=new Map();for(const block of text.split(/^### No\. \d+: /m).slice(1)){const title=block.split('\n')[0].trim(),content=block.match(/####[^\n]*(?:Prompt|提示词)[^\n]*\n[\s\S]*?```[^\n]*\n([\s\S]*?)```/)?.[1]?.trim(),author=block.match(/\*\*(?:Author|作者)[：:]?\*\*\s*\[([^\]]+)\]/)?.[1]||'社区作者',source=safeSource(block.match(/\*\*(?:Source|来源)[：:]?\*\*\s*\[[^\]]+\]\(([^)]+)\)/)?.[1]);const cover=coverUrl(block.match(/<img\s[^>]*src="([^"]+)"/)?.[1]);if(content&&source&&!rows.has(source))rows.set(source,{title,content,author,sourceUrl:source,originId:source,frontCover:cover,description:'公开整理样例；部分任务需要参考图片，请核对原帖。'});}if(!rows.size)throw new Error('精选源格式已变化，没有可核实的正文与来源');return [...rows.values()];}
const hash=text=>createHash('sha256').update(text).digest('hex').slice(0,24);
export function parseCSV(text){
  const rows=[];let row=[],cell='',quoted=false;
  for(let i=0;i<text.length;i++){const c=text[i];if(c==='"'){if(quoted&&text[i+1]==='"'){cell+='"';i++;}else quoted=!quoted;}else if(!quoted&&(c===','||c==='\n')){row.push(cell.replace(/\r$/,''));cell='';if(c==='\n'){rows.push(row);row=[];}}else cell+=c;}
  if(quoted)throw new Error('CSV 引号不完整');if(cell||row.length){row.push(cell.replace(/\r$/,''));rows.push(row);}const headers=rows.shift()?.map(h=>h.replace(/^\uFEFF/,''))||[];
  if(!headers.includes('act')||!headers.includes('prompt'))throw new Error('社区 CSV 格式已改变');
  return rows.filter(r=>r.length===headers.length).map(r=>Object.fromEntries(headers.map((h,i)=>[h,r[i]])));
}
export class Sources{
  constructor(store,{fetcher=fetch,imageVerifier}={}){this.store=store;this.fetcher=fetcher;this.imageVerifier=imageVerifier;this.syncing=new Set();this.inflight=new Set();this.abort=new AbortController();this.closing=false;this.batch=null;}
  feed(id){const f=FEEDS.find(f=>f.id===id);if(!f)throw new Error('分享源不存在');return f;}
  catalog(){return FEEDS.map(f=>({...this.store.get('feeds',f.id),...f,syncable:f.syncable!==false,contentKind:f.contentKind||(['shortcut','prompts'].includes(f.id)?'text':'images'),syncing:this.syncing.has(f.id),queued:this.batch?.status==='running'&&this.batch.items.some(i=>i.id===f.id&&i.status==='queued')}));}
  async read(url,options={}){
    const r=await this.fetcher(url,{...options,redirect:'error',signal:AbortSignal.any([this.abort.signal,AbortSignal.timeout(20000)])});
    if(!r.ok)throw new Error('分享源 HTTP '+r.status);
    if(Number(r.headers.get('content-length'))>16e6)throw new Error('分享源超过 16MB');
    let size=0,text='';const decoder=new TextDecoder();for await(const chunk of r.body){size+=chunk.length;if(size>16e6)throw new Error('分享源超过 16MB');text+=decoder.decode(chunk,{stream:true});}return text+decoder.decode();
  }
  normalize(id,r){
    const f=this.feed(id),title=String(r.title||r.act||'未命名').slice(0,250),originId=String(r.originId||r.id||hash(title+'\n'+(r.content||r.prompt||'')));
    const coverUrls=Array.isArray(r.coverUrls)?r.coverUrls.map(coverUrl).filter(Boolean).slice(0,8):[],imageLabels=Array.isArray(r.imageLabels)?r.imageLabels.map(v=>String(v).slice(0,120)).slice(0,8):[];
    return {id:id+'-'+hash(originId),sourceId:id,originId,upstreamOriginId:String(r.upstreamOriginId||originId),title,coverUrl:coverUrl(r.frontCover||r.coverUrl),coverUrls,imageLabels,viewCount:Math.max(0,Number(r.viewCount)||0),copyCount:Math.max(0,Number(r.copyCount)||0),content:typeof r.content==='string'?r.content:typeof r.prompt==='string'?r.prompt:'',negative:String(r.negative||''),description:String(r.description||'').slice(0,1000),modelHint:String(r.modelHint||r.models||'').slice(0,200),tags:Array.isArray(r.tags)?r.tags.join(', '):String(r.tags||''),author:String(r.author||'').slice(0,120),license:String(r.license||f.license).slice(0,500),sourceUrl:safeSource(r.sourceUrl)||f.url,importedFrom:r.importedFrom==='local-file'?'local-file':undefined,detailLoaded:id!=='mother'||r.importedFrom==='local-file',syncedAt:new Date().toISOString()};
  }
  ingest(id,text,fetchedUrl=''){
    this.feed(id);let rows,total;
    if(EXTRA_FEEDS.some(f=>f.id===id))rows=this.parseExtra(id,text);
    else if(id==='xrepo')rows=parseRepoGallery(text);
    else if(id==='shortcut'){const data=JSON.parse(text);if(!Array.isArray(data))throw new Error('中文词库格式已改变');rows=data.map(r=>({id:r.id,title:r.zh?.title||r.en?.title,content:r.zh?.prompt||r.en?.prompt,description:r.zh?.remark||r.zh?.description||'',tags:r.tags,author:'rockbenben / 社区贡献者'}));}
    else if(id==='prompts')rows=parseCSV(text).map(r=>({...r,content:r.prompt,author:r.contributor||'社区贡献者',tags:r.type||'通用'}));
    else{const data=JSON.parse(text);if(!data.success)throw new Error(data.message||'原站未开放匿名读取');rows=data.result?.datas;if(!Array.isArray(rows))throw new Error('原站列表格式已改变');total=data.result.total;rows=rows.map(r=>({...r,author:r.author?.nickname||r.author?.name|| (typeof r.author==='string'?r.author:''),content:''}));}
    return this.ingestRows(id,rows,fetchedUrl,total);
  }
  ingestRows(id,rows,fetchedUrl='',total){
    this.feed(id);if(this.closing)throw Error('工作台正在关闭');
    if(!Array.isArray(rows)||!rows.length||rows.length>10000)throw new Error('分享源没有有效条目或条目过多');
    if(rows.some(r=>typeof(r.content||r.prompt||'')!=='string'||String(r.content||r.prompt||'').length>1e6))throw Error('来源正文格式无效或单项超过1MB');
    let items=rows.map(r=>this.normalize(id,r)).filter(r=>r.title&& (id==='mother'||r.content));if(!items.length)throw new Error('没有可用提示词');
    // 同一原帖可能包含多个不同配方，避免把后一个正文覆盖前一个。
    if(EXTRA_FEEDS.some(f=>f.id===id))items=items.map(item=>{const originId=item.upstreamOriginId+'#'+hash(item.content);return {...item,id:id+'-'+hash(originId),originId};});
    this.store.db.exec('BEGIN IMMEDIATE');try{
      // 母版按页累积元数据；详情已读取时保留正文。开源完整快照替换该源缓存。
      if(id!=='mother'||fetchedUrl.startsWith('local-file:'))this.store.db.prepare('DELETE FROM records WHERE kind=? AND json_extract(body,\'$.sourceId\')=?').run('shared',id);
      for(const item of items){const old=this.store.get('shared',item.id);this.store.put('shared',old?.detailLoaded&&id==='mother'?{...item,content:old.content,negative:old.negative,detailLoaded:true}:item);}
      const meta=this.store.put('feeds',{id,lastSync:new Date().toISOString(),count:this.store.db.prepare("SELECT count(*) AS n FROM records WHERE kind='shared' AND json_extract(body,'$.sourceId')=?").get(id).n,total:total??items.length,fetchedUrl,lastError:null});this.store.db.exec('COMMIT');return meta;
    }catch(e){this.store.db.exec('ROLLBACK');throw e;}
  }
  parseExtra(id,text,file){const f=this.feed(id);if(['meigen','nexra','act-json','translated-json'].includes(f.adapter))return parseSourceJson(text,f);if(f.adapter==='html-prompts')return parsePromptHtml(text,f);return parseSourceMarkdown(text,f,file);}
  async readRepo(feed,file){let error;for(const url of [`https://gcore.jsdelivr.net/gh/${feed.repo}@main/${file}`,`https://raw.githubusercontent.com/${feed.repo}/main/${file}`,`https://cdn.jsdelivr.net/gh/${feed.repo}@main/${file}`]){try{return {text:await this.read(url),url};}catch(e){error=e;if(this.closing)throw e;}}throw error;}
  async extraRows(feed){
    if(feed.repo){const data=await this.readRepo(feed,feed.path);let rows=this.parseExtra(feed.id,data.text);
      if(feed.adapter==='recipes'||feed.id==='s26'||!rows.length){if(feed.id==='s26')rows=[];const files=markdownFiles(data.text,feed);for(const file of files){const part=await this.readRepo(feed,file);let items=parseSourceMarkdown(part.text,feed,file);if(feed.id==='s26'){const content=part.text.trim();if(content.length>=20)items=[{title:decodeURIComponent(file.split('/').pop().replace(/\.md$/i,'')).replaceAll('_',' '),content,originId:file,sourceUrl:feed.url+'/blob/main/'+file,author:feed.name,description:feed.notice}];}rows.push(...items);}}
      return {rows,url:data.url};
    }
    const text=await this.read(feed.url);if(feed.adapter==='html-prompts')return {rows:parsePromptHtml(text,feed),url:feed.url};
    const rows=[];for(const url of videoPages(text,feed)){const detail=await this.read(url);rows.push(...parseVideoHtml(detail,feed,url));}return {rows,url:feed.url};
  }
  async sync(id,options={}){
    if(this.closing)throw Error('工作台正在关闭');const f=this.feed(id);if(f.syncable===false)throw Error(f.notice||'此源需从原站取得文件后导入');
    if(this.batch?.status==='running'&&!options.batch)throw Error('批量同步进行中，请等待当前批次结束');
    if(this.syncing.has(id))throw new Error('该分享源正在同步');this.syncing.add(id);
    const work=this.performSync(id,options);this.inflight.add(work);try{return await work;}finally{this.inflight.delete(work);this.syncing.delete(id);}
  }
  async performSync(id,{page=1}={}){
    try{
      if(EXTRA_FEEDS.some(f=>f.id===id)){const {rows,url}=await this.extraRows(this.feed(id));return this.ingestRows(id,rows,url);}
      if(id==='mother'){const url='https://api.comfyit.cn/promptPlaza/list';return this.ingest(id,await this.read(url,{method:'POST',headers:{'Content-Type':'application/json',platform:'prompt_master'},body:JSON.stringify({pageNumber:Math.min(1000,Math.max(1,Math.floor(Number(page)||1))),pageSize:48,sortType:'latest'})}),url);}
      let error;for(const url of URLS[id])try{const text=await this.read(url);if(id==='xrepo'){if(!this.imageVerifier)throw new Error('图片校验服务不可用');const rows=parseRepoGallery(text);await Promise.all(rows.map(async row=>{await this.imageVerifier(row.frontCover);}));}return this.ingest(id,text,url);}catch(e){error=e;}throw error;
    }catch(e){const message='同步失败，保留缓存：'+String(e.message).slice(0,200);if(!this.closing){const old=this.store.get('feeds',id)||{id};this.store.put('feeds',{...old,lastError:message});}throw new Error(message);}
  }
  startBatch(ids){
    if(this.closing)throw Error('工作台正在关闭');if(this.batch?.status==='running'||this.syncing.size)throw Error('已有来源正在同步，请等待完成');
    if(!Array.isArray(ids)||!ids.length||ids.length>FEEDS.length||ids.some(id=>typeof id!=='string'))throw Error('请选择有效来源');
    const unique=[...new Set(ids)];for(const id of unique)this.feed(id);
    this.batch={id:hash(Date.now()+':'+Math.random()),status:'running',startedAt:new Date().toISOString(),items:unique.map(id=>({id,name:this.feed(id).name,status:'queued'}))};
    this.batchTask=this.runBatch().finally(()=>{this.batch.status='completed';this.batch.finishedAt=new Date().toISOString();});return this.batchStatus();
  }
  async runBatch(){for(const item of this.batch.items){const f=this.feed(item.id);if(this.closing){item.status='skipped';item.error='关闭工作台，未发起读取';continue;}if(f.syncable===false){item.status='skipped';item.error=f.notice;continue;}item.status='running';try{const result=await this.sync(item.id,{batch:true});item.status='succeeded';item.count=result.count;}catch(e){item.status='failed';item.error=e.message;}}}
  batchStatus(){if(!this.batch)return {status:'idle',items:[]};const items=this.batch.items.map(i=>({...i}));return {...this.batch,items,total:items.length,done:items.filter(i=>!['queued','running'].includes(i.status)).length,succeeded:items.filter(i=>i.status==='succeeded').length,failed:items.filter(i=>i.status==='failed').length,skipped:items.filter(i=>i.status==='skipped').length};}
  importFile(id,{text,fileName='来源文件'}){const f=this.feed(id);if(this.closing||this.syncing.size||this.batch?.status==='running')throw Error('请等待来源同步结束');if(typeof text!=='string'||!text.trim()||Buffer.byteLength(text)>10e6)throw Error('来源文件需要正文且不超过10MB');
    const importedFeed={...f,contentKind:'text',name:'用户导入 · 原作者待核对'};
    let rows;try{JSON.parse(text);rows=parseSourceJson(text,importedFeed);}catch(e){if(/^[\s]*[\[{]/.test(text))throw e;rows=parseSourceMarkdown(text,importedFeed,'人工导入');if(!rows.length)rows=[{title:String(fileName).slice(0,250),content:text,sourceUrl:f.url,author:importedFeed.name}];}
    rows=rows.map(r=>({...r,sourceUrl:r.sourceUrl===f.url+'/blob/main/人工导入'?f.url:r.sourceUrl,importedFrom:'local-file',description:'从本地文件导入；未访问原站。文件：'+String(fileName).slice(0,120)+'；许可与出处由文件提供，需核对。'}));
    return this.ingestRows(id,rows,'local-file:'+String(fileName).slice(0,120));
  }
  async close(){this.closing=true;this.abort.abort();await Promise.allSettled([...this.inflight,this.batchTask].filter(Boolean));}
  list({source='',query='',offset=0,limit=36,kind='all',sort='latest'}={}){
    limit=Math.min(100,Math.max(1,Math.floor(Number(limit)||20)));offset=Math.max(0,Math.floor(Number(offset)||0));
    const where="kind='shared' AND (?='' OR json_extract(body,'$.sourceId')=?) AND (?='' OR instr(lower(coalesce(json_extract(body,'$.title'),'')||' '||coalesce(json_extract(body,'$.description'),'')||' '||coalesce(json_extract(body,'$.content'),'')||' '||coalesce(json_extract(body,'$.modelHint'),'')||' '||coalesce(json_extract(body,'$.tags'),'')),lower(?))>0)";
    const media=kind==='images'?" AND coalesce(json_extract(body,'$.coverUrl'),'')<>''":kind==='text'?" AND coalesce(json_extract(body,'$.coverUrl'),'')=''":'';
    const order=sort==='views'?"CAST(json_extract(body,'$.viewCount') AS INTEGER) DESC":sort==='copies'?"CAST(json_extract(body,'$.copyCount') AS INTEGER) DESC":"json_extract(body,'$.sourceId'),CAST(json_extract(body,'$.originId') AS INTEGER) DESC";
    const active=` AND json_extract(body,'$.sourceId') IN (${FEEDS.map(()=>'?').join(',')})`;
    const args=[source,source,query,query,...FEEDS.map(f=>f.id)];const total=this.store.db.prepare(`SELECT count(*) AS n FROM records WHERE ${where}${media}${active}`).get(...args).n;
    const items=this.store.db.prepare(`SELECT json_remove(body,'$.content','$.negative') AS body FROM records WHERE ${where}${media}${active} ORDER BY ${order},id LIMIT ? OFFSET ?`).all(...args,limit,offset).map(r=>JSON.parse(r.body));return {items,total,offset,limit,feeds:this.catalog()};
  }
  async detail(id){
    if(this.closing)throw Error('工作台正在关闭');
    const item=this.store.get('shared',id);if(!item)throw new Error('分享条目不存在，请先同步');
    this.feed(item.sourceId);
    if(item.detailLoaded)return item;if(this.feed(item.sourceId).syncable===false)throw Error('此来源未确认自动读取权限，请访问原站或确认文件导入');if(item.sourceId!=='mother')throw new Error('正文不可用');
    const data=JSON.parse(await this.read('https://api.comfyit.cn/promptPlaza/details?id='+encodeURIComponent(item.originId),{headers:{platform:'prompt_master'}}));
    if(!data.success||typeof data.result?.positive!=='string'||!data.result.positive.trim())throw new Error('原站详情不可匿名读取，请到原软件查看');
    if(this.closing)throw Error('工作台正在关闭');return this.store.put('shared',{...item,content:data.result.positive.slice(0,100000),negative:String(data.result.negative||'').slice(0,50000),detailLoaded:true,author:data.result.author?.nickname||data.result.author?.name||item.author});
  }
}
