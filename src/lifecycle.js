import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, createWriteStream, lstatSync } from 'node:fs';
import path from 'node:path';
import { models, request, rootUrl } from './providers.js';
import { runProcess } from './secrets.js';
import {prepareManagedRouter,isManagedRouterBaseUrl} from './llama-router.js';

const managerPath=()=>process.env.PW_ROUTER_MANAGER||'';
const delay=ms=>new Promise(r=>setTimeout(r,ms));
export class Lifecycle {
  constructor(dataDir,{spawnProcess=spawn}={}){this.dataDir=dataDir;this.spawnProcess=spawnProcess;this.owned=new Set();this.children=new Map();this.started=new Set();this.locked=false;this.observed=new Map();}
  key(p){return `${rootUrl(p)}|${p.model}`;}
  fingerprint(p){return JSON.stringify([p.protocol,p.baseUrl,p.model,p.exePath||'',p.modelPath||'',p.mmprojPath||'',p.managedRouter===true,p.modelsDir||'']);}
  capabilities(p,{online=null}={}){
    const observation=this.observed.get(p?.id),knownOnline=observation&&observation.fingerprint===this.fingerprint(p)&&Date.now()-observation.at<30000?observation.online:online;
    const local=['router','ollama','llama'].includes(p?.protocol),busy=this.locked;
    const capability=(enabled,reason='')=>({enabled:!!enabled,reason:enabled?'':reason});
    if(!local){const no=capability(false,'此连接不支持本地模型启停');return {busy,start:no,load:no,unload:no,stop:no};}
    let startReason=knownOnline===true?'最近状态检查显示服务已运行': '';
    if(busy)startReason='另一项任务或模型操作正在执行';
    else if(knownOnline===true){}
    else if(p.protocol==='router'&&p.managedRouter===true){
      if(!isManagedRouterBaseUrl(p.baseUrl))startReason='托管 Router 地址须为带显式端口的本机 http://127.0.0.1:<端口>/v1';
      else if(!validExe(p.exePath))startReason='请在高级设置填写有效的 llama-server.exe 路径';
      else if(!validDirectory(p.modelsDir))startReason='请在高级设置填写可读取的 GGUF 模型目录';
    }else if(p.protocol==='router'){
      const expected=(process.env.PW_ROUTER_URL||'http://127.0.0.1:18180').replace(/\/v1\/?$/,'');
      if(rootUrl(p)!==expected)startReason='连接地址与 PW_ROUTER_URL 不匹配';
      else if(!existsSync(managerPath()))startReason='缺少 Router 管理器；请配置 PW_ROUTER_MANAGER，或改用已运行的兼容服务';
    }else if(p.protocol==='ollama'&&(!p.exePath||!existsSync(p.exePath)||path.basename(p.exePath).toLowerCase()!=='ollama.exe'))startReason='请在高级设置填写有效的 ollama.exe 路径';
    else if(p.protocol==='llama'){
      if(!p.exePath||!existsSync(p.exePath)||path.basename(p.exePath).toLowerCase()!=='llama-server.exe')startReason='请在高级设置填写有效的 llama-server.exe 路径';
      else if(!p.modelPath||!existsSync(p.modelPath)||!p.modelPath.toLowerCase().endsWith('.gguf'))startReason='请在高级设置选择已有 GGUF 模型文件';
      else if(p.mmprojPath&&!existsSync(p.mmprojPath))startReason='高级设置中的 mmproj 文件不存在';
    }
    if(p.protocol==='llama'&&!p.model&&!startReason)startReason='请先填写模型 ID，作为本地服务模型别名';
    const modelReason=!p.model?'请先选择模型':'';
    const externalLlama=knownOnline===true&&p.protocol==='llama'&&!this.started.has(p.id);
    const routerNeedsModel=p.protocol==='router'&&p.managedRouter===true&&!p.model;
    const externalRouter=knownOnline===true&&p.protocol==='router'&&p.managedRouter===true&&!this.started.has(p.id);
    const loadReason=busy?'另一项任务或模型操作正在执行':routerNeedsModel?'请先启动并读取模型，再选择要加载的模型':modelReason||(externalLlama?'检测到服务在线，但不是工作台启动的，无法保证模型使用权或自动释放':externalRouter?'服务不是由工作台启动，不能控制外部 Router':knownOnline!==true?startReason:'' );
    const key=this.key(p),owned=this.owned.has(key);
    const unloadReason=busy?'另一项任务或模型操作正在执行':p.protocol==='llama'&&!this.children.has(p.id)?'工作台未取得该连接独立服务的控制权，不会停止外部服务':owned?'':'工作台未取得该模型使用权，不会卸载外部模型';
    const stopReason=busy?'另一项任务或模型操作正在执行':this.started.has(p.id)?'':'服务不是由工作台启动，拒绝停止外部服务';
    return {busy,start:capability(!startReason,startReason),load:capability(!loadReason,loadReason),unload:capability(!unloadReason,unloadReason),stop:capability(!stopReason,stopReason)};
  }
  async exclusive(fn){if(this.locked)throw new Error('本地模型正在执行任务或生命周期操作，请稍后');this.locked=true;try{return await fn();}finally{this.locked=false;}}
  async status(p){
    try{
      const list=await models(p);
      let loaded=list;
      if(p.protocol==='ollama'){const r=await request(rootUrl(p)+'/api/ps',{timeout:10000});loaded=r.models||[];}
      this.observe(p,true);return {online:true,models:list,loaded:p.protocol==='ollama'?loaded.map(m=>m.name):list.filter(m=>['loaded','loading'].includes(m.status)).map(m=>m.id),owned:this.owned.has(this.key(p)),startedByWorkbench:this.started.has(p.id),busy:this.locked};
    }catch(e){this.observe(p,false);return {online:false,error:e.message,models:[],owned:this.owned.has(this.key(p)),startedByWorkbench:this.started.has(p.id),busy:this.locked};}
  }
  observe(p,online){this.observed.set(p.id,{online:online===true,at:Date.now(),fingerprint:this.fingerprint(p)});}
  async wait(p,expected,timeout=300000){
    const deadline=Date.now()+timeout;
    while(Date.now()<deadline){const entry=(await models(p)).find(m=>m.id===p.model);if(entry?.status===expected)return entry;await delay(500);}throw new Error(`模型状态未达到 ${expected}`);
  }
  async start(p){
    const before=await this.status(p);if(before.online)return {alreadyRunning:true,...before};
    if(p.protocol==='router'&&p.managedRouter===true){
      if(!isManagedRouterBaseUrl(p.baseUrl))throw new Error('托管 Router 地址须为带显式端口的本机 http://127.0.0.1:<端口>/v1');
      if(!validExe(p.exePath))throw new Error('请填写有效的 llama-server.exe 绝对路径');
      if(!validDirectory(p.modelsDir))throw new Error('请填写可读取的 GGUF 模型目录');
      const {iniPath}=prepareManagedRouter(this.dataDir,p);
      const port=new URL(p.baseUrl).port||'80',args=['--models-preset',iniPath,'--models-max','1','--no-models-autoload','--host','127.0.0.1','--port',port,'--slots','--fit','on','-c','4096','-np','1'];
      this.spawnOwned(p,args,process.env);
    }else if(p.protocol==='router'){
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
      const u=new URL(rootUrl(p)),gpuLayers=Math.min(200,Math.max(0,Number(p.gpuLayers)||0));const args=['--host','127.0.0.1','--port',u.port||'80','-m',p.modelPath,'--alias',p.model,'-c',String(Math.min(32768,Math.max(512,Number(p.ctxSize)||4096))),'-ngl',String(gpuLayers)];
      if(p.mmprojPath){args.push('--mmproj',p.mmprojPath);if(gpuLayers===0)args.push('--no-mmproj-offload');}
      this.spawnOwned(p,args,process.env);this.owned.add(this.key(p));
    }else throw new Error('在线连接无需启动本地服务');
    const deadline=Date.now()+300000;while(Date.now()<deadline){if((await this.status(p)).online)return this.status(p);const c=this.children.get(p.id);if((p.protocol!=='router'||p.managedRouter===true)&&(!c||c.startError||c.exitCode!==null))throw new Error('本地服务启动失败，请查看 data/logs');await delay(750);}throw new Error('模型服务启动超时，请查看 data/logs');
  }
  spawnOwned(p,args,env){
    const dir=path.join(this.dataDir,'logs');mkdirSync(dir,{recursive:true});
    const log=createWriteStream(path.join(dir,`runtime-${Date.now()}.log`));
    const c=this.spawnProcess(p.exePath,args,{cwd:path.dirname(p.exePath),env,windowsHide:true,stdio:['ignore','pipe','pipe']});
    c.stdout.pipe(log,{end:false});c.stderr.pipe(log,{end:false});const clearOwned=()=>{const prefix=`${rootUrl(p)}|`;for(const key of this.owned)if(key.startsWith(prefix))this.owned.delete(key);};c.on('error',e=>{c.startError=e;log.end();this.observe(p,false);this.started.delete(p.id);clearOwned();});c.on('exit',()=>{log.end();this.observe(p,false);this.children.delete(p.id);this.started.delete(p.id);clearOwned();});
    this.children.set(p.id,c);this.started.add(p.id);
  }
  async load(p,autoStart=true){
    if(!p.model)throw new Error('请先选择模型');
    if(!(await this.status(p)).online){if(!autoStart)throw new Error('本地服务未运行');await this.start(p);}
    if(p.protocol==='router'&&p.managedRouter===true&&!this.children.has(p.id))throw new Error('Router 不是由工作台启动的，拒绝控制外部服务');
    const key=this.key(p);
    if(p.protocol==='router'){
      const list=await models(p),active=list.filter(m=>['loading','loaded'].includes(m.status));
      if(!list.some(m=>m.id===p.model))throw new Error('Router 中没有此模型，请重新读取模型列表');
      if(p.managedRouter===true){
        if(active.some(m=>m.status==='loading'&&m.id!==p.model))throw new Error('有其他模型仍在加载，暂不能切换；请稍后重试');
        const external=active.filter(m=>!this.owned.has(`${rootUrl(p)}|${m.id}`));if(external.length)throw new Error('Router 中有外部加载模型，工作台不会卸载或替换它');
        for(const current of active.filter(m=>m.id!==p.model)){const previous={...p,model:current.id};await this.assertIdle(previous);await request(rootUrl(p)+'/models/unload',{method:'POST',body:{model:current.id},timeout:120000});await this.wait(previous,'unloaded',120000);this.owned.delete(this.key(previous));}
        const target=list.find(m=>m.id===p.model);
        if(target.status==='loaded'){
          if(!this.owned.has(key))throw new Error('Router 模型已加载但工作台没有该模型的使用权');
        }else if(target.status==='loading'){
          if(!this.owned.has(key))throw new Error('Router 模型正在加载但工作台没有该模型的使用权');
          await this.wait(p,'loaded');
        }else if(target.status==='unloaded'){
          this.owned.add(key);await request(rootUrl(p)+'/models/load',{method:'POST',body:{model:p.model},timeout:300000});await this.wait(p,'loaded');
        }else throw new Error('无法确认 Router 模型状态，请刷新服务目录后重试');
      }else if(active.some(m=>m.id!==p.model)||active.some(m=>!this.owned.has(`${rootUrl(p)}|${m.id}`)))throw new Error('已有外部加载模型，请先在原模型入口释放，工作台不会自动卸载它');
      if(p.managedRouter!==true&&!this.owned.has(key)){this.owned.add(key);await request(rootUrl(p)+'/models/load',{method:'POST',body:{model:p.model},timeout:300000});await this.wait(p,'loaded');}
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
    this.observe(p,p.protocol!=='llama');
    this.owned.delete(key);return {released:true,verified:true,model:p.model,at:new Date().toISOString()};
  }
  async stopChild(p){const c=this.children.get(p.id);if(!c)throw new Error('服务不是由工作台启动');await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('本地服务尚未退出，未强杀')),10000);c.once('exit',()=>{clearTimeout(timer);resolve();});c.kill();});this.observe(p,false);}
  async stop(p){
    if(!this.started.has(p.id))throw new Error('服务不是由工作台启动，拒绝停止外部服务');
    await this.unload(p);
    if(p.protocol==='router'&&p.managedRouter!==true){
      const active=(await models(p)).some(m=>['loaded','loading'].includes(m.status));if(active)throw new Error('还有模型未释放，不能停止 Router');
      await runProcess('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',managerPath(),'-Action','stop']);
    }else if(p.protocol==='router'&&p.managedRouter===true){
      const active=(await models(p)).some(m=>['loaded','loading'].includes(m.status));if(active)throw new Error('还有模型未释放，不能停止 Router');
      await this.stopChild(p);
    }else if(this.children.has(p.id)){
      if(p.protocol==='ollama'&&(await request(rootUrl(p)+'/api/ps',{timeout:15000})).models?.length)throw new Error('Ollama 还有外部模型，保留服务');
      await this.stopChild(p);
    }
    this.started.delete(p.id);this.observe(p,false);return {stopped:true};
  }
  async withModel(p,fn,autoUnload=true,onRelease){
    if(!['router','ollama','llama'].includes(p.protocol))return fn();
    return this.exclusive(async()=>{let release={released:false,reason:'已选择保持模型加载'},result;
      this.lastRelease=null;
      try{await this.load(p);result=await fn();}
      finally{if(autoUnload){try{release=await this.unload(p);}catch(e){release={released:false,error:e.message};}}this.lastRelease=release;onRelease?.(release);}
      return {...result,release};
    });
  }
}
function validExe(file){try{const s=lstatSync(file);return path.isAbsolute(file)&&s.isFile()&&!s.isSymbolicLink()&&path.basename(file).toLowerCase()==='llama-server.exe';}catch{return false;}}
function validDirectory(dir){try{const s=lstatSync(dir);return path.isAbsolute(dir)&&s.isDirectory()&&!s.isSymbolicLink();}catch{return false;}}
