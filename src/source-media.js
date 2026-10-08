import {EXTRA_FEEDS} from './source-catalog.js';
const repos=new Set(EXTRA_FEEDS.filter(f=>f.repo).map(f=>f.repo));
const cdns=new Set(['gcore.jsdelivr.net','cdn.jsdelivr.net']);
export function sourceImage(raw){try{const u=new URL(raw);if(u.protocol!=='https:'||u.username||u.password||u.port||u.hash)return '';const p=decodeURIComponent(u.pathname);if(p.includes('\\')||p.split('/').some(s=>s==='.'||s==='..'))return '';
  const match=cdns.has(u.hostname)?p.match(/^\/gh\/([^/]+\/[^/@]+)@main\/(.+)$/):u.hostname==='raw.githubusercontent.com'?p.match(/^\/([^/]+\/[^/]+)\/main\/(.+)$/):null;
  if(match&&repos.has(match[1])&&!u.search&&/^(?:assets|imgs|cases|data\/images|public\/images)\/.+\.(?:png|jpe?g|webp|gif)$/i.test(match[2]))return u.href;
  if(u.hostname==='images.meigen.ai'&&!u.search&&/^\/tweets\/\d+\/\d+\.(?:png|jpe?g|webp)$/i.test(p))return u.href;
  if(u.hostname==='bibigpt-apps.chatvid.ai'&&/^\/chatimg\/[\w-]+\.(?:png|jpe?g|webp)$/i.test(p)&&(!u.search||u.search==='?v=1'))return u.href;
  return '';
}catch{return '';}}
export function repoMedia(raw,feed,file=feed.path||'README.md'){try{if(!raw||!feed.repo)return '';const root=/^(?:assets|imgs|cases|data\/images|public\/images)\//.test(raw)?'README.md':file;const candidate=/^https:\/\//.test(raw)?raw:new URL(raw,`https://gcore.jsdelivr.net/gh/${feed.repo}@main/${root}`).href;return sourceImage(candidate);}catch{return '';}}
