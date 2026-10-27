const $=s=>document.querySelector(s),esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const names={queued:'等待识别',running:'识别 / 清理上下文',cancelling:'正在停止',cancelled:'已停止',succeeded:'识别完成',failed:'失败',interrupted:'上次中断，未自动重试'};
export class ImageBatchUI {
  constructor(c){this.c=c;this.files=[];this.batchId=localStorage.getItem('pw-image-batch')||'';this.requestId=crypto.randomUUID();}
  async add(files){
    if(this.busy||this.running)throw Error('请等待或停止当前批次后添加');
    if(this.files.length+files.length>20)throw Error('每批最多20张图片');
    for(const f of files)if(!['image/png','image/jpeg','image/webp'].includes(f.type)||f.size>20*1024*1024||!f.size)throw Error('图片须为PNG/JPEG/WebP，单张最多20MB');
    if([...this.files.map(r=>r.file),...files].reduce((n,f)=>n+f.size,0)>200*1024*1024)throw Error('本批原图合计最多200MB');
    for(const file of files)this.files.push({file,url:URL.createObjectURL(file)});this.paintFiles();
  }
  paintFiles(){$('#image-batch-previews').innerHTML=this.files.map((r,i)=>'<figure><img src="'+esc(r.url)+'" alt="'+esc(r.file.name)+'"><figcaption>'+esc(r.file.name)+'</figcaption><button type="button" class="text-button" data-batch-remove="'+i+'">移除</button></figure>').join('');$('#image-batch-count').textContent=this.files.length+' / 20 张';}
  async preview(file){
    if(file.size<=480*1024)return new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(r.result);r.onerror=reject;r.readAsDataURL(file);});
    const image=await createImageBitmap(file);try{let scale=Math.min(1,1536/Math.max(image.width,image.height));for(let i=0;i<8;i++){const canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(image.width*scale));canvas.height=Math.max(1,Math.round(image.height*scale));const ctx=canvas.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.drawImage(image,0,0,canvas.width,canvas.height);const url=canvas.toDataURL('image/jpeg',0.85);if(url.length<=655360)return url;scale*=0.75;}throw Error('无法缩小模型预览图：'+file.name);}finally{image.close();}
  }
  lock(value){this.busy=value;$('#image-batch-dialog').dataset.busy=String(value);for(const el of $('#image-batch-form').querySelectorAll('input,textarea,select,button'))el.disabled=value;}
  async submit(){
    if(this.busy||this.running)throw Error('当前批次尚未结束');if(!this.files.length)throw Error('请先选择图片');
    const config=this.c.payload();if(!config.providerId||!config.model)throw Error('先在工作台选择支持读图的连接和模型');
    this.lock(true);try{
      const items=[];for(const r of this.files){$('#image-batch-progress').textContent='准备原图：'+r.file.name;if(!r.dataUrl)r.dataUrl=await this.preview(r.file);if(!r.media){const response=await fetch('/api/media/upload?name='+encodeURIComponent(r.file.name),{method:'POST',headers:{'Content-Type':'application/octet-stream'},body:r.file});const value=await response.json();if(!response.ok)throw Error(value.error||'原图上传失败');r.media={uploadId:value.uploadId};}items.push({media:r.media,dataUrl:r.dataUrl});}
      const body={requestId:this.requestId,providerId:config.providerId,model:config.model,input:$('#image-batch-instruction').value,language:$('#image-batch-language').value,folderId:$('#image-batch-folder').value,temperature:config.temperature,maxTokens:config.maxTokens,items};
      const result=await this.c.api('image-batch',body);this.batchId=result.batchId;localStorage.setItem('pw-image-batch',this.batchId);for(const r of this.files){URL.revokeObjectURL(r.url);}this.files=[];this.paintFiles();await this.c.refresh();await this.poll();
    }finally{this.lock(false);}
  }
  async poll(){
    clearTimeout(this.timer);if(!this.batchId)return;const r=await this.c.api('image-batch/'+this.batchId);this.running=r.jobs.some(j=>['queued','running','cancelling'].includes(j.status));const saved=r.jobs.filter(j=>j.archiveAssetId).length;
    $('#image-batch-progress').textContent='已收录 '+saved+' / '+r.jobs.length+' 张'+(r.jobs.some(j=>j.status==='failed')?' · '+r.jobs.filter(j=>j.status==='failed').length+' 张失败':'')+(this.running?' · 逐张独立识别':' · 本批已结束');$('#image-batch-stop').disabled=!this.running;$('#image-batch-start').disabled=this.running||this.busy;
    $('#image-batch-results').innerHTML=r.jobs.map(j=>'<article class="card"><strong>'+esc(j.originalMedia?.[0]?.name)+'</strong><p>'+esc(names[j.status]||j.status)+(j.archiveAssetId?' · 提示词与原图已收录':'')+'</p><small>'+esc(j.error||j.archiveError||'')+'</small>'+(j.status==='succeeded'&&!j.archiveAssetId?'<button type="button" class="secondary" data-batch-archive="'+esc(j.id)+'">仅重试收录</button>':'')+'</article>').join('');
    if(this.running&&$('#image-batch-dialog').open)this.timer=setTimeout(()=>this.c.act(()=>this.poll()),1000);else if(!this.running){this.requestId=crypto.randomUUID();await this.c.refresh();}
  }
  async open(){const config=this.c.payload(),provider=this.c.readState().providers.find(p=>p.id===config.providerId);$('#image-batch-connection').textContent=(provider?.name||'请先选择模型连接')+' · '+(config.model||'未选模型')+(provider?.accountPlatform==='chatgpt'?' · 使用模型默认采样，不支持输出token硬上限':'');const folder=$('#image-batch-folder'),old=folder.value;folder.innerHTML='<option value="">未归档</option>'+(this.c.readState().folders||[]).map(f=>'<option value="'+esc(f.id)+'">'+esc(f.name)+'</option>').join('');folder.value=old;$('#image-batch-dialog').showModal();await this.poll();}
  init(){
    $('#image-batch-open').onclick=()=>this.c.act(()=>this.open());$('#image-batch-pick').onclick=()=>$('#image-batch-files').click();$('#image-batch-files').onchange=()=>this.c.act(async()=>{await this.add([...$('#image-batch-files').files]);$('#image-batch-files').value='';});
    $('#image-batch-form').onsubmit=e=>{e.preventDefault();this.c.act(()=>this.submit());};$('#image-batch-stop').onclick=()=>this.c.act(async()=>{await this.c.api('image-batch/'+this.batchId+'/cancel',{});await this.poll();});
    const zone=$('#image-batch-drop');zone.ondragover=e=>{e.preventDefault();e.stopPropagation();};zone.ondrop=e=>{e.preventDefault();e.stopPropagation();this.c.act(()=>this.add([...e.dataTransfer.files]));};
    $('#image-batch-dialog').addEventListener('cancel',e=>{if(this.busy)e.preventDefault();});$('#image-batch-dialog').addEventListener('close',()=>clearTimeout(this.timer));
    $('#image-batch-dialog').addEventListener('click',e=>{const remove=e.target.closest('[data-batch-remove]'),archive=e.target.closest('[data-batch-archive]');if(remove&&!this.busy&&!this.running){const [row]=this.files.splice(Number(remove.dataset.batchRemove),1);URL.revokeObjectURL(row.url);if(row.media)this.c.act(()=>this.c.api('media/staged/'+row.media.uploadId,null,'DELETE'));this.paintFiles();}if(archive)this.c.act(async()=>{await this.c.api('jobs/'+archive.dataset.batchArchive+'/archive',{});await this.poll();});});
  }
}
