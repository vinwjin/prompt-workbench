import{provenance}from'./library.js';
import { renderTemplate } from './catalog.js';
import { generate } from './providers.js';
import {prepareVariables}from'./template-studio.js';
import {composeInput,iterationSnapshot} from './prompt-lab.js';
import {qualityRules,checkQuality} from './quality.js';

export class Jobs {
  constructor(store,vault,lifecycle,{generator=generate}={}){this.store=store;this.vault=vault;this.lifecycle=lifecycle;this.generator=generator;this.queue=[];this.active=null;this.closing=false;}
  prepare(input,{snapshot=null}={}){
    const rawInput=input.input||'';
    const iteration=!snapshot&&input.parentJobId?iterationSnapshot(this.store,input.parentJobId,input.instruction):null;
    const composition=composeInput(this.store,input.input||'',snapshot?[]:input.snippetIds||[],input.snippetVersions||{});
    if(iteration&&composition.snippets.length)throw Error('继续优化请将片段写入修改要求，不重复组合原输入');
    input={...input,input:iteration?iteration.rootInput:composition.text,images:iteration?iteration.images:input.images,source:iteration?iteration.source:input.source};
    const p=this.store.get('providers',input.providerId),t=this.store.get('templates',input.templateId);
    const model=String(input.model||p?.model||'').trim();if(!p||!model||model.length>180)throw new Error('请先配置连接并选择模型');if(!iteration&&!snapshot&&(!t||t.deletedAt))throw new Error('模板不存在或在回收站');
    if(String(input.input||'').length>60000)throw new Error('输入超过 60000 字');
    const images=input.images||[];if(!Array.isArray(images)||images.length>4)throw new Error('每次最多 4 张图片');
    for(const i of images)if(typeof i?.dataUrl!=='string'||i.dataUrl.length>3e6||!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(i.dataUrl))throw new Error('图片须为 PNG/JPEG/WebP 且单张不超过 2MB');
    const vars=snapshot?snapshot.variables:iteration?iteration.variables:prepareVariables(t,{language:'中文',duration:'5',...input.variables,input:input.input||'请描述图片'});
    if(!input.input?.trim()&&!images.length)throw new Error('请输入提示词或添加参考图片');
    const compiled=snapshot?snapshot.compiled:iteration?iteration.compiled:renderTemplate(t,vars);
    if(!compiled||typeof compiled.system!=='string'||typeof compiled.user!=='string')throw Error('任务指令快照无效');
    const rules=qualityRules(input.qualityRules);
    const temperature=Number.isFinite(Number(input.temperature))?Number(input.temperature):0.6;
    return {source:provenance(input.source),input:input.input||'',variables:vars,images,providerId:p.id,providerName:p.name,model,templateId:snapshot?snapshot.templateId:iteration?iteration.templateId:t.id,templateName:snapshot?snapshot.templateName:iteration?iteration.templateName:t.name,templateRevision:snapshot?snapshot.templateRevision:iteration?iteration.templateRevision:t.revision||1,compiled,rawInput:snapshot?snapshot.rawInput:iteration?input.input:rawInput,snippets:snapshot?snapshot.snippets||[]:composition.snippets,qualityRules:rules,...(snapshot?{parentJobId:snapshot.parentJobId,chainId:snapshot.chainId,iterationDepth:snapshot.iterationDepth,rootInput:snapshot.rootInput,instruction:snapshot.instruction,rootCompiled:snapshot.rootCompiled,parentSnapshot:snapshot.parentSnapshot}:{}),...(iteration?{parentJobId:iteration.parentJobId,chainId:iteration.chainId,iterationDepth:iteration.iterationDepth,rootInput:iteration.rootInput,instruction:iteration.instruction,rootCompiled:iteration.rootCompiled,parentSnapshot:iteration.parentSnapshot}:{}),temperature:Math.min(2,Math.max(0,temperature)),maxTokens:Math.min(8192,Math.max(32,Number(input.maxTokens)||1024)),autoUnload:input.autoUnload!==false,status:'queued',stream:input.stream===true,createdAt:new Date().toISOString()};
  }
  enqueue(input){const job=this.store.put('jobs',this.prepare(input));this.queue.push(job.id);this.pump();return job;}
  retry(id){const saved=this.store.get('jobs',id);if(!saved||saved.deletedAt||['running','queued','cancelling'].includes(saved.status))throw Error('只能重试未删除的已结束任务');const job=this.store.put('jobs',this.prepare(saved,{snapshot:saved}));this.queue.push(job.id);this.pump();return job;}
  enqueueBatch(inputs){const prepared=inputs.map(input=>this.prepare(input));const jobs=[];this.store.db.exec('BEGIN IMMEDIATE');try{for(const item of prepared)jobs.push(this.store.put('jobs',item));this.store.db.exec('COMMIT');}catch(e){this.store.db.exec('ROLLBACK');throw e;}this.queue.push(...jobs.map(j=>j.id));this.pump();return jobs;
  }
  async pump(){
    if(this.active||this.closing)return;const id=this.queue.shift();if(!id)return;
    const ctrl=new AbortController();this.active={id,ctrl,phase:'preparing',partialOutput:'',metrics:{}};let job=this.store.get('jobs',id);job=this.store.put('jobs',{...job,status:'running',startedAt:new Date().toISOString()});
    const started=performance.now();let inferenceStart;
    let secret='';
    try{
      const saved=this.store.get('providers',job.providerId);if(!saved)throw new Error('连接已删除');
      secret=await this.vault.open(saved.sealedKey);const p={...saved,model:job.model,apiKey:secret};
      this.active.phase=['router','llama','ollama'].includes(p.protocol)?'loading':'connecting';
      const result=await this.lifecycle.withModel(p,async()=>{
        ctrl.signal.throwIfAborted();inferenceStart=performance.now();this.active.metrics.prepareMs=Math.round(inferenceStart-started);this.active.phase='generating';
        const generated=await this.generator(p,{...job.compiled,images:job.images,temperature:job.temperature,maxTokens:job.maxTokens,autoUnload:job.autoUnload,stream:job.stream,onProgress:text=>{if(ctrl.signal.aborted)return;this.active.partialOutput=text;if(!this.active.metrics.firstTextMs&&text)this.active.metrics.firstTextMs=Math.max(1,Math.round(performance.now()-inferenceStart));}},ctrl.signal);
        this.active.metrics.generationMs=Math.round(performance.now()-inferenceStart);this.active.phase=job.autoUnload&&['router','llama','ollama'].includes(p.protocol)?'releasing':'saving';return generated;
      },job.autoUnload);
      ctrl.signal.throwIfAborted();let quality;try{quality=checkQuality(result.output||'',job.qualityRules);}catch(e){quality={error:'检查不可用：'+e.message};}job=this.store.put('jobs',{...job,...result,status:'succeeded',quality,metrics:{...this.active.metrics,totalMs:Math.round(performance.now()-started),releaseMs:Math.max(0,Math.round(performance.now()-inferenceStart)-(this.active.metrics.generationMs||0))},release:['router','llama','ollama'].includes(p.protocol)?this.lifecycle.lastRelease:null,finishedAt:new Date().toISOString()});
    }catch(e){let error=String(e.message||e);if(secret)error=error.split(secret).join('[密钥已隐藏]');error=error.replace(/(?:sk-|key-)[A-Za-z0-9_-]{12,}/g,'[密钥已隐藏]');job=this.store.put('jobs',{...job,status:ctrl.signal.aborted?'cancelled':'failed',partialOutput:this.active.partialOutput,metrics:{...this.active.metrics,totalMs:Math.round(performance.now()-started)},error:ctrl.signal.aborted?'任务已取消；部分正文可在详情查看':error.slice(0,1000),release:['router','llama','ollama'].includes(this.store.get('providers',job.providerId)?.protocol)?this.lifecycle.lastRelease:null,finishedAt:new Date().toISOString()});}
    finally{secret='';this.active=null;try{this.store.backup();}catch(e){console.error('自动备份失败：'+e.message);}setImmediate(()=>this.pump());}
  }
  progress(id){const j=this.store.get('jobs',id||this.active?.id||'');if(!j)return null;const {images,compiled,variables,input,source,rawInput,rootInput,rootCompiled,parentSnapshot,snippets,instruction,...small}=j;return {...small,...(this.active?.id===j.id?{phase:this.active.ctrl.signal.aborted?'cancelling':this.active.phase,partialOutput:this.active.partialOutput,metrics:this.active.metrics}:{})};}
  cancel(id){const j=this.store.get('jobs',id);if(!j)throw new Error('任务不存在');if(this.active?.id===id){this.active.ctrl.abort();return this.store.put('jobs',{...j,status:'cancelling'});}if(j.status==='queued'){this.queue=this.queue.filter(x=>x!==id);return this.store.put('jobs',{...j,status:'cancelled',finishedAt:new Date().toISOString()});}return j;}
  async shutdown(){this.closing=true;for(const id of [...this.queue])this.cancel(id);if(this.active)this.cancel(this.active.id);const deadline=Date.now()+15000;while(this.active&&Date.now()<deadline)await new Promise(r=>setTimeout(r,100));return !this.active;}
}
