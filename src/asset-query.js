// SQL owns filtering and the bounded page. Only small facets/title keys are read globally.
const caches=new WeakMap();
function setup(store){
  if(caches.has(store))return caches.get(store);
  const cache={revision:-1,ranks:new Map()};caches.set(store,cache);
  store.db.function('pw_asset_tags',{deterministic:true},raw=>JSON.stringify(String(raw||'').split(/[,，;；\n]/).map(t=>t.trim()).filter(Boolean)));
  store.db.function('pw_asset_title_rank',{deterministic:true},id=>cache.ranks.get(id)??0);
  store.db.exec("CREATE INDEX IF NOT EXISTS records_asset_state ON records(json_extract(body,'$.deletedAt'),updated DESC,id) WHERE kind='assets'; CREATE INDEX IF NOT EXISTS records_asset_source ON records(json_extract(body,'$.source.sourceId'),CAST(json_extract(body,'$.source.originId') AS TEXT)) WHERE kind='assets';");
  return cache;
}
export function assetMeta(store){
  setup(store);const db=store.db;
  const counts=db.prepare("SELECT sum(json_extract(body,'$.deletedAt') IS NULL) AS total,sum(json_extract(body,'$.deletedAt') IS NULL AND json_extract(body,'$.favorite')=1) AS favorite FROM records WHERE kind='assets'").get();
  const folders=Object.fromEntries(db.prepare("SELECT coalesce(json_extract(body,'$.folderId'),'') AS id,sum(json_extract(body,'$.deletedAt') IS NULL) AS active,sum(json_extract(body,'$.deletedAt') IS NOT NULL) AS trash,sum(json_extract(body,'$.deletedAt') IS NULL AND json_extract(body,'$.favorite')=1) AS favorite FROM records WHERE kind='assets' GROUP BY id").all().map(r=>[r.id,{active:r.active,trash:r.trash,favorite:r.favorite}]));
  const tags=db.prepare("SELECT DISTINCT t.value AS tag FROM records r,json_each(pw_asset_tags(json_extract(r.body,'$.tags'))) t WHERE r.kind='assets' ORDER BY tag").all().map(r=>r.tag);
  const categories=db.prepare("SELECT DISTINCT coalesce(json_extract(body,'$.category'),'未分类') AS category FROM records WHERE kind='assets' ORDER BY category").all().map(r=>r.category);
  return {total:counts.total||0,favorite:counts.favorite||0,folders,tags,categories};
}
export function assetPage(store,{query='',scope='all',folder='',category='',tag='',sort='updated',offset=0,limit=50}={}){
  const cache=setup(store),db=store.db;
  if(!['all','favorite','trash'].includes(scope)||!['updated','favorite','title'].includes(sort))throw Error('资产筛选或排序无效');
  limit=Math.min(100,Math.max(1,Math.floor(Number(limit)||50)));offset=Math.max(0,Math.floor(Number(offset)||0));
  let where="kind='assets' AND json_extract(body,'$.deletedAt') IS "+(scope==='trash'?'NOT ':'')+'NULL';const args=[];
  if(scope==='favorite')where+=" AND json_extract(body,'$.favorite')=1";
  if(folder){where+=" AND coalesce(json_extract(body,'$.folderId'),'')=?";args.push(folder==='unfiled'?'':folder);}
  if(category){where+=" AND json_extract(body,'$.category')=?";args.push(category);}
  if(tag){where+=" AND EXISTS(SELECT 1 FROM json_each(pw_asset_tags(json_extract(body,'$.tags'))) WHERE value=?)";args.push(tag);}
  if(query){where+=" AND instr(pw_lower(coalesce(json_extract(body,'$.title'),'')||' '||coalesce(json_extract(body,'$.content'),'')||' '||coalesce(json_extract(body,'$.negative'),'')||' '||coalesce(json_extract(body,'$.category'),'')||' '||coalesce(json_extract(body,'$.tags'),'')||' '||coalesce(json_extract(body,'$.modelHint'),'')),pw_lower(?))>0";args.push(String(query).slice(0,500));}
  // SQLite has no built-in zh-CN collation. Cache title-only ranks to preserve the previous ordering.
  if(sort==='title'&&cache.revision!==store.kindRevision('assets')){
    const titles=db.prepare("SELECT id,coalesce(json_extract(body,'$.title'),'') AS title FROM records WHERE kind='assets' ORDER BY updated DESC,id").all();
    titles.sort((a,b)=>a.title.localeCompare(b.title,'zh-CN'));cache.ranks=new Map(titles.map((a,n)=>[a.id,n]));cache.revision=store.kindRevision('assets');
  }
  const order=sort==='title'?'pw_asset_title_rank(id),id':sort==='favorite'?"coalesce(json_extract(body,'$.favorite'),0) DESC,updated DESC,id":'updated DESC,id';
  const total=db.prepare('SELECT count(*) AS total FROM records WHERE '+where).get(...args).total;
  const fields=['title','category','tags','modelHint','folderId','favorite','deletedAt','source','media','resultJobId','createdAt'];
  const projection="json_object('id',id,'updatedAt',updated,'excerpt',substr(coalesce(json_extract(body,'$.content'),''),1,240),'versionsCount',coalesce(json_array_length(body,'$.versions'),0),'resultRecord',json_extract(body,'$.resultRecord') IS NOT NULL,'collectionMedia',json_object('videoUrl',json_extract(body,'$.collectionMedia.videoUrl'),'failures',json_extract(body,'$.collectionMedia.failures')),"+fields.map(k=>`'${k}',json_extract(body,'$.${k}')`).join(',')+')';
  const items=db.prepare(`SELECT ${projection} AS body FROM records WHERE ${where} ORDER BY ${order} LIMIT ? OFFSET ?`).all(...args,limit,offset).map(r=>JSON.parse(r.body));
  return {items,total,offset,limit};
}
export function assetCollectionStatus(store,ids){
  // A gallery segment has 200 cards; its independent detail dialog may add one more ID.
  setup(store);if(ids.length>201||ids.some(id=>!id||id.length>200))throw Error('收藏查询范围无效');
  const query=store.db.prepare("SELECT a.id,json_extract(a.body,'$.deletedAt') AS deletedAt FROM records a JOIN records s ON s.kind='shared' AND s.id=? WHERE a.kind='assets' AND json_extract(a.body,'$.source.sourceId')=json_extract(s.body,'$.sourceId') AND CAST(json_extract(a.body,'$.source.originId') AS TEXT)=CAST(json_extract(s.body,'$.originId') AS TEXT) ORDER BY a.updated DESC LIMIT 1");
  return Object.fromEntries([...new Set(ids)].map(id=>[id,query.get(id)||null]));
}
