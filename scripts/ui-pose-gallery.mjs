// 姿势参考页界面验收：隔离实例 + 注入假目录与假图片，离线可重复。桌面 1440 与手机 390 各一次。
import {spawn} from 'node:child_process';
import {mkdirSync,mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import assert from 'node:assert/strict';
import {setTimeout as sleep} from 'node:timers/promises';
import {createWorkbench} from '../tests/source-fixtures.js';
import {removeOwnedArtifact} from './test-artifacts.mjs';
const out=path.resolve('work/pose-gallery-ui');mkdirSync(out,{recursive:true});
const data=mkdtempSync(path.join(out,'data-')),profile=mkdtempSync(path.join(out,'chrome-'));
const png=readFileSync('public/icon-256.png');
const ANGLES=[['front','正面'],['high','上から'],['low','下から'],['side','横'],['diag','斜め']];
const no=n=>'P'+String(n).padStart(3,'0');
const row=(prefix,series,number,category,name,suffix,angle)=>({id:`${prefix}_${number.toLowerCase()}_${suffix}`,'系統':series,'ポーズ番号':number,'分類':category,'ポーズ名':name,'アングル':angle,'サムネ':`thumbs/${prefix}_${number.toLowerCase()}_${suffix}.jpg`,'原寸':`img/${prefix}_${number.toLowerCase()}_${suffix}.png`});
const pose=(prefix,series,number,category,name)=>ANGLES.map(([suffix,angle])=>row(prefix,series,number,category,name,suffix,angle));
const rows=[
  ...Array.from({length:10},(_,i)=>pose('full_sexy','全身1人・セクシー系',no(i+1),'立ち',i?'姿势样例'+no(i+1):'振り返る')).flat(),
  ...pose('pair60','2人絡み','P001','密着','寄り添う'),...pose('pair60','2人絡み','P002','密着','重なる')
];
const source=`<!doctype html><html><body><script>\nconst META={"lines":["全身1人・セクシー系","2人絡み"]};\nconst D=${JSON.stringify(rows)};\n</script></body></html>`;
const app=await createWorkbench({dataDir:data,port:0,sourceFetcher:async()=>new Response(source),imageFetcher:async()=>new Response(png)});
const tmp=net.createServer();await new Promise(r=>tmp.listen(0,'127.0.0.1',r));const debugPort=tmp.address().port;await new Promise(r=>tmp.close(r));
const browser=spawn('C:/Program Files/Google/Chrome/Application/chrome.exe',['--headless=new','--disable-gpu','--no-first-run',`--remote-debugging-port=${debugPort}`,`--user-data-dir=${profile}`,'about:blank'],{windowsHide:true,stdio:'ignore'});
let ws,pass=false;const errors=[];let cleanup='kept';
try{
  let tabs;for(let i=0;i<60;i++){try{tabs=await(await fetch('http://127.0.0.1:'+debugPort+'/json/list')).json();if(tabs.length)break;}catch{}await sleep(200);}
  ws=new WebSocket(tabs.find(t=>t.type==='page').webSocketDebuggerUrl);await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j;});let seq=0;const pending=new Map();
  ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id){const p=pending.get(m.id);if(p){pending.delete(m.id);m.error?p.reject(Error(m.error.message)):p.resolve(m.result);}}else if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails.text);};
  const cdp=(method,params={})=>new Promise((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}));setTimeout(()=>{if(pending.has(id)){pending.delete(id);reject(Error('CDP超时'));}},15000).unref();});
  const ev=async expression=>{const r=await cdp('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result.value;};
  const wait=async expression=>{for(let i=0;i<120;i++){if(await ev(expression))return;await sleep(100);}throw Error('界面等待失败 '+expression);};
  const shot=async name=>writeFileSync(path.join(out,name),Buffer.from((await cdp('Page.captureScreenshot',{format:'png'})).data,'base64'));
  await cdp('Runtime.enable');await cdp('Page.enable');await cdp('Emulation.setDeviceMetricsOverride',{width:1440,height:1050,deviceScaleFactor:1,mobile:false});await cdp('Page.navigate',{url:'http://127.0.0.1:'+app.port});
  await wait('!!document.querySelector("#template-select option")');
  // 未同步时的空状态
  await ev('document.querySelector("[data-view=pose]").click()');
  await wait('document.querySelector("#pose-grid").textContent.includes("尚未同步")');
  assert.equal(await ev('document.querySelector("#pose-count").textContent'),'尚未同步');
  await shot('pose-empty.png');
  // 手动同步
  await ev('document.querySelector("#pose-sync").click()');
  await wait('document.querySelector("#pose-status").textContent.includes("同步完成")');
  await wait('document.querySelectorAll("#pose-grid [data-pose]").length===12');
  assert.match(await ev('document.querySelector("#pose-count").textContent'),/已同步 60 张 · 12 个姿势/);
  await wait('[...document.querySelectorAll("#pose-grid img")].some(i=>i.complete&&i.naturalWidth>0)');
  await shot('pose-desktop.png');
  // 详情：五个视角、切换、按需原图
  await ev('document.querySelector("#pose-grid [data-pose]").click()');
  await wait('document.querySelector("#pose-dialog").open');
  assert.equal(await ev('document.querySelectorAll("#pose-detail-angles [data-pose-angle]").length'),5);
  await wait('document.querySelector("#pose-detail-image").naturalWidth>0');
  await ev('document.querySelectorAll("#pose-detail-angles [data-pose-angle]")[2].click()');
  await wait('document.querySelector("#pose-detail-meta").textContent.includes("仰视")');
  await shot('pose-detail.png');
  await ev('document.querySelector("#pose-detail-full").click()');
  await wait('document.querySelector("#pose-detail-status").textContent.includes("原图已加载")');
  assert.equal(await ev('document.querySelector("#pose-detail-full").disabled'),true);
  await ev('document.querySelector("#pose-dialog").close()');
  // 筛选：系列 2 个姿势；切换逐张模式
  await ev('const s=document.querySelector("#pose-series");s.selectedIndex=2;s.dispatchEvent(new Event("change"))');
  await wait('document.querySelector("#pose-page").textContent.includes("共 2 个姿势")');
  await ev('const g=document.querySelector("#pose-group");g.value="angle";g.dispatchEvent(new Event("change"))');
  await wait('document.querySelector("#pose-page").textContent.includes("共 10 张")');
  await shot('pose-angle-mode.png');
  await ev('document.querySelector("#pose-clear").click()');
  await wait('document.querySelector("#pose-page").textContent.includes("共 12 个姿势")');
  // 手机 390：无横溢出
  await cdp('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});await sleep(300);
  assert.equal(await ev('document.documentElement.scrollWidth<=innerWidth'),true);
  await shot('pose-mobile.png');
  assert.deepEqual(errors,[]);
  const status=app.poses.status();assert.equal(status.count,60);assert.equal(status.poses,12);assert.equal(status.lastError,null);
  pass=true;cleanup='pending';
  writeFileSync(path.join(out,'ui-result.json'),JSON.stringify({status:'PASS',emptyState:true,manualSync:true,statusCount:true,desktopGrid:12,detailAngles:5,angleSwitch:true,originalOnDemand:true,seriesFilter:true,angleMode:true,clearFilter:true,desktopAnd390px:true,realModel:false,network:false},null,2));
  console.log('PASS: 空状态→手动同步→12 个姿势/60 张→详情五视角与按需原图→筛选与逐张模式→桌面/390px 无横溢出。');
}catch(e){writeFileSync(path.join(out,'ui-result.json'),JSON.stringify({status:'FAIL',error:e.message},null,2));throw e;}
finally{
  ws?.close();if(browser.exitCode===null){const exit=new Promise(r=>browser.once('exit',r));browser.kill();await Promise.race([exit,sleep(5000)]);}await app.close();
  if(pass)for(const target of [profile,data]){try{removeOwnedArtifact(target);cleanup='removed';}catch(e){cleanup='blocked: '+e.message.slice(0,120);}}
  if(pass)writeFileSync(path.join(out,'ui-result.json'),JSON.stringify({...JSON.parse(readFileSync(path.join(out,'ui-result.json'),'utf8')),cleanup},null,2));
}
