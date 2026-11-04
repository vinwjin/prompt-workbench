import { ImageOutput } from './image-output.js';
// 图像生成任务队列：串行执行 ComfyUI 工作流，结果图落内容寻址存储。
// 编排 ComfyUIClient + 工作流配方 + 参考素材库，独立于文本任务（jobs.js）。
// 任务记录存 kind=comfyJobs，持久保存阶段/配套/seed/prompt_id/引用快照/输出，重启后只读核对、不自动补跑。

import { readFileSync, existsSync } from 'node:fs';
import { ComfyUIClient, validateBaseUrl } from './comfyui-client.js';
import { getRecipe, loadWorkflow, injectWorkflow, validateAgainstObjectInfo, resolvePreset, validatePreset, recipeCatalog, normalizeParams } from './comfyui-workflows.js';
import { importWorkflow, scanWorkflows } from './comfyui-import.js';
import { generateImage, imageProvider } from './image-providers.js';
import { mediaType } from './asset-media.js';
import { models as readProviderModels } from './providers.js';
import { imageSize } from '../public/image-options.js';

export { validateBaseUrl }; // 保持从 image-jobs 导入的兼容路径

const GENERATION_TIMEOUT_MS = 15 * 60 * 1000; // 15 分钟
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;      // 单张输入图 8 MiB
const MIN_FREE_VRAM = 4 * 1024 ** 3;           // 本机换装主模型 + 编码器约 16.6GB，显存不足时需内存兜底
const MIN_FREE_RAM = 8 * 1024 ** 3;            // 内存兜底门槛；仅作早期阻断，不保证可出图

// 首版默认配方。后续新增工作流后，前端按 recipeCatalog 选择，此处仅作 health 默认。
const DEFAULT_RECIPE_ID = 'qwen-ref-create';

function decodeImageDataUrl(dataUrl) {
  const m = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!m) throw new Error('图片须为 PNG/JPEG/WebP');
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > MAX_UPLOAD_BYTES) throw new Error('输入图片超过 8MB');
  if (!buf.length) throw new Error('输入图片为空');
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(mediaType(buf))) throw new Error('输入图片格式无效');
  return buf;
}

// 默认资源采样：从 /system_stats 读取显存/内存空闲，低于门槛则阻断。
// 显存不足时看内存兜底；两者都不足则拒绝。可注入替换，不硬编码恒通过。
export function defaultResourceCheck(stats) {
  const ramFree = Number(stats?.system?.ram_free) || 0;
  const devices = Array.isArray(stats?.devices) ? stats.devices : [];
  const vramFree = devices.reduce((n, d) => n + (Number(d.vram_free) || 0), 0);
  if (vramFree >= MIN_FREE_VRAM) return { ok: true, vramFree, ramFree };
  if (ramFree >= MIN_FREE_RAM) return { ok: true, vramFree, ramFree };
  return { ok: false, vramFree, ramFree, reason: `本机可用显存 ${(vramFree / 2 ** 30).toFixed(1)}GiB、内存 ${(ramFree / 2 ** 30).toFixed(1)}GiB，不足以加载生成模型，请关闭占用显存/内存的程序后重试` };
}

export class ImageJobs {
  constructor(store, assetMedia, { refs = null, poses = null, vault = null, fetchFn = fetch, resourceCheck = defaultResourceCheck } = {}) {
    this.store = store;
    this.assetMedia = assetMedia;
    this.output = new ImageOutput(store, assetMedia);
    this.refs = refs;
    this.poses = poses;
    this.vault = vault;
    this.fetchFn = fetchFn;
    this.resourceCheck = resourceCheck;
    this.queue = [];
    this.active = null;
    this.closing = false;
  }

  settings() { return this.store.get('comfySettings', 'default') || null; }

  saveSettings(input) {
    const baseUrl = validateBaseUrl(input.baseUrl);
    return this.store.put('comfySettings', { id: 'default', baseUrl });
  }

