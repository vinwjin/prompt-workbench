import {createHash} from 'node:crypto';
import {EXTRA_FEEDS} from './source-catalog.js';

export const PURPOSES={
  '建筑与室内':/建筑|室内|酒店|大堂|客厅|卧室|architecture|interior|hotel|lobby|living room/i,
  '产品展示':/产品|商品|包装|product|packaging/i,
  '人物肖像':/肖像|人像|portrait|headshot/i,
  '电商广告':/电商|广告|advertis|e-commerce/i,
  '海报设计':/海报|poster/i,
  '角色设定':/角色设定|角色设计|character design|character sheet/i,
  '视频叙事':/分镜|叙事|storyboard|narrative/i,
  '图像编辑':/图像编辑|替换背景|去除背景|image edit|replace.{0,10}background|remove.{0,10}background/i
};
export const STYLES={
  '写实摄影':/写实|摄影|photorealis|photograph/i,
  '电影感':/电影感|电影质感|cinematic/i,
  '极简':/极简|minimalis/i,
  '插画':/插画|illustration/i,
  '动漫':/动漫|二次元|anime|manga/i,
  '3D':/\b3d\b|三维渲染/i,
  '复古':/复古|vintage|retro/i,
  '水彩':/水彩|watercolou?r/i
};
const MODELS=[['Midjourney',/\bmidjourney\b/i],['SDXL',/\bsdxl\b|stable diffusion xl/i],['Stable Diffusion',/\bstable diffusion\b(?! xl)/i],['FLUX',/\bflux(?:[. -][12])?\b/i],['GPT Image',/\bgpt[- ]image\b/i],['GPT-4o',/\bgpt[- ]?4o\b/i],['Qwen Image',/\bqwen[- ]image\b/i],['Kling',/\bkling\b|可灵/i],['Seedance',/\bseedance\b|即梦/i],['Sora',/\bsora\b/i],['Veo',/\bveo\b/i]];
export const UNKNOWN='__unknown__';
export const metadataText=row=>[row.title,row.content,row.modelHint,row.tags].filter(v=>typeof v==='string').join('\n');
export const metadataHash=row=>createHash('sha256').update(metadataText(row)).digest('hex');
export function day(value){
  if(value===null||value===undefined||value==='')return null;
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))?$/.test(value)||!Number.isFinite(Date.parse(value)))throw Error('日期格式无效');
  const d=value.slice(0,10);if(new Date(d+'T00:00:00Z').toISOString().slice(0,10)!==d)throw Error('日期无效');return d;
}
export function labels(value){if(!Array.isArray(value)||value.length>20||value.some(v=>typeof v!=='string'||!v.trim()||v.length>80||v===UNKNOWN))throw Error('标签需为最多20个、每项不超过80字的文字');return [...new Set(value.map(v=>v.trim()))];}
export function validateNote(note){
  if(!note||!note.overrides||Array.isArray(note.overrides)||typeof note.overrides!=='object')throw Error('筛选修正格式无效');
  const fields=['models','purposes','styles','author','publishedAt'];
  if(Object.keys(note.overrides).some(k=>!fields.includes(k)))throw Error('未知的筛选修正字段');
  for(const key of ['models','purposes','styles'])if(Object.hasOwn(note.overrides,key))labels(note.overrides[key]);
  if(Object.hasOwn(note.overrides,'author')&&(typeof note.overrides.author!=='string'||note.overrides.author.length>120))throw Error('作者名称超过120字或格式无效');
  if(Object.hasOwn(note.overrides,'publishedAt'))day(note.overrides.publishedAt);
}
export function metadata(row,note){
  const text=metadataText(row),evidence=[];
  const extract=(rules,field)=>Object.entries(rules).flatMap(([value,re])=>{const m=re.exec(text);if(!m||/(?:不要|避免|非|without|\bno|\bnot)\s*$/i.test(text.slice(Math.max(0,m.index-12),m.index)))return [];evidence.push({field,value,origin:'rule',quote:text.slice(Math.max(0,m.index-30),m.index+m[0].length+50)});return [value];});
  const models=String(row.modelHint||'').split(/[,，;；\n|/]+/).map(v=>v.split('·')[0].trim().slice(0,80)).filter(v=>v&&!/见出处|见原文|未标|待核|适用模型|文字模板|原案例模型/.test(v)).slice(0,20);
  for(const [value,re] of MODELS){const m=re.exec(text);if(m){if(!models.some(v=>v.toLowerCase().includes(value.toLowerCase())))models.push(value);evidence.push({field:'models',value,origin:row.modelHint?.includes(m[0])?'source':'rule',quote:m[0]});}}
  const author=EXTRA_FEEDS.some(f=>f.id===row.sourceId&&f.name===row.author)||/^(?:社区作者|原站作者|用户导入 · 原作者待核对)$/.test(row.author||'')?'':row.author||'';
  const result={models:[...new Set(models)].slice(0,20),purposes:extract(PURPOSES,'purposes'),styles:extract(STYLES,'styles'),author,publishedAt:null,collectedAt:null,evidence};
  try{result.publishedAt=day(row.publishedAt);}catch{}
  try{result.collectedAt=day(row.firstSyncedAt);}catch{}
  if(note){validateNote(note);for(const [key,value] of Object.entries(note.overrides))result[key]=key==='publishedAt'?day(value):value;result.manualFields=Object.keys(note.overrides);}
  return result;
}
export function projectMetadata(store,row){
  const note=store.get('galleryNotes',row.id),m=metadata(row,note);
  store.db.prepare('INSERT INTO gallery_search(id,models,purposes,styles,author,published,collected,stamp,collectedOrder) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET models=excluded.models,purposes=excluded.purposes,styles=excluded.styles,author=excluded.author,published=excluded.published,collected=excluded.collected,stamp=excluded.stamp,collectedOrder=excluded.collectedOrder').run(row.id,JSON.stringify(m.models),JSON.stringify(m.purposes),JSON.stringify(m.styles),m.author,m.publishedAt,m.collectedAt,(row.updatedAt||'')+(note?.updatedAt||'')+'|v2',row.firstSyncedAt||null);
}
export function initMetadata(store){
  store.db.exec("CREATE TABLE IF NOT EXISTS gallery_search(id TEXT PRIMARY KEY,models TEXT NOT NULL,purposes TEXT NOT NULL,styles TEXT NOT NULL,author TEXT NOT NULL,published TEXT,collected TEXT,stamp TEXT NOT NULL,collectedOrder TEXT); CREATE INDEX IF NOT EXISTS gallery_search_published ON gallery_search(published,id); CREATE TRIGGER IF NOT EXISTS gallery_search_delete AFTER DELETE ON records WHEN OLD.kind='shared' BEGIN DELETE FROM gallery_search WHERE id=OLD.id; END;");
  if(!store.db.prepare('PRAGMA table_info(gallery_search)').all().some(r=>r.name==='collectedOrder'))store.db.exec('ALTER TABLE gallery_search ADD COLUMN collectedOrder TEXT');
  store.db.exec('CREATE INDEX IF NOT EXISTS gallery_search_collected ON gallery_search(collectedOrder DESC,id)');
  // Derived data only: stream records; never retain the entire public corpus in memory.
  store.db.exec('SAVEPOINT gallery_rebuild');try{for(const {body} of store.db.prepare("SELECT r.body FROM records r LEFT JOIN gallery_search g ON g.id=r.id LEFT JOIN records n ON n.kind='galleryNotes' AND n.id=r.id WHERE r.kind='shared' AND (g.id IS NULL OR g.stamp<>r.updated||coalesce(n.updated,'')||'|v2')").iterate())projectMetadata(store,JSON.parse(body));store.db.exec('RELEASE gallery_rebuild');}catch(e){store.db.exec('ROLLBACK TO gallery_rebuild; RELEASE gallery_rebuild');throw e;}
  store.db.exec("DELETE FROM gallery_search WHERE id NOT IN (SELECT id FROM records WHERE kind='shared')");
}
