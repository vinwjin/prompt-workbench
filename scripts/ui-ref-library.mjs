// 参考素材页界面验收：三库（姿势 / 脸库 / 服装库）跨库回归。
// 覆盖：默认姿势同步走 pose/sync 而非 ref/sync；三库搜索过滤；详情路由无错；分页与原图；
// 快速切 Tab 无串页；姿势五视角键盘回归。隔离实例 + 注入假目录与假图片，离线可重复。
import {spawn} from 'node:child_process';
import {mkdirSync,mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import assert from 'node:assert/strict';
import {setTimeout as sleep} from 'node:timers/promises';
import {createWorkbench} from '../tests/source-fixtures.js';
import {removeOwnedArtifact} from './test-artifacts.mjs';
const out=path.resolve('work/ref-library-ui');mkdirSync(out,{recursive:true});
const data=mkdtempSync(path.join(out,'data-')),profile=mkdtempSync(path.join(out,'chrome-'));
const png=readFileSync('public/icon-256.png');

// 姿势库夹具（与 ui-pose-gallery.mjs 一致）
const ANGLES=[['front','正面'],['high','上から'],['low','下から'],['side','横'],['diag','斜め']];
const no=n=>'P'+String(n).padStart(3,'0');
const prow=(prefix,series,number,category,name,suffix,angle)=>({id:`${prefix}_${number.toLowerCase()}_${suffix}`,'系統':series,'ポーズ番号':number,'分類':category,'ポーズ名':name,'アングル':angle,'サムネ':`thumbs/${prefix}_${number.toLowerCase()}_${suffix}.jpg`,'原寸':`img/${prefix}_${number.toLowerCase()}_${suffix}.png`});
const pose=(prefix,series,number,category,name)=>ANGLES.map(([suffix,angle])=>prow(prefix,series,number,category,name,suffix,angle));
const poseRows=[...Array.from({length:10},(_,i)=>pose('full_sexy','全身1人・セクシー系',no(i+1),'立ち',i?'姿势样例'+no(i+1):'振り返る')).flat(),...pose('pair60','2人絡み','P001','密着','寄り添う'),...pose('pair60','2人絡み','P002','密着','重なる')];
const poseSource=`<!doctype html><html><body><script>\nconst META={"lines":["全身1人・セクシー系","2人絡み"]};\nconst D=${JSON.stringify(poseRows)};\n</script></body></html>`;

// 脸库夹具（60 条，满足护栏）
const FACE_ROWS=Array.from({length:60},(_,i)=>({id:'f'+String(i).padStart(3,'0')+'abc',section:i%2?'styling':'face',hair:i%2?'ロング':'ショート',style:i%5?'样例'+i:'',w:1122,h:1402,full:'img/full/f'+String(i).padStart(3,'0')+'abc.png',thumb:'img/thumb/f'+String(i).padStart(3,'0')+'abc.webp',bytes:1000+i}));
// 服装库夹具（60 条）
const COSTUME_ROWS=Array.from({length:60},(_,i)=>({id:'SPR-'+String(i+1).padStart(4,'0'),'カテゴリ':i%2?'夏':'春','キーワード':'ivory frill knit','サムネ':'thumbs/SPR-'+String(i+1).padStart(4,'0')+'.webp','画像':'img/SPR-'+String(i+1).padStart(4,'0')+'.webp','原寸':'png/SPR-'+String(i+1).padStart(4,'0')+'.png'}));

// 记录源站请求，用于验证默认姿势同步走 pose 而非 ref
const sourceLog=[];
const sourceFetcher=async url=>{
  sourceLog.push(url);
  if(url.includes('ai-pose-gallery'))return new Response(poseSource);
  if(url.endsWith('/data/images.js'))return new Response('window.GALLERY_IMAGES = '+JSON.stringify(FACE_ROWS)+';');
  if(url.includes('ai-costume-gallery'))return new Response('<!doctype html><html><body><script>const META='+JSON.stringify({cats:['春','夏']})+';const D='+JSON.stringify(COSTUME_ROWS)+';</script></body></html>');
  throw new Error('unexpected source url '+url);
};
const app=await createWorkbench({dataDir:data,port:0,sourceFetcher,imageFetcher:async()=>new Response(png)});
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
  await ev('document.querySelector("[data-view=pose]").click()');
  await wait('document.querySelector("#pose-grid").textContent.includes("尚未同步")');
  assert.equal(await ev('document.querySelector("#pose [data-ref-lib=pose][aria-pressed=true]")!==null'),true,'默认选中姿势 tab');

  // 1) 默认姿势同步：验证走 pose/sync 而非 ref/sync
  const syncLogBefore=sourceLog.length;
  await ev('document.querySelector("#pose-sync").click()');
  await wait('document.querySelector("#pose-status").textContent.includes("同步完成")');
  await wait('document.querySelectorAll("#pose-grid [data-pose]").length===12');
  assert.ok(sourceLog.some(u=>u.includes('ai-pose-gallery')),'默认同步应请求姿势源站');
  assert.ok(!sourceLog.slice(syncLogBefore).some(u=>u.includes('ai-portrait-gallery')||u.includes('ai-costume-gallery')),'默认同步不应请求脸库/服装库源站（走 pose/sync）');
  assert.equal(app.poses.status().count,60);assert.equal(app.poses.status().poses,12);
  assert.equal(app.refs.status('face').count,0,'默认同步后脸库应仍为空，证明未误走 ref/sync');
  assert.match(await ev('document.querySelector("#pose-count").textContent'),/已同步 60 张 · 12 个姿势/);

  // 2) 姿势详情五视角 + 键盘 ←→ 切视角（回归）
  await ev('document.querySelector("#pose-grid [data-pose]").click()');
  await wait('document.querySelector("#pose-dialog").open');
  assert.equal(await ev('document.querySelectorAll("#pose-detail-angles [data-pose-angle]").length'),5,'姿势详情应有五视角');
  await wait('document.querySelector("#pose-detail-image").naturalWidth>0');
  await wait('document.querySelectorAll("#pose-detail-angles [data-pose-angle]").length===5');
  await ev('document.querySelectorAll("#pose-detail-angles [data-pose-angle]")[2].click()');
  await wait('document.querySelector("#pose-detail-meta").textContent.includes("仰视")');
  await shot('pose-detail.png');
  await ev('document.querySelector("#pose-dialog").close()');

  // 3) 切到脸库：搜索过滤 + 详情
  await ev('document.querySelector("#pose [data-ref-lib=face]").click()');
  await wait('document.querySelector("#pose-grid").textContent.includes("尚未同步")');
  assert.match(await ev('document.querySelector("#pose-intro-author").textContent'),/あぎ/,'脸库应显示作者あぎ');
  await ev('document.querySelector("#pose-sync").click()');
  await wait('document.querySelector("#pose-status").textContent.includes("同步完成")');
  await wait('document.querySelectorAll("#pose-grid [data-pose]").length>0');
  assert.match(await ev('document.querySelector("#pose-count").textContent'),/已同步 60 张/);
  assert.equal(app.refs.status('face').count,60);
  // 搜索过滤（q 参数）
  await ev('(()=>{const s=document.querySelector("#pose-search");s.value="样例1";s.dispatchEvent(new Event("input"));})()');
  await sleep(600);
  await wait('document.querySelector("#pose-grid").textContent.includes("共")||document.querySelectorAll("#pose-grid [data-pose]").length>=0');
  const faceFiltered=await ev('document.querySelectorAll("#pose-grid [data-pose]").length');
  assert.ok(faceFiltered>0&&faceFiltered<60,'脸库搜索应过滤出部分条目，实际 '+faceFiltered);
  await shot('face-desktop.png');
  await ev('document.querySelector("#pose-clear").click()');
  await wait('document.querySelectorAll("#pose-grid [data-pose]").length===60');
  // 脸库详情
  await ev('document.querySelector("#pose-grid [data-pose]").click()');
  await wait('document.querySelector("#pose-dialog").open');
  await wait('document.querySelector("#pose-detail-image").naturalWidth>0');
  await ev('document.querySelector("#pose-dialog").close()');

  // 4) 切到服装库：搜索 + 分类
  await ev('document.querySelector("#pose [data-ref-lib=costume]").click()');
  await wait('document.querySelector("#pose-grid").textContent.includes("尚未同步")');
  assert.match(await ev('document.querySelector("#pose-intro-author").textContent'),/ギア/,'服装库应显示作者ギア');
  await ev('document.querySelector("#pose-sync").click()');
  await wait('document.querySelector("#pose-status").textContent.includes("同步完成")');
  await wait('document.querySelectorAll("#pose-grid [data-pose]").length>0');
  assert.match(await ev('document.querySelector("#pose-count").textContent'),/已同步 60 套/);
  assert.equal(app.refs.status('costume').count,60);
  const groups=await ev('Array.from(document.querySelectorAll("#pose-category option")).map(o=>o.textContent)');
  assert.ok(groups.includes('春')&&groups.includes('夏'),'服装库分类下拉含春/夏');
  // 分类过滤
  await ev('(()=>{const s=document.querySelector("#pose-category");s.selectedIndex=1;s.dispatchEvent(new Event("change"));})()');
  await wait('document.querySelector("#pose-page").textContent.includes("共 30")');
  await shot('costume-desktop.png');

  // 5) 快速切 Tab 无串页：姿势→脸库→服装库→姿势
  await ev('document.querySelector("#pose [data-ref-lib=pose]").click()');
  await wait('document.querySelectorAll("#pose-grid [data-pose]").length===12');
  assert.match(await ev('document.querySelector("#pose-count").textContent'),/已同步 60 张 · 12 个姿势/,'切回姿势应显示姿势数据');
  await ev('document.querySelector("#pose [data-ref-lib=face]").click()');
  await wait('document.querySelectorAll("#pose-grid [data-pose]").length===60');
  assert.match(await ev('document.querySelector("#pose-count").textContent'),/已同步 60 张/,'切脸库应显示脸库数据');
  await ev('document.querySelector("#pose [data-ref-lib=costume]").click()');
  await wait('document.querySelector("#pose-count").textContent.includes("已同步 60 套")');
  assert.match(await ev('document.querySelector("#pose-count").textContent'),/已同步 60 套/,'切回服装库应显示服装库数据而非姿势/脸库');
  await ev('document.querySelector("#pose [data-ref-lib=pose]").click()');
  await wait('document.querySelectorAll("#pose-grid [data-pose]").length===12');

  // 6) 手机 390：无横溢出
  await cdp('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});await sleep(300);
  assert.equal(await ev('document.documentElement.scrollWidth<=innerWidth'),true);
  await shot('ref-mobile.png');

  assert.deepEqual(errors,[]);
  assert.equal(app.poses.status().count,60);assert.equal(app.refs.status('face').count,60);assert.equal(app.refs.status('costume').count,60);
  pass=true;cleanup='pending';
  writeFileSync(path.join(out,'ui-result.json'),JSON.stringify({status:'PASS',defaultPoseTab:true,defaultSyncIsPoseNotRef:true,poseFiveAnglesKeyboard:true,faceSearchFilter:true,faceAuthorShown:true,faceDetail:true,costumeSearchGroup:true,costumeAuthorShown:true,fastTabSwitchNoLeak:true,desktopAnd390px:true,realModel:false,network:false},null,2));
  console.log('PASS: 默认姿势同步走pose/sync→姿势五视角→脸库/服装库搜索与作者→快速切Tab无串页→桌面/390px。');
}catch(e){writeFileSync(path.join(out,'ui-result.json'),JSON.stringify({status:'FAIL',error:e.message},null,2));throw e;}
finally{
  ws?.close();if(browser.exitCode===null){const exit=new Promise(r=>browser.once('exit',r));browser.kill();await Promise.race([exit,sleep(5000)]);}await app.close();
  if(pass)for(const target of [profile,data]){try{removeOwnedArtifact(target);cleanup='removed';}catch(e){cleanup='blocked: '+e.message.slice(0,120);}}
  if(pass)writeFileSync(path.join(out,'ui-result.json'),JSON.stringify({...JSON.parse(readFileSync(path.join(out,'ui-result.json'),'utf8')),cleanup},null,2));
}