  exportResult(id) {
    const job = this.get(id);
    const outputPath = this.output.copy(job);
    this.store.put('comfyJobs', { ...job, outputPath, outputError: null });
    return { outputPath };
  }
  saveOutput(job) {
    try { return { outputPath: this.output.copy(job, this.active.outputDirectory), outputError: null }; }
    catch (e) { return { outputError: '图片已在工作台归档，但输出目录另存失败：' + e.message }; }
  }
  saveCompletedOutput(id, media) {
    const latest = this.store.put('comfyJobs', { ...this.store.get('comfyJobs', id), status: 'succeeded', mediaId: media.id, mediaType: media.type, mediaName: media.name });
    return this.store.put('comfyJobs', { ...latest, ...this.saveOutput(latest) });
  }
  recipe(id) { return this.store.get('comfyWorkflows', id) || getRecipe(id); }
  recipes() {
    const imported = this.store.db.prepare("SELECT json_remove(body,'$.workflow') AS body FROM records WHERE kind='comfyWorkflows' ORDER BY updated DESC LIMIT 100").all().map(r => JSON.parse(r.body));
    return [...recipeCatalog(), ...recipeCatalog(imported)];
  }
  import(input) {
    const recipe = importWorkflow(input.workflow, input.name);
    if (this.store.count('comfyWorkflows') >= 100 && !this.store.get('comfyWorkflows', recipe.id)) throw new Error('最多加入 100 个本地工作流');
    normalizeParams(recipe, Object.fromEntries(recipe.params.map(p => [p.key, p.default])));
    this.store.put('comfyWorkflows', recipe);
    return { recipe: recipeCatalog([recipe])[0] };
  }
  scan(directory) { return { files: scanWorkflows(directory) }; }
  providers() {
    return this.store.list('providers').filter(p => ['openai', 'gemini'].includes(p.protocol)).map(p => ({ id: p.id, name: p.name, protocol: p.protocol, baseUrl: p.baseUrl, model: p.model,
      models: (this.store.get('modelLists', p.id)?.models || []).slice(0, 2000).map(m => m.id), checkedAt: this.store.get('modelLists', p.id)?.checkedAt || null }));
  }

  async providerModels(id) {
    const saved = this.store.get('providers', String(id || ''));
    if (!saved || !['openai','gemini'].includes(saved.protocol)) throw Error('请选择已保存的生图 API 连接');
    const epoch = (this.modelReads ||= new Map()).get(id) || 0; this.modelReads.set(id, epoch + 1);
    const apiKey = await this.vault.open(saved.sealedKey);
    try {
      const models = await readProviderModels({ ...saved, apiKey }, { fetchFn: this.fetchFn });
      if (this.store.get('providers', id)?.updatedAt !== saved.updatedAt || this.modelReads.get(id) !== epoch + 1) throw Error('连接或目录读取已变化，请重新获取模型');
      const checkedAt = new Date().toISOString();
      this.store.put('modelLists', { id, models, checkedAt });
      return { models: models.map(m => m.id), checkedAt };
    } catch (e) { throw Error(apiKey ? e.message.split(apiKey).join('[密钥已隐藏]') : e.message); }
  }

