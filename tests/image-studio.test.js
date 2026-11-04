import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync} from 'node:fs';
import path from 'node:path';
import {importWorkflow} from '../src/comfyui-import.js';
import {getRecipe,loadWorkflow,injectWorkflow} from '../src/comfyui-workflows.js';
import {generateImage} from '../src/image-providers.js';
import {Store} from '../src/store.js';
import {AssetMedia} from '../src/asset-media.js';
import {ImageJobs} from '../src/image-jobs.js';
const png=readFileSync('public/icon-256.png');
const temp=()=>{mkdirSync(process.env.PW_TEST_ROOT||'work',{recursive:true});return mkdtempSync(path.resolve(process.env.PW_TEST_ROOT||'work','image-studio-test-'));};
const provider={id:'online',name:'测试生图',protocol:'openai',baseUrl:'https://images.example.test/v1',model:'image-model',apiKey:'test-secret'};

test('工作流导入：API 原配套、LoRA、参数保留，关闭额外模型调用，稳定身份与无副作用',()=>{
 const graph=loadWorkflow(getRecipe('qwen-ref-create'));graph.sampler.inputs.steps=19;graph.encode.inputs.reference_size=512;graph.prompt.inputs.optimizer='开启';
 const before=JSON.stringify(graph),r=importWorkflow(graph,'my-flow.json');
 assert.equal(JSON.stringify(graph),before);assert.equal(r.params.find(p=>p.key==='steps').default,19);assert.equal(r.embeddedPreset.values.reference_size,512);
 assert.equal(r.workflow.prompt.inputs.optimizer,'关闭');assert.equal(r.slots.filter(s=>s.kind==='image').length,3);assert.equal(r.id,importWorkflow(r.workflow,'renamed').id);
 assert.throws(()=>importWorkflow({nodes:[{id:1,type:'unknown',widgets_values:[]}],links:[]}),/不支持/);
 assert.throws(()=>importWorkflow({...graph, bad:{class_type:'RemotePaidImage',inputs:{}}}),/不支持/);
});

test('导入工作流的原配套使用稳定ID通过模型读取、入队和生成',async()=>{
 const store=new Store(temp()),media=new AssetMedia(store),source=loadWorkflow(getRecipe('qwen-character'));
 source.encode.inputs.unet_name='Imported-Qwen.safetensors';source.encode.inputs.clip_name='Imported-Clip.safetensors';source.encode.inputs.vae_name='Imported-VAE.safetensors';
 const imported=importWorkflow(source,'embedded-fixture'),recipe=imported;
 const info=Object.fromEntries(Object.values(recipe.workflow).map(n=>[n.class_type,{input:{required:{}}}]));
 let submitted;
 const fetchFn=async(url,opts={})=>{const u=new URL(url),json=x=>new Response(JSON.stringify(x));
  if(u.pathname==='/system_stats')return json({system:{ram_free:16*1024**3}});
  if(u.pathname==='/queue')return json({queue_running:[],queue_pending:[]});
  if(u.pathname==='/object_info')return json(info);
  if(u.pathname==='/local_qwen/catalog')return json({presets:[],loras:recipe.loraStack.map(l=>l.name)});
  if(u.pathname==='/upload/image')return json({name:'input.png',subfolder:'fixture'});
  if(u.pathname==='/prompt'){submitted=JSON.parse(opts.body).prompt;return json({prompt_id:'embedded-fixture'});}
  if(u.pathname==='/history/embedded-fixture')return json({'embedded-fixture':{outputs:{[recipe.outputNode]:{images:[{filename:'out.png'}]}},status:{completed:true}}});
  if(u.pathname==='/view')return new Response(png);
  throw Error('unexpected '+u.pathname);
 };
 const jobs=new ImageJobs(store,media,{fetchFn,resourceCheck:()=>({ok:true})});
 try{
  store.put('comfyWorkflows',recipe);jobs.saveSettings({baseUrl:'http://127.0.0.1:8188'});
  const listed=await jobs.models(recipe.id),embeddedId=`embedded:${recipe.id}:${recipe.embeddedPreset.values.unet_name}`;
  assert.deepEqual(listed.models.map(m=>m.id),[embeddedId]);assert.equal(listed.models[0].compatible,true);
  const image={dataUrl:'data:image/png;base64,'+png.toString('base64')};
  const task=jobs.enqueue({recipeId:recipe.id,backend:'comfy',presetName:embeddedId,prompt:'imported prompt',filenamePrefix:'imported-name',slots:{person:image,garment:image}});
  for(let i=0;i<100&&jobs.get(task.id).status==='running';i++)await new Promise(r=>setTimeout(r,20));
  const done=jobs.get(task.id);assert.equal(done.status,'succeeded');assert.equal(submitted[recipe.encodeNode].inputs.unet_name,'Imported-Qwen.safetensors');assert.equal(done.preset.name,`原配套 · ${recipe.embeddedPreset.values.unet_name}`);assert.match(done.outputPath,/imported-name_00001\.png$/);
 }finally{await jobs.close();store.close();}
});

