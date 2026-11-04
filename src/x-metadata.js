import {createHash} from 'node:crypto';
import {sourceVideoUrl} from './gallery-policy.js';
const metric=v=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0?v:null;
export function postMetadata(p,previous={},now=new Date().toISOString()){
  const millis=Number.isFinite(p.created_timestamp)?p.created_timestamp*1000:Date.parse(p.created_at);
  const publishedAt=Number.isFinite(millis)&&millis>=0&&millis<=Date.now()+86400000?new Date(millis).toISOString():null;
  const metrics=Object.fromEntries(['likes','reposts','replies','quotes','views'].map(k=>[k,metric(p[k])]));
  const heat=['likes','reposts','replies','quotes'].every(k=>metrics[k]!==null)?metrics.likes+2*metrics.reposts+2*metrics.replies+metrics.quotes:null;
  const videos=(p.media?.videos||[]).map(v=>sourceVideoUrl(v.url)).filter(Boolean).slice(0,4);
  const contentHash=createHash('sha256').update(JSON.stringify({text:p.text,photos:p.media?.photos||[],videos,publishedAt})).digest('hex');
  const snapshot={at:now,provider:'fxembed',metrics};const history=[...(previous?.metricHistory||[]),snapshot].slice(-30);
  const latestMs=Date.parse(now),base=[...history].reverse().find(s=>s.provider==='fxembed'&&latestMs-Date.parse(s.at)>=86400000&&latestMs-Date.parse(s.at)<=2*86400000);
  const growth=base&&metrics.views!==null&&base.metrics?.views!=null&&metrics.views>=base.metrics.views?{views:metrics.views-base.metrics.views,hours:(latestMs-Date.parse(base.at))/3600000,from:base.at,to:now}:null;
  return {publishedAt,metrics,heat,videos,language:typeof p.lang==='string'?p.lang.slice(0,20):null,isLongPost:p.is_note_tweet===true,contentHash,metricHistory:history,metricsFetchedAt:now,growth};
}