  async models(recipeId) {
    const baseUrl = this.settings()?.baseUrl;
    if (!baseUrl) throw Error('请先配置并保存本机 ComfyUI 地址，再读取模型');
    const client = new ComfyUIClient({ baseUrl, fetchFn: this.fetchFn });
    const recipe = this.recipe(recipeId || 'qwen-character'), workflow = loadWorkflow(recipe);
    const [catalog, info] = await Promise.all([client.catalog(), client.objectInfo()]);
    const catalogOptions = (catalog.presets || []).map(p => ({ ...p, id: p.name }));
    const embedded = recipe.embeddedPreset;
    const samePreset = p => ['unet_name', 'clip_name', 'vae_name', 'reference_size'].every(k => p.values?.[k] === embedded?.values?.[k])
      && JSON.stringify([...(p.sampler_types || [])].sort()) === JSON.stringify([...(embedded?.sampler_types || [])].sort());
    const embeddedMatches = embedded && catalogOptions.some(samePreset);
    const options = [...(!embedded || embeddedMatches ? [] : [{ ...embedded, id: `embedded:${recipe.id}:${embedded.values.unet_name}`, name: `原配套 · ${embedded.values.unet_name}` }]), ...catalogOptions];
    const unique = new Map(options.map(p => [p.id, p]));
    const models = [...unique.values()].map(p => {
      try { validatePreset(recipe, workflow, info, catalog, p); return { id: p.id, name: p.name, model: p.values.unet_name, compatible: true }; }
      catch (e) { return { id: p.id, name: p.name, model: p.values?.unet_name, compatible: false, reason: e.message }; }
    });
    const defaults = models.filter(m => m.compatible);
    const defaultPresetId = defaults.find(m => m.id === recipe.presetName)?.id
      || defaults.find(m => embedded && samePreset(unique.get(m.id)))?.id
      || null;
    return { models, defaultPresetId, baseUrl };
  }

  // 健康检查：只读 /system_stats + /object_info + /local_qwen/catalog，校验节点/模型/配套，不执行推理、不上传。
  async health(input = {}) {
    const settings = this.settings();
    if (!settings || !settings.baseUrl) throw new Error('请先配置 ComfyUI 地址');
    const client = new ComfyUIClient({ baseUrl: settings.baseUrl, fetchFn: this.fetchFn });
    const recipe = this.recipe(input.recipeId || DEFAULT_RECIPE_ID);
    const workflow = loadWorkflow(recipe);
    await client.systemStats();
    const objectInfo = await client.objectInfo();
    const catalog = await client.catalog();
    const preset = resolvePreset(recipe, catalog, input.presetName);
    validateAgainstObjectInfo(injectWorkflow(workflow, { ...recipe, slots: [] }, { _preset: preset.values }), recipe, objectInfo);
    validatePreset(recipe, workflow, objectInfo, catalog, preset);
    return { online: true, recipe: recipe.name, preset: preset.name };
  }

  // 校验并规范化一次生成请求。两阶段：先同步校验全部输入与参数（不落盘），通过后再落盘上传图，避免失败预验证遗留无主私人图。
  enqueue(input) {
    if (this.closing) throw new Error('工作台正在关闭');
    const online = input.backend === 'online';
    if (!online && input.expectedBaseUrl && input.expectedBaseUrl !== this.settings()?.baseUrl) throw new Error('本机 ComfyUI 地址已变化，请重新读取模型后再生成');
    const recipe = online ? getRecipe('qwen-character') : this.recipe(input.recipeId);
    const provider = online ? imageProvider(this.store.get('providers', input.providerId), input.model) : null;
    const outputSize = online ? imageSize(provider.protocol, provider.model, input.imageSize, input.imageResolution || '') : null;
    if (online && !String(input.prompt || '').trim()) throw new Error('请填写提示词');
    if (String(input.prompt || '').length > 12000 || String(input.negativePrompt || '').length > 2000) throw new Error('提示词过长');
    // 参数范围/类型校验：在私人图落盘与上传前拒绝非法值（整数/min-max/安全 seed/画幅对齐/总像素预算）。
    const params = normalizeParams(recipe, { ...Object.fromEntries(recipe.params.map(p => [p.key, p.default])), ...(input.params || {}) });
    const slots = {};
    const pendingUploads = [];
    for (const s of recipe.slots) {
      const v = input.slots ? input.slots[s.key] : undefined;
      if (s.kind === 'image') {
        if (s.required && (v === undefined || v === null)) throw new Error('缺少输入：' + s.label);
        if (v === undefined || v === null) continue;
        if ((typeof v === 'object' && v.dataUrl !== undefined) || (s.source === 'upload' && typeof v === 'string' && v.startsWith('data:'))) {
          const dataUrl = typeof v === 'object' && v.dataUrl !== undefined ? v.dataUrl : v;
          const buf = decodeImageDataUrl(dataUrl);
          pendingUploads.push({ key: s.key, label: s.label, buf });
        } else {
          const refId = typeof v === 'object' && v.refId !== undefined ? v.refId : v;
          if (typeof refId !== 'string' || !refId || refId.length > 200) throw new Error('请选择' + s.label);
          const library = s.source === 'ref:pose' ? 'pose' : s.key === 'person' ? 'face' : 'costume';
          const record = this.store.get(library === 'pose' ? 'poseRefs' : 'refItems', refId);
          if (!record || (library !== 'pose' && record.lib !== library)) throw new Error('所选参考图不属于' + s.label + '库');
          slots[s.key] = { refId, library };
        }
      } else {
        if (s.required && (v === undefined || v === null || String(v).trim() === '')) throw new Error('缺少输入：' + s.label);
        if (v !== undefined && v !== null) slots[s.key] = String(v).slice(0, s.maxLength || 2000);
      }
    }
    for (const u of pendingUploads) {
      const row = this.assetMedia.save(u.label, u.buf);
      slots[u.key] = { mediaId: row.id };
    }
    const job = this.store.put('comfyJobs', { recipeId: recipe.id, recipeName: online ? provider.name : recipe.name, slots, params,
      recipeSnapshot: recipe, backend: online ? 'online' : 'comfy', providerId: provider?.id, providerSnapshot: provider ? { id: provider.id, name: provider.name, protocol: provider.protocol, baseUrl: provider.baseUrl } : undefined,
      filenamePrefix: String(input.filenamePrefix || '').trim().slice(0, 100), model: provider?.model, imageSize: outputSize?.size, imageResolution: outputSize?.resolution,
      baseUrl: online ? provider.baseUrl : this.settings()?.baseUrl,
      prompt: input.prompt, negativePrompt: String(input.negativePrompt || ''), presetName: String(input.presetName || ''),
      status: 'queued', createdAt: new Date().toISOString() });
    this.queue.push(job.id);
    this.pump();
    return job;
  }

