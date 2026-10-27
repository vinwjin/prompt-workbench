export async function waitForServiceExit(version,{fetcher=fetch,pause=ms=>new Promise(r=>setTimeout(r,ms)),attempts=60,online=()=>globalThis.navigator?.onLine!==false}={}){
  let failed=0;
  for(let n=0;n<attempts;n++){
    await pause(500);
    try{const r=await fetcher('/health',{cache:'no-store',signal:AbortSignal.timeout(1500)});failed=0;if(!r.ok)continue;const h=await r.json();if(h.app==='prompt-workbench'&&typeof h.version==='string'&&h.version!==version)return 'restarted';}
    catch(e){if(e.name==='TypeError'&&online()){if(++failed>=3)return 'closed';}else failed=0;}
  }
  return 'pending';
}