test('三参考注入：缺省图不占编号，最终提示词精确传递，seed为安全整数',()=>{
 const r=getRecipe('qwen-character');const g=injectWorkflow(loadWorkflow(r),r,{garment:'outfit.png',pose:'pose.png',_promptOverride:'<image1>服装，<image2>姿势',seed:-1});
 assert.deepEqual(JSON.parse(g.prompt.inputs.references_state),[{filename:'outfit.png',role:'服装'},{filename:'pose.png',role:'姿势动作'}]);
 assert.equal(g.prompt.inputs.prompt,'<image1>服装，<image2>姿势');assert.ok(Number.isSafeInteger(g.sampler.inputs.seed));assert.equal(g.encode.inputs.lora_stack,'[]');
});

test('OpenAI：无图 JSON / 有图 multipart，单次请求，不传 GPT Image 不支持的 response_format',async()=>{
 const seen=[];const fetchFn=async(url,opts)=>{seen.push({url,...opts});return new Response(JSON.stringify({data:[{b64_json:png.toString('base64')}]}));};
 assert.deepEqual((await generateImage(provider,{prompt:'test'},{fetchFn})).data,png);
 const body=JSON.parse(seen[0].body);assert.equal(body.n,1);assert.equal(body.model,'image-model');assert.ok(!Object.hasOwn(body,'response_format'));assert.ok(seen[0].url.endsWith('/images/generations'));
 await generateImage(provider,{prompt:'edit',images:[png,png],size:'1024x1536'},{fetchFn});assert.ok(seen[1].url.endsWith('/images/edits'));assert.equal(seen[1].body.getAll('image[]').length,2);assert.equal(seen[1].headers['Content-Type'],undefined);assert.equal(seen.length,2);
});

test('Gemini：inlineData参考图、图片响应解析，跳过思考图片',async()=>{
 let req;const p={...provider,protocol:'gemini',baseUrl:'https://generativelanguage.googleapis.com/v1beta',model:'models/image-model'};
 const r=await generateImage(p,{prompt:'角色',images:[png],size:'3:4'},{fetchFn:async(url,o)=>{req={url,...o};return new Response(JSON.stringify({candidates:[{content:{parts:[{thought:true,inlineData:{data:'YmFk'}},{text:'说明'},{inlineData:{data:png.toString('base64'),mimeType:'image/png'}}]}}]}));}});
 assert.deepEqual(r.data,png);assert.equal(r.text,'说明');const b=JSON.parse(req.body);assert.equal(b.contents[0].parts[1].inlineData.mimeType,'image/png');assert.deepEqual(b.generationConfig.responseModalities,['TEXT','IMAGE']);assert.equal(b.generationConfig.imageConfig.aspectRatio,'3:4');assert.match(req.url,/models\/image-model:generateContent$/);
});

test('在线失败不重发、脱敏；超时结果未知，文字/URL输出不冒充图片',async()=>{
 let calls=0;await assert.rejects(()=>generateImage(provider,{prompt:'test'},{fetchFn:async()=>{calls++;throw new DOMException('timeout','TimeoutError');}}),e=>e.submitUnknown&&/可能已处理或计费/.test(e.message));assert.equal(calls,1);
 await assert.rejects(()=>generateImage(provider,{prompt:'test'},{fetchFn:async()=>new Response(JSON.stringify({error:{message:'test-secret'}}),{status:401})}),e=>/401/.test(e.message)&&!e.message.includes('test-secret'));
 await assert.rejects(()=>generateImage(provider,{prompt:'test'},{fetchFn:async()=>new Response(JSON.stringify({data:[{url:'https://private.example/image.png'}]}))}),/远程链接/);
});