  async resolveImageData(slot, value) {
    if (value && value.mediaId) {
      const file = this.assetMedia.file(value.mediaId);
      if (!existsSync(file)) throw new Error(slot.label + ' 图片已失效，请重新上传');
      return readFileSync(file);
    }
    if (value && value.refId) {
      if (!this.refs) throw new Error('参考素材模块不可用');
      const image = await (value.library === 'pose' ? this.poses : this.refs).image(value.refId, { full: true });
      return image.data;
    }
    throw new Error('缺少输入：' + slot.label);
  }

  // 每次异步返回后的守卫：任务已被取消/关闭/终态时抛错，防止迟到响应覆盖终态。
  _assertActive(id) {
    if (this.closing || !this.active || this.active.id !== id) throw new Error('任务已结束');
    this.active.ctrl.signal.throwIfAborted();
    const latest = this.store.get('comfyJobs', id);
    if (latest && ['cancelled', 'interrupted'].includes(latest.status)) throw new Error('任务已结束');
  }

  // 提交后 / 提交结果不明的阶段（外部可能已开始推理，取消/关闭时须标注 unknown）。
  _externalRiskPhase(phase) { return ['submitting', 'generating', 'downloading'].includes(phase); }

  async pump() {
    if (this.active || this.closing) return;
    const id = this.queue.shift();
    if (!id) return;
    const ctrl = new AbortController();
    this.active = { id, ctrl, phase: 'preparing', client: null, promptId: null, outputDirectory: this.output.settings().directory };
    let job = this.store.get('comfyJobs', id);
    if (!job) { this.active = null; setImmediate(() => this.pump()); return; }
    job = this.store.put('comfyJobs', { ...job, status: 'running', startedAt: new Date().toISOString() });
    const started = performance.now();
    let inferenceStart;
    try {
      if (job.backend === 'online') {
        const saved = this.store.get('providers', job.providerId);
        if (!saved || saved.baseUrl !== job.providerSnapshot.baseUrl || saved.protocol !== job.providerSnapshot.protocol) throw new Error('连接已更改，请重新选择连接后生成');
        const provider = imageProvider(saved, job.model);
        const images = [];
        for (const s of job.recipeSnapshot.slots.filter(s => s.kind === 'image')) if (job.slots[s.key]) images.push(await this.resolveImageData(s, job.slots[s.key]));
        this._assertActive(id);
        provider.apiKey = await this.vault.open(saved.sealedKey);
        this._assertActive(id);
        this.active.phase = 'submitting';
        const result = await generateImage(provider, { prompt: job.prompt, images, size: job.imageSize, resolution: job.imageResolution }, { fetchFn: this.fetchFn, signal: ctrl.signal });
        this._assertActive(id);
        const media = this.assetMedia.save('生成图', result.data);
        const completed = this.saveCompletedOutput(id, media);
        this.store.put('comfyJobs', { ...completed, resultText: result.text, metrics: { generationMs: Math.round(performance.now() - started) }, finishedAt: new Date().toISOString() });
        return;
      }
      const settings = { baseUrl: job.baseUrl || this.settings()?.baseUrl };
      if (!settings || !settings.baseUrl) throw new Error('请先配置 ComfyUI 地址');
      const client = new ComfyUIClient({ baseUrl: settings.baseUrl, fetchFn: this.fetchFn });
      this.active.client = client;
      const recipe = job.recipeSnapshot || this.recipe(job.recipeId);
      const workflow = loadWorkflow(recipe);

      // —— 生成前检查：在任何参考图外发之前完成只读节点/配套核查、系统资源与共享实例忙闲保护 ——
      ctrl.signal.throwIfAborted();
      const [stats, queueState, objectInfo] = await Promise.all([
        client.systemStats(ctrl.signal),
        client.queue(ctrl.signal),
        client.objectInfo(ctrl.signal)
      ]);
      // 共享实例忙闲：已有外部队列任务则阻断（只读，不清空、不卸载）。
      const running = Array.isArray(queueState?.queue_running) ? queueState.queue_running.length : 0;
      const pending = Array.isArray(queueState?.queue_pending) ? queueState.queue_pending.length : 0;
      if (running > 0 || pending > 0) throw new Error(`ComfyUI 正忙（运行中 ${running}、排队 ${pending}），请等待其完成后再试`);
      // 系统资源门槛（可注入采样）
      const resCheck = this.resourceCheck(stats);
      if (!resCheck || resCheck.ok === false) throw new Error(resCheck?.reason || '本机资源不足，暂不能生成');
      const catalog = await client.catalog(ctrl.signal);
      const preset = resolvePreset(recipe, catalog, job.presetName);
      validateAgainstObjectInfo(injectWorkflow(workflow, { ...recipe, slots: [] }, { _preset: preset.values }), recipe, objectInfo);
      validatePreset(recipe, workflow, objectInfo, catalog, preset);

      // —— 现在才外发参考图：上传并保留 subfolder，按 slot 顺序构造引用快照 ——
      const injections = {};
      const references = [];
      for (const s of recipe.slots) {
        ctrl.signal.throwIfAborted();
        if (s.kind === 'image') {
          if (!job.slots[s.key] && !s.required) continue;
          const buf = await this.resolveImageData(s, job.slots[s.key]);
          const up = await client.uploadImage(buf, s.key + '-' + String(id).slice(0, 8), ctrl.signal);
          const filename = up.subfolder ? up.subfolder + '/' + up.name : up.name;
          injections[s.key] = filename;
          references.push({ key: s.key, filename, name: up.name, subfolder: up.subfolder, role: s.role });
        } else {
          injections[s.key] = job.slots[s.key] || '';
        }
      }
      injections._preset = preset.values;
      if (job.prompt !== undefined) injections._promptOverride = job.prompt;
      injections._negativePrompt = job.negativePrompt;
      for (const p of recipe.params) if (job.params[p.key] !== undefined) injections[p.key] = job.params[p.key];
      const graph = injectWorkflow(workflow, recipe, injections);

      // —— 提交前重新确认必要条件：再查一次忙闲（上传期间外部可能排入新任务） ——
      ctrl.signal.throwIfAborted();
      const queueAgain = await client.queue(ctrl.signal);
      const againRunning = Array.isArray(queueAgain?.queue_running) ? queueAgain.queue_running.length : 0;
      const againPending = Array.isArray(queueAgain?.queue_pending) ? queueAgain.queue_pending.length : 0;
      if (againRunning > 0 || againPending > 0) throw new Error('ComfyUI 正忙，已取消本次提交，请稍后再试');

      // —— 提交前持久化完整快照（配套 + 实际 seed + 引用顺序 + 参数 + LoRA + 目标地址），供重启后只读核对 ——
      const seedNode = recipe.params.find(p => p.key === 'seed');
      const actualSeed = seedNode ? graph[seedNode.node]?.inputs?.[seedNode.field] : undefined;
      job = this.store.put('comfyJobs', {
        ...job,
        phase: 'submitting',
        preset: { name: preset.name, ...preset.values },
        seed: actualSeed,
        references,
        params: { ...job.params },
        loraStack: recipe.loraStack || [],
        baseUrl: settings.baseUrl,
        prompt: graph[recipe.promptNode].inputs.prompt
      });
      this.active.phase = 'submitting';
      inferenceStart = performance.now();

      // 提交：区分「明确拒绝」（普通失败）与「提交结果不明」（fetch 网络错误/超时，服务可能已接受并开始推理）。
      let promptId;
      try {
        promptId = await client.queuePrompt(graph, id, ctrl.signal);
      } catch (e) {
        if (e?.submitUnknown && this.active?.id === id && !ctrl.signal.aborted) {
          const latest = this.store.get('comfyJobs', id);
          if (latest && !['cancelled', 'interrupted'].includes(latest.status)) {
            this.store.put('comfyJobs', { ...latest, status: 'failed', externalUnknown: true, error: e.message, finishedAt: new Date().toISOString() });
          }
        }
        throw e;
      }
      this._assertActive(id); // 迟到提交响应：任务可能已被取消，不得写回旧快照
      this.active.promptId = promptId;
      this.active.phase = 'generating';
      this.store.put('comfyJobs', { ...this.store.get('comfyJobs', id), promptId, clientId: id });

      const imageRef = await this.waitForImage(client, promptId, recipe.outputNode, GENERATION_TIMEOUT_MS, ctrl.signal);
      this._assertActive(id);
      this.active.phase = 'downloading';
      const data = await client.view(imageRef, ctrl.signal);
      this._assertActive(id); // 迟到 view 响应：任务可能已被取消，不得把 cancelled 改 succeeded
      const media = this.assetMedia.save('生成图', data);
      job = this.saveCompletedOutput(id, media);
      job = this.store.put('comfyJobs', { ...job, metrics: { prepareMs: Math.round(inferenceStart - started), generationMs: Math.round(performance.now() - inferenceStart), totalMs: Math.round(performance.now() - started) }, finishedAt: new Date().toISOString() });
    } catch (e) {
      if (this.active?.id === id) {
        const latest = this.store.get('comfyJobs', id);
        // 取消/关闭已写入终态时不再覆盖（保留 externalUnknown / interrupted 等语义）。
        if (latest && !['cancelled', 'interrupted'].includes(latest.status)) {
          const msg = String(e.message || e).slice(0, 1000);
          if (ctrl.signal.aborted) {
            const externalUnknown = this._externalRiskPhase(this.active.phase);
            this.store.put('comfyJobs', { ...latest, status: 'cancelled', externalUnknown, error: externalUnknown ? '已停止本地等待；外部推理可能仍在进行，结果未知' : '任务已取消', finishedAt: new Date().toISOString() });
          } else {
            this.store.put('comfyJobs', { ...latest, status: 'failed', externalUnknown: !!latest.externalUnknown || !!e.submitUnknown, error: msg, finishedAt: new Date().toISOString() });
          }
        }
      }
    } finally {
      this.active = null;
      try { this.store.scheduleBackup(); } catch (e) { console.error('自动备份失败：' + e.message); }
      setImmediate(() => this.pump());
    }
  }

