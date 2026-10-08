import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {readGenerationStream} from '../src/streaming.js';
import {generate} from '../src/providers.js';

const sse=data=>'data: '+JSON.stringify(data)+'\r\n\r\n';
const frames={
  openai:[sse({choices:[{index:0,delta:{content:'自然'}}]}),sse({choices:[{index:0,delta:{content:'光'},finish_reason:'stop'}]}),'data: [DONE]\n\n'],
  anthropic:[sse({type:'message_start',message:{usage:{input_tokens:2}}}),sse({type:'content_block_delta',delta:{type:'text_delta',text:'自然光'}}),sse({type:'message_delta',delta:{stop_reason:'end_turn'},usage:{output_tokens:3}}),sse({type:'message_stop'})],
  gemini:[sse({candidates:[{content:{parts:[{thought:true,text:'隐藏思考'},{text:'自然光'}]}}]}),sse({candidates:[{finishReason:'STOP'}],usageMetadata:{candidatesTokenCount:3}})],
  ollama:[JSON.stringify({message:{content:'自然光'},done:false})+'\n',JSON.stringify({done:true,done_reason:'stop',eval_count:3})+'\n']
};
test('四类流式协议支持逐字节UTF8分片、正文进度和结束标记',async()=>{
  for(const [protocol,parts]of Object.entries(frames)){const bytes=Buffer.from(parts.join('')),progress=[];async function* chunks(){for(const byte of bytes)yield Uint8Array.of(byte);}const out=await readGenerationStream(chunks(),protocol,text=>progress.push(text));assert.equal(out.output,'自然光');assert.equal(progress.at(-1),'自然光');assert.ok(!progress.some(t=>t.includes('隐藏思考')));}
});
test('流式错误与缺结束标记拒绝成功，保留调用者已收到的部分正文',async()=>{
  async function* partial(){yield Buffer.from(frames.openai[0]);}let latest='';await assert.rejects(readGenerationStream(partial(),'openai',t=>latest=t),/中断/);assert.equal(latest,'自然');
  async function* failure(){yield Buffer.from(sse({error:{message:'服务错误'}}));}await assert.rejects(readGenerationStream(failure(),'openai'),/服务错误/);
});
test('实时请求仅一次，首段在结束前到达；取消及不支持实时均不自动重试',async()=>{
  let calls=0,finish;const complete=new Promise(r=>finish=r);const server=http.createServer(async(req,res)=>{calls++;let body='';for await(const c of req)body+=c;assert.equal(JSON.parse(body).stream,true);if(req.url.startsWith('/error')){res.writeHead(400,{'Content-Type':'application/json'});res.end(JSON.stringify({error:{message:'不支持stream'}}));return;}res.writeHead(200,{'Content-Type':'text/event-stream'});res.write(frames.openai[0]);await complete;res.end(frames.openai.slice(1).join(''));});await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const p={protocol:'openai',baseUrl:'http://127.0.0.1:'+server.address().port,model:'mock'};
  try{let first;const seen=new Promise(r=>first=r);const pending=generate(p,{system:'系统',user:'正文',stream:true,onProgress:t=>first(t)});assert.equal(await seen,'自然');finish();assert.equal((await pending).output,'自然光');assert.equal(calls,1);await assert.rejects(generate({...p,baseUrl:p.baseUrl+'/error'},{system:'系统',user:'正文',stream:true}),/不支持/);assert.equal(calls,2);
  }finally{finish();await new Promise(r=>server.close(r));}
});

test('用户取消终止同一次实时请求，普通JSON响应兼容且不补发请求',async()=>{
  let calls=0,closed;const closeObserved=new Promise(r=>closed=r);const server=http.createServer(async(req,res)=>{calls++;for await(const c of req){}if(req.url.startsWith('/json')){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({choices:[{message:{content:'完整正文'},finish_reason:'stop'}]}));return;}res.writeHead(200,{'Content-Type':'text/event-stream'});res.write(frames.openai[0]);res.on('close',closed);});await new Promise(r=>server.listen(0,'127.0.0.1',r));const p={protocol:'openai',baseUrl:'http://127.0.0.1:'+server.address().port,model:'mock'};
  try{const ctrl=new AbortController();let first;const seen=new Promise(r=>first=r);const pending=generate(p,{user:'测试',stream:true,onProgress:t=>first(t)},ctrl.signal);assert.equal(await seen,'自然');ctrl.abort();await assert.rejects(pending);await closeObserved;assert.equal(calls,1);const result=await generate({...p,baseUrl:p.baseUrl+'/json'},{user:'测试',stream:true});assert.equal(result.output,'完整正文');assert.equal(calls,2);}finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
});
