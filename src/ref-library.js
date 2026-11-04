// AI 参考素材（脸库 / 服装库）只读来源：直接对接作者源站，不依赖任何 GitHub 中转仓库。
// 数据源：ai-portrait-gallery.pages.dev（脸库，CC0）与 ai-costume-gallery.pages.dev（服装库）。
// 许可口径：脸库 CC0 可自由使用；服装库制作者允许免费用于创作参考（含商用），但禁止再分发图片本体。
// 本模块只解析元数据（分类 / 标签 / 图片相对路径）并存入 SQLite 记录；缩略图与原图一律经既有
// ImageCache 按需下载并持久缓存在本机磁盘，但缓存不进业务 JSON 备份，也不随公开副本分发；仅在用户选择后发起生成时，所选参考图会发送至所选模型服务。

const ORIGINS={
  face:'https://ai-portrait-gallery.pages.dev/',
  costume:'https://ai-costume-gallery.pages.dev/'
};
const MAX_HTML=32e6, MAX_JS=32e6;

// 三库统一的中文界面标签来源（与原站日文/英文对应）。未收录的新词回退原文，不影响同步。
const FACE_SECTION_ZH={face:'脸部特写',styling:'造型'};
const FACE_HAIR_ZH={
  'ショート':'短发','ミディアム':'中发','セミロング':'中长发','ロング':'长发'
};
const COSTUME_CAT_ZH={
  '春':'春','夏':'夏','秋':'秋','冬':'冬',
  'ランジェリー':'内衣','パーティ':'派对','水着':'泳装','セクシー':'性感'
};

export const REF_LIBRARIES={
  face:{
    id:'face',name:'脸库',unit:'张',
    url:ORIGINS.face,author:'あぎ',authorUrl:'https://x.com/agi_aibusi',
    license:'CC0 1.0 · 放弃著作权，可自由使用',
    notice:'AI 生成架空人物，非真人；正面向脸特写与造型参考。图片仅供本机个人参考，不随备份或公开副本分发。'
  },
  costume:{
    id:'costume',name:'服装库',unit:'套',
    url:ORIGINS.costume,author:'ギア',authorUrl:'https://x.com/giaaibusi',
    license:'免费用于创作参考（含商用）· 禁止再分发图片本体',
    notice:'无人物、只有服装的参考图。制作者做过品牌相似度检查但不保证不侵权，商用前请自行判断。图片仅供本机个人参考。'
  }
};

