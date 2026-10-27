import {randomUUID} from 'node:crypto';
export function authorHandle(value){const author=String(value||'').trim().replace(/^@/,'');if(!/^[A-Za-z0-9_]{1,15}$/.test(author))throw Error('请输入X作者名，例如 @CyberTotal2026');return author.toLowerCase();}
const terminal=b=>!b||!['running','cancelling'].includes(b.status);
export function validateAuthorState(s){
  const cursor=v=>v===null||typeof v==='string'&&v.length>0&&v.length<=2000;
  if(s.id!==authorHandle(s.id)||s.author!==s.id||!cursor(s.cursor)||s.watermark!==null&&!Number.isFinite(Date.parse(s.watermark))||s.recentCursors!==undefined&&(!Array.isArray(s.recentCursors)||s.recentCursors.length>100||s.recentCursors.some(c=>!cursor(c))))throw Error('作者断点备份无效');
  const p=s.pending;if(p){if(!['updates','older'].includes(p.mode)||typeof p.previewId!=='string'||!cursor(p.nextCursor)||!Number.isFinite(Date.parse(p.watermark))||!Array.isArray(p.urls)||p.urls.length>100||p.urls.some(u=>typeof u!=='string'||!new RegExp('^https://x\\.com/'+s.id+'/status/\\d{10,25}$').test(u))||!Array.isArray(p.cards)||p.cards.length>100||p.cards.some(c=>!c||typeof c.excerpt!=='string'||c.excerpt.length>160||!p.urls.includes(c.url))||p.batchId!==null&&typeof p.batchId!=='string')throw Error('作者预览备份无效');}return s;
}
export class XTimeline{
  constructor(store,queue,{fetcher=fetch}={}){this.store=store;this.queue=queue;this.fetcher=fetcher;this.busy=false;}
  state(value){const id=authorHandle(value);let s=this.store.get('inboxAuthors',id)||{id,author:id,watermark:null,cursor:null,exhausted:false};const p=s.pending;
    const batch=p?.batchId?this.queue.status(p.batchId):null;
    if(p?.batchId&&batch?.status==='completed'&&batch.items.every(i=>i.status==='succeeded')&&p.urls.every(url=>this.store.get('inbox',url.split('/').at(-1))))s=this.commit(s,p);return {...s,batchStatus:s.pending?.batchId?this.queue.status(s.pending.batchId)?.status:null};
  }
  commit(s,p){return this.store.put('inboxAuthors',{...s,watermark:p.watermark||s.watermark,cursor:p.nextCursor,recentCursors:[...new Set([...(s.recentCursors||[]),...(p.nextCursor?[p.nextCursor]:[])])].slice(-100),exhausted:!p.nextCursor,pending:null});}
  bindRetry(oldId,newId){for(const s of this.store.list('inboxAuthors'))if(s.pending?.batchId===oldId)this.store.put('inboxAuthors',{...s,pending:{...s.pending,batchId:newId}});}
  idle(){if(this.busy||this.queue.active||this.queue.closing||this.queue.inbox.busy.size)throw Error('采集正在进行，请先停止或等待本批完成');}
  async preview({author,mode='updates'}){this.idle();if(!['updates','older'].includes(mode))throw Error('采集方向无效');const s=this.state(author);if(s.pending?.batchId)throw Error('本页尚未完成，请继续失败/中断项或放弃本页');if(mode==='older'&&!s.cursor)throw Error(s.exhausted?'当前来源没有更多页':'请先完成最新一页，再读取更早内容');this.busy=true;
    try{const url=new URL('https://api.fxtwitter.com/2/profile/'+s.id+'/statuses');url.searchParams.set('count','20');if(mode==='older')url.searchParams.set('cursor',s.cursor);
      const t=performance.now(),r=await this.fetcher(url.href,{redirect:'error',signal:AbortSignal.timeout(15000)});if(r.status===204)throw Error('来源未返回正文，本次不推进断点');if(!r.ok)throw Error('公开作者读取失败（HTTP '+r.status+'），没有推进断点');let bytes=0,text='';const decoder=new TextDecoder();for await(const c of r.body){bytes+=c.length;if(bytes>2e6)throw Error('作者响应超过2MB，本次未采集');text+=decoder.decode(c,{stream:true});}const d=JSON.parse(text+decoder.decode());if(d.code!==200||!Array.isArray(d.results)||!d.results.length||d.results.length>100)throw Error('作者分页为空或超过100条，本次不推进断点');
      const urls=[],cards=[],seen=new Set();let skipped=0,top=s.watermark?Date.parse(s.watermark):0;for(const p of d.results){const id=String(p.id||''),handle=p.author?.screen_name;if(p.type!=='status'||!/^\d{10,25}$/.test(id)||typeof p.text!=='string'||!p.text.trim()||typeof handle!=='string'||handle.toLowerCase()!==s.id)throw Error('作者页含不可确认或转发内容，本次不推进断点');const time=Number.isFinite(p.created_timestamp)?p.created_timestamp*1000:Date.parse(p.created_at);if(!Number.isFinite(time)||time<0||time>Date.now()+86400000)throw Error('帖子发布时间无效，本次不推进断点');top=Math.max(top,time);if(seen.has(id))continue;seen.add(id);if(this.store.get('inbox',id)){skipped++;continue;}const sourceUrl='https://x.com/'+s.id+'/status/'+id;urls.push(sourceUrl);cards.push({id,url:sourceUrl,excerpt:p.text.slice(0,160),publishedAt:new Date(time).toISOString()});}
      const next=d.cursor?.bottom??null;if(next!==null&&(typeof next!=='string'||next.length>2000||!next||mode==='older'&&(next===s.cursor||(s.recentCursors||[]).includes(next))))throw Error('来源分页游标无效或重复，本次不推进断点');
      if(this.queue.closing||this.queue.active)throw Error('其他采集已启动，本次未推进断点');
      const nextCursor=mode==='updates'&&(s.cursor||s.exhausted)?s.cursor:next;
      const pending={previewId:randomUUID(),mode,urls,cards,nextCursor,watermark:new Date(top).toISOString(),sourceCount:d.results.length,skipped,bytes,elapsedMs:Math.round(performance.now()-t),createdAt:new Date().toISOString(),batchId:null};return this.store.put('inboxAuthors',{...s,pending});
    }finally{this.busy=false;}
  }
  capture({author,previewId}){this.idle();const s=this.state(author),p=s.pending;if(!p||p.previewId!==previewId||p.batchId&&!terminal(this.queue.status(p.batchId)))throw Error('预览已失效，请重新读取作者');if(!p.urls.length){const row=this.commit(s,p);return {batch:null,state:row};}const batch=this.queue.start({urls:p.urls});const row=this.store.put('inboxAuthors',{...s,pending:{...p,batchId:batch.id}});return {batch,state:{...row,batchStatus:batch.status}};}
  discard({author,previewId}){this.idle();const s=this.state(author);if(!s.pending||s.pending.previewId!==previewId)throw Error('预览已变化，请重新查看后操作');return this.store.put('inboxAuthors',{...s,pending:null});}
}
