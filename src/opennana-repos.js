import {createHash} from 'node:crypto';
import {openNanaRow} from './opennana.js';
import {sourceVideoUrl,videoPost} from './gallery-policy.js';
import {coverUrl} from './image-cache.js';

// Case headings, not TOC links or headings inside prompt fences, delimit records.
export function repoCases(text){
  const rows=[];let row=null,fence=false;
  for(const line of text.split(/\r?\n/)){
    if(/^\s*```/.test(line))fence=!fence;
    const h=!fence&&line.match(/^## 案例\s*(\d+)(.*)$/);
    if(h){if(row)rows.push(row);row={id:h[1],heading:h[2],lines:[]};}
    else if(row)row.lines.push(line);
  }
  if(row)rows.push(row);return rows;
}
function prompts(body,min=20){
  const parts=body.split(/\*\*((?:英文|中文|示例)?提示词(?:模版|模板|\d+)?)[：:]?\*\*/g),rows=[];
  for(let n=1;n<parts.length;n+=2){const label=parts[n],section=parts[n+1]||'',blocks=[...section.matchAll(/```[^\n]*\n([\s\S]*?)```/g)].map(v=>v[1].trim());
    const text=blocks.length?blocks.join('\n\n'):section.split(/https:\/\/github\.com\/user-attachments\/|<a id=|^---/m)[0].trim();
    if(text.length>=min)rows.push({type:label.startsWith('英文')?'en':label.startsWith('中文')?'zh':'original',label,text});
  }return rows;
}
export function historicalImages(files){
  const rows=new Map(),ids=new Set();
  for(const {file,text} of files)for(const c of repoCases(text)){
    if(ids.has(c.id))throw Error('历史Markdown重复编号：'+c.id);ids.add(c.id);
    const body=c.lines.join('\n'),source=c.heading.match(/https:\/\/(?:x\.com|twitter\.com)\/[\w]+\/status\/\d+/)?.[0];
    const images=[...body.matchAll(/(?:src="|!\[[^\]]*\]\()\.\/?(images\/\d+(?:-\d+)?\.(?:png|jpe?g|webp))/gi)].map(m=>'https://img.opennana.com/prompts/'+m[1]);
    const p={slug:'prompt-'+c.id,title:c.heading.replace(/^\s*[：:]\s*/,'').split(/\s*\(来源/)[0],media_type:'image',access_type:0,is_unlocked:true,source_url:source,source_name:source?'@'+new URL(source).pathname.split('/')[1]:'',images,prompts:prompts(body,1)};
    let row=openNanaRow(p,'image');
    // Historical cases can cite their actual repository entry when no X attribution exists.
    if(!row&&p.prompts.length&&images.some(coverUrl)){const original=c.heading.match(/https:\/\/mp\.weixin\.qq\.com\/s\/[A-Za-z0-9_-]+/)?.[0];row={id:p.slug,title:p.title,content:p.prompts.map(v=>v.label+'\n'+v.text).join('\n\n'),prompts:p.prompts,frontCover:images[0],coverUrls:images,sourceUrl:source||original||`https://github.com/songguoxs/gpt4o-image-prompts/blob/master/${file}#prompt-${c.id}`,author:source?p.source_name:original?'原作者见来源':'仓库未标注原作者',referenceOnly:true};}
    if(row)rows.set(c.id,{...row,modelHint:c.heading.match(/模型[：:]\s*(.+)$/)?.[1]||'原案例模型见出处',sourceType:'historical-markdown',sourceVersion:createHash('sha256').update(text).digest('hex'),originFile:file,description:'历史Markdown案例；现行同slug正文优先。'});
  }
  const max=Math.max(0,...[...ids].map(Number));if(ids.size!==max||[...ids].some(id=>Number(id)<1))throw Error('历史Markdown编号集合不连续');
  const all=[...rows.values()],eligible=all.filter(r=>!r.referenceOnly).length;return {rows:all,cases:ids.size,eligible,references:all.length-eligible,rejected:ids.size-eligible};
}
export function videoRepository(text){
  const rows=repoCases(text).map(c=>{const body=c.lines.join('\n'),sourceUrl=videoPost(c.heading.match(/https:\/\/(?:x\.com|twitter\.com)\/[\w]+\/status\/\d+/)?.[0]),videoUrl=sourceVideoUrl(body.match(/https:\/\/github\.com\/user-attachments\/assets\/[a-f\d-]+/i)?.[0]),p=prompts(body);if(!sourceUrl||!videoUrl||!p.length)throw Error('视频仓库案例缺正文/原帖/稳定视频：'+c.id);return {id:'video-'+c.id,title:'仓库视频案例 '+c.id,sourceUrl,videoUrl,prompts:p,content:p.map(v=>v.label+'\n'+v.text).join('\n\n'),author:'@'+new URL(sourceUrl).pathname.split('/')[1],modelHint:'原仓库未逐案标注模型',sourceType:'video-repository',sourceVersion:createHash('sha256').update(text).digest('hex'),description:p.length>1?'双语正文；无静态封面，视频在原链接观看。':'单语正文；无静态封面，视频在原链接观看。'};});
  if(!rows.length||new Set(rows.map(v=>v.id)).size!==rows.length)throw Error('视频仓库案例集合无效');return rows;
}
