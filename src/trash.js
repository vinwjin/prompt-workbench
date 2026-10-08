const KINDS=['assets','jobs','templates','inbox','snippets'];
const ACTIVE=new Set(['queued','running','cancelling']);
export function trashItems(store){return KINDS.flatMap(kind=>store.list(kind).filter(r=>r.deletedAt).map(r=>({kind,id:r.id,title:r.title||r.name||r.input?.slice(0,100)||r.url||'未命名',deletedAt:r.deletedAt}))).sort((a,b)=>b.deletedAt.localeCompare(a.deletedAt));}
export function manageTrash(store,{kind,ids,action,confirmation}){
  if(!KINDS.includes(kind)||!Array.isArray(ids)||!ids.length||ids.length>1000||ids.some(id=>typeof id!=='string')||!['restore','purge'].includes(action))throw Error('回收站操作无效');
  if(action==='purge'&&confirmation!=='永久删除')throw Error('永久删除需要明确确认');
  const rows=[...new Set(ids)].map(id=>store.get(kind,id));
  if(rows.some(r=>!r||!r.deletedAt||kind==='jobs'&&ACTIVE.has(r.status)))throw Error('只能处理回收站中的已结束记录，请刷新后重试');
  store.backup();store.db.exec('BEGIN IMMEDIATE');try{
    for(const row of rows)action==='purge'?store.remove(kind,row.id):store.put(kind,{...row,deletedAt:null});
    if(kind==='assets'&&action==='purge'){const purged=new Set(rows.map(r=>r.id));for(const item of store.list('inbox'))if(purged.has(item.assetId))store.put('inbox',{...item,assetId:null,status:'pending',selectedPostId:null});}
    store.db.exec('COMMIT');
  }catch(e){store.db.exec('ROLLBACK');throw e;}
  return {changed:rows.length,action};
}