  async waitForImage(client, promptId, outputNode, timeoutMs, signal) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (signal?.aborted) throw new Error('任务已取消');
      if (Date.now() > deadline) throw new Error('ComfyUI 生成超时');
      const history = await client.history(promptId, signal);
      const entry = history && history[promptId];
      if (entry) {
        const output = entry.outputs && entry.outputs[outputNode];
        if (output && Array.isArray(output.images) && output.images.length) return output.images[0];
        const status = entry.status || {};
        if (status.completed || String(status.status_str).toLowerCase() === 'error') throw new Error('ComfyUI 未生成结果图片');
      }
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  clearHistory() {
    let hidden = 0;
    for (const job of this.store.list('comfyJobs')) {
      if (!job.historyHidden && !['queued', 'running', 'cancelling'].includes(job.status)) {
        this.store.put('comfyJobs', { ...job, historyHidden: true }); hidden++;
      }
    }
    return { hidden };
  }

  list({ offset = 0, limit = 60 } = {}) {
    limit = Math.min(100, Math.max(1, Math.floor(Number(limit) || 60)));
    offset = Math.max(0, Math.floor(Number(offset) || 0));
    const total = this.store.db.prepare("SELECT count(*) AS n FROM records WHERE kind='comfyJobs' AND coalesce(json_extract(body,'$.historyHidden'),0)=0").get().n;
    const jobs = this.store.db.prepare("SELECT json_remove(body,'$.recipeSnapshot','$.slots','$.prompt','$.negativePrompt') AS body FROM records WHERE kind='comfyJobs' AND coalesce(json_extract(body,'$.historyHidden'),0)=0 ORDER BY updated DESC LIMIT ? OFFSET ?").all(limit, offset).map(r => JSON.parse(r.body));
    return { jobs, total, offset, limit };
  }

