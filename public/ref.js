// 参考素材 · 脸库 / 服装库（只读）。数据直接对接作者源站，不依赖中转仓库。
// 与姿势参考（pose.js）共用同一 #pose 视图，通过顶部库切换 tab 协调；本模块负责 face / costume 两库。
const $=s=>document.querySelector(s);
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const imageUrl=(id,full=false)=>`/api/ref/${encodeURIComponent(id)}/image${full?'?full=1':''}`;
const LIB_META={
  face:{title:'脸库',unit:'张',groupLabel:'部位',search:'搜索发型、造型或编号',author:'あぎ',authorUrl:'https://x.com/agi_aibusi',desc:'AI 生成架空人物，非真人；正面向脸特写与造型参考。CC0 1.0，放弃著作权，可自由使用（含商用）。图片只在本机缓存供你个人参考，不随备份或公开副本分发。'},
  costume:{title:'服装库',unit:'套',groupLabel:'分类',search:'搜索关键词或编号',author:'ギア',authorUrl:'https://x.com/giaaibusi',desc:'无人物、只有服装的参考图。制作者允许免费用于创作参考（含商用），但禁止再分发图片本体；品牌相似度已做检查但不保证不侵权，商用前请自行判断。图片只在本机缓存供你个人参考。'}
};
export class RefUI{
  constructor(ctx){this.c=ctx;this.lib='face';this.active=false;this.pageSize=60;this.page=0;this.total=0;this.items=[];this.status=null;this.selected=null;this.original=false;this.observer=null;this.serial=0;this.bound=false;}
  libMeta(lib){return LIB_META[lib]||LIB_META.face;}
  state(){return this.c.readState();}
  filters(){return {group:$('#pose-category').value,query:$('#pose-search').value.trim()};}
  ensureObserver(){
    if(this.observer)return this.observer;
    this.observer=new IntersectionObserver(entries=>{for(const entry of entries)if(entry.isIntersecting){const img=entry.target;if(!img.isConnected||!img.dataset.src)continue;img.src=img.dataset.src;delete img.dataset.src;this.observer.unobserve(img);}},{rootMargin:'200px'});
    return this.observer;
  }
  async load(reset=true){
    if(reset)this.page=0;
    const serial=++this.serial;
    const requestLib=this.lib;
    const {group,query}=this.filters();
    const params=new URLSearchParams({lib:this.lib,group,q:query,offset:String(this.page*this.pageSize),limit:String(this.pageSize)});
    const result=await this.c.api(`ref?${params}`);
    // 慢回包竞态护栏：请求期间切到其它库或本库再次发起请求时，丢弃过期响应，避免覆盖当前视图。
    if(serial!==this.serial||!this.active||this.lib!==requestLib)return;
    this.items=result.items||[];this.total=result.total||0;this.status=result.status||this.status;
    this.renderFilters();this.render();this.renderStatus();
  }
  renderFilters(){
    const status=this.status;if(!status)return;
    const sel=$('#pose-category');const old=sel.value;
    const html=`<option value="">全部${LIB_META[this.lib].groupLabel}</option>`+(status.groups||[]).map(v=>`<option value="${esc(v)}">${esc(v)}</option>`).join('');
    if(sel.innerHTML!==html){sel.innerHTML=html;sel.value=(status.groups||[]).includes(old)?old:'';}
    $('#pose-series').value='';$('#pose-angle').value='';$('#pose-group').value='pose';
    $('#pose-series').disabled=true;$('#pose-angle').disabled=true;$('#pose-group').disabled=true;
    $('#pose-category').disabled=false;$('#pose-search').placeholder=LIB_META[this.lib].search;
  }
  renderStatus(){
    const status=this.status||{},count=Number(status.count)||0;
    $('#pose-count').textContent=count?`已同步 ${count} ${LIB_META[this.lib].unit}`:'尚未同步';
    const note=status.lastSync?`上次同步 ${new Date(status.lastSync).toLocaleString('zh-CN')}${status.lastAdded?` · 新增 ${status.lastAdded}`:''}${status.lastRemoved?` · 移除 ${status.lastRemoved}`:''}`:`点「同步${LIB_META[this.lib].title}」从作者源站读取最新目录。`;
    $('#pose-sync-note').textContent=note;
    $('#pose-sync').disabled=!!status.syncing;
    $('#pose-sync').textContent=status.syncing?'同步中…':`同步${LIB_META[this.lib].title}`;
    $('#pose-status').textContent=status.lastError||'';
    $('#pose-status').classList.toggle('error',!!status.lastError);
    const pages=Math.max(1,Math.ceil(this.total/this.pageSize));
    $('#pose-page').textContent=this.total?`第 ${this.page+1} / ${pages} 页 · 共 ${this.total} ${LIB_META[this.lib].unit}`:'';
    $('#pose-prev').disabled=this.page<=0;
    $('#pose-next').disabled=this.page+1>=pages;
  }
  label(item){
    if(this.lib==='face')return [item.section,item.hair,item.style].filter(Boolean).join(' · ');
    return [item.category,item.keywordsZh].filter(Boolean).join(' · ');
  }
  card(item){
    const title=this.lib==='face'?(item.style||item.hair||item.section):item.keywordsZh;
    return `<article class="shared-card has-cover" data-pose="${esc(item.id)}" tabindex="0" role="button" aria-label="查看 ${esc(title)}">
      <div class="shared-cover" data-image-state="loading"><img data-pose-img data-src="${esc(imageUrl(item.id))}" alt="${esc(title)}参考图" loading="lazy" decoding="async"><span class="cover-fallback">缩略图暂不可用</span><span class="cover-model">${esc(item.originId)}</span><div class="cover-meta"><span>${esc(this.lib==='face'?item.section:item.category)}</span></div></div>
      <div class="card-footer"><h3>${esc(title)}</h3><div class="gallery-card-labels"><span class="mini-tag">${esc(this.lib==='face'?item.hair:item.keywordsZh)}</span></div></div>
    </article>`;
  }
  render(){
    const grid=$('#pose-grid');
    if(!this.total){grid.innerHTML=`<div class="empty">${this.status?.count?'当前筛选没有匹配的参考图。':`尚未同步。点上方「同步${LIB_META[this.lib].title}」从作者源站读取。`}</div>`;return;}
    grid.innerHTML=this.items.map(item=>this.card(item)).join('');
    const observer=this.ensureObserver();
    for(const img of grid.querySelectorAll('img[data-src]'))observer.observe(img);
  }
  async open(id){
    const requestLib=this.lib;
    const detail=await this.c.api(`ref/${encodeURIComponent(id)}/detail`);
    // 慢回包护栏：详情请求期间切到其它库时，不渲染错库详情弹窗。
    if(!this.active||this.lib!==requestLib)return;
    this.selected=detail;this.openedId=id;this.original=false;
    $('#pose-detail-title').textContent=this.lib==='face'?(detail.style||detail.hair||detail.section):detail.keywordsZh;
    $('#pose-detail-meta').textContent=this.label(detail);
    $('#pose-detail-image').src=imageUrl(detail.id);
    $('#pose-detail-status').textContent='';
    $('#pose-detail-full').textContent='加载原图';
    $('#pose-detail-full').disabled=false;
    $('#pose-detail-source').href=detail.fullUrl;
    $('#pose-detail-angles').innerHTML='';
    const dialog=$('#pose-dialog');
    if(!dialog.open)dialog.showModal();
  }
  loadOriginal(){
    if(!this.selected||this.original)return;
    this.original=true;
    $('#pose-detail-image').src=imageUrl(this.selected.id,true);
    $('#pose-detail-status').textContent='正在加载原图，首次加载后会缓存在本机。';
    $('#pose-detail-full').textContent='已加载原图';
    $('#pose-detail-full').disabled=true;
  }
  step(delta){
    if(!this.items.length||!this.selected||this.switching)return;
    const index=this.items.findIndex(item=>item.id===(this.openedId||this.selected.id));
    if(index<0)return;
    const next=this.items[index+delta];
    if(!next)return;
    this.switching=true;
    this.c.act(async()=>{try{await this.open(next.id);}finally{this.switching=false;}});
  }
  onKey(e){
    if(e.target.closest('input,textarea,select'))return;
    if(e.key==='ArrowUp'||e.key==='ArrowDown'){e.preventDefault();this.step(e.key==='ArrowDown'?1:-1);}
  }
  async sync(){
    if(this.status?.syncing)return;
    const requestLib=this.lib;
    $('#pose-sync').disabled=true;$('#pose-sync').textContent='同步中…';
    $('#pose-status').textContent='正在读取作者源站目录…';
    $('#pose-status').classList.remove('error');
    try{
      const result=await this.c.api('ref/sync',{lib:this.lib});
      if(!this.active||this.lib!==requestLib)return;
      this.c.toast(`${LIB_META[this.lib].title}同步完成：${result.total} ${LIB_META[this.lib].unit}，新增 ${result.added}`);
      await this.load(true);
      if(!this.active||this.lib!==requestLib)return;
      $('#pose-status').textContent=`同步完成：共 ${result.total} ${LIB_META[this.lib].unit}，新增 ${result.added}，移除 ${result.removed}，更新 ${result.updated}。`;
      $('#pose-status').classList.remove('error');
    }catch(e){
      if(!this.active||this.lib!==requestLib)return;
      $('#pose-status').textContent=e.message;
      $('#pose-status').classList.add('error');
      this.c.toast(e.message,true);
      try{await this.load(false);}catch{}
      this.renderStatus();
    }
  }
  init(){
    if(this.bound)return;this.bound=true;
    $('#pose-sync').addEventListener('click',()=>{if(!this.active)return;this.c.act(()=>this.sync());});
    $('#pose-prev').addEventListener('click',()=>{if(!this.active)return;this.c.act(async()=>{if(this.page<=0)return;this.page--;await this.load(false);});});
    $('#pose-next').addEventListener('click',()=>{if(!this.active)return;this.c.act(async()=>{if((this.page+1)*this.pageSize>=this.total)return;this.page++;await this.load(false);});});
    $('#pose-category').addEventListener('change',()=>{if(!this.active)return;this.c.act(()=>this.load(true));});
    let timer=null;
    $('#pose-search').addEventListener('input',()=>{if(!this.active)return;clearTimeout(timer);timer=setTimeout(()=>this.c.act(()=>this.load(true)),300);});
    $('#pose-clear').addEventListener('click',()=>{if(!this.active)return;this.c.act(async()=>{$('#pose-category').value='';$('#pose-search').value='';await this.load(true);});});
    $('#pose-grid').addEventListener('click',e=>{if(!this.active)return;const card=e.target.closest('[data-pose]');if(card)this.c.act(()=>this.open(card.dataset.pose));});
    $('#pose-grid').addEventListener('keydown',e=>{if(!this.active)return;if(e.key!=='Enter'&&e.key!==' ')return;const card=e.target.closest('[data-pose]');if(card){e.preventDefault();this.c.act(()=>this.open(card.dataset.pose));}});
    $('#pose-detail-full').addEventListener('click',()=>{if(!this.active)return;this.loadOriginal();});
    $('#pose-detail-prev').addEventListener('click',()=>{if(!this.active)return;this.step(-1);});
    $('#pose-detail-next').addEventListener('click',()=>{if(!this.active)return;this.step(1);});
    $('#pose-dialog').addEventListener('keydown',e=>{if(!this.active)return;this.onKey(e);});
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
