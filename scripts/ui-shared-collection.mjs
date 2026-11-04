import {spawn} from 'node:child_process';
import {mkdirSync,mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import assert from 'node:assert/strict';
import {setTimeout as sleep} from 'node:timers/promises';
import {createWorkbench} from '../tests/source-fixtures.js';
import {removeOwnedArtifact} from './test-artifacts.mjs';
const out=path.resolve('work/shared-collection-dev21/ui');mkdirSync(out,{recursive:true});
const data=mkdtempSync(path.join(out,'data-')),profile=mkdtempSync(path.join(out,'chrome-'));let fail=true,reads=0;
const app=await createWorkbench({dataDir:data,port:0,imageFetcher:async()=>{reads++;return fail?new Response('',{status:503}):new Response(readFileSync('public/icon-256.png'));}});
app.store.put('shared',{id:'ui-collection',sourceId:'s05',originId:'ui-collection',title:'收藏图片与来源验收',content:'保留木质墙面、自然光与空间动线的完整提示词正文。',negative:'模糊',tags:'空间',author:'原作者',license:'原站许可',sourceUrl:'https://github.com/langgptai/awesome-gpt-4o-prompts',modelHint:'测试模型',coverUrl:'https://img.alicdn.com/ui-collection.png',coverUrls:['https://img.alicdn.com/ui-collection.png'],imageLabels:['原站效果图'],videoUrl:'https://img.opennana.com/prompts/assets/videos/test.mp4',detailLoaded:true});
const tmp=net.createServer();await new Promise(r=>tmp.listen(0,'127.0.0.1',r));const debugPort=tmp.address().port;await new Promise(r=>tmp.close(r));
const browser=spawn('C:/Program Files/Google/Chrome/Application/chrome.exe',['--headless=new','--disable-gpu','--no-first-run',`--remote-debugging-port=${debugPort}`,`--user-data-dir=${profile}`,'about:blank'],{windowsHide:true,stdio:'ignore'});
let ws,pass=false;const errors=[];
try{
  let tabs;for(let i=0;i<60;i++){try{tabs=await(await fetch('http://127.0.0.1:'+debugPort+'/json/list')).json();if(tabs.length)break;}catch{}await sleep(200);}
  ws=new WebSocket(tabs.find(t=>t.type==='page').webSocketDebuggerUrl);await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j;});let seq=0;const pending=new Map();
  ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id){const p=pending.get(m.id);if(p){pending.delete(m.id);m.error?p.reject(Error(m.error.message)):p.resolve(m.result);}}else if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails.text);};
  const cdp=(method,params={})=>new Promise((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}));setTimeout(()=>{if(pending.has(id)){pending.delete(id);reject(Error('CDP超时'));}},15000).unref();});
  const ev=async expression=>{const r=await cdp('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result.value;};
  const wait=async expression=>{for(let i=0;i<100;i++){if(await ev(expression))return;await sleep(100);}throw Error('界面等待失败 '+expression);};
  const shot=async name=>writeFileSync(path.join(out,name),Buffer.from((await cdp('Page.captureScreenshot',{format:'png'})).data,'base64'));
  await cdp('Runtime.enable');await cdp('Page.enable');await cdp('Emulation.setDeviceMetricsOverride',{width:1440,height:1050,deviceScaleFactor:1,mobile:false});await cdp('Page.navigate',{url:'http://127.0.0.1:'+app.port});
  await wait('!!document.querySelector("#template-select option")');await ev('document.querySelector("[data-view=plaza]").click()');await wait('!!document.querySelector("[data-action=shared-collect]")');
  await ev('document.querySelector("[data-action=shared-collect]").click()');await wait('document.querySelector("#toast").textContent.includes("部分图片未保存")');
  await ev('document.querySelector("[data-view=library]").click()');await wait('!!document.querySelector(".asset-media-warning")');
  fail=false;await ev('document.querySelector("[data-action=asset-fill-media]").click()');await wait('!!document.querySelector(".asset-card .personal-media img")&&!document.querySelector(".asset-media-warning")');
  await wait('document.querySelector(".personal-media img").complete&&document.querySelector(".personal-media img").naturalWidth>0');await shot('library-desktop.png');
  const a=app.store.list('assets')[0];assert.equal(a.media.length,1);assert.ok(reads>=2);await app.imageCache.clear();
  await ev(`document.querySelector('[data-asset-card="${a.id}"] h3').click()`);await wait('document.querySelector("#asset-detail-dialog").open');await wait('document.querySelector("#asset-detail img").naturalWidth>0');
  assert.equal(await ev('document.querySelector("#asset-detail .asset-source-video").href'),'https://img.opennana.com/prompts/assets/videos/test.mp4');
  assert.ok(await ev('document.querySelector("#asset-detail").textContent.includes("原作者")'));await shot('detail-desktop.png');
  await cdp('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});await sleep(200);assert.equal(await ev('document.documentElement.scrollWidth<=innerWidth'),true);await shot('detail-mobile.png');
  const b=app.store.put('assets',{title:'另一个收藏B',content:'保留B的当前详情',media:[],tags:'',versions:[]});
  app.store.put('assets',{...app.store.get('assets',a.id),collectionMedia:{...a.collectionMedia,failures:[{url:'',message:'重试验收'}]}});
  const source=app.store.get('shared','ui-collection');app.store.put('shared',{...source,coverUrls:['https://img.alicdn.com/ui-collection-new.png']});
  let release,entered;const gate=new Promise(r=>entered=r);app.imageCache.fetcher=async()=>{entered();await new Promise(r=>release=r);return new Response(readFileSync('public/icon-256.png'));};
  await cdp('Page.navigate',{url:'http://127.0.0.1:'+app.port});await wait('!!document.querySelector("#template-select option")');await ev('document.querySelector("[data-view=library]").click()');await wait('!!document.querySelector("[data-action=asset-fill-media]")');
  await ev(`document.querySelector('[data-asset-card="${a.id}"] h3').click();document.querySelector('#asset-detail [data-action=asset-fill-media]').click()`);await gate;
  await ev(`document.querySelector('#asset-detail-dialog').close();document.querySelector('[data-asset-card="${b.id}"] h3').click()`);release();await wait('document.querySelector("#toast").textContent.includes("来源素材已补齐")');
  assert.equal(await ev('document.querySelector("#asset-detail h3").textContent'),'另一个收藏B','补图迟到响应不得切回旧详情');
  assert.deepEqual(errors,[]);pass=true;writeFileSync(path.join(out,'ui-result.json'),JSON.stringify({status:'PASS',collectToLibrary:true,failedImageWarningAndRetry:true,personalImageDecodedAfterCacheClear:true,videoIsExternalLink:true,sourceAndLicenseShown:true,desktopAnd390px:true,lateFillPreservesOtherDetail:true,realGeneration:false},null,2));console.log('PASS: 广场收藏→个人图片、失败提示/重试、清缓存读图、视频原链、桌面/手机与迟到保护。');
}catch(e){writeFileSync(path.join(out,'ui-result.json'),JSON.stringify({status:'FAIL',error:e.message},null,2));throw e;}
finally{ws?.close();if(browser.exitCode===null){const exit=new Promise(r=>browser.once('exit',r));browser.kill();await Promise.race([exit,sleep(5000)]);}await app.close();if(pass){removeOwnedArtifact(profile);removeOwnedArtifact(data);}}