function scanLiteral(text,start){
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

// 服装库：首页内嵌 const META={...} 与 const D=[...]。
export function parseCostumePage(html){
  if(typeof html!=='string'||!html)throw new Error('服装库页面为空');
  if(html.length>MAX_HTML)throw new Error('服装库页面超过 32MB');
  const metaMatch=html.match(/const META=(\{[\s\S]{0,3000}?\});/);
  if(!metaMatch)throw new Error('服装库页面结构已变化：找不到 META');
  let meta;
  try{meta=JSON.parse(metaMatch[1]);}catch{throw new Error('服装库 META 不是有效 JSON');}
  if(!meta||!Array.isArray(meta.cats)||!meta.cats.length||meta.cats.length>50||meta.cats.some(v=>typeof v!=='string'||!v||v.length>40))throw new Error('服装库分类列表无效');
  const at=html.indexOf('const D=');
  if(at<0)throw new Error('服装库页面结构已变化：找不到数据数组');
  const start=html.indexOf('[',at);
  if(start<0)throw new Error('服装库数据数组格式无效');
  const slice=scanLiteral(html,start);
  if(!slice)throw new Error('服装库数据数组未闭合');
  let rows;
  try{rows=JSON.parse(slice);}catch{throw new Error('服装库数据不是有效 JSON');}
  if(!Array.isArray(rows)||rows.length<50||rows.length>20000)throw new Error('服装库条目数量异常');
  const seen=new Set();
  for(const row of rows){
    if(!row||typeof row!=='object'||Array.isArray(row))throw new Error('服装库存在无效条目');
    for(const field of ['id','カテゴリ','キーワード','サムネ','画像','原寸'])if(typeof row[field]!=='string'||!row[field]||row[field].length>400)throw new Error('服装库条目的'+field+'字段无效');
    if(!meta.cats.includes(row['カテゴリ']))throw new Error('服装库条目分类不在分类列表内');
    if(seen.has(row.id))throw new Error('服装库存在重复编号');
    seen.add(row.id);
  }
  return {cats:meta.cats,rows};
}

// 脸库：首页经 <script src="data/images.js"> 加载 window.GALLERY_IMAGES=[...]。
export function parseFaceImages(js){
  if(typeof js!=='string'||!js)throw new Error('脸库数据为空');
  if(js.length>MAX_JS)throw new Error('脸库数据超过 32MB');
  const at=js.indexOf('window.GALLERY_IMAGES');
  if(at<0)throw new Error('脸库数据结构已变化：找不到 GALLERY_IMAGES');
  const start=js.indexOf('[',at);
  if(start<0)throw new Error('脸库数据数组格式无效');
  const slice=scanLiteral(js,start);
  if(!slice)throw new Error('脸库数据数组未闭合');
  let rows;
  try{rows=JSON.parse(slice);}catch{throw new Error('脸库数据不是有效 JSON');}
  if(!Array.isArray(rows)||rows.length<50||rows.length>20000)throw new Error('脸库条目数量异常');
  const seen=new Set();
  for(const row of rows){
    if(!row||typeof row!=='object'||Array.isArray(row))throw new Error('脸库存在无效条目');
    if(typeof row.id!=='string'||!row.id||row.id.length>40)throw new Error('脸库条目的 id 无效');
    if(typeof row.full!=='string'||!row.full||row.full.length>200||typeof row.thumb!=='string'||!row.thumb||row.thumb.length>200)throw new Error('脸库条目图片路径无效');
    if(row.section!=='face'&&row.section!=='styling')throw new Error('脸库条目 section 无效');
    if(seen.has(row.id))throw new Error('脸库存在重复编号');
    seen.add(row.id);
  }
  return rows;
}

function hairZh(raw){return FACE_HAIR_ZH[raw]||raw||'';}
function faceStyleZh(raw){return raw?raw.replace(/（/g,'(').replace(/）/g,')'):'';}

export class RefLibrary{
  constructor(store,{fetcher=fetch,imageCache}={}){
    this.store=store;this.fetcher=fetcher;this.imageCache=imageCache;
    this.syncing=new Set();this.abort=new AbortController();this.closing=false;
  }
  lib(id){
    const lib=REF_LIBRARIES[id];
    if(!lib)throw new Error('参考素材库不存在');
    return lib;
  }
  feed(id){return this.store.get('refFeed',id)||null;}
  async read(url,{max=MAX_HTML,type='text/html'}={}){
    const r=await this.fetcher(url,{redirect:'error',signal:AbortSignal.any([this.abort.signal,AbortSignal.timeout(30000)]),headers:{Accept:type}});
    if(!r.ok)throw new Error('参考素材源 HTTP '+r.status);
    if(Number(r.headers.get('content-length'))>max)throw new Error('参考素材源超过大小限制');
    let size=0,text='';const decoder=new TextDecoder();
    for await(const chunk of r.body){size+=chunk.length;if(size>max)throw new Error('参考素材源超过大小限制');text+=decoder.decode(chunk,{stream:true});}
    return text+decoder.decode();
  }
  status(id){
    const feed=this.feed(id);
    const count=this.store.db.prepare("SELECT count(*) AS n FROM records WHERE kind='refItems' AND json_extract(body,'$.lib')=?").get(id).n;
    return {lib:this.lib(id),count,syncing:this.syncing.has(id),lastSync:feed?.lastSync||null,lastAdded:feed?.lastAdded||0,lastRemoved:feed?.lastRemoved||0,total:feed?.total??null,lastError:feed?.lastError||null,groups:feed?.groups||[]};
  }
  async sync(id){
    if(this.closing)throw new Error('工作台正在关闭');
    this.lib(id);
    if(this.syncing.has(id))throw new Error('该参考素材库正在同步');
    this.syncing.add(id);
    this.store.put('refFeed',{...(this.feed(id)||{}),id,lastError:null});
    try{
      let items,groups;
      if(id==='face'){
        const js=await this.read(ORIGINS.face+'data/images.js',{max:MAX_JS,type:'text/javascript'});
        if(this.closing)throw new Error('工作台正在关闭');
        const rows=parseFaceImages(js);
        groups=[...new Set(rows.map(r=>FACE_SECTION_ZH[r.section]||r.section))];
        items=rows.map((row,index)=>({
          id:'face-'+row.id,lib:'face',originId:row.id,section:FACE_SECTION_ZH[row.section]||row.section,
          hair:hairZh(row.hair),style:faceStyleZh(row.style||''),
          thumbUrl:ORIGINS.face+row.thumb,fullUrl:ORIGINS.face+row.full,
          width:Number(row.w)||0,height:Number(row.h)||0,bytes:Number(row.bytes)||0,order:index
        }));
      }else{
        const html=await this.read(ORIGINS.costume);
        if(this.closing)throw new Error('工作台正在关闭');
        const {cats,rows}=parseCostumePage(html);
        groups=cats.map(c=>COSTUME_CAT_ZH[c]||c);
        items=rows.map((row,index)=>({
          id:'costume-'+row.id,lib:'costume',originId:row.id,category:COSTUME_CAT_ZH[row['カテゴリ']]||row['カテゴリ'],
          keywordsZh:row['キーワード'],thumbUrl:ORIGINS.costume+row['サムネ'],fullUrl:ORIGINS.costume+row['原寸'],order:index
        }));
      }
      const incoming=new Set(items.map(i=>i.id));
      const existing=new Set(this.store.db.prepare("SELECT id FROM records WHERE kind='refItems' AND json_extract(body,'$.lib')=?").all(id).map(r=>r.id));
      let added=0,removed=0,updated=0;const now=new Date().toISOString();
      this.store.db.exec('BEGIN IMMEDIATE');
      try{
        for(const item of items){
          const old=this.store.get('refItems',item.id);
          if(!old)added++;
          else if(old.order!==item.order||(id==='face'&&(old.hair!==item.hair||old.style!==item.style||old.section!==item.section))||(id==='costume'&&(old.category!==item.category||old.keywordsZh!==item.keywordsZh)))updated++;
          this.store.put('refItems',{...item,firstSyncedAt:old?.firstSyncedAt||now,lastSyncedAt:now});
        }
        for(const oid of existing)if(!incoming.has(oid)){this.store.remove('refItems',oid);removed++;}
        const feed=this.store.put('refFeed',{...(this.feed(id)||{}),id,lastSync:now,lastAdded:added,lastRemoved:removed,lastUpdated:updated,total:items.length,count:items.length,groups,lastError:null});
        this.store.db.exec('COMMIT');
        return {added,removed,updated,total:items.length,groups,lastSync:feed.lastSync};
      }catch(e){this.store.db.exec('ROLLBACK');throw e;}
    }catch(e){
      const message='同步失败，保留已有目录：'+String(e.message).slice(0,200);
      if(!this.closing)this.store.put('refFeed',{...(this.feed(id)||{}),id,lastError:message});
      throw new Error(message);
    }finally{this.syncing.delete(id);}
  }
  list({id,group='',query='',offset=0,limit=60}={}){
    this.lib(id);
    limit=Math.min(120,Math.max(1,Math.floor(Number(limit)||60)));offset=Math.max(0,Math.floor(Number(offset)||0));
    const field=id==='face'?'section':'category';
    const where="kind='refItems' AND json_extract(body,'$.lib')='"+id+"'"
      +(group?" AND json_extract(body,'$."+field+"')='"+group.replace(/'/g,"''")+"'":'')
      +(query?" AND instr(lower(coalesce(json_extract(body,'$.style'),'')||' '||coalesce(json_extract(body,'$.hair'),'')||' '||coalesce(json_extract(body,'$.keywordsZh'),'')||' '||coalesce(json_extract(body,'$.category'),'')||' '||coalesce(json_extract(body,'$.section'),'')||' '||coalesce(json_extract(body,'$.originId'),'')),lower('"+String(query).slice(0,120).replace(/'/g,"''")+"'))>0":'');
    const total=this.store.db.prepare(`SELECT count(*) AS n FROM records WHERE ${where}`).get().n;
    const items=this.store.db.prepare(`SELECT json_remove(body,'$.fullUrl') AS body FROM records WHERE ${where} ORDER BY json_extract(body,'$.order') LIMIT ? OFFSET ?`).all(limit,offset).map(r=>JSON.parse(r.body));
    return {items,total,offset,limit,groups:this.feed(id)?.groups||[]};
  }
  detail(id){
    if(typeof id!=='string'||!id)throw new Error('请选择参考图');
    const item=this.store.get('refItems',id);
    if(!item)throw new Error('参考图不存在，请先同步');
    return item;
  }
  async image(id,{full=false}={}){
    if(!this.imageCache)throw new Error('图片缓存不可用');
    const item=this.store.get('refItems',String(id||''));
    if(!item)throw new Error('参考图不存在，请先同步');
    return this.imageCache.get(full?item.fullUrl:item.thumbUrl);
  }
  close(){this.closing=true;this.abort.abort();}
}
