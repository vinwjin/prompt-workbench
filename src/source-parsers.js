import {createHash} from 'node:crypto';
import {repoMedia} from './source-media.js';
const digest=s=>createHash('sha256').update(s).digest('hex').slice(0,24);
export function sourceLink(raw){try{const u=new URL(raw);return u.protocol==='https:'&&!u.username&&!u.password&&!u.port?u.href:'';}catch{return '';}}
export function decodeHtml(text){return String(text||'').replace(/&#(x[\da-f]+|\d+);/gi,(_,n)=>{const v=n[0].toLowerCase()==='x'?parseInt(n.slice(1),16):Number(n);return v>0&&v<=0x10ffff?String.fromCodePoint(v):'';}).replace(/&(amp|lt|gt|quot|apos|nbsp);/g,(_,k)=>({amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:' '})[k]);}
const plain=s=>decodeHtml(String(s).replace(/<br\s*\/?\s*>/gi,'\n').replace(/<[^>]*>/g,'')).trim();
const titleText=s=>plain(s.replace(/\[([^\]]+)\]\([^)]*\)/g,'$1').replace(/[*_`]/g,''));
export function parseSourceJson(text,feed){const data=JSON.parse(text),rows=Array.isArray(data)?data:data?.prompts||data?.items||((data?.prompt||data?.content||data?.positive_prompt)?[data]:null);if(!Array.isArray(rows)||rows.some(r=>!r||typeof r!=='object'))throw Error('来源JSON没有有效条目数组');return rows.map(r=>{
  const content=typeof r.prompt_zh==='string'&&r.prompt_zh.trim()?r.prompt_zh:typeof r.prompt==='string'?r.prompt:r.content||r.positive_prompt||r.positive||'';
  return {id:r.id,originId:r.source_url||r.sourceUrl||r.id,title:r.title_zh||r.title||r.act||r.cmd||String(content).slice(0,70),content,negative:r.negative_prompt||r.negative||'',author:r.author_name||r.author||r.contributor||feed.name,sourceUrl:sourceLink(r.source_url||r.sourceUrl)||feed.url,frontCover:feed.contentKind==='images'?repoMedia(r.image_url||r.image||r.images?.[0],feed):'',modelHint:r.model||r.modelHint||'',tags:r.categories||r.tags||[],license:r.license?`${r.license} · 上游逐条标注；原作者权利另核`:feed.license,description:feed.notice};
}).filter(r=>typeof r.content==='string'&&r.content.trim());}

// 只读取文本/JSON/YAML提示词块；代码围栏内的标题不会被当成目录。
export function parseSourceMarkdown(text,feed,file=feed.path||'README.md'){
  const sections=[];let current={title:feed.name,lines:[]},fence=false,marker='';
  for(const line of text.split(/\r?\n/)){const m=line.match(/^\s*(`{3,}|~{3,})/);if(m){if(!fence){fence=true;marker=m[1][0];}else if(m[1][0]===marker)fence=false;current.lines.push(line);continue;}
    const heading=!fence&&line.match(/^#{1,3}\s+(.+)/);if(heading){sections.push(current);current={title:titleText(heading[1]),lines:[]};}else current.lines.push(line);
  }sections.push(current);
  const rows=[];
  for(const section of sections){const body=section.lines.join('\n');if(/^(?:目录|contents|table of contents|sponsor|赞助|why |stats|changelog|quick start|how to |use with |start in |installation|install |links|faq|contribut|license|model snapshot|prompt formula|workflow|method [12])/i.test(section.title))continue;
    const blocks=[...body.matchAll(/^\s*(`{3,}|~{3,})([^\n]*)\n([\s\S]*?)^\s*\1\s*$/gm)].filter(m=>!m[2].trim()||/^(text|plaintext|json|yaml|markdown|md|prompt)$/i.test(m[2].replace(/\s+/g,''))).map(m=>m[3].trim());
    if(!blocks.length&&/(?:prompt|提示词|prompt：)/i.test(body))for(const m of body.matchAll(/^\s*`([^`]+(?:\n[^`]+)*)`\s*$/gm))blocks.push(m[1].trim());
    const content=blocks.filter(b=>b.length>=20&&!/^(?:npm |pip |git clone|curl |npx |import |from \w+ import|https:\/\/)/.test(b)).join('\n\n');if(!content)continue;
    const origin=body.match(/https:\/\/(?:x\.com|twitter\.com)\/[\w]+\/status\/\d+/)?.[0];
    const images=[...body.matchAll(/(?:src="|!\[[^\]]*\]\()([^"\s)]+)(?:"|\))/g)].map(m=>m[1]);
    const frontCover=feed.contentKind==='images'?images.map(u=>repoMedia(u,feed,file)).find(Boolean)||'':'';
    const coverUrls=feed.id==='s11'?images.map(u=>repoMedia(u,feed,file)).filter(Boolean).slice(0,2):[];
    rows.push({originId:origin||file+'#'+digest(section.title+'\n'+content),title:section.title,content,frontCover,coverUrls,imageLabels:feed.id==='s11'?['Nano Banana 2','GPT Image 2']:[],sourceUrl:origin||`${feed.url}/blob/main/${file}`,author:origin?'@'+new URL(origin).pathname.split('/')[1]:feed.name,modelHint:feed.id==='s11'?'Nano Banana 2 · 详情可看对比图':feed.contentKind==='images'?'原案例模型见出处':'文字模板 · 适用模型见原文',description:feed.notice});
  }
  return rows;
}
export function markdownFiles(text,feed){const rows=[];for(const m of text.matchAll(/\]\(([^)]+\.md(?:#[^)]*)?)\)/g)){let file=m[1].split('#')[0];if(file.startsWith(feed.url+'/blob/main/'))file=file.slice((feed.url+'/blob/main/').length);if(/^(?:prompts|examples)\/.+\.md$/i.test(file)&&!file.includes('..')&&!file.includes('\\')&&!file.startsWith('/'))rows.push(file);}return [...new Set(rows)].slice(0,40);}
export function parsePromptHtml(text,feed){const rows=[];for(const block of text.split(/<article\b/i).slice(1)){const content=block.match(/<pre\b[^>]*data-prompt[^>]*>([\s\S]*?)<\/pre>/i)?.[1];if(!content)continue;const title=plain(block.match(/<a\b[^>]*class="[^"]*pm-title[^"]*"[^>]*>([\s\S]*?)<\/a>/i)?.[1]||block.match(/<h[23]\b[^>]*>([\s\S]*?)<\/h[23]>/i)?.[1]||content.slice(0,60)),link=block.match(/href="([^"#]+\.html)"/)?.[1];rows.push({title,content:plain(content),originId:link||digest(content),sourceUrl:link?new URL(link,feed.url).href:feed.url,author:feed.name,description:feed.notice});}return rows;}
export function videoPages(text,feed){return [...new Set([...text.matchAll(/href="([^"#]+)"/g)].map(m=>{try{return new URL(decodeHtml(m[1]),feed.url);}catch{return null;}}).filter(u=>u&&u.origin===new URL(feed.url).origin&&/^\/prompts\/[a-z0-9-]+$/.test(u.pathname)).map(u=>u.href))].slice(0,24);}
export function parseVideoHtml(text,feed,url){const rows=[];if(feed.id==='s33'){
  for(const block of text.split(/<h2\b/i).slice(1)){const title=plain(block.match(/^[^>]*>([\s\S]*?)<\/h2>/i)?.[1]||''),content=plain(block.match(/<p\b[^>]*>([\s\S]*?)<\/p>/i)?.[1]||'');if(content.length>=20&&/^[“"‘]/.test(content))rows.push({title,content:content.replace(/^[“"‘]|[”"’]$/g,''),sourceUrl:url,originId:url+'#'+digest(title),author:feed.name,modelHint:new URL(url).pathname.split('/').pop(),description:feed.notice});}
  }else{const content=text.match(/Production prompt[\s\S]*?<p\b[^>]*>([\s\S]*?)<\/p>/i)?.[1];if(content)rows.push({title:plain(text.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1]||''),content:plain(content),sourceUrl:url,originId:url,author:feed.name,modelHint:'WAN · 版本见原站',description:feed.notice});}
  return rows;
}