test('导入工作流随业务备份恢复；在线任务复用密钥且列表不返回完整图与工作流',async()=>{
 const store=new Store(temp()),media=new AssetMedia(store);let generated=0;
 const jobs=new ImageJobs(store,media,{vault:{open:async()=> 'test-secret'},fetchFn:async(url,o)=>{generated++;assert.equal(o.headers.Authorization,'Bearer test-secret');return new Response(JSON.stringify({data:[{b64_json:png.toString('base64')}]}));}});
 try{
  jobs.import({workflow:loadWorkflow(getRecipe('qwen-character')),name:'fixture'});
  const backup=store.export(),other=new Store(temp());try{other.import(backup);assert.equal(other.list('comfyWorkflows').length,1);}finally{other.close();}
  store.put('providers',{...provider,apiKey:undefined,sealedKey:'sealed'});
  const j=jobs.enqueue({backend:'online',providerId:'online',model:'image-model',prompt:'hello',slots:{person:{dataUrl:'data:image/png;base64,'+png.toString('base64')}}});
  for(let i=0;i<100&&jobs.get(j.id).status==='running';i++)await new Promise(r=>setTimeout(r,20));
  assert.equal(jobs.get(j.id).status,'succeeded');assert.equal(generated,1);assert.ok(!JSON.stringify(jobs.get(j.id)).includes('test-secret'));
  const summary=jobs.list().jobs[0];assert.equal(summary.recipeSnapshot,undefined);assert.equal(summary.slots,undefined);assert.equal(summary.prompt,undefined);
 }finally{await jobs.close();store.close();}
});

test('Qwen 画布转换：种子控制组件不串位，比例按本机32像素公倍数计算',()=>{
 const ui={nodes:[
  {id:1,type:'LocalQwenPrompt',widgets_values:['人物或场景参考创作','test','','[]','关闭','test',false,'{}']},
  {id:2,type:'LocalQwenEncode',widgets_values:['unet','clip','vae',288,384,512,'{}','[]','center'],inputs:[{name:'prompt',link:1},{name:'negative_prompt',link:2},{name:'references',link:3},{name:'width',link:4},{name:'height',link:5}]},
  {id:3,type:'KSampler',widgets_values:[42,'randomize',25,1,'euler','simple',1],inputs:[{name:'model',link:6}]},
  {id:4,type:'SaveImage',widgets_values:['old-prefix'],inputs:[{name:'images',link:7}]},
  {id:5,type:'LocalQwenCanvas',widgets_values:['3:2','高度',720,'按比例计算',576,768]},
  {id:6,type:'MarkdownNote',widgets_values:['不执行说明文字']}
 ],links:[[1,1,0,2,0],[2,1,1,2,1],[3,1,2,2,2],[4,5,0,2,3],[5,5,1,2,4],[6,2,0,3,0],[7,3,0,4,0]]};
 const r=importWorkflow(ui,'canvas');assert.equal(r.converted,true);assert.equal(r.workflow['3'].inputs.steps,25);assert.equal(r.workflow['3'].inputs.cfg,1);assert.equal(r.workflow['2'].inputs.width,1056);assert.equal(r.workflow['2'].inputs.height,704);assert.equal(r.workflow['6'],undefined);
});

test('备份恢复丢弃未规范化优化器与伪造参数，保留规范化图',()=>{
 const store=new Store(temp());try{const recipe=importWorkflow(loadWorkflow(getRecipe('qwen-character')),'safe');const backup=store.export();recipe.workflow.prompt.inputs.optimizer='在线 API';recipe.params=[{key:'injected',node:'prompt',field:'optimizer'}];backup.comfyWorkflows=[recipe];store.import(backup);const restored=store.get('comfyWorkflows',recipe.id);assert.equal(restored.workflow.prompt.inputs.optimizer,'关闭');assert.ok(!restored.params.some(p=>p.key==='injected'));}finally{store.close();}
});

