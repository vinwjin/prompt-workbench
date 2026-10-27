import {day,UNKNOWN} from './gallery-metadata.js';
import{historicalImages,videoRepository}from'./opennana-repos.js';
import{openNanaPage,openNanaSnapshot,OPENNANA_SCAN}from'./opennana.js';
import {GALLERY_IDS,VIDEO_GALLERY_IDS,sourceVideoUrl,videoPost,galleryEligible} from './gallery-policy.js';
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
// Public distribution retains manual import for sources without verified automated-access permission.
export const FEEDS=BASE_FEEDS.map(f=>['mother','s31','s38','s39','s40'].includes(f.id)||/未声明|未确认|逐条许可|未核实/.test(f.license)?{...f,syncable:false,notice:'公开版未确认自动读取权限；请访问原站，或导入你有权使用的文件。'}:f);
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
  constructor(store,{fetcher=fetch,imageVerifier}={}){this.store=store;this.fetcher=fetcher;this.imageVerifier=imageVerifier;this.nanaDetails=new Map();this.syncing=new Set();this.inflight=new Set();this.abort=new AbortController();this.closing=false;const saved=this.store.get('sourceBatches','latest');this.batch=saved?{...saved,id:saved.batchId}:null;if(this.batch&&['running','cancelling'].includes(this.batch.status)){this.batch.status='interrupted';for(const item of this.batch.items)if(['queued','running'].includes(item.status)){item.status='interrupted';item.error='上次同步中断，未自动重试';}this.saveBatch();}}
  feed(id){const f=FEEDS.find(f=>f.id===id);if(!f)throw new Error('分享源不存在');return f;}
  catalog(){const revision=this.store.kindRevision('shared');if(this.countCache?.revision!==revision)this.countCache={revision,counts:new Map(this.store.db.prepare("SELECT source,sum(hasCover) AS images,sum(1-hasCover) AS text FROM shared_summary GROUP BY source").all().map(r=>[r.source,r]))};const counts=this.countCache.counts;return FEEDS.map(f=>({...this.store.get('feeds',f.id),...f,syncable:f.syncable!==false,preferredKind:counts.get(f.id)?.images?(counts.get(f.id)?.text?'all':'images'):counts.get(f.id)?.text?'text':f.contentKind||'all',contentKind:f.contentKind||(['shortcut','prompts'].includes(f.id)?'text':'images'),syncing:this.syncing.has(f.id),queued:this.batchBusy()&&this.batch.items.some(i=>i.id===f.id&&i.status==='queued')}));}
  async read(url,options={}){
    const r=await this.fetcher(url,{...options,redirect:'error',signal:AbortSignal.any([this.abort.signal,AbortSignal.timeout(20000)])});
    if(!r.ok)throw new Error('分享源 HTTP '+r.status);
    if(Number(r.headers.get('content-length'))>16e6)throw new Error('分享源超过 16MB');
    let size=0,text='';const decoder=new TextDecoder();for await(const chunk of r.body){size+=chunk.length;if(size>16e6)throw new Error('分享源超过 16MB');text+=decoder.decode(chunk,{stream:true});}return text+decoder.decode();
  }
  normalize(id,r){
    const f=this.feed(id),title=String(r.title||r.act||'未命名').slice(0,250),originId=String(r.originId||r.id||hash(title+'\n'+(r.content||r.prompt||'')));
    const coverUrls=Array.isArray(r.coverUrls)?r.coverUrls.map(coverUrl).filter(Boolean).slice(0,8):[],imageLabels=Array.isArray(r.imageLabels)?r.imageLabels.map(v=>String(v).slice(0,120)).slice(0,8):[];
    return {id:id+'-'+hash(originId),sourceId:id,originId,upstreamOriginId:String(r.upstreamOriginId||originId),title,coverUrl:coverUrl(r.frontCover||r.coverUrl),videoUrl:VIDEO_GALLERY_IDS.includes(id)?sourceVideoUrl(r.videoUrl):'',coverUrls,imageLabels,viewCount:Math.max(0,Number(r.viewCount)||0),copyCount:Math.max(0,Number(r.copyCount)||0),content:typeof r.content==='string'?r.content:typeof r.prompt==='string'?r.prompt:'',negative:String(r.negative||''),description:String(r.description||'').slice(0,1000),modelHint:String(r.modelHint||r.models||'').slice(0,200),tags:Array.isArray(r.tags)?r.tags.join(', '):String(r.tags||''),author:String(r.author||'').slice(0,120),submitter:String(r.submitter||'').slice(0,120),galleryUrl:safeSource(r.galleryUrl),license:String(r.license||f.license).slice(0,500),sourceUrl:safeSource(r.sourceUrl)||f.url,importedFrom:r.importedFrom==='local-file'?'local-file':undefined,detailLoaded:id!=='mother'||r.detailLoaded===true||r.importedFrom==='local-file',prompts:Array.isArray(r.prompts)?r.prompts:[],sourceType:r.sourceType||(['s38','s39'].includes(id)?'live-api':''),sourceVersion:r.sourceVersion||'',originFile:r.originFile||'',referenceOnly:r.referenceOnly===true,examples:r.examples||[],notes:r.notes||[],publishedAt:(()=>{try{return day(r.publishedAt||r.sourcePublishedAt);}catch{return null;}})(),syncedAt:new Date().toISOString()};
  }
  ingest(id,text,fetchedUrl='',options={}){
    this.feed(id);let rows,total;
    if(EXTRA_FEEDS.some(f=>f.id===id))rows=this.parseExtra(id,text);
    else if(id==='xrepo')rows=parseRepoGallery(text);
    else if(id==='shortcut'){const data=JSON.parse(text);if(!Array.isArray(data))throw new Error('中文词库格式已改变');rows=data.map(r=>({id:r.id,title:r.zh?.title||r.en?.title,content:r.zh?.prompt||r.en?.prompt,description:r.zh?.remark||r.zh?.description||'',tags:r.tags,author:'rockbenben / 社区贡献者'}));}
    else if(id==='prompts')rows=parseCSV(text).map(r=>({...r,content:r.prompt,author:r.contributor||'社区贡献者',tags:r.type||'通用'}));
    else{const data=JSON.parse(text);if(!data.success)throw new Error(data.message||'原站未开放匿名读取');rows=data.result?.datas;if(!Array.isArray(rows))throw new Error('原站列表格式已改变');total=data.result.total;rows=rows.map(r=>({...r,author:r.author?.nickname||r.author?.name|| (typeof r.author==='string'?r.author:''),content:''}));}
    return this.ingestRows(id,rows,fetchedUrl,total,{},options);
  }
  ingestRows(id,rows,fetchedUrl='',total,feedExtra={},options={}){
    this.feed(id);if(this.closing)throw Error('工作台正在关闭');
    if(!Array.isArray(rows)||!rows.length||rows.length>10000)throw new Error('分享源没有有效条目或条目过多');
    if(rows.some(r=>typeof(r.content||r.prompt||'')!=='string'||String(r.content||r.prompt||'').length>1e6))throw Error('来源正文格式无效或单项超过1MB');
    let items=rows.map(r=>this.normalize(id,r)).filter(r=>r.title&& (id==='mother'||r.content));if(!items.length)throw new Error('没有可用提示词');
    // 同一原帖可能包含多个不同配方，避免把后一个正文覆盖前一个。
    if(!['s38','s39','s40'].includes(id)&&EXTRA_FEEDS.some(f=>f.id===id))items=items.map(item=>{const originId=item.upstreamOriginId+'#'+hash(item.content);return {...item,id:id+'-'+hash(originId),originId};});
    this.store.db.exec('BEGIN IMMEDIATE');try{
      const before=this.store.get('feeds',id)||{},now=new Date().toISOString();let added=0,unchanged=0;
      const ids=[...new Set(items.map(item=>item.id))];
      for(const item of items){const old=this.store.get('shared',item.id);if(options.incremental&&old){unchanged++;continue;}if(id==='s38'&&old&&!old.sourceType?.startsWith('historical-')&&item.sourceType?.startsWith('historical-')){unchanged++;continue;}if(!old)added++;
        this.store.put('shared',{...item,firstSyncedAt:old?(old.firstSyncedAt||null):now,...(old?.detailLoaded&&id==='mother'&&!item.detailLoaded?{content:old.content,negative:old.negative,detailLoaded:true}:{})});}
      if(!options.incremental&&(!['mother','s38','s39','s40'].includes(id)||(id==='mother'&&fetchedUrl.startsWith('local-file:'))))this.store.db.prepare("DELETE FROM records WHERE kind='shared' AND json_extract(body,'$.sourceId')=? AND id NOT IN (SELECT value FROM json_each(?))").run(id,JSON.stringify(ids));
      const meta=this.store.put('feeds',{...before,...feedExtra,id,lastSync:now,count:this.store.db.prepare("SELECT count(*) AS n FROM records WHERE kind='shared' AND json_extract(body,'$.sourceId')=?").get(id).n,total:total??items.length,fetchedUrl,lastError:null,lastAdded:added,lastUnchanged:unchanged,readStrategy:options.incremental?'snapshot-diff':'full-or-page'});this.store.db.exec('COMMIT');return meta;
    }catch(e){this.store.db.exec('ROLLBACK');throw e;}
  }
  parseExtra(id,text,file){const f=this.feed(id);if(['meigen','nexra','act-json','translated-json'].includes(f.adapter))return parseSourceJson(text,f);if(f.adapter==='html-prompts')return parsePromptHtml(text,f);return parseSourceMarkdown(text,f,file);}
  async readRepo(feed,file){let error;for(const url of [`https://gcore.jsdelivr.net/gh/${feed.repo}@${feed.branch||'main'}/${file}`,`https://raw.githubusercontent.com/${feed.repo}/${feed.branch||'main'}/${file}`,`https://cdn.jsdelivr.net/gh/${feed.repo}@${feed.branch||'main'}/${file}`]){try{return {text:await this.read(url),url};}catch(e){error=e;if(this.closing)throw e;}}throw error;}
  async extraRows(feed){
    if(feed.repo){const data=await this.readRepo(feed,feed.path);let rows=this.parseExtra(feed.id,data.text);
      if(feed.adapter==='recipes'||feed.id==='s26'||!rows.length){if(feed.id==='s26')rows=[];const files=markdownFiles(data.text,feed);for(const file of files){const part=await this.readRepo(feed,file);let items=parseSourceMarkdown(part.text,feed,file);if(feed.id==='s26'){const content=part.text.trim();if(content.length>=20)items=[{title:decodeURIComponent(file.split('/').pop().replace(/\.md$/i,'')).replaceAll('_',' '),content,originId:file,sourceUrl:feed.url+'/blob/main/'+file,author:feed.name,description:feed.notice}];}rows.push(...items);}}
      return {rows,url:data.url};
    }
    const text=await this.read(feed.url);if(feed.adapter==='html-prompts')return {rows:parsePromptHtml(text,feed),url:feed.url};
    const rows=[];for(const url of videoPages(text,feed)){const detail=await this.read(url);rows.push(...parseVideoHtml(detail,feed,url));}return {rows,url:feed.url};
  }
  async sync(id,options={}){
    if(this.closing)throw Error('工作台正在关闭');if(options.mode&&!['incremental','quick','full','restart'].includes(options.mode))throw Error('同步模式无效');const f=this.feed(id);if(f.syncable===false)throw Error(f.notice||'此源需从原站取得文件后导入');
    if(this.batchBusy()&&!options.batch)throw Error('批量同步进行中，请等待当前批次结束');
    if(this.syncing.has(id))throw new Error('该分享源正在同步');this.syncing.add(id);this.store.put('feeds',{...(this.store.get('feeds',id)||{}),id,lastAdded:0,lastUnchanged:0});
    const work=this.performSync(id,options);this.inflight.add(work);try{return await work;}finally{this.inflight.delete(work);this.syncing.delete(id);}
  }
  async performSync(id,{page,mode='quick',batch=false}={}){
    try{
      const options={incremental:mode==='incremental'};
      if(['s38','s39'].includes(id))return mode==='incremental'?await this.syncOpenNanaIncremental(id,{batch}):await this.syncOpenNana(id,page,{mode,batch});
      if(id==='s40'){const {text,url}=await this.readRepo({repo:'songguoxs/awesome-video-prompts',branch:'main'},'README.md');return this.ingestRows(id,videoRepository(text),url,undefined,{},options);}
      if(EXTRA_FEEDS.some(f=>f.id===id)){const {rows,url}=await this.extraRows(this.feed(id));return this.ingestRows(id,rows,url,undefined,{},options);}
      if(id==='mother')return await this.syncMother(page,options);
      let error;for(const url of URLS[id])try{const text=await this.read(url);if(id==='xrepo'){if(!this.imageVerifier)throw new Error('图片校验服务不可用');const rows=parseRepoGallery(text);await Promise.all(rows.filter(row=>!options.incremental||!this.store.get('shared',this.normalize(id,row).id)).map(async row=>{await this.imageVerifier(row.frontCover);}));}return this.ingest(id,text,url,options);}catch(e){error=e;}throw error;
    }catch(e){const message='同步失败，保留缓存：'+String(e.message).slice(0,200);if(!this.closing){const old=this.store.get('feeds',id)||{id};this.store.put('feeds',{...old,lastError:message});}throw new Error(message);}
  }
  async syncMother(requestedPage,{incremental=false}={}){
    const url='https://api.comfyit.cn/promptPlaza/list',headers={'Content-Type':'application/json',platform:'prompt_master'},rows=[];let knownCount=0;const previousFeed=this.store.get('feeds','mother')||{},baseline=new Set(previousFeed.incrementalSeen||[]),pending=[];
    const read=async(u,o)=>{try{return await this.read(u,o);}catch(e){if(this.closing||e.message!=='fetch failed')throw e;return this.read(u,o);}};
    let page=requestedPage?Math.min(1000,Math.max(1,Math.floor(Number(requestedPage)||1))):1,total=0,lastPage=page;
    do{
      const data=JSON.parse(await read(url,{method:'POST',headers,body:JSON.stringify({pageNumber:page,pageSize:48,sortType:'latest'})}));
      if(!data.success||!Array.isArray(data.result?.datas))throw Error('原站列表不可读取或格式已改变');
      total=Number(data.result.total);if(!Number.isInteger(total)||total<0||total>10000||data.result.datas.length>48)throw Error('原站条目数量无效或超过10000条');
      if(!data.result.datas.length&&(page-1)*48<total)throw Error('原站分页意外为空，保留旧缓存');
      if(incremental)for(const r of data.result.datas)if(pending.length<200&&!pending.includes(String(r.id)))pending.push(String(r.id));const listed=data.result.datas.filter(r=>coverUrl(r.frontCover));const candidates=listed.filter(r=>{if(incremental&&this.store.get('shared','mother-'+hash(String(r.id)))){knownCount++;return false;}return true;});
      for(let offset=0;offset<candidates.length;offset+=4){const group=await Promise.all(candidates.slice(offset,offset+4).map(async r=>{
        if(!/^\d+$/.test(String(r.id)))throw Error('原站条目编号无效');
        const detail=JSON.parse(await read('https://api.comfyit.cn/promptPlaza/details?id='+encodeURIComponent(r.id),{headers:{platform:'prompt_master'}}));
        if(!detail.success)throw Error('原站正文读取失败');
        if(typeof detail.result?.positive!=='string'||detail.result.positive.trim().length<20)return null;
        return {...r,content:detail.result.positive.slice(0,100000),negative:String(detail.result.negative||'').slice(0,50000),detailLoaded:true,author:detail.result.author?.nickname||detail.result.author?.name||r.author?.nickname||r.author?.name||'',sourceUrl:this.feed('mother').url};
      }));rows.push(...group.filter(Boolean));}
      lastPage=page;if(requestedPage||page*48>=total||(incremental&&(!baseline.size||baseline.has(String(data.result.datas.at(-1)?.id)))))break;page++;
    }while(page<=209);
    const before=this.store.get('feeds','mother')||{id:'mother'};const meta=rows.length?this.ingestRows('mother',rows,url,total,{}, {incremental}):incremental?{...before,lastSync:new Date().toISOString(),lastAdded:0}:this.ingestRows('mother',rows,url,total);return this.store.put('feeds',{...meta,...(incremental?{lastUnchanged:knownCount,incrementalSeen:pending,readStrategy:'latest-pages',total,lastError:null}:{lastPage,nextPage:lastPage*48<total?lastPage+1:null})});
  }
  async readNana(url){
    if(this.nanaDetails.has(url))return this.nanaDetails.get(url);
    let error;for(let attempt=0;attempt<2;attempt++){try{const text=await this.read(url);if(new URL(url).pathname.startsWith('/api/prompts/')){if(this.nanaDetails.size>=100)this.nanaDetails.delete(this.nanaDetails.keys().next().value);this.nanaDetails.set(url,text);}return text;}catch(e){error=e;if(this.closing||this.batch?.status==='cancelling')throw e;}}
    throw error;
  }
  async syncOpenNana(id,page,{mode='quick',batch=false}={}){
    if(!['incremental','quick','full','restart'].includes(mode))throw Error('同步模式无效');
    let old=this.store.get('feeds',id)||{};
    if(mode==='restart')this.nanaDetails.clear();
    if(old.scanVersion!==OPENNANA_SCAN||mode==='restart'){old={...old,scanVersion:OPENNANA_SCAN,nextPage:1,lastPage:0,scannedTotal:0,detailTotal:0,eligibleTotal:0,rejectedTotal:0,lockedTotal:0,scanComplete:false};this.store.put('feeds',{...old,id});}
    if(old.scanComplete&&mode==='full')return old;
    let current=page??old.nextPage??1;
    if(current===1&&old.scanComplete){old={...old,scannedTotal:0,detailTotal:0,eligibleTotal:0,rejectedTotal:0,lockedTotal:0,scanComplete:false};this.store.put('feeds',{...old,id,nextPage:1});}
    const stop=()=>this.closing||(batch&&this.batch?.status==='cancelling');
    do{
      if(stop())return {...old,stopped:true};
      const part=await openNanaPage(u=>this.readNana(u),id==='s39'?'video':'image',current,{stop,progress:v=>{this.store.put('feeds',{...old,id,...v,lastError:null});}});
      if(stop())return {...old,stopped:true};
      const extra={...old,scanVersion:OPENNANA_SCAN,lastPage:part.page,nextPage:part.nextPage,currentPage:part.page,pageLoaded:0,scanned:part.scanned,locked:part.locked,rejected:part.rejected,scannedTotal:(old.scannedTotal||0)+part.scanned,detailTotal:(old.detailTotal||0)+part.scanned-part.locked,eligibleTotal:(old.eligibleTotal||0)+part.rows.length,rejectedTotal:(old.rejectedTotal||0)+part.rejected,lockedTotal:(old.lockedTotal||0)+part.locked,scanComplete:part.nextPage===null,totalChanged:!!old.totalChanged||(old.total!=null&&old.lastPage>0&&old.total!==part.total)};
      old=part.rows.length?this.ingestRows(id,part.rows,part.url,part.total,extra):this.store.put('feeds',{...extra,id,lastSync:new Date().toISOString(),count:old.count||0,total:part.total,lastError:null,fetchedUrl:part.url});
      this.nanaDetails.clear();current=part.nextPage;
    }while(current&&mode!=='quick');return old;
  }
  async syncOpenNanaIncremental(id,{batch=false}={}){
    let old=this.store.get('feeds',id)||{id},current=old.incrementalNextPage||1,added=0,unchanged=0;
    const baseline=new Set(old.incrementalSeen||[]);let pending=old.incrementalPendingSeen||[];const stop=()=>this.closing||(batch&&this.batch?.status==='cancelling');this.nanaDetails.clear();
    do{
      if(stop())return {...old,stopped:true};
      old=this.store.put('feeds',{...old,id,incrementalNextPage:current});
      const part=await openNanaPage(u=>this.readNana(u),id==='s39'?'video':'image',current,{stop,order:'DESC',sort:'reviewed_at',known:slug=>baseline.has(slug)||!!this.store.get('shared',id+'-'+hash(slug))});
      if(stop())return {...old,stopped:true};
      const finished=!baseline.size||!part.nextPage||baseline.has(part.slugs.at(-1));pending=[...new Set([...pending,...part.slugs])].slice(0,200);
      const extra={...old,incrementalNextPage:finished?null:part.nextPage,incrementalTotal:part.total,incrementalSeen:finished?pending:[...baseline],incrementalPendingSeen:finished?[]:pending,readStrategy:'latest-pages'};
      old=part.rows.length?this.ingestRows(id,part.rows,part.url,old.total,extra,{incremental:true}):this.store.put('feeds',{...extra,id,lastSync:new Date().toISOString(),lastAdded:0,lastError:null});
      added+=old.lastAdded||0;unchanged+=part.known;old=this.store.put('feeds',{...old,lastAdded:added,lastUnchanged:unchanged,readStrategy:'latest-pages'});
      current=finished?null:part.nextPage;this.nanaDetails.clear();
    }while(current);return old;
  }
  async syncHistory(){
    if(this.closing||this.batchBusy()||this.syncing.size)throw Error('请等待来源同步结束');
    this.syncing.add('s38');const work=(async()=>{const files=[];for(const file of [...Array.from({length:10},(_,i)=>(i+1)*100+'.md'),'README.md']){const data=await this.readRepo({repo:'songguoxs/gpt4o-image-prompts',branch:'master'},file);files.push({file,text:data.text});}const h=historicalImages(files),old=this.store.get('feeds','s38')||{};return this.ingestRows('s38',h.rows,'historical-markdown:complete',old.total,{...old,historyCases:h.cases,historyEligible:h.eligible,historyReferences:h.references,historyRejected:h.rejected});})();this.inflight.add(work);try{return await work;}finally{this.inflight.delete(work);this.syncing.delete('s38');}
  }
  startBatch(ids,{mode='quick'}={}){
    if(!['incremental','quick','full','restart'].includes(mode))throw Error('同步模式无效');
    if(this.closing)throw Error('工作台正在关闭');if(this.batchBusy()||this.syncing.size)throw Error('已有来源正在同步，请等待完成');
    if(!Array.isArray(ids)||!ids.length||ids.length>FEEDS.length||ids.some(id=>typeof id!=='string'))throw Error('请选择有效来源');
    const unique=[...new Set(ids)];for(const id of unique)this.feed(id);
    this.batch={id:hash(Date.now()+':'+Math.random()),status:'running',mode,startedAt:new Date().toISOString(),items:unique.map(id=>({id,name:this.feed(id).name,status:'queued'}))};
    this.saveBatch();this.batchTask=this.runBatch().finally(()=>{this.batch.status=this.batch.status==='cancelling'?'cancelled':'completed';this.batch.finishedAt=new Date().toISOString();this.saveBatch();});return this.batchStatus();
  }
  batchBusy(){return ['running','cancelling'].includes(this.batch?.status);}
  saveBatch(){if(this.batch)this.store.put('sourceBatches',{...this.batch,batchId:this.batch.id,id:'latest'});}
  cancelBatch(id){if(!this.batch||id!==this.batch.id)throw Error('同步批次已变化，请刷新后重试');if(this.batchBusy()){this.batch.status='cancelling';this.saveBatch();}return this.batchStatus();}
  async runBatch(){for(const item of this.batch.items){const f=this.feed(item.id);if(this.batch.status==='cancelling'){item.status='cancelled';item.error='用户停止，未发起读取';this.saveBatch();continue;}if(this.closing){item.status='skipped';item.error='关闭工作台，未发起读取';continue;}if(f.syncable===false){item.status='skipped';item.error=f.notice;continue;}item.status='running';this.saveBatch();try{const result=await this.sync(item.id,{batch:true,mode:this.batch.mode||'quick'});item.status=result.stopped?'cancelled':'succeeded';item.count=result.count;item.added=result.lastAdded||0;item.unchanged=result.lastUnchanged||0;item.readStrategy=result.readStrategy;}catch(e){item.status=this.batch.status==='cancelling'?'cancelled':'failed';item.error=e.message;const partial=this.store.get('feeds',item.id);item.added=partial?.lastAdded||0;item.unchanged=partial?.lastUnchanged||0;}this.saveBatch();}}
  batchStatus(){if(!this.batch)return {status:'idle',items:[]};const items=this.batch.items.map(i=>({...i}));return {...this.batch,items,total:items.length,done:items.filter(i=>!['queued','running'].includes(i.status)).length,succeeded:items.filter(i=>i.status==='succeeded').length,failed:items.filter(i=>i.status==='failed').length,skipped:items.filter(i=>i.status==='skipped').length,cancelled:items.filter(i=>i.status==='cancelled').length,interrupted:items.filter(i=>i.status==='interrupted').length};}
  importFile(id,{text,fileName='来源文件'}){const f=this.feed(id);if(this.closing||this.syncing.size||this.batchBusy())throw Error('请等待来源同步结束');if(typeof text!=='string'||!text.trim()||Buffer.byteLength(text)>10e6)throw Error('来源文件需要正文且不超过10MB');
    const importedFeed={...f,contentKind:GALLERY_IDS.includes(id)&&!VIDEO_GALLERY_IDS.includes(id)?'images':'text',name:'用户导入 · 原作者待核对'};
    let rows;try{const data=JSON.parse(text);rows=id==='s38'&&data.generatedAt?openNanaSnapshot(text):parseSourceJson(text,importedFeed);}catch(e){if(/^[\s]*[\[{]/.test(text))throw e;rows=parseSourceMarkdown(text,importedFeed,'人工导入');if(!rows.length)rows=[{title:String(fileName).slice(0,250),content:text,sourceUrl:f.url,author:importedFeed.name}];}
    rows=rows.map(r=>({...r,sourceUrl:r.sourceUrl===f.url+'/blob/main/人工导入'?f.url:r.sourceUrl,importedFrom:'local-file',description:'从本地文件导入；未访问原站。文件：'+String(fileName).slice(0,120)+'；许可与出处由文件提供，需核对。'}));
    return this.ingestRows(id,rows,'local-file:'+String(fileName).slice(0,120),this.store.get('feeds',id)?.total,['s38','s39','s40'].includes(id)?this.store.get('feeds',id)||{}:{});
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
  galleryCandidates(){const revision=this.store.kindRevision('shared');if(this.galleryCountCache?.revision!==revision)this.galleryCountCache={revision,counts:new Map(this.store.db.prepare('SELECT source,count(*) AS n FROM shared_summary WHERE eligible=1 GROUP BY source').all().map(r=>[r.source,r.n]))};const counts=this.galleryCountCache.counts;return this.catalog().filter(f=>GALLERY_IDS.includes(f.id)).map(f=>({...f,cachedCount:f.count,count:counts.get(f.id)||0,contentKind:VIDEO_GALLERY_IDS.includes(f.id)?'video':'images',preferredKind:VIDEO_GALLERY_IDS.includes(f.id)?'video':'images'}));}
  galleryRows(){const revision=this.store.kindRevision('shared');if(this.galleryCache?.revision===revision)return this.galleryCache.rows;const rows=this.store.db.prepare(`SELECT body FROM records WHERE kind='shared' AND json_extract(body,'$.sourceId') IN (${GALLERY_IDS.map(()=>'?').join(',')})`).all(...GALLERY_IDS).map(r=>JSON.parse(r.body)).filter(galleryEligible);this.galleryCache={revision,rows};return rows;}
  galleryCatalog(){return this.galleryCandidates().filter(f=>f.count>0);}
  galleryFacets(kind='images'){
    const stamp=this.store.kindRevision('shared')+':'+this.store.kindRevision('galleryNotes')+':'+kind;if(this.facetsCache?.stamp===stamp)return this.facetsCache.value;
    const video=VIDEO_GALLERY_IDS.map(()=>'?').join(','),media=kind==='all'?'':` AND s.source ${kind==='video'?'IN':'NOT IN'} (${video})`,args=kind==='all'?[]:VIDEO_GALLERY_IDS,value={};
    for(const key of ['models','purposes','styles'])value[key]=this.store.db.prepare(`SELECT DISTINCT j.value FROM gallery_search g JOIN shared_summary s ON s.id=g.id,json_each(g.${key}) j WHERE s.eligible=1${media} ORDER BY j.value LIMIT 500`).all(...args).map(r=>r.value);
    this.facetsCache={stamp,value};return value;
  }
  galleryList({source='',query='',offset=0,limit=50,kind='images',sort='latest',model='',purpose='',style='',author='',from='',to='',timeField='published',unknownDate=false}={}){
    if(!['images','video','all'].includes(kind))throw Error('精品广场只提供图片或视频案例');
    if(!['latest','published','views','copies'].includes(sort)||!['published','collected'].includes(timeField))throw Error('排序或时间筛选无效');
    limit=Math.min(100,Math.max(1,Math.floor(Number(limit)||50)));offset=Math.max(0,Math.floor(Number(offset)||0));const q=String(query).toLowerCase();
    const video=VIDEO_GALLERY_IDS.map(()=>'?').join(','),media=kind==='all'?'':` AND s.source ${kind==='video'?'IN':'NOT IN'} (${video})`;
    let where="s.eligible=1 AND r.kind='shared' AND (?='' OR s.source=?)"+media+" AND (?='' OR instr(pw_lower(coalesce(json_extract(r.body,'$.title'),'')||' '||coalesce(json_extract(r.body,'$.content'),'')||' '||coalesce(json_extract(r.body,'$.modelHint'),'')||' '||coalesce(json_extract(r.body,'$.tags'),'')||' '||coalesce(json_extract(r.body,'$.author'),'')||' '||g.author||' '||g.models||' '||g.purposes||' '||g.styles),?)>0)";
    const args=[source,source,...(kind==='all'?[]:VIDEO_GALLERY_IDS),q,q];
    for(const [key,value] of [['models',model],['purposes',purpose],['styles',style]])if(value){if(value===UNKNOWN)where+=` AND json_array_length(g.${key})=0`;else{where+=` AND EXISTS (SELECT 1 FROM json_each(g.${key}) WHERE value=?)`;args.push(String(value).slice(0,80));}}
    if(author){if(author===UNKNOWN)where+=" AND trim(g.author)=''";else{where+=' AND instr(pw_lower(g.author),?)>0';args.push(String(author).toLowerCase().slice(0,120));}}
    if(unknownDate&&(from||to))throw Error('未标注时间不能与日期范围同时使用');
    if(from&&to&&day(from)>day(to))throw Error('开始日期不能晚于结束日期');
    if(unknownDate)where+=` AND g.${timeField} IS NULL`;
    if(from){where+=` AND g.${timeField}>=?`;args.push(day(from));}if(to){where+=` AND g.${timeField}<=?`;args.push(day(to));}
    const fromSql=" FROM shared_summary s JOIN records r ON r.kind='shared' AND r.id=s.id JOIN gallery_search g ON g.id=s.id WHERE "+where;
    const order=sort==='views'?"coalesce(json_extract(r.body,'$.viewCount'),0) DESC,r.id":sort==='copies'?"coalesce(json_extract(r.body,'$.copyCount'),0) DESC,r.id":sort==='published'?'g.published DESC,g.id':'g.collectedOrder DESC,g.id';
    const total=this.store.db.prepare('SELECT count(*) AS n'+fromSql).get(...args).n;
    const items=this.store.db.prepare("SELECT json_remove(r.body,'$.content','$.negative','$.prompts','$.examples','$.notes') AS body,g.models,g.purposes,g.styles,g.author AS filterAuthor,g.published,g.collected"+fromSql+' ORDER BY '+order+' LIMIT ? OFFSET ?').all(...args,limit,offset).map(r=>({...JSON.parse(r.body),metadata:{models:JSON.parse(r.models),purposes:JSON.parse(r.purposes),styles:JSON.parse(r.styles),author:r.filterAuthor,publishedAt:r.published,collectedAt:r.collected}}));
    return {items,total,offset,limit,feeds:this.galleryCatalog(),facets:this.galleryFacets(kind)};
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