  get(id) {
    const j = this.store.get('comfyJobs', id);
    if (!j) throw new Error('图像任务不存在');
    return j;
  }

  cancel(id) {
    const j = this.store.get('comfyJobs', id);
    if (!j) throw new Error('图像任务不存在');
    if (j.status === 'queued') {
      this.queue = this.queue.filter(x => x !== id);
      return this.store.put('comfyJobs', { ...j, status: 'cancelled', finishedAt: new Date().toISOString() });
    }
    if (this.active?.id === id) {
      const phase = this.active.phase;
      this.active.ctrl.abort();
      // 不调用 client.interrupt()：本机 /interrupt 是无目标全局中断，会停掉其他客户端任务。
      // preparing（未提交）仅取消本地，无外部影响；submitting/generating/downloading（已提交或提交结果不明）只停止本地等待，如实标注外部未知。
      const externalUnknown = this._externalRiskPhase(phase);
      return this.store.put('comfyJobs', {
        ...j, status: 'cancelled', cancelledAt: new Date().toISOString(), externalUnknown,
        error: externalUnknown ? '已停止本地等待；外部推理可能仍在进行，结果未知' : '任务已取消',
        finishedAt: new Date().toISOString()
      });
    }
    return j;
  }

  async close() {
    this.closing = true;
    for (const id of [...this.queue]) this.cancel(id);
    if (this.active) {
      const phase = this.active.phase;
      this.active.ctrl.abort();
      const j = this.store.get('comfyJobs', this.active.id);
      if (j && ['running', 'queued', 'cancelling'].includes(j.status)) {
        const externalUnknown = this._externalRiskPhase(phase);
        this.store.put('comfyJobs', { ...j, status: 'interrupted', externalUnknown, error: externalUnknown ? '工作台关闭，外部推理可能仍在进行，结果未知' : '工作台关闭，任务未完成', finishedAt: new Date().toISOString() });
      }
    }
    const deadline = Date.now() + 15000;
    while (this.active && Date.now() < deadline) await new Promise(r => setTimeout(r, 100));
    return !this.active;
  }
}
