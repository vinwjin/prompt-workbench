// 参考库、已保存连接和图像任务的组合入口；浏览与参数调整不发起生成。
import { IMAGE_RATIOS, imageModelKind, imageSize, fitImageRatio } from './image-options.js';
const $ = s => document.querySelector(s);
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const STATUS = { queued: '排队中', running: '生成中', cancelling: '正在取消', succeeded: '已完成', failed: '失败', cancelled: '已停止等待', interrupted: '已中断' };
const REFERENCES = [{ key: 'person', lib: 'face', label: '人像', icon: '◎', hint: '确定人物身份与面貌' }, { key: 'garment', lib: 'costume', label: '服装', icon: '♧', hint: '挑选穿搭与服饰细节' }, { key: 'pose', lib: 'pose', label: '姿势', icon: '♧', hint: '指定动作与镜头角度' }];
const STYLES = { photo: '写实人像写真，自然肤质，柔和自然光，准确的人体结构，画面细节清晰。', film: '电影感摄影，富有层次的光影，协调的色彩，真实材质与自然表情。', illustration: '角色设计插画，清晰的轮廓，统一的画风，完整的人体结构与服饰细节。', custom: '' };

export class ComfyStudio {
  constructor({ api, act, toast }) { Object.assign(this, { api, act, toast, slots: {}, jobs: [], recipes: [], providers: [], params: {}, page: 0, pickerPage: 0, pickerSerial: 0, modelSerial: 0, onlineSerial: 0 }); }
  init() {
    const click = (id, fn) => $(id).addEventListener('click', () => this.act(fn, $(id)));
    click('#comfy-jobs-clear', async () => {
      await this.api('comfy/jobs/clear-history', {}); this.page = 0; this.selectedJob = null; await this.loadJobs();
    });
    click('#comfy-output-save', async () => { const r = await this.api('comfy/output', { directory: $('#comfy-output-dir').value }); this.renderOutput(r); this.toast('图片输出目录已保存'); });
    $('#comfy-output-open').onclick = () => { $('#comfy-config-dialog').showModal(); $('#comfy-output-dir').focus(); };
    click('#comfy-save', () => this.saveSettings()); click('#comfy-health', () => this.health());
    click('#comfy-run', () => this.run()); click('#comfy-model-refresh', () => this.loadModels());
    click('#comfy-online-refresh', () => this.loadOnlineModels());
    $('#comfy-online-config').onclick = () => $('#comfy-config-dialog').showModal();
    $('#comfy-inline-url').oninput = () => { this.invalidateModels(); $('#comfy-connection-state').textContent = '地址已编辑，请先连接并读取模型'; $('#comfy-model-refresh').textContent = '连接并读取模型'; };
    $('#comfy-model-search').oninput = () => this.renderOnlineModels();
    $('#comfy-model-select').onchange = () => { const id = $('#comfy-model-select').value; $('#comfy-model-id').value = id === '__manual__' ? '' : id; this.modelFeedback(); };
    $('#comfy-model-id').oninput = () => this.modelFeedback();
    $('#comfy-image-size').onchange = () => this.sizeFeedback();
    $('#comfy-image-resolution').onchange = () => this.sizeFeedback();
    $('#comfy-custom-ratio').onchange = () => this.syncSize('width');
    $('#comfy-lock-ratio').onchange = () => { if ($('#comfy-lock-ratio').checked) this.syncSize('width'); };
    for (const axis of ['width', 'height']) $('#comfy-custom-' + axis).onchange = () => this.syncSize(axis);
    click('#comfy-jobs-refresh', () => this.loadJobs()); click('#comfy-scan', () => this.scan());
    click('#comfy-prompt-copy', async () => { await navigator.clipboard.writeText($('#comfy-prompt').value); this.toast('提示词已复制'); });
    $('#comfy-config-open').onclick = () => $('#comfy-config-dialog').showModal();
    $('#comfy-open-connections').onclick = () => { $('#comfy-config-dialog').close(); document.querySelector('nav [data-view="models"]').click(); };
    for (const id of ['#comfy-config-dialog', '#comfy-garment-dialog']) $(id).addEventListener('click', e => { if (e.target.closest('[data-close]')) $(id).close(); });
    $('#comfy-garment-dialog').addEventListener('close', () => { if (!$('#comfy-garment-dialog').open) { ++this.pickerSerial; $('#comfy-garment-grid').replaceChildren(); } });
    $('#comfy-clear').onclick = () => { this.slots = {}; this.renderSlots(); this.compose(); };
    $('#comfy-recipe').onchange = () => { this.captureParams(); this.params = {}; this.renderRecipe(); this.invalidateModels(); if ($('#comfy-inline-url').value.trim() === this.settings?.baseUrl) this.act(() => this.loadModels({ saveAddress: false }), null); };
    $('#comfy-backend').onchange = () => { this.renderBackend(); };
    $('#comfy-provider').onchange = () => this.renderProvider();
    $('#comfy-style').onchange = () => this.compose();
    $('#comfy-prompt').oninput = () => { this.promptEdited = true; };
    $('#comfy-prompt-reset').onclick = () => { if (this.promptEdited && !confirm('用当前参考图和画风重建提示词？现有手工编辑将被替换。')) return; this.promptEdited = false; this.compose(); };
    $('#comfy-size').onchange = () => { if ($('#comfy-size').value === 'custom') { $('#comfy-advanced').open = true; return; } const [w, h] = $('#comfy-size').value.split('x'); const defaults = this.currentRecipe().params; $('#comfy-param-width').value = w || defaults.find(p => p.key === 'width').default; $('#comfy-param-height').value = h || defaults.find(p => p.key === 'height').default; $('#comfy-local-lock').checked = false; };
    $('#comfy-garment-search').oninput = () => { clearTimeout(this.searchTimer); this.pickerPage = 0; ++this.pickerSerial; this.searchTimer = setTimeout(() => this.act(() => this.renderPicker(), null), 250); };
    $('#comfy-garment-cat').onchange = () => { this.pickerPage = 0; this.act(() => this.renderPicker(), null); };
    $('#comfy-picker-prev').onclick = () => { --this.pickerPage; this.act(() => this.renderPicker(), null); };
    $('#comfy-picker-next').onclick = () => { ++this.pickerPage; this.act(() => this.renderPicker(), null); };
    $('#comfy-jobs-prev').onclick = () => { --this.page; this.act(() => this.loadJobs(), null); };
    $('#comfy-jobs-next').onclick = () => { ++this.page; this.act(() => this.loadJobs(), null); };
    $('#comfy-garment-grid').onclick = e => { const b = e.target.closest('[data-pick]'); if (b) this.pick(b.dataset.pick); };
    $('#comfy-import-file').onchange = () => this.act(async () => {
      const file = $('#comfy-import-file').files[0]; if (!file) return;
      if (file.size > 2 * 1024 * 1024) throw Error('工作流超过 2MB');
      await this.addWorkflow(JSON.parse(await file.text()), file.name); $('#comfy-import-file').value = '';
    }, null);
    $('#comfy-workflow-files').onclick = e => { const b = e.target.closest('[data-import]'); if (b) this.act(() => this.addWorkflow(this.scanned[Number(b.dataset.import)].recipe.workflow, this.scanned[Number(b.dataset.import)].name), b); };
    $('#comfy-jobs').onclick = e => { const b = e.target.closest('[data-job]'); if (b) { this.selectedJob = b.dataset.job; this.renderResult(); } };
    $('#comfy-result-actions').onclick = e => {
      if (e.target.closest('[data-reveal]')) this.act(async () => { await this.api('comfy/reveal', { id: this.selectedJob }); this.toast('已请求资源管理器定位图片'); }, e.target);
      if (e.target.closest('[data-save-as]')) {
        const job = this.jobs.find(j => j.id === this.selectedJob);
        this.act(async () => {
          if (!window.showSaveFilePicker) throw Error('请使用本机 Chrome 或 Edge 打开工作台，以选择保存位置');
          const type = job.mediaType || 'image/png', ext = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif' }[type] || '.png';
          let handle;
          try { handle = await window.showSaveFilePicker({ suggestedName: '角色图' + ext, types: [{ description: '图片', accept: { [type]: [ext] } }] }); }
          catch (error) { if (error.name === 'AbortError') return; throw error; }
          const response = await fetch('/api/comfy/jobs/' + encodeURIComponent(job.id) + '/image');
          if (!response.ok) throw Error('原图读取失败，未保存文件');
          const blob = await response.blob(), writable = await handle.createWritable();
          try { await writable.write(blob); await writable.close(); }
          catch (error) { await writable.abort().catch(() => {}); throw error; }
          this.toast('已另存为：' + handle.name);
        }, e.target);
      }
      if (e.target.closest('[data-cancel]')) this.act(async () => { await this.api('comfy/jobs/' + encodeURIComponent(this.selectedJob) + '/cancel', {}); await this.loadJobs(); }, e.target);
      if (e.target.closest('[data-reuse]')) this.act(async () => { const j = await this.api('comfy/jobs/' + encodeURIComponent(this.selectedJob)); $('#comfy-prompt').value = j.prompt || ''; $('#comfy-negative').value = j.negativePrompt || ''; this.promptEdited = true; this.toast('已带回正面和负面提示词，可修改后手动生成'); }, e.target);
    };
    $('#comfy-result').onclick = e => { if (e.target.closest('[data-result-preview]')) this.openPreview(); };
    $('#comfy-result').onkeydown = e => { if ((e.key === 'Enter' || e.key === ' ') && e.target.closest('[data-result-preview]')) { e.preventDefault(); this.openPreview(); } };
    $('#comfy-preview-dialog').addEventListener('click', e => { if (e.target.closest('[data-close]') || e.target === $('#comfy-preview-dialog')) $('#comfy-preview-dialog').close(); });
    $('#comfy-preview-dialog').addEventListener('cancel', e => { e.preventDefault(); $('#comfy-preview-dialog').close(); });
    $('#comfy-preview-dialog').addEventListener('close', () => { $('#comfy-preview-image').removeAttribute('src'); $('#comfy-preview-image').alt = ''; $('#comfy-preview-image').classList.remove('original-size'); $('#comfy-preview-fit').textContent = '原尺寸'; });
    $('#comfy-preview-fit').onclick = () => { const original = $('#comfy-preview-image').classList.toggle('original-size'); $('#comfy-preview-fit').textContent = original ? '适应窗口' : '原尺寸'; };
    $('#comfy-local-ratio').onchange = () => this.syncLocalSize('width');
    $('#comfy-local-lock').onchange = () => this.syncLocalSize('width');
    this.renderSlots(); this.compose();
  }
  async load() {
    const [settings, recipes, providers, output] = await Promise.all([this.api('comfy/settings'), this.api('comfy/recipes'), this.api('comfy/providers'), this.api('comfy/output')]);
    this.renderOutput(output);
    this.settings = settings.settings; this.providers = providers.providers || [];
    this.setRecipes(recipes.recipes || []);
    const old = $('#comfy-provider').value;
    $('#comfy-provider').innerHTML = '<option value="">选择已保存的 API 连接</option>' + this.providers.map(p => `<option value="${esc(p.id)}">${esc(p.name)} · ${p.protocol === 'gemini' ? 'Gemini' : 'OpenAI 兼容'}</option>`).join('');
    if (this.providers.some(p => p.id === old)) $('#comfy-provider').value = old;
    if (!this.loaded) { this.renderSettings(); this.renderRecipe(); this.invalidateModels(); this.renderProvider(); this.loaded = true; }
    this.renderBackend(); this.renderSlots(); this.resultSignature = null; await this.loadJobs();
  }
  renderOutput(output) { $('#comfy-output-dir').value = output.directory; $('#comfy-output-status').textContent = '新图片输出：' + output.directory + '；工作台归档：' + output.archiveDirectory; }
  setRecipes(recipes, selected) { const old = selected || $('#comfy-recipe').value; this.recipes = recipes; $('#comfy-recipe').innerHTML = recipes.map(r => `<option value="${esc(r.id)}">${esc(r.name)}</option>`).join(''); if (recipes.some(r => r.id === old)) $('#comfy-recipe').value = old; }
  currentRecipe() { return this.recipes.find(r => r.id === $('#comfy-recipe').value); }
  renderSettings() {
    $('#comfy-base-url').value = $('#comfy-inline-url').value = this.settings?.baseUrl || 'http://127.0.0.1:8188';
    $('#comfy-health-status').textContent = this.settings?.baseUrl ? '已保存地址；测试连接不会生成图片。' : '填写并保存本机服务地址。';
    $('#comfy-connection-state').textContent = this.settings?.baseUrl ? '地址已保存 · 尚未验证本次连接' : '点击下方“连接并读取模型”保存此地址并连接';
    $('#comfy-model-refresh').textContent = this.settings?.baseUrl ? '刷新本机模型' : '连接并读取模型';
  }
  async saveSettings() { const r = await this.api('comfy/settings', { baseUrl: $('#comfy-base-url').value.trim() }); this.settings = r.settings; this.renderSettings(); this.invalidateModels(); this.toast('本机 ComfyUI 地址已保存'); }
  async health() { $('#comfy-health-status').textContent = '正在检查连接、节点和模型…'; try { const r = await this.api('comfy/health', { recipeId: this.currentRecipe()?.id, presetName: $('#comfy-preset').value }); $('#comfy-health-status').textContent = `连接可用 · ${r.preset}（未运行生成）`; } catch (e) { $('#comfy-health-status').textContent = e.message; throw e; } }
  invalidateModels() { ++this.modelSerial; this.modelRead = null; const r = this.currentRecipe(); $('#comfy-preset').replaceChildren(); $('#comfy-connection-state').textContent = this.settings?.baseUrl ? `已保存地址 · “${r?.name || '当前工作流'}”尚未读取` : '尚未保存本机服务地址'; $('#comfy-model-note').textContent = `尚未读取“${r?.name || '当前工作流'}”的模型配套；读取目录不会加载模型或生成图片。`; }
  async loadModels({ saveAddress = true } = {}) {
    const serial = ++this.modelSerial, recipeId = this.currentRecipe()?.id, recipeName = this.currentRecipe()?.name;
    $('#comfy-connection-state').textContent = '正在连接并读取节点与模型…';
    try {
      let baseUrl = $('#comfy-inline-url').value.trim();
      if (!baseUrl) throw Error('请填写本机 ComfyUI 地址，例如 http://127.0.0.1:8188');
      if (baseUrl !== this.settings?.baseUrl && !saveAddress) throw Error('地址已更改，请先保存地址，再读取模型');
      if (baseUrl !== this.settings?.baseUrl) { const saved = await this.api('comfy/settings', { baseUrl }); this.settings = saved.settings; if (serial !== this.modelSerial) return; baseUrl = saved.settings.baseUrl; $('#comfy-base-url').value = baseUrl; $('#comfy-inline-url').value = baseUrl; }
      const r = await this.api('comfy/models', { recipeId });
      baseUrl = r.baseUrl || baseUrl;
      if (serial !== this.modelSerial || recipeId !== this.currentRecipe()?.id || baseUrl !== $('#comfy-inline-url').value.trim()) return;
      const compatible = r.models.filter(m => m.id && m.compatible), selected = $('#comfy-preset').value;
      $('#comfy-preset').innerHTML = compatible.map(m => `<option value="${esc(m.id)}">${esc(m.name)}</option>`).join('');
      const preferred = compatible.find(m => m.id === selected) || compatible.find(m => m.id === r.defaultPresetId) || compatible.find(m => m.id === this.currentRecipe()?.presetName) || compatible.find(m => m.name === this.currentRecipe()?.presetName);
      if (preferred) $('#comfy-preset').value = preferred.id;
      this.modelRead = { baseUrl, recipeId, compatible, all: r.models };
      $('#comfy-connection-state').textContent = `已连接 · ${r.models.filter(m => m.compatible).length} 个兼容配套`;
      const incompatible = r.models.filter(m => !m.compatible);
      $('#comfy-model-note').innerHTML = incompatible.length ? `<details><summary>${incompatible.length} 个不兼容配套，查看原因</summary>${incompatible.map(m => `<p>${esc(m.name)}：${esc(m.reason)}</p>`).join('')}<p>若需使用这些模型，请切换到匹配的图像工作流。</p></details>` : '已读取本机模型，未加载模型或提交生成。';
      if (!compatible.length) $('#comfy-model-note').textContent = `“${recipeName}”当前没有兼容配套，请检查工作流或切换到匹配的图像工作流。`;
    } catch (e) { if (serial === this.modelSerial) { this.modelRead = null; $('#comfy-connection-state').textContent = '连接未完成：' + e.message; $('#comfy-preset').replaceChildren(); $('#comfy-model-note').textContent = e.message; } throw e; }
    finally { $('#comfy-model-refresh').textContent = this.settings?.baseUrl ? '刷新本机模型' : '连接并读取模型'; }
  }
  renderBackend() {
    const local = $('#comfy-backend').value === 'comfy';
    for (const id of ['#comfy-recipe-wrap', '#comfy-local-model', '#comfy-local-connection', '#comfy-size-wrap', '#comfy-advanced', '#comfy-negative-wrap']) $(id).classList.toggle('hidden', !local);
    for (const id of ['#comfy-provider-wrap', '#comfy-online-model']) $(id).classList.toggle('hidden', local);
    $('#comfy-backend-badge').textContent = local ? '本地生成' : '在线生成';
    $('#comfy-recipe-desc').textContent = local ? this.currentRecipe()?.description || '' : '通过所选 API 连接生成图片，沿用模型连接中加密保存的密钥。';
    $('#comfy-model-note').classList.toggle('hidden', !local);
    $('#comfy-submit-note').textContent = local ? '点击后提交到本机 ComfyUI，失败不会自动重试。' : '点击后，参考图与提示词将发送到所选服务，可能产生费用。失败不自动重试。';
  }
  renderProvider() {
    ++this.onlineSerial;
    const p = this.providers.find(p => p.id === $('#comfy-provider').value);
    $('#comfy-model-search').value = '';
    $('#comfy-model-id').value = p?.model && imageModelKind(p.model) === 'candidate' ? p.model : '';
    $('#comfy-provider-info').textContent = p ? `${p.protocol === 'gemini' ? 'Gemini' : 'OpenAI 兼容'} · ${p.baseUrl}` : '先选择已保存的 API 连接，或点“配置连接”添加。';
    $('#comfy-online-refresh').disabled = !p;
    $('#comfy-online-status').textContent = p?.checkedAt ? '缓存目录 · ' + new Date(p.checkedAt).toLocaleString('zh-CN') : '尚未读取此连接的模型目录，点击“获取 API 模型”。';
    const sizes = p?.protocol === 'gemini' ? ['auto', ...IMAGE_RATIOS] : ['auto', '1024x1024', '1024x1536', '1536x1024', 'custom'];
    $('#comfy-image-size').innerHTML = sizes.map(s => `<option value="${s}">${s === 'auto' ? '模型默认' : s === 'custom' ? '自定义宽高 / 锁定比例' : s}</option>`).join('');
    $('#comfy-resolution-wrap').classList.toggle('hidden', p?.protocol !== 'gemini'); $('#comfy-image-resolution').value = '';
    this.renderOnlineModels(); this.sizeFeedback();
  }
  renderOnlineModels() {
    const p = this.providers.find(p => p.id === $('#comfy-provider').value), current = $('#comfy-model-id').value, query = $('#comfy-model-search').value.trim().toLowerCase();
    const ids = [...new Set(p?.models || [])].filter(id => id.toLowerCase().includes(query)).sort((a,b) => (imageModelKind(a)==='candidate'?0:1)-(imageModelKind(b)==='candidate'?0:1));
    $('#comfy-model-select').innerHTML = '<option value="">请选择生图模型</option>' + ids.map(id => { const k=imageModelKind(id); return `<option value="${esc(id)}" ${k==='chat'?'disabled':''}>${esc(id)} · ${k==='candidate'?'生图候选':k==='chat'?'聊天 / 推理':'能力待确认'}</option>`; }).join('') + '<option value="__manual__">手动填写模型 ID…</option>';
    $('#comfy-model-select').value = current ? ids.includes(current) && imageModelKind(current)!=='chat' ? current : '__manual__' : '';
    this.modelFeedback();
  }
  modelFeedback() {
    $('#comfy-manual-model-wrap').classList.toggle('hidden', $('#comfy-model-select').value !== '__manual__');
    const id = $('#comfy-model-id').value.trim(), kind=imageModelKind(id);
    $('#comfy-model-capability').textContent = !id ? '聊天默认模型不会自动带入。请选择目录中的生图候选，或填写服务商提供的生图模型。' : kind==='chat' ? '这是聊天 / 推理型号，生成前会阻止提交，请更换生图模型。' : kind==='candidate' ? '按名称识别为生图候选；目录可见不等于所选服务的图片接口已验收。' : '自定义模型能力待确认，请核对服务商是否支持图片生成。';
    this.sizeFeedback();
  }
  async loadOnlineModels() {
    const id=$('#comfy-provider').value, serial=this.onlineSerial=(this.onlineSerial||0)+1;
    if (!id) throw Error('请先选择 API 连接');
    $('#comfy-online-status').textContent='正在读取服务的模型目录，不发送提示词…';
    try {
      const r=await this.api('comfy/providers/models',{providerId:id});
      if(serial!==this.onlineSerial||id!==$('#comfy-provider').value)return;
      const p=this.providers.find(p=>p.id===id);p.models=r.models;p.checkedAt=r.checkedAt;this.renderOnlineModels();
      $('#comfy-online-status').textContent=`已获取 ${r.models.length} 个模型 · ${r.models.filter(m=>imageModelKind(m)==='candidate').length} 个生图候选 · ${new Date(r.checkedAt).toLocaleTimeString('zh-CN')}`;
    } catch(e) {if(serial===this.onlineSerial)$('#comfy-online-status').textContent='读取失败，保留已有目录：'+e.message;throw e;}
  }
  syncSize(axis) {
    if ($('#comfy-lock-ratio').checked) {
      const dims=fitImageRatio($('#comfy-custom-'+axis).value,$('#comfy-custom-ratio').value,axis);
      $('#comfy-custom-width').value=dims.width;$('#comfy-custom-height').value=dims.height;
    }
    this.sizeFeedback();
  }
  outputSize() {
    const p=this.providers.find(p=>p.id===$('#comfy-provider').value), mode=$('#comfy-image-size').value;
    return imageSize(p?.protocol||'openai',$('#comfy-model-id').value,mode==='custom'?`${$('#comfy-custom-width').value}x${$('#comfy-custom-height').value}`:mode,$('#comfy-image-resolution').value);
  }
  sizeFeedback() {
    $('#comfy-custom-size').classList.toggle('hidden',$('#comfy-image-size').value!=='custom');
    try {const {size,resolution}=this.outputSize();$('#comfy-size-feedback').textContent=`将提交：${size==='auto'?'模型默认画幅':size}${resolution?' · '+resolution:''}。实际可用尺寸取决于所选模型和服务，失败不自动换尺寸重试。`;$('#comfy-size-feedback').classList.remove('comfy-error');}
    catch(e){$('#comfy-size-feedback').textContent=e.message;$('#comfy-size-feedback').classList.add('comfy-error');}
  }
  syncLocalSize(axis) { $('#comfy-size').value = 'custom'; if (!$('#comfy-local-lock').checked) return; const dims = fitImageRatio($('#comfy-param-'+axis).value,$('#comfy-local-ratio').value,axis); $('#comfy-param-width').value=dims.width; $('#comfy-param-height').value=dims.height; }
  captureParams() { for (const el of document.querySelectorAll('#comfy-params input')) this.params[el.dataset.param] = el.value; }
  renderRecipe() {
    const r = this.currentRecipe(); if (!r) return;
    $('#comfy-recipe-desc').textContent = r.description || '';
    $('#comfy-size').value = '';
    $('#comfy-params').innerHTML = r.params.map(p => `<label>${esc(p.label)}<input id="comfy-param-${esc(p.key)}" data-param="${esc(p.key)}" type="number" value="${esc(this.params[p.key] ?? p.default)}" ${p.min === undefined ? '' : `min="${p.min}"`} ${p.max === undefined ? '' : `max="${p.max}"`} step="${p.step || 1}"><small>${esc(p.hint)}</small></label>`).join('');
    $('#comfy-loras').textContent = r.loras?.length ? '工作流 LoRA：' + r.loras.join('、') : '工作流不叠加 LoRA。';
    $('#comfy-local-lock').checked = false;
    for (const axis of ['width','height']) $('#comfy-param-'+axis).onchange = () => this.syncLocalSize(axis);
    this.compose();
  }
  renderSlots() {
    $('#comfy-slots').innerHTML = REFERENCES.map(s => { const v = this.slots[s.key]; return `<div class="comfy-reference" tabindex="0" data-slot="${s.key}" aria-label="${s.label}参考图，可粘贴或拖入图片"><div class="comfy-reference-top"><strong>${s.label}</strong>${v ? `<button data-remove="${s.key}" class="text-button" aria-label="移除${s.label}">×</button>` : '<small>可选</small>'}</div><button class="comfy-reference-preview" data-picker="${s.key}">${v ? `<img src="${esc(this.previewUrl(v))}" alt="${esc(v.name || s.label)}">` : `<span>${s.icon}</span><small>${s.hint}</small>`}</button><span class="comfy-reference-name">${esc(v?.name || '尚未选择')}</span><div class="comfy-reference-buttons"><button data-picker="${s.key}" class="text-button">参考库</button><label class="comfy-file-button">上传<input type="file" data-upload="${s.key}" accept="image/png,image/jpeg,image/webp"></label></div></div>`; }).join('');
    for (const b of document.querySelectorAll('#comfy-slots [data-picker]')) b.onclick = () => this.openPicker(b.dataset.picker);
    for (const b of document.querySelectorAll('#comfy-slots [data-remove]')) b.onclick = () => { delete this.slots[b.dataset.remove]; this.renderSlots(); this.compose(); };
    for (const input of document.querySelectorAll('#comfy-slots [data-upload]')) input.onchange = () => this.act(() => this.upload(input.dataset.upload, input.files[0]), null);
    for (const card of document.querySelectorAll('#comfy-slots [data-slot]')) {
      card.ondragover = e => { e.preventDefault(); card.classList.add('dragging'); }; card.ondragleave = () => card.classList.remove('dragging');
      card.ondrop = e => { e.preventDefault(); this.act(() => this.upload(card.dataset.slot, e.dataTransfer.files[0]), null); };
      card.onpaste = e => { const file = [...(e.clipboardData?.items || [])].find(i => i.type.startsWith('image/'))?.getAsFile(); if (file) { e.preventDefault(); this.act(() => this.upload(card.dataset.slot, file), null); } };
    }
  }
  previewUrl(v) { return v.dataUrl || `/api/${v.library === 'pose' ? 'pose' : 'ref'}/${encodeURIComponent(v.refId)}/image`; }
  async upload(key, file) {
    if (!file) return; if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 8 * 1024 * 1024) throw Error('请上传 8MB 内的 PNG、JPEG 或 WebP 图片');
    const dataUrl = await new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(r.result); r.onerror = () => reject(Error('图片读取失败')); r.readAsDataURL(file); });
    this.slots[key] = { dataUrl, name: file.name }; this.renderSlots(); this.compose();
  }
  compose() {
    if (this.promptEdited) { $('#comfy-prompt-note').textContent = '已保留你的手工编辑。参考图变动后，请核对图像编号，或点“重建”。'; return; }
    const selected = REFERENCES.filter(s => this.slots[s.key]);
    const lines = selected.map((s, i) => `<image${i + 1}>（${s.label}参考）：${s.key === 'person' ? '保留人物的五官、脸型、发型与身份特征。' : s.key === 'garment' ? '采用图中的服装，保留颜色、面料和款式细节。' : '参考身体姿态、构图与视角，不复制线稿或人偶外观。'}`);
    $('#comfy-prompt').value = [selected.length ? '请结合以下参考图，创作一张完整的角色图像：' : '创作一张角色图像，描述人物、服装、姿态与场景。', ...lines, STYLES[$('#comfy-style').value]].filter(Boolean).join('\n');
    $('#comfy-prompt-note').textContent = selected.length ? `已组合 ${selected.length} 张参考图，可直接编辑最终提示词。` : '参考图可选，也可以直接描述画面生成。';
  }
  openPicker(key) { this.pickerKey = key; this.pickerPage = 0; $('#comfy-garment-search').value = ''; $('#comfy-garment-cat').innerHTML = '<option value="">全部分类</option>'; $('#comfy-picker-title').textContent = '选择' + REFERENCES.find(s => s.key === key).label; $('#comfy-garment-dialog').showModal(); this.act(() => this.renderPicker(), null); }
  async renderPicker() {
    const serial = ++this.pickerSerial; const ref = REFERENCES.find(s => s.key === this.pickerKey); if (!ref) return;
    const q = new URLSearchParams({ lib: ref.lib, q: $('#comfy-garment-search').value, limit: '24', offset: String(this.pickerPage * 24), ...(ref.lib === 'pose' ? { group: 'angle', category: $('#comfy-garment-cat').value } : { group: $('#comfy-garment-cat').value }) });
    $('#comfy-garment-grid').innerHTML = '<div class="empty">读取参考库…</div>';
    const r = await this.api((ref.lib === 'pose' ? 'pose?' : 'ref?') + q);
    if (serial !== this.pickerSerial || !$('#comfy-garment-dialog').open) return;
    this.pickerItems = r.items || [];
    const sel = $('#comfy-garment-cat'), old = sel.value, cats = r.status?.categories || r.groups || r.status?.groups || [];
    sel.innerHTML = '<option value="">全部分类</option>' + cats.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join(''); sel.value = old;
    $('#comfy-garment-grid').innerHTML = this.pickerItems.map(it => `<button class="comfy-pick" data-pick="${esc(it.id)}"><img src="/api/${ref.lib === 'pose' ? 'pose' : 'ref'}/${encodeURIComponent(it.id)}/image" alt="" loading="lazy"><span>${esc(this.itemName(it, ref.lib))}</span></button>`).join('') || '<div class="empty">没有匹配的参考图。可前往“AI参考素材”同步目录，或直接上传图片。</div>';
    $('#comfy-picker-page').textContent = `${this.pickerPage + 1} / ${Math.max(1, Math.ceil(r.total / 24))} · ${r.total} 张`;
    $('#comfy-picker-prev').disabled = this.pickerPage === 0; $('#comfy-picker-next').disabled = (this.pickerPage + 1) * 24 >= r.total;
    $('#comfy-picker-credit').textContent = ref.lib === 'face' ? '人像素材：あぎ · CC0。' : '参考素材：ギア · 仅用于创作参考，禁止再分发原图。';
  }
  itemName(it, lib) { return lib === 'pose' ? [it.poseName, it.angle].filter(Boolean).join(' · ') : lib === 'face' ? [it.hair, it.style].filter(Boolean).join(' · ') || it.originId : [it.category, it.originId].filter(Boolean).join(' · '); }
  pick(id) { const ref = REFERENCES.find(s => s.key === this.pickerKey), item = this.pickerItems.find(it => it.id === id); if (!item) return; this.slots[this.pickerKey] = { refId: id, library: ref.lib, name: this.itemName(item, ref.lib) }; $('#comfy-garment-dialog').close(); this.renderSlots(); this.compose(); }
  async scan() { const r = await this.api('comfy/workflows/scan', { directory: $('#comfy-workflow-dir').value }); this.scanned = r.files; $('#comfy-workflow-files').innerHTML = r.files.map((f, i) => `<div class="comfy-import-row"><span>${esc(f.name)}<small>${esc(f.error || (f.recipe.converted ? '已识别 Qwen 画布格式，可转换导入' : 'API 格式'))}</small></span>${f.error ? '' : `<button class="secondary" data-import="${i}">加入</button>`}</div>`).join('') || '<p>此目录没有 JSON 文件。</p>'; }
  async addWorkflow(workflow, name) { const r = await this.api('comfy/workflows/import', { workflow, name }); const catalog = await this.api('comfy/recipes'); this.setRecipes(catalog.recipes, r.recipe.id); this.params = {}; this.renderRecipe(); this.invalidateModels(); this.toast('工作流已加入，未提交生成'); }
  async run() {
    const backend = $('#comfy-backend').value, recipe = this.currentRecipe();
    if (backend === 'comfy' && (!this.settings?.baseUrl || $('#comfy-inline-url').value.trim() !== this.settings.baseUrl)) throw Error('本机地址尚未保存或已修改，请先点“连接并读取模型”');
    if (backend === 'comfy' && (this.modelRead?.baseUrl !== this.settings.baseUrl || this.modelRead?.recipeId !== recipe?.id)) throw Error('请先为当前地址和工作流读取并核验兼容配套');
    if (backend === 'comfy' && !this.modelRead.compatible.length) throw Error(`“${recipe?.name}”没有兼容配套，请切换工作流或检查本机模型`);
    if (backend === 'comfy' && !this.modelRead.compatible.some(m => m.id === $('#comfy-preset').value)) throw Error('请选择当前工作流已核验的模型配套');
    const prompt = $('#comfy-prompt').value.trim(); if (!prompt) throw Error('请填写提示词');
    if (backend === 'online' && !$('#comfy-model-id').value.trim()) throw Error('请获取 API 模型并选择生图模型，或手动填写');
    if (backend === 'online' && imageModelKind($('#comfy-model-id').value) === 'chat') throw Error('所选是聊天 / 推理型号，请更换生图模型');
    const output = backend === 'online' ? this.outputSize() : {};
    const params = {}; if (backend === 'comfy') for (const p of recipe.params) { const el = $('#comfy-param-' + p.key); if (!el.reportValidity()) return; params[p.key] = Number(el.value); }
    const slots = Object.fromEntries(Object.entries(this.slots).map(([k, v]) => [k, v.dataUrl ? { dataUrl: v.dataUrl } : { refId: v.refId }]));
    if (backend === 'comfy' && recipe.slots.every(s => s.key !== 'pose') && slots.pose) throw Error('此换装工作流不支持姿势参考，请选择“Qwen 角色合成”或导入的工作流');
    const r = await this.api('comfy/jobs', { backend, recipeId: recipe?.id, expectedBaseUrl: backend === 'comfy' ? this.modelRead.baseUrl : undefined, slots, params, prompt, negativePrompt: $('#comfy-negative').value,
      filenamePrefix: $('#comfy-filename-prefix').value, presetName: $('#comfy-preset').value, providerId: $('#comfy-provider').value, model: $('#comfy-model-id').value, imageSize: output.size, imageResolution: output.resolution });
    this.selectedJob = r.id; this.page = 0; this.toast('已提交本次生成'); await this.loadJobs();
  }
  async loadJobs() {
    clearTimeout(this.pollTimer); const page = this.page, serial = this.jobsSerial = (this.jobsSerial || 0) + 1;
    const r = await this.api(`comfy/jobs?offset=${page * 12}&limit=12`); if (page !== this.page || serial !== this.jobsSerial) return;
    this.jobs = r.jobs || []; this.total = r.total || 0;
    if (!this.jobs.some(j => j.id === this.selectedJob)) this.selectedJob = this.jobs[0]?.id;
    this.renderJobs(); this.renderResult();
    if (this.jobs.some(j => ['queued', 'running', 'cancelling'].includes(j.status)) && !$('#comfy').classList.contains('hidden')) this.pollTimer = setTimeout(() => this.act(() => this.loadJobs(), null), 2000);
  }
  renderJobs() {
    $('#comfy-jobs').innerHTML = this.jobs.map(j => `<button class="comfy-job ${j.id === this.selectedJob ? 'selected' : ''}" data-job="${esc(j.id)}"><div class="comfy-job-img">${j.mediaId && !j.mediaMissing ? `<img src="/api/comfy/jobs/${encodeURIComponent(j.id)}/image" loading="lazy" alt="生成缩略图">` : `<span>${esc(STATUS[j.status] || j.status)}</span>`}</div><span>${esc(j.model || j.recipeName)}</span></button>`).join('') || '<p class="comfy-help">你的生成记录会保存在这里。</p>';
    $('#comfy-jobs-prev').disabled = this.page === 0; $('#comfy-jobs-next').disabled = (this.page + 1) * 12 >= this.total; $('#comfy-jobs-page').textContent = this.total ? `${this.page + 1} / ${Math.ceil(this.total / 12)}` : '';
  }
  renderResult() {
    const j = this.jobs.find(j => j.id === this.selectedJob);
    $('#comfy-result-status').textContent = j ? STATUS[j.status] || j.status : '等待创作';
    const signature = JSON.stringify(j || null); if (signature === this.resultSignature) return; this.resultSignature = signature;
    $('#comfy-result').innerHTML = j?.mediaId && !j.mediaMissing ? `<button class="comfy-result-preview" data-result-preview aria-label="放大查看生成结果"><img src="/api/comfy/jobs/${encodeURIComponent(j.id)}/image" alt="生成结果，可点击放大"></button>` : `<div class="comfy-result-empty"><span>${j?.status === 'running' ? '◌' : '✧'}</span><strong>${j ? esc(STATUS[j.status]) : '下一位角色，由你定义'}</strong><p>${esc(j?.error || (j?.mediaMissing ? '备份缺图，结果不可用' : j ? '任务已记录，请等待本次结果。' : '组合参考图、选择模型，再点击“生成角色图”。'))}</p>${j?.externalUnknown ? '<p>外部结果未知，请到服务端核对后再决定是否重新生成。</p>' : ''}</div>`;
    $('#comfy-result-actions').innerHTML = !j ? '' : `${j.mediaId && !j.mediaMissing ? `<button class="secondary" data-reveal>打开存放位置</button><button class="secondary" data-save-as>另存为…</button>` : ''}<button class="secondary" data-reuse>复用提示词</button>${['running', 'queued'].includes(j.status) ? '<button class="secondary" data-cancel>停止等待</button>' : ''}<small>${esc(j.model || j.preset?.name || j.recipeName)}${j.metrics ? ' · ' + (j.metrics.generationMs / 1000).toFixed(1) + ' 秒' : ''}</small>${j.mediaId ? `<small style="overflow-wrap:anywhere;white-space:normal">${esc(j.outputError || (j.outputPath ? '已另存：' + j.outputPath : '已保存在工作台归档；可另存到输出目录'))}</small>` : ''}`;
    for (const b of document.querySelectorAll('#comfy-jobs [data-job]')) b.classList.toggle('selected', b.dataset.job === this.selectedJob);
  }
  openPreview() { const image = $('#comfy-result img'); if (!image?.src) return; $('#comfy-preview-image').src = image.src; $('#comfy-preview-image').alt = image.alt; $('#comfy-preview-image').classList.remove('original-size'); $('#comfy-preview-fit').textContent = '原尺寸'; $('#comfy-preview-dialog').showModal(); }
}
