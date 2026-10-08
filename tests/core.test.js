import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,readFileSync,readdirSync } from 'node:fs';
import path from 'node:path';
import { Store } from '../src/store.js';
import { renderTemplate } from '../src/catalog.js';
import { SecretVault } from '../src/secrets.js';
import { buildGeneration,validateProvider,generate } from '../src/providers.js';
import http from 'node:http';

export function temp(){return mkdtempSync(path.join(path.resolve('work'),'test-'));}
test('模板变量缺失阻止请求，正文中的花括号不会二次解释',()=>{
  assert.throws(()=>renderTemplate({system:'{{role}}',user:'{{input}}'},{input:'abc'}),/role/);
  assert.deepEqual(renderTemplate({system:'编辑',user:'{{input}}'},{input:'{{secret}}'}),{system:'编辑',user:'{{secret}}'});
});
test('SQLite 重启保留资产；中断任务不自动执行；恢复不覆盖当前记录或密钥',()=>{
  const dir=temp();let s=new Store(dir);s.put('assets',{id:'a',title:'测试',content:'原文'});s.put('providers',{id:'p',name:'local',protocol:'openai',model:'test',baseUrl:'http://127.0.0.1:9999/v1',sealedKey:'cipher'});s.put('jobs',{id:'j',input:'中文测试',createdAt:new Date().toISOString(),status:'running'});
  const backup=s.export();assert.equal(backup.providers[0].sealedKey,undefined);s.close();s=new Store(dir);
  assert.equal(s.get('assets','a').content,'原文');assert.equal(s.get('jobs','j').status,'interrupted');
  backup.assets[0].content='外部覆盖';backup.providers[0].sealedKey='malicious';s.import(backup);
  assert.equal(s.get('assets','a').content,'原文');assert.equal(s.get('providers','p').sealedKey,'cipher');
  assert.throws(()=>s.import({schema:'wrong'}),/备份/);assert.equal(s.get('assets','a').content,'原文');s.close();
});
test('自动备份不含凭据且保留数量有上限',()=>{const s=new Store(temp());s.put('providers',{id:'a',sealedKey:'secret-cipher'});for(let i=0;i<24;i++)s.backup();const files=readdirSync(path.join(s.dir,'backups'));assert.equal(files.length,20);assert.ok(!readFileSync(path.join(s.dir,'backups',files.at(-1)),'utf8').includes('secret-cipher'));s.close();});
test('异常恢复整批拒绝；模板删除跨重启保持；旧任务可分页并全文查找',()=>{
  const dir=temp();let s=new Store(dir);const backup=s.export();backup.assets.push({id:'valid',title:'不应部分写入',content:'文本'});backup.jobs.push({id:'invalid',status:'succeeded'});
  assert.throws(()=>s.import(backup),/任务无效/);assert.equal(s.get('assets','valid'),null);
  s.remove('templates','translate');for(let i=0;i<270;i++)s.put('jobs',{id:'job-'+i,input:i===0?'旧记录唯一关键字':'普通历史',createdAt:new Date().toISOString(),status:'succeeded',images:[]});
  assert.equal(s.jobPage({limit:100,offset:200}).jobs.length,70);assert.equal(s.jobPage({query:'旧记录唯一关键字'}).jobs[0].id,'job-0');
  s.close();s=new Store(dir);assert.equal(s.get('templates','translate'),null);assert.equal(s.jobPage().total,270);s.close();
});
test('Windows DPAPI 密钥往返与错误密文拒绝',{skip:process.platform!=='win32'},async()=>{const v=new SecretVault();const seal=await v.seal('test-only-not-a-real-api-key');assert.ok(!seal.includes('test-only'));assert.equal(await v.open(seal),'test-only-not-a-real-api-key');await assert.rejects(v.open('bad-cipher'));});
test('服务地址禁止明文在线接口与 URL 凭据',()=>{assert.throws(()=>validateProvider({name:'x',protocol:'openai',baseUrl:'http://example.org/v1'}),/HTTPS/);assert.throws(()=>validateProvider({name:'x',protocol:'openai',baseUrl:'https://user:pass@example.org/v1'}),/凭据/);assert.doesNotThrow(()=>validateProvider({name:'x',protocol:'openai',baseUrl:'http://127.0.0.1:8080/v1'}));});
test('推理模型参数兼容可切换；Claude 默认省略不支持的采样参数',()=>{
  const input={system:'编辑',user:'正文',temperature:0.6,maxTokens:2048};
  const p={protocol:'openai',baseUrl:'https://api.openai.com/v1',model:'gpt-5'};
  const body=buildGeneration(p,input).body;assert.equal(body.max_completion_tokens,2048);assert.equal(body.max_tokens,undefined);assert.equal(body.temperature,undefined);
  const manual=buildGeneration({...p,temperatureMode:'send',tokenField:'max_tokens'},input).body;assert.equal(manual.max_tokens,2048);assert.equal(manual.temperature,0.6);
  assert.equal(buildGeneration({protocol:'anthropic',baseUrl:'https://api.anthropic.com/v1',model:'custom'},input).body.temperature,undefined);
});
test('三类在线协议和 Ollama 协议保留图像、系统指令与用量',async()=>{
  const seen=[];const server=http.createServer(async(req,res)=>{let body='';for await(const b of req)body+=b;seen.push({path:req.url,headers:req.headers,body:JSON.parse(body)});const protocol=req.url.includes('messages')?'anthropic':req.url.includes('generateContent')?'gemini':req.url.includes('/api/chat')?'ollama':'openai';const out={anthropic:{content:[{type:'text',text:'结果'}],usage:{output_tokens:9}},gemini:{candidates:[{content:{parts:[{text:'结果'}]},finishReason:'STOP'}],usageMetadata:{candidatesTokenCount:9}},ollama:{message:{content:'结果'},eval_count:9},openai:{choices:[{message:{content:'结果'},finish_reason:'length'}],usage:{completion_tokens:9}}}[protocol];res.setHeader('Content-Type','application/json');res.end(JSON.stringify(out));});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;
  try{for(const protocol of ['openai','anthropic','gemini','ollama']){const p={protocol,baseUrl:base+(protocol==='gemini'?'/v1beta':'/v1'),model:'test',apiKey:'fake-key'};const result=await generate(p,{system:'系统',user:'中文输入',images:[{dataUrl:'data:image/png;base64,YQ=='}]},undefined);assert.equal(result.output,'结果');assert.ok(result.usage);if(protocol==='openai')assert.equal(result.truncated,true);}
    assert.equal(seen[0].headers.authorization,'Bearer fake-key');assert.equal(seen[1].body.system,'系统');assert.equal(seen[1].body.messages[0].content[1].source.data,'YQ==');assert.equal(seen[2].headers['x-goog-api-key'],'fake-key');assert.equal(seen[3].body.keep_alive,0);assert.equal(seen[3].body.messages[1].images[0],'YQ==');
  }finally{await new Promise(r=>server.close(r));}
});
