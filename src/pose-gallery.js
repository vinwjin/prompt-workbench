// POSE-DB-01 姿势集只读来源：页面为单文件静态 SPA，1439 条数据内嵌在 const D=[...]。
// 制作者条款：可免费用于创作参考（含商用），但禁止再分发/转载/转售图片本身。图片仅本机个人参考使用。
import {translatePose,seriesZh,angleZh} from './pose-i18n.js';
export const POSE_SOURCE={
  id:'pose-db-01',
  name:'POSE-DB-01 · 姿势集',
  url:'https://ai-pose-gallery.pages.dev/',
  author:'ギア',
  authorUrl:'https://x.com/giaaibusi',
  license:'免费用于创作参考（含商用），无需署名；禁止再分发、转载或转售图片本身',
  notice:'人体模型线稿，非真人。图片仅供本机个人参考，不随备份或公开副本分发。'
};
const ORIGIN='https://ai-pose-gallery.pages.dev/';
const MAX_PAGE=16e6;
const FIELDS=['id','系統','ポーズ番号','分類','ポーズ名','アングル','サムネ','原寸'];
const THUMB=/^thumbs\/[A-Za-z0-9_]+\.jpg$/,FULL=/^img\/[A-Za-z0-9_]+\.png$/;
export const POSE_ANGLES=['正面','俯视','仰视','侧面','斜视'];

