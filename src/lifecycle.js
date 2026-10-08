import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, createWriteStream } from 'node:fs';
import path from 'node:path';
import { models, request, rootUrl } from './providers.js';
import { runProcess } from './secrets.js';

const managerPath=()=>process.env.PW_ROUTER_MANAGER||'';
const delay=ms=>new Promise(r=>setTimeout(r,ms));
export class Lifecycle {
  constructor(dataDir){this.dataDir=dataDir;this.owned=new Set();this.children=new Map();this.started=new Set();this.locked=false;}
  key(p){return `${rootUrl(p)}|${p.model}`;}
  async exclusive(fn){if(this.locked)throw new Error('本地模型正在执行任务或生命周期操作，请稍后');this.locked=true;try{return await fn();}finally{this.locked=false;}}
  async status(p){
    try{
      const list=await models(p);
      let loaded=list;
      if(p.protocol==='ollama'){const r=await request(rootUrl(p)+'/api/ps',{timeout:10000});loaded=r.models||[];}
      return {online:true,models:list,loaded:p.protocol==='ollama'?loaded.map(m=>m.name):list.filter(m=>['loaded','loading'].includes(m.status)).map(m=>m.id),owned:this.owned.has(this.key(p)),startedByWorkbench:this.started.has(p.id),busy:this.locked};
    }catch(e){return {online:false,error:e.message,models:[],owned:this.owned.has(this.key(p)),startedByWorkbench:this.started.has(p.id),busy:this.locked};}
  }
  async wait(p,expected,timeout=300000){
    const deadline=Date.now()+timeout;
    while(Date.now()<deadline){const entry=(await models(p)).find(m=>m.id===p.model);if(entry?.status===expected)return entry;await delay(500);}throw new Error(`模型状态未达到 ${expected}`);
  }
  async start(p){
    const before=await this.status(p);if(before.online)return {alreadyRunning:true,...before};
    if(p.protocol==='router'){
      if(rootUrl(p)!==(process.env.PW_ROUTER_URL||'http://127.0.0.1:18180').replace(/\/v1\/?$/,''))throw new Error('Router地址与PW_ROUTER_URL不一致，请使用匹配的管理器或外部兼容连接');
      if(!existsSync(managerPath()))throw new Error('请先设置PW_ROUTER_MANAGER为可信本地管理脚本的路径，或使用已运行的兼容服务');
      await runProcess('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',managerPath(),'-Action','start','-NoBrowser']);
      this.started.add(p.id);
    }else if(p.protocol==='ollama'){
      if(!p.exePath||!existsSync(p.exePath)||path.basename(p.exePath).toLowerCase()!=='ollama.exe')throw new Error('请填写已安装的 ollama.exe 路径');
      const u=new URL(rootUrl(p));this.spawnOwned(p,['serve'],{...process.env,OLLAMA_HOST:u.host});
    }else if(p.protocol==='llama'){
      if(!p.exePath||!existsSync(p.exePath)||path.basename(p.exePath).toLowerCase()!=='llama-server.exe')throw new Error('请填写 llama-server.exe 的绝对路径');
      if(!p.modelPath||!existsSync(p.modelPath)||!p.modelPath.toLowerCase().endsWith('.gguf'))throw new Error('请填写已有 GGUF 文件路径');
      if(p.mmprojPath&&!existsSync(p.mmprojPath))throw new Error('视觉投影文件不存在');
      const u=new URL(rootUrl(p));const args=['--host','127.0.0.1','--port',u.port||'80','-m',p.modelPath,'--alias',p.model,'-c',String(Math.min(32768,Math.max(512,Number(p.ctxSize)||4096))),'-ngl',String(Math.min(200,Math.max(0,Number(p.gpuLayers)||0)))];
      if(p.mmprojPath)args.push('--mmproj',p.mmprojPath);
      this.spawnOwned(p,args,process.env);this.owned.add(this.key(p));
    }else throw new Error('在线连接无需启动本地服务');
    const deadline=Date.now()+300000;while(Date.now()<deadline){if((await this.status(p)).online)return this.status(p);const c=this.children.get(p.id);if(p.protocol!=='router'&&(!c||c.startError||c.exitCode!==null))throw new Error('本地服务启动失败，请查看 data/logs');await delay(750);}throw new Error('模型服务启动超时，请查看 data/logs');
  }
  spawnOwned(p,args,env){
    const dir=path.join(this.dataDir,'logs');mkdirSync(dir,{recursive:true});
    const log=createWriteStream(path.join(dir,`runtime-${Date.now()}.log`));
    const c=spawn(p.exePath,args,{cwd:path.dirname(p.exePath),env,windowsHide:true,stdio:['ignore','pipe','pipe']});
    c.stdout.pipe(log,{end:false});c.stderr.pipe(log,{end:false});c.on('error',e=>{c.startError=e;log.end();this.started.delete(p.id);this.owned.delete(this.key(p));});c.on('exit',()=>{log.end();this.children.delete(p.id);this.started.delete(p.id);this.owned.delete(this.key(p));});
    this.children.set(p.id,c);this.started.add(p.id);
  }
  async load(p,autoStart=true){
    if(!p.model)throw new Error('请先选择模型');
    if(!(await this.status(p)).online){if(!autoStart)throw new Error('本地服务未运行');await this.start(p);}
    const key=this.key(p);
    if(p.protocol==='router'){
      const list=await models(p),active=list.filter(m=>['loading','loaded'].includes(m.status));
      if(!list.some(m=>m.id===p.model))throw new Error('Router 中没有此模型，请重新读取模型列表');
      if(active.some(m=>m.id!==p.model)||active.some(m=>!this.owned.has(`${rootUrl(p)}|${m.id}`)))throw new Error('已有外部加载模型，请先在原模型入口释放，工作台不会自动卸载它');
      if(!this.owned.has(key)){this.owned.add(key);await request(rootUrl(p)+'/models/load',{method:'POST',body:{model:p.model},timeout:300000});await this.wait(p,'loaded');}
    }else if(p.protocol==='ollama'){
      const current=await request(rootUrl(p)+'/api/ps',{timeout:10000});
      if((current.models||[]).some(m=>m.name!==p.model||!this.owned.has(key)))throw new Error('Ollama 已有外部加载模型，请先释放再由工作台加载');
      if(!this.owned.has(key)){this.owned.add(key);await request(rootUrl(p)+'/api/generate',{method:'POST',body:{model:p.model,prompt:'',stream:false,keep_alive:'5m'},timeout:300000});}
    }else if(p.protocol==='llama'&&!this.children.has(p.id))throw new Error('此独立服务由外部启动，工作台无法保证自动释放；请使用兼容 API 连接，或先停止外部服务');
    return this.status(p);
  }
  async assertIdle(p){
    const suffix=p.protocol==='router'?`?model=${encodeURIComponent(p.model)}&autoload=false`:'';
    const slots=await request(rootUrl(p)+'/slots'+suffix,{timeout:10000});
    if(!Array.isArray(slots)||!slots.length||slots.some(s=>s.is_processing!==false))throw new Error('无法确认模型空闲，保留模型；请稍后重试释放');
  }
  async unload(p){
    const key=this.key(p);
    if(!this.owned.has(key))return {released:false,reason:'工作台未取得该模型使用权，未卸载外部模型'};
    if(p.protocol==='router'){
      const state=(await models(p)).find(m=>m.id===p.model)?.status;
      if(state!=='unloaded'){await this.assertIdle(p);await request(rootUrl(p)+'/models/unload',{method:'POST',body:{model:p.model},timeout:120000});await this.wait(p,'unloaded',120000);}
    }else if(p.protocol==='ollama'){
      await request(rootUrl(p)+'/api/generate',{method:'POST',body:{model:p.model,prompt:'',stream:false,keep_alive:0},timeout:120000});
      const list=await request(rootUrl(p)+'/api/ps',{timeout:15000});if(list.models?.some(m=>m.name===p.model))throw new Error('Ollama 仍显示模型在内存中，未确认释放');
    }else if(p.protocol==='llama'){
      await this.assertIdle(p);await this.stopChild(p);
    }
    this.owned.delete(key);return {released:true,verified:true,model:p.model,at:new Date().toISOString()};
  }
  async stopChild(p){const c=this.children.get(p.id);if(!c)throw new Error('服务不是由工作台启动');await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('本地服务尚未退出，未强杀')),10000);c.once('exit',()=>{clearTimeout(timer);resolve();});c.kill();});}
  async stop(p){
    if(!this.started.has(p.id))throw new Error('服务不是由工作台启动，拒绝停止外部服务');
    await this.unload(p);
    if(p.protocol==='router'){
      const active=(await models(p)).some(m=>['loaded','loading'].includes(m.status));if(active)throw new Error('还有模型未释放，不能停止 Router');
      await runProcess('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',managerPath(),'-Action','stop']);
    }else if(this.children.has(p.id)){
      if(p.protocol==='ollama'&&(await request(rootUrl(p)+'/api/ps',{timeout:15000})).models?.length)throw new Error('Ollama 还有外部模型，保留服务');
      await this.stopChild(p);
    }
    this.started.delete(p.id);return {stopped:true};
  }
  async withModel(p,fn,autoUnload=true){
    if(!['router','ollama','llama'].includes(p.protocol))return fn();
    return this.exclusive(async()=>{let release={released:false,reason:'已选择保持模型加载'},result;
      this.lastRelease=null;
      try{await this.load(p);result=await fn();}
      finally{if(autoUnload){try{release=await this.unload(p);}catch(e){release={released:false,error:e.message};}}this.lastRelease=release;}
      return {...result,release};
    });
  }
}
