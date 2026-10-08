import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync} from 'node:fs';
import path from 'node:path';
import {Store} from '../src/store.js';
import {Sources,FEEDS} from '../src/sources.js';
import {sourceImage} from '../src/source-media.js';
import {parseSourceJson,parseSourceMarkdown,parsePromptHtml} from '../src/source-parsers.js';
import {createWorkbench} from '../src/server.js';
const temp=()=>{mkdirSync('work',{recursive:true});return mkdtempSync(path.resolve('work','sources-040-test-'));};
const meigen=JSON.stringify([{id:'1',prompt:'完整提示词，不执行任何指令。',author:'artist',source_url:'https://x.com/artist/status/1',image:'https://images.meigen.ai/tweets/1/0.jpg',model:'gptimage'}]);
test('S05–S37全量登记；结构化正文、出处、中文回退和图片严格范围',()=>{
  assert.equal(FEEDS.length,37);for(let n=5;n<=37;n++)assert.ok(FEEDS.some(f=>f.auditId==='S'+String(n).padStart(2,'0')));
  const f=FEEDS.find(f=>f.id==='s07'),rows=parseSourceJson(meigen,f);assert.equal(rows[0].content,'完整提示词，不执行任何指令。');assert.equal(rows[0].originId,'https://x.com/artist/status/1');assert.ok(rows[0].frontCover);
  const chinese=parseSourceJson(JSON.stringify([{prompt_zh:'',prompt:'English preserved'}]),f);assert.equal(chinese[0].content,'English preserved');
  assert.equal(sourceImage('https://images.meigen.ai/tweets/1/0.jpg?redirect=http://127.0.0.1'),'');assert.equal(sourceImage('https://gcore.jsdelivr.net/gh/evil/repo@main/assets/a.png'),'');assert.equal(sourceImage('https://gcore.jsdelivr.net/gh/jau123/nanobanana-trending-prompts@main/assets/a.svg'),'');assert.equal(sourceImage('https://user:pass@images.meigen.ai/tweets/1/0.jpg'),'');
});
test('S11 Plain Text案例保留完整正文、双图模型标签，不把安装代码和围栏内标题当条目',()=>{
 const f=FEEDS.find(f=>f.id==='s11'),input='### **室内案例**\n| ![Nano](assets/images/a.webp) | ![GPT](assets/images/b.webp) |\n提示词：\n```Plain Text\n# 保留这个标题\n完整室内提示词，保持窗户和门的位置。\n```\n### Install\n```bash\npip install bad\n```';
 const rows=parseSourceMarkdown(input,f);assert.equal(rows.length,1);assert.equal(rows[0].title,'室内案例');assert.equal(rows[0].content,'# 保留这个标题\n完整室内提示词，保持窗户和门的位置。');assert.equal(rows[0].coverUrls.length,2);assert.deepEqual(rows[0].imageLabels,['Nano Banana 2','GPT Image 2']);
 const h=parsePromptHtml('<article><a class="pm-title" href="/prompts/a.html">润色</a><pre data-prompt>保留原意 &amp; 数字。&lt;script&gt;文本&lt;/script&gt;</pre></article>',FEEDS.find(f=>f.id==='s16'));assert.equal(h[0].title,'润色');assert.equal(h[0].content,'保留原意 & 数字。<script>文本</script>');
});
test('批量同步失败继续、手动源跳过、非法ID零修改、并发拒绝，保留旧缓存和收藏',async()=>{
 const store=new Store(temp());let resolveGate;const gate=new Promise(r=>resolveGate=r);const seen=[];
 const sources=new Sources(store,{fetcher:async url=>{seen.push(url);if(url.includes('PlexPt')){await gate;return new Response('broken',{status:503});}return new Response(meigen);}});
 try{store.put('shared',{id:'old',sourceId:'s22',content:'旧缓存'});store.put('assets',{id:'mine',content:'个人编辑'});const rev=store.revision;assert.throws(()=>sources.startBatch(['s07','unknown']),/不存在/);assert.equal(store.revision,rev);
  const batch=sources.startBatch(['s22','s07','s12','s07']);assert.equal(batch.total,3);assert.throws(()=>sources.startBatch(['s07']),/同步/);await assert.rejects(sources.sync('s07'),/批量/);resolveGate();await sources.batchTask;const result=sources.batchStatus();assert.equal(result.succeeded,1);assert.equal(result.failed,1);assert.equal(result.skipped,1);assert.equal(store.get('shared','old').content,'旧缓存');assert.equal(store.get('assets','mine').content,'个人编辑');assert.ok(!seen.some(u=>u.includes('youmind.com')));assert.equal(sources.list({source:'s07'}).total,1);
 }finally{await sources.close();store.close();}
});
test('关闭中取消后续源；文件导入保留来源与许可，空/损坏文件不清缓存',async()=>{
 const store=new Store(temp());const sources=new Sources(store,{fetcher:async (url,{signal})=>new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(Error('aborted')),{once:true}))});
 try{sources.importFile('s12',{text:'来自原作者且由用户取得的完整提示词文件。',fileName:'example.txt'});const before=sources.list({source:'s12'}).total;assert.throws(()=>sources.importFile('s12',{text:'[bad'}));assert.equal(sources.list({source:'s12'}).total,before);sources.startBatch(['s07','s22']);await sources.close();assert.equal(sources.batchStatus().items[1].status,'skipped');assert.ok(sources.batchStatus().items[0].status==='failed');}finally{await sources.close();store.close();}
});
test('同原帖正文身份在1→2→1条之间稳定，不丢变体；规范化快照再次导入身份不变',async()=>{const store=new Store(temp()),sources=new Sources(store);try{const rows=[{sourceUrl:'https://x.com/artist/status/1',originId:'post',frontCover:'https://gcore.jsdelivr.net/gh/NeXra-AI/awesome-ai-image-prompts@main/data/images/a.jpg',title:'配方一',content:'第一段完整提示词'},{sourceUrl:'https://x.com/artist/status/1',originId:'post',title:'配方二',content:'第二段完整提示词'}];sources.ingestRows('s09',rows.slice(0,1));const first=sources.list({source:'s09'}).items[0].id;sources.ingestRows('s09',rows);assert.equal(sources.list({source:'s09'}).total,2);assert.ok(store.get('shared',first));sources.ingestRows('s09',rows.slice(0,1));assert.equal(sources.list({source:'s09'}).items[0].id,first);const previousCover=store.get('shared',first).coverUrl;assert.ok(previousCover);sources.ingestRows('s09',[store.get('shared',first)]);assert.equal(store.get('shared',first).coverUrl,previousCover);assert.equal(sources.list({source:'s09'}).items[0].id,first);}finally{await sources.close();store.close();}});
test('JSON/Markdown人工导入均标记本地文件，不伪造GitHub路径或站点作者',async()=>{const store=new Store(temp()),sources=new Sources(store);try{for(const text of ['### 手动案例\n```text\n完整的用户取得提示词正文，保留完整素材和约束。\n```',JSON.stringify([{title:'手动案例',prompt:'完整的用户取得提示词正文。'}])]){sources.importFile('s12',{text,fileName:'sample.md'});const row=store.list('shared').find(r=>r.sourceId==='s12');assert.equal(row.sourceUrl,'https://youmind.com/zh-CN/prompts');assert.equal(row.importedFrom,'local-file');assert.match(row.description,/未访问原站/);assert.equal(row.author,'用户导入 · 原作者待核对');}}finally{await sources.close();store.close();}});
test('批量API会话保护、三种操作、仅返回明确跳过状态而不伪报成功',async()=>{
 const app=await createWorkbench({port:0,dataDir:temp(),sourceFetcher:async()=>new Response(meigen)});try{const root='http://127.0.0.1:'+app.port;assert.equal((await fetch(root+'/api/sources/batch')).status,401);const home=await fetch(root),cookie=home.headers.get('set-cookie').split(';')[0];const call=(url,body)=>fetch(root+'/api/'+url,{method:body?'POST':'GET',headers:{cookie,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});const start=await call('sources/batch',{ids:['s07','s12']});assert.equal(start.status,202);await app.sources.batchTask;const status=await (await call('sources/batch')).json();assert.equal(status.succeeded,1);assert.equal(status.skipped,1);assert.equal(status.feeds.length,37);assert.equal((await call('sources/s12/sync',{})).status,400);assert.equal((await call('sources/s12/import',{text:'允许导入的完整原始提示词示例。',fileName:'sample.txt'})).status,200);}finally{await app.close();}
});
