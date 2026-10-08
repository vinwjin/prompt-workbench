import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, existsSync, createReadStream } from 'node:fs';
import {AssetMedia} from './asset-media.js';
import { randomBytes, createHash } from 'node:crypto';
import { Store } from './store.js';
import {trashItems,manageTrash} from './trash.js';
import { SecretVault } from './secrets.js';
import { PRESETS } from './catalog.js';
import { validateProvider, models } from './providers.js';
import { Lifecycle } from './lifecycle.js';
import {VERSION} from '../public/version.js';
import { Jobs } from './jobs.js';
import { bulkManage, saveAsset, provenance, resultAsset, exportAssets } from './library.js';
import { Sources } from './sources.js';
import { ImageCache } from './image-cache.js';
import {XInbox} from './x-inbox.js';
import {saveTemplate,previewTemplate} from './template-studio.js';
import {saveSnippet,composeInput,compareJobs,iterationChain,qualityRules} from './prompt-lab.js';
import {checkQuality} from './quality.js';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export async function createWorkbench({dataDir=path.join(ROOT,'data'),port=18765,store=new Store(dataDir),vault=new SecretVault(),lifecycle=new Lifecycle(dataDir),generator,sourceFetcher,imageFetcher,xFetcher}={}){
  const token=randomBytes(32).toString('hex');const jobs=new Jobs(store,vault,lifecycle,{generator});
  const assetMedia=new AssetMedia(store);
  const imageCache=new ImageCache(store,{fetcher:imageFetcher});
  const sources=new Sources(store,{fetcher:sourceFetcher,imageVerifier:url=>imageCache.get(url)});
  const inbox=new XInbox(store,{fetcher:xFetcher});
  const leaseKeys=p=>[...lifecycle.owned].filter(key=>key.startsWith(lifecycle.key({...p,model:''})));
  const leasedProvider=p=>{const prefix=lifecycle.key({...p,model:''}),key=leaseKeys(p)[0];return key?{...p,model:key.slice(prefix.length)}:p;};
  const sameConnection=(a,b)=>!!a&&a.baseUrl===b.baseUrl&&a.protocol===b.protocol&&a.sealedKey===b.sealedKey;
  const iniPath=process.env.PW_ROUTER_INI||'';
  for(const p of store.list('providers'))if(p.protocol==='router'&&p.baseUrl==='http://127.0.0.1:18180/v1'&&!store.get('modelLists',p.id)&&existsSync(iniPath)){
    const ids=[...readFileSync(iniPath,'utf8').matchAll(/^\[([^\]\r\n]+)\]\s*$/gm)].map(m=>m[1]).filter(id=>id!=='*');
    store.put('modelLists',{id:p.id,models:ids.map(id=>({id,status:'configured'})),source:'local-configuration',checkedAt:new Date().toISOString()});
  }
  let stopping=false;
  const json=(res,code,data)=>{res.writeHead(code,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
  const body=async req=>{req.setEncoding('utf8');let raw='',size=0;for await(const chunk of req){size+=Buffer.byteLength(chunk);if(size>((req.url==='/api/import'||req.url==='/api/assets/import')?320e6:14e6))throw new Error('请求过大，请缩小文件或分批导入');raw+=chunk;}if(!raw)return {};try{return JSON.parse(raw);}catch{throw new Error('JSON 格式无效');}};
  const privateProvider=async id=>{const p=store.get('providers',id);if(!p)throw new Error('连接不存在');return {...p,apiKey:await vault.open(p.sealedKey)};};
  const server=http.createServer(async(req,res)=>{
    res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('Cross-Origin-Resource-Policy','same-origin');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'");
    const actualPort=server.address()?.port||port;const hosts=[`127.0.0.1:${actualPort}`,`localhost:${actualPort}`];
    if(!hosts.includes(req.headers.host))return json(res,403,{error:'访问地址不受信任'});
    const url=new URL(req.url,`http://${req.headers.host}`),route=url.pathname;
    if(req.headers.origin&&!hosts.some(h=>req.headers.origin===`http://${h}`))return json(res,403,{error:'拒绝跨站访问'});
    if(route==='/health'&&req.method==='GET')return json(res,200,{app:'prompt-workbench',version:VERSION,instance:createHash('sha256').update((ROOT+'|'+store.dir).toLowerCase()).digest('hex').slice(0,16)});
    if(!route.startsWith('/api/')){
      const files={'/':'index.html','/app.js':'app.js','/version.js':'version.js','/studio.js':'studio.js','/collections.js':'collections.js','/source-manager.js':'source-manager.js','/recycle.js':'recycle.js','/dialogs.js':'dialogs.js','/folders.js':'folders.js','/lab.js':'lab.js','/asset-import.js':'asset-import.js','/prompt-import.js':'prompt-import.js','/style.css':'style.css','/manifest.json':'manifest.json','/icon.svg':'icon.svg'};
      if(req.method!=='GET'||!files[route])return json(res,404,{error:'页面不存在'});
      if(route==='/')res.setHeader('Set-Cookie',`pw_session=${token}; HttpOnly; SameSite=Strict; Path=/`);
      const name=files[route],types={html:'text/html',js:'text/javascript',css:'text/css',json:'application/json',svg:'image/svg+xml'};
      res.writeHead(200,{'Content-Type':types[name.split('.').pop()]+'; charset=utf-8','Cache-Control':'no-store'});return res.end(readFileSync(path.join(ROOT,'public',name)));
    }
    if(!String(req.headers.cookie||'').split(';').some(c=>c.trim()===`pw_session=${token}`))return json(res,401,{error:'请从工作台页面重新连接'});
    if(stopping)return json(res,503,{error:'工作台正在关闭'});
    try{
      if(!['GET','POST','DELETE'].includes(req.method))throw new Error('请求方法不支持');
      if(req.method==='POST'&&route!=='/api/media/upload'&&!String(req.headers['content-type']||'').startsWith('application/json'))return json(res,415,{error:'仅接受 JSON'});

      if(route==='/api/media/upload'&&req.method==='POST'){if(req.headers['content-type']!=='application/octet-stream')throw Error('素材上传格式无效');return json(res,200,await assetMedia.upload(req,url.searchParams.get('name')));}
      const stagedMedia=route.match(/^\/api\/media\/staged\/([A-Za-z0-9-]+)$/);if(stagedMedia&&req.method==='DELETE'){assetMedia.discard(stagedMedia[1]);return json(res,200,{discarded:true});}
      const linkedMedia=route.match(/^\/api\/assets\/([A-Za-z0-9_-]+)\/media\/([a-f0-9]{64})$/);
      if(linkedMedia&&req.method==='GET'){const row=assetMedia.linked(linkedMedia[1],linkedMedia[2]);let start=0,end=row.bytes-1,code=200;const range=req.headers.range;if(range){const m=range.match(/^bytes=(\d*)-(\d*)$/);if(!m||!m[1]&&!m[2]){res.writeHead(416,{'Content-Range':'bytes */'+row.bytes});return res.end();}if(!m[1])start=Math.max(0,row.bytes-Number(m[2]));else start=Number(m[1]);if(m[1]&&m[2])end=Math.min(end,Number(m[2]));if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start> end||start>=row.bytes){res.writeHead(416,{'Content-Range':'bytes */'+row.bytes});return res.end();}code=206;res.setHeader('Content-Range','bytes '+start+'-'+end+'/'+row.bytes);}res.writeHead(code,{'Content-Type':row.type,'Content-Length':end-start+1,'Accept-Ranges':'bytes','Cache-Control':'no-store',...(url.searchParams.get('download')==='1'?{'Content-Disposition':"attachment; filename*=UTF-8''"+encodeURIComponent(row.name)}:{})});const stream=createReadStream(row.file,{start,end});stream.on('error',()=>res.destroy());res.on('close',()=>stream.destroy());return stream.pipe(res);}
      let b=req.method==='POST'?await body(req):{};

      if(route==='/api/database'&&req.method==='GET')return json(res,200,store.diagnostics());
      if(route==='/api/trash'&&req.method==='GET')return json(res,200,{items:trashItems(store)});
      if(route==='/api/trash/manage'&&req.method==='POST')return json(res,200,manageTrash(store,b));
      if(route==='/api/progress'&&req.method==='GET')return json(res,200,{revision:store.revision,activeJobId:jobs.active?.id,queued:jobs.queue.length,job:jobs.progress(url.searchParams.get('id'))});
      if(route==='/api/snippets'&&req.method==='GET')return json(res,200,{items:store.list('snippets').filter(s=>!s.deletedAt)});
      if(route==='/api/snippets'&&req.method==='POST')return json(res,200,saveSnippet(store,b));
      const snippetRoute=route.match(/^\/api\/snippets\/([^/]+)$/);
      if(snippetRoute&&req.method==='DELETE'){const s=store.get('snippets',snippetRoute[1]);if(!s||s.deletedAt)throw Error('片段不存在或在回收站');store.backup();store.put('snippets',{...s,deletedAt:new Date().toISOString()});return json(res,200,{recoverable:true});}
      if(route==='/api/compose'&&req.method==='POST')return json(res,200,composeInput(store,b.input||'',b.snippetIds||[]));
      if(route==='/api/quality/check'&&req.method==='POST')return json(res,200,checkQuality(b.text,b.rules));
      if(route==='/api/compare'&&req.method==='GET')return json(res,200,compareJobs(store,url.searchParams.get('left'),url.searchParams.get('right')));
      if(route==='/api/chain'&&req.method==='GET')return json(res,200,iterationChain(store,url.searchParams.get('job')));
      if(route==='/api/templates/import'&&req.method==='POST'){if(b.schema!=='prompt-workbench/templates/v1'||!Array.isArray(b.templates)||!b.templates.length||b.templates.length>100)throw Error('模板导入格式无效，最多100条');store.backup();store.db.exec('BEGIN IMMEDIATE');try{for(const t of b.templates){const {id,builtin,revisions,deletedAt,...copy}=t;saveTemplate(store,copy);}store.db.exec('COMMIT');}catch(e){store.db.exec('ROLLBACK');throw e;}return json(res,200,{imported:b.templates.length});}
      if(route==='/api/inbox'&&req.method==='GET')return json(res,200,{items:store.list('inbox')});
      if(route==='/api/inbox/capture'&&req.method==='POST')return json(res,200,await inbox.capture(b.url));
      if(route==='/api/inbox/manage'&&req.method==='POST')return json(res,200,inbox.manage(b));
      const inboxRoute=route.match(/^\/api\/inbox\/([0-9]+)\/(collect|image)$/);
      if(inboxRoute){const [,id,action]=inboxRoute;if(action==='collect'&&req.method==='POST')return json(res,200,inbox.collect(id,b));if(action==='image'&&req.method==='GET'){const item=store.get('inbox',id),p=item?.posts.find(p=>p.id===url.searchParams.get('post'));const media=p?.images[Number(url.searchParams.get('index'))||0];if(!media)throw Error('该帖子没有此图片');const img=await imageCache.get(media);res.writeHead(200,{'Content-Type':img.type,'Cache-Control':'no-store'});return res.end(img.data);}}
      if(route==='/api/templates/preview'&&req.method==='POST')return json(res,200,previewTemplate(b.template,b.variables||{}));
      const restoreTemplate=route.match(/^\/api\/templates\/([^/]+)\/restore$/);
      if(restoreTemplate&&req.method==='POST'){const t=store.get('templates',restoreTemplate[1]),v=!t?.deletedAt&&t?.revisions?.find(v=>v.revision===Number(b.revision));if(!v)throw Error('模板版本不存在');return json(res,200,saveTemplate(store,{...v,variableSchema:v.variableSchema||[],id:t.id,status:'draft'}));}
      if(route==='/api/state'&&req.method==='GET')return json(res,200,{providers:store.list('providers').map(p=>store.publicProvider(p)),templates:store.list('templates').filter(t=>!t.deletedAt),revision:store.revision,assets:store.list('assets').map(a=>({...a,isResult:resultAsset(store,a)})),folders:store.list('folders'),modelLists:store.list('modelLists'),feeds:sources.catalog(),sourceBatch:sources.batchStatus(),jobs:store.jobPage({limit:250}).jobs,draft:store.get('drafts','workbench'),presets:PRESETS,activeJobId:jobs.active?.id,dataDir:store.dir});
      const historyFilters=()=>({query:String(url.searchParams.get('q')||'').slice(0,300),status:String(url.searchParams.get('status')||''),providerId:String(url.searchParams.get('provider')||''),trash:url.searchParams.get('trash')==='true'});
      if(route==='/api/history'&&req.method==='GET')return json(res,200,store.jobPage({...historyFilters(),offset:Math.max(0,Math.floor(Number(url.searchParams.get('offset'))||0)),limit:100}));
      if(route==='/api/history/manage'&&req.method==='POST'){
        const page=b.all?store.jobPage({...b.filters,limit:10000}):null;
        if(page?.total>10000)throw new Error('筛选结果超过 10000 条，请缩小筛选范围后分批清理；本次没有清理任何记录');
        const ids=page?page.jobs.map(j=>j.id):b.ids;
        return json(res,200,bulkManage(store,'jobs',{...b,ids}));
      }
      if(route==='/api/assets/manage'&&req.method==='POST')return json(res,200,bulkManage(store,'assets',b));
      if(route==='/api/assets/export'&&req.method==='POST'){const result=exportAssets(store,b.ids);return json(res,200,{...result,mediaFiles:assetMedia.exportFiles(result.assets)});}
      if(route==='/api/assets/import'&&req.method==='POST'){
        if(b.schema!=='prompt-workbench/assets/v1'||!Array.isArray(b.assets)||!b.assets.length||b.assets.length>1000)throw new Error('提示词导入文件格式无效，最多 1000 条');
        const importedMedia=assetMedia.importFiles(b.mediaFiles);try{assetMedia.validateReferences(b.assets);
        const assetKey=a=>JSON.stringify([a.title,a.content,a.negative||'',a.modelHint||'',(a.media||[]).map(m=>m.id).sort()]);
        store.backup();let imported=0,skipped=0;store.db.exec('BEGIN IMMEDIATE');try{const keys=new Set(store.list('assets').filter(a=>!a.deletedAt).map(assetKey));for(const row of b.assets){if(keys.has(assetKey(row))){skipped++;continue;}const a=saveAsset(store,{...row,id:undefined,folderId:store.get('folders',row.folderId||'')?row.folderId:''},{allowResultRecord:true,mediaSelection:row.media||[]});keys.add(assetKey(a));imported++;}store.db.exec('COMMIT');}catch(e){store.db.exec('ROLLBACK');throw e;}return json(res,200,{imported,skipped});}catch(e){assetMedia.rollbackImport(importedMedia);throw e;}
      }
      if(route==='/api/folders'&&req.method==='POST'){
        if(typeof b.name!=='string'||!b.name.trim())throw new Error('请输入文件夹名称');
        if(b.id&&!store.get('folders',b.id))throw Error('文件夹不存在');if(b.id&&b.expectedUpdatedAt&&store.get('folders',b.id).updatedAt!==b.expectedUpdatedAt)throw Error('文件夹已更改，请重新选择后编辑');
        if(store.list('folders').some(f=>f.id!==b.id&&f.name.trim().toLocaleLowerCase()===b.name.trim().slice(0,80).toLocaleLowerCase()))throw Error('已有同名文件夹，请直接使用或更换名称');
        return json(res,200,store.put('folders',{id:b.id,name:b.name.trim().slice(0,80)}));
      }
      const folderRoute=route.match(/^\/api\/folders\/([^/]+)$/);
      if(folderRoute&&req.method==='DELETE'){
        const id=folderRoute[1];if(!store.get('folders',id))throw Error('文件夹不存在，请刷新后重试');store.backup();store.db.exec('BEGIN IMMEDIATE');try{for(const a of store.list('assets'))if(a.folderId===id)store.put('assets',{...a,folderId:''});store.remove('folders',id);store.db.exec('COMMIT');}catch(e){store.db.exec('ROLLBACK');throw e;}return json(res,200,{deleted:true,assetsPreserved:true});
      }
      if(route==='/api/cache'&&req.method==='GET')return json(res,200,{...imageCache.stats(),publicEntries:sources.list({limit:1}).total});
      if(route==='/api/cache/settings'&&req.method==='POST')return json(res,200,imageCache.configure(b));
      if(route==='/api/cache/clear'&&req.method==='POST')return json(res,200,await imageCache.clear({expiredOnly:b.expiredOnly===true}));
      if(route==='/api/shared'&&req.method==='GET')return json(res,200,sources.list({source:String(url.searchParams.get('source')||''),query:String(url.searchParams.get('q')||'').slice(0,300),kind:String(url.searchParams.get('kind')||'all'),sort:String(url.searchParams.get('sort')||'latest'),limit:Number(url.searchParams.get('limit'))||20,offset:Math.max(0,Math.floor(Number(url.searchParams.get('offset'))||0))}));
      const feedRoute=route.match(/^\/api\/sources\/([^/]+)\/sync$/);
      if(feedRoute&&req.method==='POST')return json(res,200,await sources.sync(feedRoute[1],{page:b.page}));
      if(route==='/api/sources/batch'&&req.method==='POST')return json(res,202,sources.startBatch(b.ids));
      if(route==='/api/sources/batch'&&req.method==='GET')return json(res,200,{...sources.batchStatus(),feeds:sources.catalog()});
      const sourceImport=route.match(/^\/api\/sources\/([^/]+)\/import$/);
      if(sourceImport&&req.method==='POST')return json(res,200,sources.importFile(sourceImport[1],b));
      const sharedRoute=route.match(/^\/api\/shared\/([^/]+)(?:\/(collect|template|image))?$/);
      if(sharedRoute){const [,id,action]=sharedRoute;
        if(req.method==='GET'&&action==='image'){const item=store.get('shared',id);const index=Number(url.searchParams.get('index')||0);if(!Number.isInteger(index)||index<0||index>7)throw Error('图片序号无效');const imageUrl=item?.coverUrls?.length?item.coverUrls[index]:index===0?item?.coverUrl:'';if(!imageUrl)throw new Error('该条目没有此效果图');const feed=sources.feed(item.sourceId);const image=await imageCache.get(imageUrl,{allowDownload:feed.syncable!==false});res.writeHead(200,{'Content-Type':image.type,'Content-Length':image.data.length,'Cache-Control':'no-store','X-Image-Cache':image.cached?'HIT':'MISS'});return res.end(image.data);}
        if(req.method==='GET'&&!action)return json(res,200,await sources.detail(id));
        if(req.method==='POST'&&['collect','template'].includes(action)){
          const item=await sources.detail(id);const provenance={sourceId:item.sourceId,originId:item.originId,url:item.sourceUrl,author:item.author,license:item.license};
          if(action==='template'){if(item.content.length>40000)throw new Error('条目超过模板长度，请先收藏后编辑精简');const existing=store.list('templates').find(t=>t.source?.sourceId===item.sourceId&&t.source.originId===item.originId);if(existing?.deletedAt){store.backup();return json(res,200,store.put('templates',{...existing,deletedAt:null}));}return json(res,200,existing||store.put('templates',{name:item.title.slice(0,100),category:'社区导入',system:item.content,user:'{{input}}',builtin:false,source:provenance}));}
          const existing=store.list('assets').find(a=>a.source?.sourceId===item.sourceId&&a.source.originId===item.originId);if(existing?.deletedAt){store.backup();return json(res,200,store.put('assets',{...existing,deletedAt:null}));}
          return json(res,200,existing||saveAsset(store,{title:item.title,content:item.content,negative:item.negative,modelHint:item.modelHint,tags:item.tags,category:'分享收藏',note:item.description,source:provenance}));
        }
      }
      const selection=route.match(/^\/api\/providers\/([^/]+)\/selection$/);
      if(selection&&req.method==='POST'){
        if(jobs.active||lifecycle.locked)throw new Error('请等当前任务或模型操作完成');const p=store.get('providers',selection[1]);if(!p)throw new Error('连接不存在');
        if(leaseKeys(p).length)throw new Error('请先释放当前模型，再切换');
        const model=String(b.model||'').trim();if(!model||model.length>180)throw new Error('模型 ID 无效');return json(res,200,store.publicProvider(store.put('providers',{...p,model})));
      }
      if(route==='/api/providers'&&req.method==='POST'){
        if(jobs.active||lifecycle.locked)throw new Error('任务或模型操作执行中，连接配置暂不可修改');
        const old=store.get('providers',String(b.id||''));if(b.id&&!old)throw Error('连接不存在，请刷新后重新添加');if(old&&b.expectedUpdatedAt&&b.expectedUpdatedAt!==old.updatedAt)throw Error('连接已更新，请重新打开编辑');
        const p=validateProvider({id:old?.id,name:b.name,protocol:b.protocol,baseUrl:b.baseUrl,model:String(b.model||'').slice(0,180),timeoutMs:Math.min(1800000,Math.max(10000,Number(b.timeoutMs)||300000)),exePath:String(b.exePath||''),modelPath:String(b.modelPath||''),mmprojPath:String(b.mmprojPath||''),gpuLayers:Number(b.gpuLayers)||0,ctxSize:Number(b.ctxSize)||4096});
        if(old&&(leaseKeys(old).length||lifecycle.started.has(old.id)))throw new Error('请先释放模型并停止此连接服务，再编辑配置');
        Object.assign(p,validateProvider({...p,tokenField:b.tokenField||'auto',temperatureMode:b.temperatureMode||'auto'}));
        p.sealedKey=b.clearKey?null:b.apiKey?await vault.seal(String(b.apiKey).trim()):old?.sealedKey;
        if(jobs.active||lifecycle.locked)throw Error('任务或模型操作执行中，连接配置暂不可修改');if(old&&store.get('providers',old.id)?.updatedAt!==old.updatedAt)throw Error('连接已更新，请重新打开编辑');if(old)store.remove('modelLists',old.id);
        return json(res,200,store.publicProvider(store.put('providers',p)));
      }
      if(route==='/api/models/discover'&&req.method==='POST'){
        const old=store.get('providers',String(b.id||'')),p=validateProvider({name:b.name||'连接',protocol:b.protocol,baseUrl:b.baseUrl,model:b.model||''});
        p.apiKey=String(b.apiKey||'')||await vault.open(old?.sealedKey);
        try{return json(res,200,{models:await models(p)});}catch(e){throw new Error(p.apiKey?e.message.split(p.apiKey).join('[密钥已隐藏]'):e.message);}
      }
      const providerRoute=route.match(/^\/api\/providers\/([^/]+)\/(models|status|start|load|unload|stop)$/);
      if(providerRoute){const [,id,action]=providerRoute;const p=await privateProvider(id);
        if(['models','status'].includes(action)&&req.method==='GET'){
          try{const result=action==='models'?{models:await models(p)}:await lifecycle.status(leasedProvider(p));if(action==='models'){if(!sameConnection(store.get('providers',p.id),p))throw new Error('连接已更改，请重新读取模型列表');store.put('modelLists',{id:p.id,models:result.models.slice(0,2000),checkedAt:new Date().toISOString()});}if(result.error&&p.apiKey)result.error=result.error.split(p.apiKey).join('[密钥已隐藏]');return json(res,200,result);}catch(e){throw new Error(p.apiKey?e.message.split(p.apiKey).join('[密钥已隐藏]'):e.message);}
        }
        if(req.method!=='POST')throw new Error('生命周期操作需要 POST');
        if(jobs.active)throw new Error('请先完成或取消正在执行的任务');
        try{const actual=['unload','stop'].includes(action)?leasedProvider(p):p;const result=await lifecycle.exclusive(()=>lifecycle[action](actual));if(result.error&&p.apiKey)result.error=result.error.split(p.apiKey).join('[密钥已隐藏]');return json(res,200,result);}catch(e){throw new Error(p.apiKey?e.message.split(p.apiKey).join('[密钥已隐藏]'):e.message);}
      }
      if(route==='/api/templates'&&req.method==='POST'){
        return json(res,200,saveTemplate(store,b));
      }
      if(route==='/api/assets'&&req.method==='POST'){
        const mediaSelection=assetMedia.resolve(b.media,b.id,b.copyOf);store.backup();const asset=saveAsset(store,b,{mediaSelection});assetMedia.committed(b.media);return json(res,200,asset);
      }
      if(route==='/api/draft'&&req.method==='POST'){return json(res,200,store.put('drafts',{id:'workbench',source:provenance(b.source),input:String(b.input||'').slice(0,60000),snippetIds:Array.isArray(b.snippetIds)?b.snippetIds.filter(id=>typeof id==='string').slice(0,20):[],snippetVersions:b.snippetVersions&&typeof b.snippetVersions==='object'&&!Array.isArray(b.snippetVersions)?Object.fromEntries(Object.entries(b.snippetVersions).slice(0,20).filter(([k,v])=>k.length<=100&&typeof v==='string'&&v.length<=100)): {},qualityRules:qualityRules(b.qualityRules),model:String(b.model||'').slice(0,180),templateId:b.templateId,providerId:b.providerId,variables:b.variables||{},autoUnload:b.autoUnload!==false,stream:b.stream!==false,temperature:Number.isFinite(Number(b.temperature))?Math.min(2,Math.max(0,Number(b.temperature))):0.6,maxTokens:Number(b.maxTokens)||1024}));}
      if(route==='/api/jobs'&&req.method==='POST')return json(res,202,jobs.enqueue(b));
      if(route==='/api/batch'&&req.method==='POST'){
        if(!Array.isArray(b.inputs)||!b.inputs.length||b.inputs.length>50)throw new Error('每批需要 1–50 条输入');
        // 先统一验证，避免部分入队后才报错
        const provider=store.get('providers',b.providerId),template=store.get('templates',b.templateId);if(!provider?.model||!template)throw new Error('请配置模型与模板');
        for(const input of b.inputs){if(typeof input!=='string'||!input.trim()||input.length>60000)throw new Error('批量输入无效');}
        return json(res,202,{jobs:jobs.enqueueBatch(b.inputs.map(input=>({...b,input,images:[]})))});
      }
      const jobRoute=route.match(/^\/api\/jobs\/([^/]+)(?:\/(cancel|retry))?$/);
      if(jobRoute){const [,id,action]=jobRoute;const j=store.get('jobs',id);if(!j)throw new Error('任务不存在');
        if(req.method==='GET'&&!action)return json(res,200,j);
        if(req.method==='POST'&&action==='cancel')return json(res,200,jobs.cancel(id));
        if(req.method==='POST'&&action==='retry'){if(['running','queued','cancelling'].includes(j.status))throw new Error('任务尚未结束');return json(res,202,jobs.retry(id));}
      }
      const deletion=route.match(/^\/api\/(templates|assets|providers)\/([^/]+)$/);
      if(deletion&&req.method==='DELETE'){if(jobs.active||jobs.queue.length||lifecycle.locked)throw new Error('任务或模型操作尚未完成，暂不可删除');const [,kind,id]=deletion;if(kind==='providers'){const p=store.get(kind,id);if(p&&(leaseKeys(p).length||lifecycle.started.has(id)))throw new Error('请先释放模型并停止服务');}const record=store.get(kind,id);if(!record)throw Error('记录不存在');store.backup();if(kind==='providers')store.remove(kind,id);else store.put(kind,{...record,deletedAt:new Date().toISOString()});return json(res,200,{deleted:true,recoverable:kind!=='providers'});}
      if(route==='/api/export'&&req.method==='GET'){const result=store.export();return json(res,200,{...result,mediaFiles:assetMedia.exportFiles(result.assets)});}
      if(route==='/api/backup'&&req.method==='POST')return json(res,200,{file:store.backup()});
      if(route==='/api/import'&&req.method==='POST'){
        if(jobs.active||jobs.queue.length)throw new Error('任务执行中不能恢复');
        for(const p of b.providers||[])validateProvider(p);
        for(const t of b.templates||[])if(typeof t.system!=='string'||typeof t.user!=='string'||!t.name)throw new Error('备份模板无效');
        const importedMedia=assetMedia.importFiles(b.mediaFiles);try{assetMedia.validateReferences(b.assets||[]);return json(res,200,store.import(b));}catch(e){assetMedia.rollbackImport(importedMedia);throw e;}
      }
      if(route==='/api/shutdown'&&req.method==='POST'){json(res,200,{stopping:true});setImmediate(()=>close());return;}
      return json(res,404,{error:'接口不存在'});
    }catch(e){return json(res,400,{error:String(e.message||e).slice(0,1200)});}
  });
  server.requestTimeout=30000;
  async function close(){if(stopping)return;stopping=true;const done=await jobs.shutdown();if(!done){stopping=false;jobs.closing=false;console.error('任务仍在释放模型，工作台暂未退出，请稍后重试关闭');return;}
    const inboxDeadline=Date.now()+20000;while(inbox.busy.size&&Date.now()<inboxDeadline)await new Promise(r=>setTimeout(r,100));if(inbox.busy.size){stopping=false;jobs.closing=false;console.error('X读取尚未结束，请稍后关闭');return;}
    await sources.close();await Promise.allSettled([...imageCache.pending.values(),...assetMedia.pending]);
    for(const saved of store.list('providers'))try{const p=leasedProvider(saved);if(leaseKeys(p).length)await lifecycle.exclusive(()=>lifecycle.unload(p));if(lifecycle.started.has(p.id))await lifecycle.exclusive(()=>lifecycle.stop(p));}catch(e){console.error('释放未确认：'+e.message);}
    store.backup();await new Promise(r=>server.close(r));store.close();
  }
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
  return {server,store,jobs,lifecycle,sources,imageCache,assetMedia,inbox,close,port:server.address().port};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const app=await createWorkbench({dataDir:process.env.PW_DATA_DIR||path.join(ROOT,'data'),port:Number(process.env.PW_PORT)||18765});
  console.log(`提示词工坊：http://127.0.0.1:${app.port}`);
  process.on('SIGINT',()=>app.close());process.on('SIGTERM',()=>app.close());
}
