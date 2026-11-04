export async function waitForServiceExit(version,{fetcher=fetch,pause=ms=>new Promise(r=>setTimeout(r,ms)),attempts=60,online=()=>globalThis.navigator?.onLine!==false}={}){
  let failed=0;
  for(let n=0;n<attempts;n++){
    await pause(500);
    try{const r=await fetcher('/health',{cache:'no-store',signal:AbortSignal.timeout(1500)});failed=0;if(!r.ok)continue;const h=await r.json();if(h.app==='prompt-workbench'&&typeof h.version==='string'&&h.version!==version)return 'restarted';}
    catch(e){if(e.name==='TypeError'&&online()){if(++failed>=3)return 'closed';}else failed=0;}
  }
  return 'pending';
}

// 等待「重启」：先观察到 health 不可达（旧服务已退出），再观察到同版本重新上线。
export async function waitForRestart(version,{fetcher=fetch,pause=ms=>new Promise(r=>setTimeout(r,ms)),attempts=80}={}){
  let sawDown=false,downCount=0;
  for(let n=0;n<attempts;n++){
    await pause(500);
    try{
      const r=await fetcher('/health',{cache:'no-store',signal:AbortSignal.timeout(1500)});
      if(!r.ok){sawDown=true;downCount++;continue;}
      const h=await r.json();
      if(h.app==='prompt-workbench'&&typeof h.version==='string'&&h.version===version&&sawDown)return 'restarted';
    }catch(e){sawDown=true;downCount++;}
  }
  return sawDown?'closed':'still-running';
}
