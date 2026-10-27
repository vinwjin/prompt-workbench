const $=s=>document.querySelector(s);
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const bytes=n=>{if(!n)return '0 B';const k=Math.min(3,Math.floor(Math.log(n)/Math.log(1024)));return (n/1024**k).toLocaleString('zh-CN',{maximumFractionDigits:k?1:0})+' '+['B','KiB','MiB','GiB'][k];};
const date=v=>v?new Date(v).toLocaleString('zh-CN'):'暂无';
export class Settings {
  constructor(ctx){this.c=ctx;this.serial=0;this.pending=null;}
  init(){
    const style=document.createElement('link');style.rel='stylesheet';style.href='/management.css';document.head.append(style);$('#quick-open').disabled=false;
    $('#data-overview-refresh').onclick=()=>this.c.act(()=>this.load({fresh:true}));
    $('#diagnostic-export').onclick=()=>this.c.act(async()=>{const r=await this.c.api('database/overview?refresh=1');this.c.download({schema:'prompt-workbench/diagnostics/v1',...r},'workbench-diagnostics.json');});
    $('#snapshot-create').onclick=()=>this.c.act(async()=>{const button=$('#snapshot-create');button.disabled=true;$('#snapshot-status').textContent='正在保存一致性快照，请等待完成…';try{const r=await this.c.api('database/snapshots',{});$('#snapshot-status').textContent='已保存 '+bytes(r.bytes)+' · '+date(r.createdAt)+' · 快速检查通过';await this.load();this.c.toast('数据库快照已保存；图片和视频文件需另行备份。');}catch(e){$('#snapshot-status').textContent=e.message;throw e;}finally{button.disabled=false;}});
    $('#settings-nav').onclick=e=>{const button=e.target.closest('[data-settings-target]');if(!button)return;const target=$('#'+button.dataset.settingsTarget);target.scrollIntoView({behavior:'smooth',block:'start'});for(const b of $('#settings-nav').querySelectorAll('button'))b.setAttribute('aria-current',String(b===button));};
    $('#settings-models').onclick=()=>this.c.show('models');
    this.palette();this.render();
  }
  render(){const p=this.c.readState().providers||[],local=p.filter(x=>['router','ollama','llama'].includes(x.protocol)).length;$('#connection-overview').innerHTML=`<div><span class="kicker">连接概览</span><strong>${p.length} 个连接</strong><small>${p.length-local} 个在线 / 账号 · ${local} 个本地</small></div><p>目录读取、当前选模与生成测试各自保留状态。进入连接卡片可管理模型；测试生成由你主动发起。</p>`;$('#settings-connection-count').textContent=p.length+' 个已配置连接';}
  async load({fresh=false}={}){if(this.pending){if(!fresh)return this.pending;await this.pending.catch(()=>{});return this.load({fresh:true});}this.pending=this.readOverview(fresh);try{return await this.pending;}finally{this.pending=null;}}
  async readOverview(fresh=false){const serial=++this.serial;$('#data-overview-refresh').disabled=true;$('#data-overview-status').textContent='正在读取本机数据统计…';try{const d=await this.c.api('database/overview'+(fresh?'?refresh=1':''));if(serial!==this.serial)return;
      const db=d.database,backupBytes=d.backups.reduce((n,r)=>n+r.bytes,0),snapshotBytes=d.snapshots.reduce((n,r)=>n+r.bytes,0);
      const count=kind=>d.records.find(r=>r.kind===kind)?.count||0;
      $('#data-metrics').innerHTML=[['我的提示词',count('assets'),'包含已入回收站的记录'],['公共案例',count('shared'),'本机已同步，可按来源查看'],['数据库',bytes(db.mainBytes+db.walBytes),'主库 '+bytes(db.mainBytes)+' · WAL '+bytes(db.walBytes)],['最近业务备份',d.backups.length?date(d.backups[0].createdAt):'暂无备份',d.backups.length+' 份业务 JSON · '+bytes(backupBytes)]].map(([label,value,note])=>`<article class="metric-card"><span>${esc(label)}</span><strong>${esc(value)}</strong><small>${esc(note)}</small></article>`).join('');
      const categories=[['数据库与日志',db.mainBytes+db.walBytes,'记录与配置'],['私人素材',d.privateMedia.bytes,d.privateMedia.count+' 个文件，单独保留'],['公共图片缓存',d.publicCache.bytes,d.publicCache.count+' 张，可重新读取'],['业务 JSON 备份',backupBytes,d.backups.length+' 份'],['数据库快照',snapshotBytes,d.snapshots.length+' 份，不含素材文件']];const total=categories.reduce((n,r)=>n+r[1],0);
      $('#storage-total').textContent=bytes(total);$('#storage-breakdown').innerHTML=categories.map(([label,size,note],i)=>`<div class="storage-row"><div><span class="storage-key tone-${i}"></span><strong>${esc(label)}</strong><small>${esc(note)}</small></div><span>${bytes(size)}</span><meter class="storage-meter tone-${i}" min="0" max="${Math.max(1,total)}" value="${size}" aria-label="${esc(label)}容量比例"></meter></div>`).join('');
      $('#database-detail').textContent=`${String(db.journalMode).toUpperCase()} · 数据模式 ${db.schema} · 库内可复用空间 ${bytes(db.reusableBytes)}。可复用空间不等于损坏，无需每次压缩。`;
      $('#data-records').innerHTML=d.records.filter(r=>r.label!==r.kind||r.kind==='shared').map(r=>`<tr><th scope="row">${esc(r.label)}</th><td>${r.count.toLocaleString('zh-CN')}</td><td>${r.group==='public'?'公共缓存':'本机记录'}</td></tr>`).join('');
      $('#backup-list').innerHTML=d.backups.slice(0,5).map(r=>`<li><time>${esc(date(r.createdAt))}</time><span>${bytes(r.bytes)}</span></li>`).join('')||'<li>尚无业务备份</li>';
      $('#snapshot-list').innerHTML=d.snapshots.map(r=>`<li><div><time>${esc(date(r.createdAt))}</time><small>${bytes(r.bytes)}</small></div><a class="snapshot-download" href="/api/database/snapshots/${encodeURIComponent(r.name)}" download>下载快照</a></li>`).join('')||'<li>尚未创建数据库快照</li>';
      $('#data-overview-status').textContent='更新于 '+date(d.checkedAt)+' · 统计范围为数据库、素材、公共图片及本机备份';
    }catch(e){$('#data-overview-status').textContent='读取失败：'+e.message;throw e;}finally{if(serial===this.serial)$('#data-overview-refresh').disabled=false;}}
  palette(){
    const entries=[['工作台','创作 优化 扩写 翻译','workspace'],['我的提示词','收藏 资产 文件夹','library'],['提示词广场','图片 视频 OpenNana','plaza'],['采集收集箱','链接 作者 X','inbox'],['片段库','组合 复用 提示词 积木','snippets'],['结果对比','比较 实验 迭代','compare'],['模板与工程','变量 模板','templates'],['任务与历史','恢复 输入 历史','history'],['模型连接','账号 API 模型 登录','models'],['数据与设置','备份 数据库 缓存','settings'],['回收站','恢复 删除','recycle']];
    const dialog=$('#quick-dialog'),input=$('#quick-search');let selected=0,visible=[];
    const paint=()=>{const q=input.value.trim().toLowerCase();visible=[...entries,...(this.c.readState().templates||[]).map(t=>['应用模板 · '+t.name,'创作 任务 模板','workspace',t.id])].filter(e=>e.join(' ').toLowerCase().includes(q)).slice(0,40);selected=Math.min(selected,Math.max(0,visible.length-1));$('#quick-results').innerHTML=visible.map((e,i)=>`<button type="button" role="option" aria-selected="${i===selected}" data-quick-index="${i}"><span>${esc(e[0])}</span><small>${esc(e[1])}</small><kbd>↵</kbd></button>`).join('')||'<p class="muted">没有匹配的页面，试试“模型”“备份”或“对比”。</p>';input.setAttribute('aria-expanded','true');};
    const open=()=>{if(document.querySelector('dialog[open]'))return;input.value='';selected=0;paint();dialog.showModal();input.focus();};
    const run=i=>{const entry=visible[i];if(!entry)return;dialog.close();this.c.show(entry[2]);if(entry[3]){$('#template-select').value=entry[3];$('#template-select').dispatchEvent(new Event('change'));$('#input').focus();}};
    $('#quick-open').onclick=open;input.oninput=()=>{selected=0;paint();};input.onkeydown=e=>{if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();selected=(selected+(e.key==='ArrowDown'?1:-1)+Math.max(1,visible.length))%Math.max(1,visible.length);paint();$('#quick-results [aria-selected="true"]')?.scrollIntoView({block:'nearest'});}if(e.key==='Enter'){e.preventDefault();run(selected);}};$('#quick-results').onclick=e=>{const b=e.target.closest('[data-quick-index]');if(b)run(Number(b.dataset.quickIndex));};
    document.addEventListener('keydown',e=>{if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='k'){if(dialog.open){e.preventDefault();dialog.close();}else if(!document.querySelector('dialog[open]')){e.preventDefault();open();}}});
  }
}
