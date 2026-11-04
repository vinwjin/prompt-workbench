// 姿势参考：POSE-DB-01 只读图库。图片一律经本地 /api/pose/<id>/image 读取，不向浏览器暴露原站直链。
const $=s=>document.querySelector(s);
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const imageUrl=(id,full=false)=>`/api/pose/${encodeURIComponent(id)}/image${full?'?full=1':''}`;
export class PoseUI{
  constructor(ctx){this.c=ctx;this.active=false;this.pageSize=60;this.page=0;this.total=0;this.items=[];this.status=null;this.selected=null;this.original=false;this.observer=null;this.serial=0;this.bound=false;}
  state(){return this.c.readState();}
  filters(){return {series:$('#pose-series').value,category:$('#pose-category').value,angle:$('#pose-angle').value,query:$('#pose-search').value.trim(),group:$('#pose-group').value};}
  ensureObserver(){
    if(this.observer)return this.observer;
    this.observer=new IntersectionObserver(entries=>{for(const entry of entries)if(entry.isIntersecting){const img=entry.target;if(!img.isConnected||!img.dataset.src)continue;img.src=img.dataset.src;delete img.dataset.src;this.observer.unobserve(img);}},{rootMargin:'200px'});
    return this.observer;
  }
  async load(reset=true){
    if(reset)this.page=0;
    const serial=++this.serial;
    const {series,category,angle,query,group}=this.filters();
    const params=new URLSearchParams({series,category,angle,q:query,group,offset:String(this.page*this.pageSize),limit:String(this.pageSize)});
    const result=await this.c.api(`pose?${params}`);
    // 慢回包竞态护栏：请求期间切到其它库或本库再次发起请求时，丢弃过期响应，避免覆盖当前视图。
    if(serial!==this.serial||!this.active)return;
    this.items=result.items||[];this.total=result.total||0;this.status=result.status||this.status;this.group=result.group||group;
    this.renderFilters();this.render();this.renderStatus();
  }
  renderFilters(){
    const status=this.status;if(!status)return;
    const fill=(node,values,label)=>{const old=node.value;const html=`<option value="">${esc(label)}</option>`+values.map(v=>`<option value="${esc(v)}">${esc(v)}</option>`).join('');if(node.innerHTML!==html){node.innerHTML=html;node.value=values.includes(old)?old:'';}};
    fill($('#pose-series'),status.lines||[],'全部系列');
    fill($('#pose-category'),status.categories||[],'全部分类');
    const angles=['正面','俯视','仰视','侧面','斜视'];
    fill($('#pose-angle'),angles,'全部视角');
  }
  renderStatus(){
    const status=this.status||{},count=Number(status.count)||0,poses=Number(status.poses)||0;
    $('#pose-count').textContent=count?`已同步 ${count} 张 · ${poses} 个姿势`:'尚未同步';
    const note=status.lastSync?`上次同步 ${new Date(status.lastSync).toLocaleString('zh-CN')}${status.lastAdded?` · 新增 ${status.lastAdded}`:''}${status.lastRemoved?` · 移除 ${status.lastRemoved}`:''}`:'点「同步姿势集」从原站读取最新目录，一次读取全部条目。';
    $('#pose-sync-note').textContent=note;
    $('#pose-sync').disabled=!!status.syncing;
    $('#pose-sync').textContent=status.syncing?'同步中…':'同步姿势集';
    $('#pose-status').textContent=status.lastError||'';
    $('#pose-status').classList.toggle('error',!!status.lastError);
    const pages=Math.max(1,Math.ceil(this.total/this.pageSize));
    $('#pose-page').textContent=this.total?`第 ${this.page+1} / ${pages} 页 · 共 ${this.total} ${this.group==='angle'?'张':'个姿势'}`:'';
    $('#pose-prev').disabled=this.page<=0;
    $('#pose-next').disabled=this.page+1>=pages;
  }
  card(item){
    const isPose=this.group!=='angle';
    const id=isPose?item.coverId:item.id;
    const angleCount=isPose?(item.angles||[]).length:0;
    const title=isPose?item.poseName:`${item.poseName} · ${item.angle}`;
    const label=isPose?`${item.poseNo} · ${angleCount} 视角`:`${item.poseNo} · ${item.angle}`;
    return `<article class="shared-card has-cover" data-pose="${esc(id)}" tabindex="0" role="button" aria-label="查看 ${esc(title)}">
      <div class="shared-cover" data-image-state="loading"><img data-pose-img data-src="${esc(imageUrl(id))}" alt="${esc(title)}的姿势参考线稿" loading="lazy" decoding="async"><span class="cover-fallback">缩略图暂不可用</span><span class="cover-model">${esc(label)}</span><div class="cover-meta"><span>${esc(isPose?item.category:item.angle)}</span><span>${esc(isPose?'':item.category)}</span></div></div>
      <div class="card-footer"><h3>${esc(title)}</h3><div class="gallery-card-labels"><span class="mini-tag">${esc(isPose?item.series:item.series)}</span></div></div>
    </article>`;
  }
  render(){
    const grid=$('#pose-grid');
    if(!this.total){grid.innerHTML=`<div class="empty">${this.status?.count?'当前筛选没有匹配的姿势。':'尚未同步。点上方「同步姿势集」从原站读取 1439 张姿势参考线稿。'}</div>`;return;}
    grid.innerHTML=this.items.map(item=>this.card(item)).join('');
    const observer=this.ensureObserver();
    for(const img of grid.querySelectorAll('img[data-src]'))observer.observe(img);
  }
  async open(id){
    const detail=await this.c.api(`pose/${encodeURIComponent(id)}/detail`);
    // 慢回包护栏：详情请求期间切到其它库时，不渲染错库详情弹窗。
    if(!this.active)return;
    this.selected=detail;this.openedId=id;this.original=false;
    $('#pose-detail-title').textContent=`${detail.poseNo} · ${detail.poseName}`;
    $('#pose-detail-meta').textContent=`${detail.series} / ${detail.category} / ${detail.angle}`;
    $('#pose-detail-image').src=imageUrl(detail.id);
    $('#pose-detail-status').textContent='';
    $('#pose-detail-full').textContent='加载原图';
    $('#pose-detail-full').disabled=false;
    $('#pose-detail-source').href=this.status?.source?.url||'https://ai-pose-gallery.pages.dev/';
    $('#pose-detail-angles').innerHTML=(detail.angles||[]).map(a=>`<button type="button" class="pose-angle ${a.id===detail.id?'selected':''}" data-pose-angle="${esc(a.id)}" aria-pressed="${a.id===detail.id}">${esc(a.angle)}</button>`).join('');
    const dialog=$('#pose-dialog');
    if(!dialog.open)dialog.showModal();
  }
  selectAngle(id){
    if(!this.selected)return;
    const angle=(this.selected.angles||[]).find(a=>a.id===id);
    if(!angle)return;
    this.original=false;
    $('#pose-detail-image').src=imageUrl(id);
    $('#pose-detail-meta').textContent=`${this.selected.series} / ${this.selected.category} / ${angle.angle}`;
    $('#pose-detail-full').textContent='加载原图';
    $('#pose-detail-full').disabled=false;
    $('#pose-detail-status').textContent='';
    for(const button of $('#pose-detail-angles').querySelectorAll('[data-pose-angle]')){const active=button.dataset.poseAngle===id;button.classList.toggle('selected',active);button.setAttribute('aria-pressed',String(active));}
  }
  loadOriginal(){
    if(!this.selected||this.original)return;
    const active=$('#pose-detail-angles').querySelector('[data-pose-angle][aria-pressed="true"]')?.dataset.poseAngle||this.selected.id;
    this.original=true;
    $('#pose-detail-image').src=imageUrl(active,true);
    $('#pose-detail-status').textContent='正在加载 900×1200 原图（约 0.5MB），首次加载后会缓存在本机。';
    $('#pose-detail-full').textContent='已加载原图';
    $('#pose-detail-full').disabled=true;
  }
  // 相邻姿势导航：按当前列表上下文定位（按姿势取 coverId，逐张模式取单张 id）。
  step(delta){
    if(!this.items.length||!this.selected||this.switching)return;
    const isPose=this.group!=='angle';
    const currentId=this.openedId||this.selected.id;
    const index=this.items.findIndex(item=>isPose?item.coverId===currentId:item.id===currentId);
    if(index<0)return;
    const next=this.items[index+delta];
    if(!next)return;
    this.switching=true;
    this.c.act(async()=>{try{await this.open(isPose?next.coverId:next.id);}finally{this.switching=false;}});
  }
  // 详情键盘流：←→ 切视角、↑↓ 切姿势；Esc 由原生 dialog 处理。输入控件聚焦时不拦截。
  onKey(e){
    if(e.target.closest('input,textarea,select'))return;
    if(e.key==='ArrowLeft'||e.key==='ArrowRight'){
      e.preventDefault();
      const angles=this.selected?.angles||[];
      if(!angles.length)return;
      const active=$('#pose-detail-angles').querySelector('[data-pose-angle][aria-pressed="true"]')?.dataset.poseAngle||this.selected.id;
      let i=angles.findIndex(a=>a.id===active);
      if(i<0)i=0;
      i=(i+(e.key==='ArrowRight'?1:-1)+angles.length)%angles.length;
      this.selectAngle(angles[i].id);
    }else if(e.key==='ArrowUp'||e.key==='ArrowDown'){
      e.preventDefault();
      this.step(e.key==='ArrowDown'?1:-1);
    }
  }
  async sync(){
    if(this.status?.syncing)return;
    $('#pose-sync').disabled=true;$('#pose-sync').textContent='同步中…';
    $('#pose-status').textContent='正在读取原站目录…';
    $('#pose-status').classList.remove('error');
    try{
      const result=await this.c.api('pose/sync',{});
      if(!this.active)return;
      this.c.toast(`姿势集同步完成：${result.total} 张，新增 ${result.added}`);
      await this.load(true);
      if(!this.active)return;
      // 结果提示写在状态重绘之后，否则会被 renderStatus 清空。
      $('#pose-status').textContent=`同步完成：共 ${result.total} 张，新增 ${result.added} 张，移除 ${result.removed} 张，更新 ${result.updated} 张。`;
      $('#pose-status').classList.remove('error');
    }catch(e){
      if(!this.active)return;
      $('#pose-status').textContent=e.message;
      $('#pose-status').classList.add('error');
      this.c.toast(e.message,true);
      // 失败时从接口重新取状态，界面不保留本地猜测的同步结果。
      try{await this.load(false);}catch{}
      this.renderStatus();
    }
  }
  init(){
    if(this.bound)return;this.bound=true;
    $('#pose-sync').addEventListener('click',()=>{if(!this.active)return;this.c.act(()=>this.sync());});
    $('#pose-prev').addEventListener('click',()=>{if(!this.active)return;this.c.act(async()=>{if(this.page<=0)return;this.page--;await this.load(false);});});
    $('#pose-next').addEventListener('click',()=>{if(!this.active)return;this.c.act(async()=>{if((this.page+1)*this.pageSize>=this.total)return;this.page++;await this.load(false);});});
    for(const id of ['pose-series','pose-category','pose-angle','pose-group'])$('#'+id).addEventListener('change',()=>{if(!this.active)return;this.c.act(()=>this.load(true));});
    let timer=null;
    $('#pose-search').addEventListener('input',()=>{if(!this.active)return;clearTimeout(timer);timer=setTimeout(()=>this.c.act(()=>this.load(true)),300);});
    $('#pose-clear').addEventListener('click',()=>{if(!this.active)return;this.c.act(async()=>{for(const id of ['pose-series','pose-category','pose-angle'])$('#'+id).value='';$('#pose-search').value='';$('#pose-group').value='pose';await this.load(true);});});
    $('#pose-grid').addEventListener('click',e=>{
      if(!this.active)return;
      const card=e.target.closest('[data-pose]');
      if(card)this.c.act(()=>this.open(card.dataset.pose));
    });
    $('#pose-grid').addEventListener('keydown',e=>{
      if(!this.active)return;
      if(e.key!=='Enter'&&e.key!==' ')return;
      const card=e.target.closest('[data-pose]');
      if(card){e.preventDefault();this.c.act(()=>this.open(card.dataset.pose));}
    });
    $('#pose-detail-angles').addEventListener('click',e=>{
      if(!this.active)return;
      const button=e.target.closest('[data-pose-angle]');
      if(button)this.selectAngle(button.dataset.poseAngle);
    });
    $('#pose-detail-full').addEventListener('click',()=>{if(!this.active)return;this.loadOriginal();});
    $('#pose-detail-prev').addEventListener('click',()=>{if(!this.active)return;this.step(-1);});
    $('#pose-detail-next').addEventListener('click',()=>{if(!this.active)return;this.step(1);});
    $('#pose-dialog').addEventListener('keydown',e=>{if(!this.active)return;this.onKey(e);});
    // 图片加载失败只影响卡片显示，不阻塞列表；删除 data-src 后不再重试同一地址。
    document.addEventListener('error',e=>{
      if(!this.active)return;
      const img=e.target;
      if(!(img instanceof HTMLImageElement)||!img.hasAttribute('data-pose-img'))return;
      const cover=img.closest('.shared-cover');
      if(cover)cover.dataset.imageState='error';
      if(img.id==='pose-detail-image')$('#pose-detail-status').textContent='图片读取失败，请稍后重试或到原站查看。';
    },true);
    document.addEventListener('load',e=>{
      if(!this.active)return;
      const img=e.target;
      if(!(img instanceof HTMLImageElement)||!img.hasAttribute('data-pose-img'))return;
      const cover=img.closest('.shared-cover');
      if(cover)cover.dataset.imageState='ready';
      if(img.id==='pose-detail-image'&&this.original)$('#pose-detail-status').textContent='原图已加载。';
    },true);
    $('#pose-dialog')?.addEventListener('close',()=>{if(!this.active)return;this.selected=null;this.openedId=null;this.original=false;$('#pose-detail-image').removeAttribute('src');$('#pose-detail-status').textContent='';});
  }
}