test('HTTP 生图三张合法大图不再撞旧14MB上限，预览/失败不调用模型',async()=>{
 const {createWorkbench}=await import('../src/server.js');let calls=0;const app=await createWorkbench({dataDir:temp(),port:0,comfyFetcher:async()=>{calls++;throw Error('不应访问模型');}});
 try{const base='http://127.0.0.1:'+app.port;const home=await fetch(base);const cookie=home.headers.get('set-cookie').split(';')[0];const data=Buffer.alloc(4*1024*1024);png.copy(data);const value={dataUrl:'data:image/png;base64,'+data.toString('base64')};const body=JSON.stringify({recipeId:'qwen-character',prompt:'fixture',slots:{person:value,garment:value,pose:value}});assert.ok(Buffer.byteLength(body)>14e6);const res=await fetch(base+'/api/comfy/jobs',{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json'},body});assert.equal(res.status,202);assert.equal(calls,0);}finally{await app.close();}
});
import {imageModelKind,imageSize,fitImageRatio} from '../public/image-options.js';

test('模型分类与尺寸：聊天型号阻断；自定义像素、比例锁定与Gemini档位',async()=>{
 assert.equal(imageModelKind('grok-4.7'),'chat');assert.equal(imageModelKind('gpt-image-2.5'),'candidate');assert.equal(imageModelKind('private-alias'),'unknown');
 let calls=0;await assert.rejects(()=>generateImage({...provider,model:'grok-4.7'},{prompt:'test'},{fetchFn:async()=>{calls++;}}),/聊天/);assert.equal(calls,0);
 assert.deepEqual(fitImageRatio(1536,'16:9'),{width:1536,height:864});assert.deepEqual(fitImageRatio(864,'16:9','height'),{width:1536,height:864});
 assert.equal(imageSize('openai','gpt-image-2.5','1536x864').size,'1536x864');assert.throws(()=>imageSize('openai','gpt-image-1.5','1536x864'),/此型号/);assert.throws(()=>imageSize('openai','custom','123x1024'),/16倍数/);
 assert.equal(imageSize('gemini','gemini-3-pro-image','4:5','2K').resolution,'2K');assert.throws(()=>imageSize('gemini','gemini-2.5-flash-image','4:5','2K'),/模型默认/);
});

test('缺少ComfyUI设置返回可操作提示，不接触网络',async()=>{
 const jobs=new ImageJobs({get:()=>null},null,{fetchFn:async()=>{throw Error('不能请求');}});await assert.rejects(()=>jobs.models('qwen-character'),/请先配置并保存/);
});

test('API目录读取复用凭据，只发送GET，成功缓存且失败保留目录和模型默认',async()=>{
 const store=new Store(temp());let fail=false;const seen=[];const jobs=new ImageJobs(store,new AssetMedia(store),{vault:{open:async()=> 'secret-test'},fetchFn:async(url,o)=>{seen.push([url,o.method]);assert.equal(o.headers.Authorization,'Bearer secret-test');return fail?new Response(JSON.stringify({error:{message:'secret-test invalid'}}),{status:401}):new Response(JSON.stringify({data:[{id:'grok-4.7'},{id:'gpt-image-2.5'}]}));}});
 try{store.put('providers',{...provider,model:'grok-4.7',sealedKey:'sealed'});const r=await jobs.providerModels('online');assert.deepEqual(r.models,['grok-4.7','gpt-image-2.5']);assert.equal(store.get('providers','online').model,'grok-4.7');fail=true;await assert.rejects(()=>jobs.providerModels('online'),e=>!e.message.includes('secret-test'));assert.equal(store.get('modelLists','online').models.length,2);assert.ok(seen.every(([u,m])=>u.endsWith('/models')&&m==='GET'));}finally{await jobs.close();store.close();}
});

test('404指明图片接口或模型未找到，不误导为密钥/配额故障；自定义尺寸进入请求',async()=>{
 let payload;await assert.rejects(()=>generateImage({...provider,model:'gpt-image-2.5'},{prompt:'test',size:'1536x864'},{fetchFn:async(u,o)=>{payload=JSON.parse(o.body);return new Response('{}',{status:404});}}),e=>/images\/generations/.test(e.message)&&/接口或模型未找到/.test(e.message)&&!e.message.includes('配额'));
 assert.equal(payload.size,'1536x864');
});
import { ImageOutput } from '../src/image-output.js';
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
test('输出目录：持久化、实际扩展名与字节、旧图另存不覆盖、失败保留归档',()=>{
 const store=new Store(temp()),media=new AssetMedia(store),jobs=new ImageJobs(store,media),output=jobs.output;
 try {
  const saved=media.save('test',png);store.put('comfyJobs',{id:'old',status:'succeeded',mediaId:saved.id,mediaType:saved.type});
  assert.throws(()=>output.save('relative/path'),/绝对目录/);
  if(process.platform==='win32')for(const network of ['\\\\server\\share','/\\server/share','\\/server/share'])assert.throws(()=>output.save(network),/本机磁盘/);
  const dir=path.join(store.dir,'custom');output.save(dir);assert.equal(new ImageOutput(store,media).settings().directory,dir);
  const a=jobs.exportResult('old'),b=jobs.exportResult('old');assert.notEqual(a.outputPath,b.outputPath);assert.equal(path.extname(a.outputPath),'.png');assert.deepEqual(readFileSync(a.outputPath),png);assert.equal(readdirSync(dir).length,2);
  assert.equal(store.export().imageOutputSettings,undefined);
  const bad=path.join(store.dir,'file');writeFileSync(bad,'occupied');assert.throws(()=>output.save(bad));assert.equal(output.settings().directory,dir);
  jobs.active={outputDirectory:bad};const result=jobs.saveOutput({mediaId:saved.id,mediaType:saved.type});assert.match(result.outputError,/另存失败/);assert.ok(existsSync(media.file(saved.id)));assert.equal(jobs.get('old').status,'succeeded');jobs.active=null;
 } finally {store.close();}
});
test('打开存放位置：定位已有输出，缺失时回到归档，不复制图片',async()=>{
 const store=new Store(temp()),media=new AssetMedia(store),output=new ImageOutput(store,media);
 try {const saved=media.save('image',png),job={mediaId:saved.id,mediaType:saved.type};let selected;
 if(process.platform!=='win32')return;
 await output.reveal(job,async file=>{selected=file;});assert.equal(selected,media.file(saved.id));
 job.outputPath=output.copy(job);await output.reveal(job,async file=>{selected=file;});assert.equal(selected,job.outputPath);
 assert.equal(readdirSync(output.settings().directory).length,1);
 job.outputPath='\\\\invalid-server\\share\\image.png';await output.reveal(job,async file=>{selected=file;});assert.equal(selected,media.file(saved.id));
 await assert.rejects(output.reveal({},async()=>{}),/没有已保存/);
 }finally{store.close();}
});
test('Turbo 独立采样链：ManualSigmas固定8步，noise_seed注入，导入与原链一致',()=>{
 const r=getRecipe('qwen-turbo'),g=loadWorkflow(r);
 assert.equal(g['3'].class_type,'SamplerCustom');assert.equal(g['15'].inputs.sigmas.split(',').length,9);
 assert.equal(r.params.some(p=>p.key==='steps'),false);
 const injected=injectWorkflow(g,r,{seed:123,cfg:1.5,width:384,height:512,_promptOverride:'测试'});
 assert.equal(injected['3'].inputs.noise_seed,123);assert.equal(injected['3'].inputs.seed,undefined);assert.equal(injected['15'].inputs.sigmas,g['15'].inputs.sigmas);
 const excessive=structuredClone(g);excessive['15'].inputs.sigmas=Array.from({length:1002},(_,i)=>1001-i).join(',');assert.throws(()=>importWorkflow(excessive,'too many'),/序列无效/);
 const imported=importWorkflow(g,'Turbo');assert.equal(imported.embeddedPreset.sampler_types[0],'SamplerCustom');assert.equal(imported.params.find(p=>p.key==='seed').field,'noise_seed');assert.equal(imported.params.some(p=>p.key==='steps'),false);
});

test('output naming keeps files and cleared history preserves records and active jobs',()=>{
 const dir=temp(),store=new Store(dir),media=new AssetMedia(store),jobs=new ImageJobs(store,media);
 try {
 const item=media.save('fixture.png',png);const base={mediaId:item.id,mediaType:'image/png',preset:{name:'Noct-V4'},status:'succeeded'};
 const first=jobs.output.copy(base),second=jobs.output.copy(base);
 assert.match(first,/Noct-V4_00001\.png$/);assert.match(second,/Noct-V4_00002\.png$/);
 assert.deepEqual(readFileSync(first),png);
 assert.match(jobs.output.copy({...base,filenamePrefix:'custom'}),/custom_00001\.png$/);
 const done=store.put('comfyJobs',base),active=store.put('comfyJobs',{status:'running'});
 assert.equal(jobs.clearHistory().hidden,1);assert.equal(jobs.list().total,1);assert.equal(jobs.list().jobs[0].id,active.id);
 assert.equal(jobs.get(done.id).mediaId,item.id);assert.deepEqual(readFileSync(media.file(item.id)),png);assert.deepEqual(readFileSync(first),png);
 }finally{store.close();}
});
