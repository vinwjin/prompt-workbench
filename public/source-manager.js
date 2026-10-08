const $=s=>document.querySelector(s);
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const statusText={queued:'等待',running:'同步中',succeeded:'成功',failed:'失败',skipped:'需人工处理'};
export class SourceManager{
  constructor(ctx){this.c=ctx;this.selected=new Set();this.feeds=[];this.batch={status:'idle',items:[]};this.timer=null;this.starting=false;this.importing=false;}
  render(feeds,batch=this.c.readState().sourceBatch){this.feeds=feeds;this.batch=batch||this.batch;const busy=this.starting||this.importing||this.batch.status==='running';
    $('#share-feeds').innerHTML=feeds.map(f=>{const item=this.batch.items?.find(i=>i.id===f.id),syncable=f.syncable!==false;return `<article class="feed-card ${this.selected.has(f.id)?'is-selected':''}"><div class="feed-heading"><label class="check"><input type="checkbox" data-select-feed="${esc(f.id)}" ${this.selected.has(f.id)?'checked':''} aria-label="选中 ${esc(f.name)}"><strong>${esc(f.auditId||'基础源')}</strong></label><h3>${esc(f.name)}</h3><span class="mini-tag">${syncable?'公开同步':'文件导入'}</span></div><small>${esc(f.license)}</small><p>${esc(f.description)}</p><p class="muted">${esc(f.notice||'同步公开正文，个人收藏独立保留。')}</p><div class="feed-meta">${f.lastSync?`缓存 ${Number(f.count)||0} 条${f.total>f.count?' / 原站 '+f.total+' 条':''} · ${new Date(f.lastSync).toLocaleDateString('zh-CN')}`:'尚无缓存'}${item?`<p class="feed-result">${esc(statusText[item.status])}${item.count!=null?' · '+Number(item.count)+'条':''}${item.error?' · '+esc(item.error):''}</p>`:''}${f.lastError?`<span class="history-error">${esc(f.lastError)}</span>`:''}</div><div class="button-row"><button class="secondary" data-action="feed-sync" data-id="${esc(f.id)}" ${busy||!syncable?'disabled':''}>${syncable?'同步此源':'需要原站文件'}</button>${f.id==='mother'?`<button class="secondary" data-action="feed-next" data-id="mother" ${busy?'disabled':''}>读取下一页</button>`:''}<button class="text-button" data-action="feed-import" data-id="${esc(f.id)}" ${busy?'disabled':''}>导入来源文件</button><a class="source-link" href="${esc(f.url)}" target="_blank" rel="noopener noreferrer">访问来源 ↗</a></div></article>`;}).join('');
    $('#source-selected-count').textContent=`已选 ${this.selected.size} / ${feeds.length} 个来源`;
    const all=$('#source-select-all');all.checked=feeds.length>0&&feeds.every(f=>this.selected.has(f.id));all.indeterminate=this.selected.size>0&&!all.checked;
    $('#sources-sync-all').disabled=busy;$('#sources-sync-selected').disabled=busy||!this.selected.size;
    const b=this.batch;$('#sources-sync-progress').textContent=b.status==='idle'?'一键同步公开来源；需人工文件的来源会明确列为未同步。':`${b.status==='running'?'同步进行中':'本批结束'} ${b.done||0}/${b.total||0} · 成功 ${b.succeeded||0} · 失败 ${b.failed||0} · 需人工 ${b.skipped||0}`;
    if(b.status==='running')this.schedule();
  }
  schedule(){if(this.timer)return;this.timer=setTimeout(()=>{this.timer=null;this.poll();},800);}
  async poll(){try{const result=await this.c.api('sources/batch');this.render(result.feeds,result);if(result.status==='running')this.schedule();else{await this.c.refresh();await this.c.reloadShared();this.c.toast(`同步结束：${result.succeeded||0}成功，${result.failed||0}失败，${result.skipped||0}需人工文件`,!!result.failed);}}catch(e){$('#sources-sync-progress').textContent='同步状态读取失败：'+e.message+'；刷新页面可继续查看。';this.c.toast(e.message,true);}}
  async sync(ids){if(this.starting||this.batch.status==='running')throw Error('批量同步正在进行');if(!ids.length)throw Error('请先勾选来源');this.starting=true;this.render(this.feeds);try{const batch=await this.c.api('sources/batch',{ids});this.batch=batch;this.c.toast('同步批次已启动，进度与每源结果在来源管理中显示。');}finally{this.starting=false;this.render(this.feeds,this.batch);}}
  importSource(id){this.importId=id;$('#source-file').value='';$('#source-file').click();}
  init(){
    $('#sources-sync-all').onclick=()=>this.c.act(()=>this.sync(this.feeds.map(f=>f.id)));
    $('#sources-sync-selected').onclick=()=>this.c.act(()=>this.sync([...this.selected]));
    $('#source-select-all').onchange=e=>{for(const f of this.feeds)e.target.checked?this.selected.add(f.id):this.selected.delete(f.id);this.render(this.feeds);};
    $('#sources-clear-selection').onclick=()=>{this.selected.clear();this.render(this.feeds);};
    document.addEventListener('change',e=>{const id=e.target.dataset.selectFeed;if(!id)return;e.target.checked?this.selected.add(id):this.selected.delete(id);this.render(this.feeds);});
    $('#source-file').onchange=()=>this.c.act(async()=>{const file=$('#source-file').files[0],id=this.importId;if(!file||!id)return;if(file.size>10e6)throw Error('来源文件最多10MB');const text=await file.text();if(!confirm('将文件正文导入此来源缓存？会替换此源当前缓存，个人收藏保留。'))return;this.importing=true;this.render(this.feeds);try{const r=await this.c.api(`sources/${id}/import`,{text,fileName:file.name});this.c.toast(`文件导入 ${r.count} 条；未访问原站`);await this.c.refresh();await this.c.reloadShared();}finally{this.importing=false;this.render(this.feeds);$('#source-file').value='';}});
  }
}