// 从 start 处扫描一个完整的 JSON 数组字面量，正确处理字符串内的括号与转义。
function scanArray(text,start){
  let depth=0,inString=false,escaped=false;
  for(let i=start;i<text.length;i++){
    const c=text[i];
    if(inString){if(escaped)escaped=false;else if(c==='\\')escaped=true;else if(c==='"')inString=false;continue;}
    if(c==='"'){inString=true;continue;}
    if(c==='['||c==='{')depth++;
    else if(c===']'||c==='}'){depth--;if(depth===0)return text.slice(start,i+1);}
  }
  return null;
}
export function parsePosePage(html){
  if(typeof html!=='string'||!html)throw new Error('姿势集页面为空');
  if(html.length>MAX_PAGE)throw new Error('姿势集页面超过 16MB');
  const metaMatch=html.match(/const META=(\{[\s\S]{0,2000}?\});/);
  if(!metaMatch)throw new Error('姿势集页面结构已变化：找不到 META');
  let meta;
  try{meta=JSON.parse(metaMatch[1]);}catch{throw new Error('姿势集 META 不是有效 JSON');}
  if(!meta||!Array.isArray(meta.lines)||!meta.lines.length||meta.lines.length>20||meta.lines.some(v=>typeof v!=='string'||!v||v.length>60))throw new Error('姿势集系列列表无效');
  const at=html.indexOf('const D=');
  if(at<0)throw new Error('姿势集页面结构已变化：找不到数据数组');
  const start=html.indexOf('[',at);
  if(start<0)throw new Error('姿势集数据数组格式无效');
  const slice=scanArray(html,start);
  if(!slice)throw new Error('姿势集数据数组未闭合');
  let rows;
  try{rows=JSON.parse(slice);}catch{throw new Error('姿势集数据不是有效 JSON');}
  if(!Array.isArray(rows)||rows.length<50||rows.length>20000)throw new Error('姿势集条目数量异常');
  const seen=new Set();
  for(const row of rows){
    if(!row||typeof row!=='object'||Array.isArray(row))throw new Error('姿势集存在无效条目');
    for(const field of FIELDS)if(typeof row[field]!=='string'||!row[field]||row[field].length>200)throw new Error('姿势集条目的'+field+'字段无效');
    if(!meta.lines.includes(row['系統']))throw new Error('姿势集条目系列不在系列列表内');
    if(!THUMB.test(row['サムネ'])||!FULL.test(row['原寸']))throw new Error('姿势集图片路径不合规');
    if(seen.has(row.id))throw new Error('姿势集存在重复编号');
    seen.add(row.id);
  }
  return {lines:meta.lines,rows};
}
export function normalizePose(row,order){
  // poseKey 用原始系列保持聚合稳定；series/category/poseName/angle 翻译为中文用于展示、筛选与搜索。
  return translatePose({
    id:row.id,
    sourceId:POSE_SOURCE.id,
    series:row['系統'],
    poseKey:row['系統']+'|'+row['ポーズ番号'],
    poseNo:row['ポーズ番号'],
    category:row['分類'],
    poseName:row['ポーズ名'],
    angle:row['アングル'],
    thumbUrl:ORIGIN+row['サムネ'],
    fullUrl:ORIGIN+row['原寸'],
    order
  });
}
const escape=n=>String(n).replace(/'/g,"''");
export class PoseGallery{
  constructor(store,{fetcher=fetch,imageCache}={}){
    this.store=store;this.fetcher=fetcher;this.imageCache=imageCache;this.syncing=false;this.abort=new AbortController();this.closing=false;
  }
  feed(){return this.store.get('poseFeed',POSE_SOURCE.id)||null;}
  status(){
    const feed=this.feed();
    const count=this.store.db.prepare("SELECT count(*) AS n FROM records WHERE kind='poseRefs'").get().n;
    const poses=this.store.db.prepare("SELECT count(DISTINCT json_extract(body,'$.poseKey')) AS n FROM records WHERE kind='poseRefs'").get().n;
    return {
      source:POSE_SOURCE,count,poses,syncing:this.syncing,
      lastSync:feed?.lastSync||null,lastAdded:feed?.lastAdded||0,lastRemoved:feed?.lastRemoved||0,
      total:feed?.total??null,lastError:feed?.lastError||null,lines:feed?.lines||[],categories:feed?.categories||[]
    };
  }
  async read(url){
    const r=await this.fetcher(url,{redirect:'error',signal:AbortSignal.any([this.abort.signal,AbortSignal.timeout(30000)]),headers:{Accept:'text/html'}});
    if(!r.ok)throw new Error('姿势集 HTTP '+r.status);
    if(Number(r.headers.get('content-length'))>MAX_PAGE)throw new Error('姿势集页面超过 16MB');
    let size=0,text='';const decoder=new TextDecoder();
    for await(const chunk of r.body){size+=chunk.length;if(size>MAX_PAGE)throw new Error('姿势集页面超过 16MB');text+=decoder.decode(chunk,{stream:true});}
    return text+decoder.decode();
  }
  // 手动同步：一次 GET 取全量目录，按内嵌 id 集合做差，不穷举编号（原站编号有空缺）。
  async sync(){
    if(this.closing)throw new Error('工作台正在关闭');
    if(this.syncing)throw new Error('姿势集正在同步');
    this.syncing=true;
    this.store.put('poseFeed',{...(this.feed()||{}),id:POSE_SOURCE.id,lastError:null});
    try{
      const html=await this.read(POSE_SOURCE.url);
      if(this.closing)throw new Error('工作台正在关闭');
      const {lines,rows}=parsePosePage(html);
      const zhLines=lines.map(l=>seriesZh[l]||l);
      const items=rows.map((row,index)=>normalizePose(row,index));
      const incoming=new Set(items.map(i=>i.id));
      const existing=new Set(this.store.db.prepare("SELECT id FROM records WHERE kind='poseRefs'").all().map(r=>r.id));
      let added=0,removed=0,updated=0;
      const categories=[...new Set(items.map(i=>i.category))].sort();
      const previous=this.feed()||{},now=new Date().toISOString();
      this.store.db.exec('BEGIN IMMEDIATE');
      try{
        for(const item of items){
          const old=this.store.get('poseRefs',item.id);
          if(!old)added++;
          else if(old.order!==item.order||old.poseName!==item.poseName||old.category!==item.category||old.angle!==item.angle||old.series!==item.series)updated++;
          this.store.put('poseRefs',{...item,firstSyncedAt:old?.firstSyncedAt||now,lastSyncedAt:now});
        }
        for(const id of existing)if(!incoming.has(id)){this.store.remove('poseRefs',id);removed++;}
        const feed=this.store.put('poseFeed',{...previous,id:POSE_SOURCE.id,lastSync:now,lastAdded:added,lastRemoved:removed,lastUpdated:updated,total:items.length,count:items.length,lines:zhLines,categories,lastError:null});
        this.store.db.exec('COMMIT');
        return {added,removed,updated,total:items.length,count:items.length,lines:zhLines,categories,lastSync:feed.lastSync,unchanged:items.length-added-updated};
      }catch(e){this.store.db.exec('ROLLBACK');throw e;}
    }catch(e){
      const message='同步失败，保留已有目录：'+String(e.message).slice(0,200);
      if(!this.closing)this.store.put('poseFeed',{...(this.feed()||{}),id:POSE_SOURCE.id,lastError:message});
      throw new Error(message);
    }finally{this.syncing=false;}
  }
  // 系列/分类/视角筛选与分页；group=pose 按姿势聚合，group=angle 逐张。
  list({series='',category='',angle='',query='',group='pose',offset=0,limit=60}={}){
    limit=Math.min(120,Math.max(1,Math.floor(Number(limit)||60)));offset=Math.max(0,Math.floor(Number(offset)||0));
    if(!['pose','angle'].includes(group))throw new Error('浏览方式无效');
    const where="kind='poseRefs'"
      +(series?" AND json_extract(body,'$.series')='"+escape(series)+"'":'')
      +(category?" AND json_extract(body,'$.category')='"+escape(category)+"'":'')
      +(angle?" AND json_extract(body,'$.angle')='"+escape(angle)+"'":'')
      +(query?" AND instr(lower(json_extract(body,'$.poseName')||' '||json_extract(body,'$.poseNo')||' '||json_extract(body,'$.category')),lower('"+escape(String(query).slice(0,120))+"'))>0":'');
    if(group==='angle'){
      const total=this.store.db.prepare(`SELECT count(*) AS n FROM records WHERE ${where}`).get().n;
      const items=this.store.db.prepare(`SELECT body FROM records WHERE ${where} ORDER BY json_extract(body,'$.order') LIMIT ? OFFSET ?`).all(limit,offset).map(r=>JSON.parse(r.body));
      return {items,total,offset,limit,group};
    }
    const total=this.store.db.prepare(`SELECT count(DISTINCT json_extract(body,'$.poseKey')) AS n FROM records WHERE ${where}`).get().n;
    const rows=this.store.db.prepare(`SELECT json_extract(body,'$.poseKey') AS poseKey,min(json_extract(body,'$.order')) AS firstOrder,
      json_group_array(json_object('id',id,'angle',json_extract(body,'$.angle'),'thumbUrl',json_extract(body,'$.thumbUrl'),'fullUrl',json_extract(body,'$.fullUrl'),'order',json_extract(body,'$.order'))) AS angles
      FROM records WHERE ${where} GROUP BY poseKey ORDER BY firstOrder LIMIT ? OFFSET ?`).all(limit,offset);
    const items=rows.map(r=>{
      const angles=JSON.parse(r.angles).sort((a,b)=>a.order-b.order);
      const cover=angles.find(a=>a.angle==='正面')||angles[0];
      const meta=this.store.get('poseRefs',cover.id)||{};
      return {poseKey:r.poseKey,poseNo:meta.poseNo||'',poseName:meta.poseName||'',series:meta.series||'',category:meta.category||'',order:r.firstOrder,coverId:cover.id,coverUrl:cover.thumbUrl,fullUrl:cover.fullUrl,angles:angles.map(a=>({id:a.id,angle:a.angle,thumbUrl:a.thumbUrl,fullUrl:a.fullUrl}))};
    });
    return {items,total,offset,limit,group};
  }
  detail(id){
    if(typeof id!=='string'||!id)throw new Error('请选择姿势');
    const item=this.store.get('poseRefs',id);
    if(!item)throw new Error('姿势不存在，请先同步');
    const siblings=this.store.db.prepare("SELECT body FROM records WHERE kind='poseRefs' AND json_extract(body,'$.poseKey')=? ORDER BY json_extract(body,'$.order')").all(item.poseKey).map(r=>JSON.parse(r.body));
    return {...item,angles:siblings.map(s=>({id:s.id,angle:s.angle,thumbUrl:s.thumbUrl,fullUrl:s.fullUrl}))};
  }
  // 缩略图与按需原图都走既有图片缓存（含容量上限、LRU、单张 8MB 保护）。
  async image(id,{full=false}={}){
    if(!this.imageCache)throw new Error('图片缓存不可用');
    const item=this.store.get('poseRefs',String(id||''));
    if(!item)throw new Error('姿势不存在，请先同步');
    return this.imageCache.get(full?item.fullUrl:item.thumbUrl);
  }
  close(){this.closing=true;this.abort.abort();}
}
