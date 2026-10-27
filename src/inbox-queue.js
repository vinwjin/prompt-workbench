import {randomUUID} from 'node:crypto';
import {inboxLink} from './inbox-link.js';
export class InboxQueue{
  constructor(store,inbox){this.store=store;this.inbox=inbox;this.active=null;this.closing=false;for(const b of store.list('inboxBatches'))if(['running','cancelling'].includes(b.status))store.put('inboxBatches',{...b,status:'interrupted',items:b.items.map(i=>['running','queued'].includes(i.status)?{...i,status:'interrupted',error:'上次中断，未自动执行'}:i)});}
  status(id){if(id)return this.store.get('inboxBatches',id);const row=this.store.db.prepare("SELECT body FROM records WHERE kind='inboxBatches' ORDER BY updated DESC LIMIT 1").get();return row?JSON.parse(row.body):null;}
  start({urls,refresh=false}){
    if(this.closing||this.active||this.inbox.busy.size)throw Error('采集正在进行，请等待或停止当前批次');
    if(!Array.isArray(urls)||!urls.length||urls.length>100||urls.some(u=>typeof u!=='string'))throw Error('每批需要1–100个公开链接');
    const unique=new Map();for(const url of urls){const link=inboxLink(url);if(!unique.has(link.id))unique.set(link.id,{id:link.id,url,status:'queued'});}
    const batch=this.store.put('inboxBatches',{id:randomUUID(),status:'running',refresh:refresh===true,items:[...unique.values()],createdAt:new Date().toISOString()});this.active=batch.id;this.work=this.run(batch.id);return batch;
  }
  async run(id){try{let b=this.status(id);for(let n=0;n<b.items.length;n++){
    b=this.status(id);if(this.closing||b.status==='cancelling'){for(let i=n;i<b.items.length;i++)b.items[i]={...b.items[i],status:'cancelled'};this.store.put('inboxBatches',{...b,status:'cancelled',finishedAt:new Date().toISOString()});return;}
    b.items[n]={...b.items[n],status:'running'};this.store.put('inboxBatches',b);
    let result;try{const row=await this.inbox.capture(b.items[n].url,{refresh:b.refresh});result={status:row.readStatus==='needs-content'?'needs-content':'succeeded',recordId:row.id};}catch(e){result={status:'failed',error:String(e.message).slice(0,500)};}
    b=this.status(id);b.items[n]={...b.items[n],...result};this.store.put('inboxBatches',b);
  }b=this.status(id);this.store.put('inboxBatches',{...b,status:b.status==='cancelling'?'cancelled':'completed',finishedAt:new Date().toISOString()});}finally{this.active=null;}}
  cancel(id){const b=this.status(id);if(!b)throw Error('采集批次不存在');if(b.status==='running')return this.store.put('inboxBatches',{...b,status:'cancelling'});return b;}
  retry(id){const b=this.status(id);if(!b)throw Error('采集批次不存在');return this.start({urls:b.items.filter(i=>['failed','interrupted','cancelled'].includes(i.status)).map(i=>i.url),refresh:b.refresh});}
  async close(){this.closing=true;if(this.active)this.cancel(this.active);await this.work;}
}
