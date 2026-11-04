import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, existsSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { Store } from '../src/store.js';
import { AssetMedia } from '../src/asset-media.js';
import { ComfyUIClient } from '../src/comfyui-client.js';
import { getRecipe, loadWorkflow, injectWorkflow, validateAgainstObjectInfo, resolvePreset, validatePreset, recipeCatalog, normalizeParams } from '../src/comfyui-workflows.js';
import { ImageJobs, validateBaseUrl, defaultResourceCheck } from '../src/image-jobs.js';
import { createWorkbench } from './source-fixtures.js';

const temp = () => { mkdirSync('work', { recursive: true }); return mkdtempSync(path.resolve(process.env.PW_TEST_ROOT || 'work', 'comfy-test-')); };
const png = readFileSync('public/icon-256.png');
function makeStore() { const store = new Store(temp()); for (const id of ['x', 'costume-SPR-0001']) store.put('refItems', {id,lib:'costume'}); return store; }

async function waitFor(fn, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (fn()) return; await new Promise(r => setTimeout(r, 20)); }
  throw new Error('等待超时');
}

// 只含工作流用到的节点类型，编码节点提供真实模型下拉供 validatePreset 校验。
function minimalObjectInfo() {
  const wf = loadWorkflow(getRecipe('qwen-ref-create'));
  const info = {};
  for (const node of Object.values(wf)) info[node.class_type] = { input: { required: {}, optional: {} } };
  info.LocalQwenEncode.input.required = {
    prompt: ['STRING', { forceInput: true }], negative_prompt: ['STRING', { forceInput: true }], references: ['QWEN_REFERENCE_SET'],
    unet_name: [['NoctQ_V4_int8_convrot.safetensors', 'qwen-image-2.1-UC-Q5_K_M.gguf']],
    clip_name: [['qwen3vl_8b_int8_convrot.safetensors']],
    vae_name: [['qwen_image_2.1_vae_bf16.safetensors']],
    width: ['INT', { default: 576 }], height: ['INT', { default: 768 }], reference_size: ['INT', { default: 256 }]
  };
  return info;
}

function minimalCatalog() {
  return {
    loras: ['qwen21-nsfw-image-edit.safetensors'],
    presets: [
      { name: '03【Qwen】Noct-V4_写实人物', values: { unet_name: 'NoctQ_V4_int8_convrot.safetensors', clip_name: 'qwen3vl_8b_int8_convrot.safetensors', vae_name: 'qwen_image_2.1_vae_bf16.safetensors', reference_size: 256 }, sampler_types: ['KSampler'] }
    ]
  };
}

// 完整生成链路的 fetchFn 工厂：记录调用，upload 返回 subfolder 以验证引用拼接。
function fullFetch(overrides = {}) {
  const seen = [];
  const fetchFn = async (url, opts = {}) => {
    const u = new URL(url);
    seen.push(u.pathname);
    if (u.pathname === '/system_stats') return new Response(JSON.stringify(overrides.stats ?? {}), { status: 200 });
    if (u.pathname === '/queue') return new Response(JSON.stringify(overrides.queue ?? { queue_running: [], queue_pending: [] }), { status: 200 });
    if (u.pathname === '/object_info') return new Response(JSON.stringify(overrides.objectInfo ?? minimalObjectInfo()), { status: 200 });
    if (u.pathname === '/local_qwen/catalog') return new Response(JSON.stringify(overrides.catalog ?? minimalCatalog()), { status: 200 });
    if (u.pathname === '/upload/image') return new Response(JSON.stringify(overrides.upload ?? { name: 'up.png', subfolder: 'private-upload', type: 'input' }), { status: 200 });
    if (u.pathname === '/prompt') {
      if (overrides.promptThrow) throw overrides.promptThrow;
      if (overrides.promptGate) await overrides.promptGate;
      return new Response(JSON.stringify({ prompt_id: 'p1', node_errors: {} }), { status: 200 });
    }
    if (u.pathname === '/history/p1') return new Response(JSON.stringify({ p1: { outputs: { save: { images: [{ filename: 'o.png', subfolder: 'pw', type: 'output' }] } }, status: { completed: true, status_str: 'success' } } }), { status: 200 });
    if (u.pathname === '/view') {
      if (overrides.viewGate) await overrides.viewGate;
      return new Response(png);
    }
    throw new Error('unexpected ' + u.pathname);
  };
  return { fetchFn, seen };
}

test('validateBaseUrl：仅允许回环，拒绝伪装成局域网的域名', () => {
  assert.equal(validateBaseUrl('http://127.0.0.1:8188'), 'http://127.0.0.1:8188');
  assert.equal(validateBaseUrl('http://localhost:8188/'), 'http://localhost:8188');
  assert.throws(() => validateBaseUrl('http://192.168.example.com'), /回环/);
  assert.throws(() => validateBaseUrl('http://10.example.com'), /回环/);
  assert.throws(() => validateBaseUrl('http://192.168.1.5:8188'), /回环/);
  assert.throws(() => validateBaseUrl('http://10.0.0.2:8188'), /回环/);
  assert.throws(() => validateBaseUrl('http://evil.example.com:8188'), /回环/);
  assert.throws(() => validateBaseUrl('https://1.2.3.4:8188'), /回环/);
  assert.throws(() => validateBaseUrl('http://user@127.0.0.1:8188'), /账号或密码/);
  assert.throws(() => validateBaseUrl('ftp://127.0.0.1:8188'), /HTTP/);
  assert.throws(() => validateBaseUrl('http://127.0.0.1:8188?x=1'), /查询参数/);
});

test('缺陷1：ComfyUIClient 构造与 Store.import 统一拒绝公网地址', () => {
  // 构造客户端即校验（防御旧持久设置绕过 saveSettings）
  assert.throws(() => new ComfyUIClient({ baseUrl: 'https://outside.example.test' }), /回环/);
  assert.throws(() => new ComfyUIClient({ baseUrl: 'http://192.168.example.com' }), /回环/);
  // 备份导入拒绝公网 comfySettings
  const store = makeStore();
  const backup = { schema: 'prompt-workbench/v1', templates: [], assets: [], jobs: [], drafts: [], providers: [], comfySettings: [{ id: 'default', baseUrl: 'https://outside.example.test' }] };
  assert.throws(() => store.import(backup), /回环/);
  store.close();
});

test('配方框架：references_state 注入角色与编号、prompt 编号一致、catalog 配套', () => {
  const cat = recipeCatalog();
  assert.equal(cat.length, 3);
  assert.equal(cat[0].id, 'qwen-character');
  assert.ok(!('role' in cat[0].slots[0]), '配方目录不应泄露内部 role');
  const recipe = getRecipe('qwen-ref-create');
  const wf = loadWorkflow(recipe);
  assert.equal(wf.prompt.class_type, 'LocalQwenPrompt');
  assert.equal(wf.encode.class_type, 'LocalQwenEncode');
  assert.equal(wf[recipe.outputNode].class_type, 'SaveImage');
  assert.throws(() => getRecipe('nope'), /配方不存在/);
  const before = JSON.stringify(wf);
  const graph = injectWorkflow(wf, recipe, { person: 'person.png', garment: 'garment.png', prompt: '追加要求', seed: 42 });
  assert.deepEqual(JSON.parse(graph.prompt.inputs.references_state), [
    { filename: 'person.png', role: '人物身份' },
    { filename: 'garment.png', role: '服装' }
  ]);
  assert.ok(graph.prompt.inputs.prompt.includes('<image1>') && graph.prompt.inputs.prompt.includes('<image2>'));
  assert.ok(graph.prompt.inputs.prompt.includes('追加要求'));
  assert.equal(graph.sampler.inputs.seed, 42);
  assert.equal(graph.prompt.inputs.negative_prompt, '');
  assert.equal(JSON.stringify(wf), before, '注入不应污染原始模板');
  assert.throws(() => injectWorkflow(wf, recipe, { garment: 'g.png' }), /人物图/);
  const g2 = injectWorkflow(wf, recipe, { person: 'p.png', garment: 'g.png', prompt: '', seed: -1 });
  assert.ok(Number.isInteger(g2.sampler.inputs.seed) && g2.sampler.inputs.seed >= 0);
  const preset = resolvePreset(recipe, minimalCatalog());
  assert.equal(preset.name, '03【Qwen】Noct-V4_写实人物');
  const g3 = injectWorkflow(wf, recipe, { person: 'p.png', garment: 'g.png', prompt: '', _preset: preset.values });
  assert.equal(g3.encode.inputs.unet_name, 'NoctQ_V4_int8_convrot.safetensors');
  assert.equal(g3.encode.inputs.reference_size, 256);
});

test('缺陷4：normalizeParams 拒绝非法参数（范围/整数/安全 seed/画幅对齐/总像素）', () => {
  const recipe = getRecipe('qwen-ref-create');
  assert.throws(() => normalizeParams(recipe, { width: 1000000 }), /不能大于/);
  assert.throws(() => normalizeParams(recipe, { height: 0.1 }), /必须是整数/);
  assert.throws(() => normalizeParams(recipe, { steps: -5 }), /不能小于/);
  assert.throws(() => normalizeParams(recipe, { cfg: -3 }), /不能小于/);
  assert.throws(() => normalizeParams(recipe, { width: 300 }), /16 的倍数/); // 画幅对齐
  assert.throws(() => normalizeParams(recipe, { width: 4096, height: 2048 }), /总像素/); // 8M 超 4M 预算
  assert.throws(() => normalizeParams(recipe, { seed: 2 ** 53 }), /安全整数/);
  const ok = normalizeParams(recipe, { seed: 7, width: 288, height: 384, steps: 25, cfg: 1.5 });
  assert.deepEqual(ok, { seed: 7, width: 288, height: 384, steps: 25, cfg: 1.5 });
});

test('缺陷5：resolvePreset 未命中即报错不回退；validatePreset 校验 sampler_types', () => {
  const recipe = getRecipe('qwen-ref-create');
  const wf = loadWorkflow(recipe);
  const turboOnly = { loras: ['qwen21-nsfw-image-edit.safetensors'], presets: [{ name: 'Turbo-only', values: { unet_name: 'mock-unet', clip_name: 'mock-clip', vae_name: 'mock-vae', reference_size: 256 }, sampler_types: ['SamplerCustom'] }] };
  assert.throws(() => resolvePreset(recipe, turboOnly), /缺少所需模型配套：03【Qwen】Noct-V4_写实人物/);
  // 名称匹配但 sampler_types 不兼容
  const wrongSampler = { loras: ['qwen21-nsfw-image-edit.safetensors'], presets: [{ name: '03【Qwen】Noct-V4_写实人物', values: { unet_name: 'NoctQ_V4_int8_convrot.safetensors', clip_name: 'qwen3vl_8b_int8_convrot.safetensors', vae_name: 'qwen_image_2.1_vae_bf16.safetensors', reference_size: 256 }, sampler_types: ['SamplerCustom'] }] };
  const preset = resolvePreset(recipe, wrongSampler);
  assert.throws(() => validatePreset(recipe, wf, minimalObjectInfo(), wrongSampler, preset), /采样器与工作流不兼容/);
});

test('健康校验：节点缺失、模型文件缺失、LoRA 缺失', () => {
  const recipe = getRecipe('qwen-ref-create');
  const wf = loadWorkflow(recipe);
  const info = minimalObjectInfo();
  const catalog = minimalCatalog();
  const preset = resolvePreset(recipe, catalog);
  assert.equal(validateAgainstObjectInfo(wf, recipe, info), true);
  assert.equal(validatePreset(recipe, wf, info, catalog, preset), true);
  const missingNode = { ...info }; delete missingNode.LocalQwenPrompt;
  assert.throws(() => validateAgainstObjectInfo(wf, recipe, missingNode), /缺少节点：LocalQwenPrompt/);
  const wrongModel = minimalObjectInfo();
  wrongModel.LocalQwenEncode.input.required.unet_name = [['wrong.safetensors']];
  assert.throws(() => validatePreset(recipe, wf, wrongModel, catalog, preset), /缺少模型文件：NoctQ_V4_int8_convrot/);
  const noLora = { ...minimalCatalog(), loras: [] };
  assert.throws(() => validatePreset(recipe, wf, info, noLora, preset), /缺少 LoRA：qwen21-nsfw-image-edit/);
});

test('ComfyUIClient：端点 + catalog + 响应有界 + submitUnknown', async () => {
  const seen = [];
  const fetchFn = async (url, opts = {}) => {
    const u = new URL(url);
    seen.push([u.pathname, opts.method || 'GET']);
    if (u.pathname === '/upload/image') return new Response(JSON.stringify({ name: 'a.png', subfolder: '', type: 'input' }), { status: 200 });
    if (u.pathname === '/prompt') return new Response(JSON.stringify({ prompt_id: 'p1', node_errors: {} }), { status: 200 });
    if (u.pathname === '/history/p1') return new Response(JSON.stringify({}), { status: 200 });
    if (u.pathname === '/view') return new Response(png);
    if (u.pathname === '/system_stats') return new Response(JSON.stringify({ system: {} }), { status: 200 });
    if (u.pathname === '/object_info') return new Response(JSON.stringify({}), { status: 200 });
    if (u.pathname === '/queue') return new Response(JSON.stringify({ queue_running: [], queue_pending: [] }), { status: 200 });
    if (u.pathname === '/local_qwen/catalog') return new Response(JSON.stringify(minimalCatalog()), { status: 200 });
    throw new Error('unexpected ' + u.pathname);
  };
  const c = new ComfyUIClient({ baseUrl: 'http://127.0.0.1:8188', fetchFn });
  assert.ok((await c.systemStats()));
  assert.ok((await c.objectInfo()));
  assert.deepEqual(await c.queue(), { queue_running: [], queue_pending: [] });
  assert.deepEqual(await c.catalog(), minimalCatalog());
  assert.deepEqual(await c.uploadImage(png, 'person'), { name: 'a.png', subfolder: '', type: 'input' });
  assert.equal(await c.queuePrompt({ '1': { class_type: 'X', inputs: {} } }, 'cid'), 'p1');
  assert.deepEqual(await c.history('p1'), {});
  const buf = await c.view({ filename: 'a.png', subfolder: '', type: 'output' });
  assert.equal(buf.length, png.length);
  // 提交网络错误 → submitUnknown 标记
  const lost = new ComfyUIClient({ baseUrl: 'http://127.0.0.1:8188', fetchFn: async () => { throw new TypeError('network lost'); } });
  await assert.rejects(() => lost.queuePrompt({}, 'cid'), e => e.submitUnknown === true);
  // 明确拒绝（HTTP 400）不标 submitUnknown
  const rejected = new ComfyUIClient({ baseUrl: 'http://127.0.0.1:8188', fetchFn: async () => new Response('{}', { status: 400 }) });
  await assert.rejects(() => rejected.queuePrompt({}, 'cid'), /拒绝工作流/);
  // 响应超限：Content-Length 预检直接拒绝
  const bigFetch = async () => new Response(new ArrayBuffer(0), { status: 200, headers: { 'content-length': String(65 * 1024 * 1024) } });
  await assert.rejects(() => new ComfyUIClient({ baseUrl: 'http://127.0.0.1:8188', fetchFn: bigFetch }).view({ filename: 'a.png' }), /超过大小限制/);
});

test('ImageJobs：健康检查只读、完整生成落盘并保存完整引用/参数快照', async () => {
  const store = makeStore();
  const assetMedia = new AssetMedia(store);
  const pngB64 = png.toString('base64');
  const { fetchFn } = fullFetch();
  const refs = { image: async () => ({ data: png, type: 'image/png' }) };
  const jobs = new ImageJobs(store, assetMedia, { refs, fetchFn, resourceCheck: () => ({ ok: true }) });
  assert.equal(jobs.recipes().length, 3);
  await assert.rejects(() => jobs.health(), /请先配置 ComfyUI 地址/);
  jobs.saveSettings({ baseUrl: 'http://127.0.0.1:8188' });
  assert.equal((await jobs.health()).online, true);
  assert.throws(() => jobs.enqueue({ recipeId: 'qwen-ref-create', slots: { garment: { refId: 'x' } }, params: {} }), /人物图/);
  assert.throws(() => jobs.enqueue({ recipeId: 'qwen-ref-create', slots: { person: { dataUrl: 'data:image/png;base64,' + pngB64 }, garment: { refId: 'x' } }, params: { width: 1000000 } }), /不能大于/);
  const job = jobs.enqueue({ recipeId: 'qwen-ref-create', slots: { person: { dataUrl: 'data:image/png;base64,' + pngB64 }, garment: { refId: 'costume-SPR-0001' }, prompt: '测试' }, params: { seed: 7 } });
  await waitFor(() => { const s = store.get('comfyJobs', job.id).status; return s !== 'running' && s !== 'queued'; });
  const saved = store.get('comfyJobs', job.id);
  assert.equal(saved.status, 'succeeded');
  assert.ok(saved.mediaId, '应返回结果图 mediaId');
  assert.equal(saved.promptId, 'p1');
  assert.equal(saved.preset.name, '03【Qwen】Noct-V4_写实人物');
  assert.equal(saved.seed, 7);
  assert.equal(saved.baseUrl, 'http://127.0.0.1:8188');
  // 缺陷7：引用按 slot 顺序（person→garment）、含 subfolder 拼接、role 完整
  assert.deepEqual(saved.references.map(r => r.key), ['person', 'garment']);
  assert.equal(saved.references[0].role, '人物身份');
  assert.equal(saved.references[1].role, '服装');
  assert.equal(saved.references[0].filename, 'private-upload/up.png');
  assert.equal(saved.references[0].subfolder, 'private-upload');
  // 参数快照完整
  assert.deepEqual(saved.params, { seed: 7, steps:25, cfg:1.5, width:288, height:384 });
  assert.ok(Array.isArray(saved.loraStack) && saved.loraStack.length === 1);
  assert.ok(existsSync(assetMedia.file(saved.mediaId)), '结果图应落内容寻址存储');
  store.close();
});

test('缺陷3：生成前忙闲保护——共享队列非空即阻断，不上传参考图', async () => {
  const store = makeStore();
  const assetMedia = new AssetMedia(store);
  const pngB64 = png.toString('base64');
  const { fetchFn, seen } = fullFetch({ queue: { queue_running: [{ prompt_id: 'x' }], queue_pending: [] } });
  const refs = { image: async () => ({ data: png, type: 'image/png' }) };
  const jobs = new ImageJobs(store, assetMedia, { refs, fetchFn, resourceCheck: () => ({ ok: true }) });
  jobs.saveSettings({ baseUrl: 'http://127.0.0.1:8188' });
  const job = jobs.enqueue({ recipeId: 'qwen-ref-create', slots: { person: { dataUrl: 'data:image/png;base64,' + pngB64 }, garment: { refId: 'x' } }, params: {} });
  await waitFor(() => store.get('comfyJobs', job.id).status === 'failed');
  const saved = store.get('comfyJobs', job.id);
  assert.match(saved.error, /正忙/);
  assert.ok(!seen.includes('/upload/image'), '忙闲阻断应发生在任何参考图外发之前');
  assert.ok(seen.includes('/queue'), '应调用忙闲检查');
  store.close();
});

test('缺陷3：资源不足阻断，不上传参考图', async () => {
  const store = makeStore();
  const assetMedia = new AssetMedia(store);
  const pngB64 = png.toString('base64');
  const { fetchFn, seen } = fullFetch();
  const refs = { image: async () => ({ data: png, type: 'image/png' }) };
  const jobs = new ImageJobs(store, assetMedia, { refs, fetchFn, resourceCheck: () => ({ ok: false, reason: '本机资源不足' }) });
  jobs.saveSettings({ baseUrl: 'http://127.0.0.1:8188' });
  const job = jobs.enqueue({ recipeId: 'qwen-ref-create', slots: { person: { dataUrl: 'data:image/png;base64,' + pngB64 }, garment: { refId: 'x' } }, params: {} });
  await waitFor(() => store.get('comfyJobs', job.id).status === 'failed');
  assert.match(store.get('comfyJobs', job.id).error, /资源不足/);
  assert.ok(!seen.includes('/upload/image'), '资源不足应在上传前阻断');
  store.close();
});

test('缺陷3：缺模型文件在上传前阻断（validatePreset）', async () => {
  const store = makeStore();
  const assetMedia = new AssetMedia(store);
  const pngB64 = png.toString('base64');
  const badCatalog = { loras: ['qwen21-nsfw-image-edit.safetensors'], presets: [{ name: '03【Qwen】Noct-V4_写实人物', values: { unet_name: 'missing-model', clip_name: 'missing-clip', vae_name: 'missing-vae', reference_size: 256 }, sampler_types: ['KSampler'] }] };
  const { fetchFn, seen } = fullFetch({ catalog: badCatalog });
  const refs = { image: async () => ({ data: png, type: 'image/png' }) };
  const jobs = new ImageJobs(store, assetMedia, { refs, fetchFn, resourceCheck: () => ({ ok: true }) });
  jobs.saveSettings({ baseUrl: 'http://127.0.0.1:8188' });
  const job = jobs.enqueue({ recipeId: 'qwen-ref-create', slots: { person: { dataUrl: 'data:image/png;base64,' + pngB64 }, garment: { refId: 'x' } }, params: {} });
  await waitFor(() => store.get('comfyJobs', job.id).status === 'failed');
  assert.match(store.get('comfyJobs', job.id).error, /缺少模型文件/);
  assert.ok(!seen.includes('/upload/image'), '缺模型应在上传前阻断');
  store.close();
});

test('defaultResourceCheck：显存/内存门槛', () => {
  assert.equal(defaultResourceCheck({ devices: [{ vram_free: 8 * 1024 ** 3 }], system: { ram_free: 0 } }).ok, true);
  assert.equal(defaultResourceCheck({ devices: [], system: { ram_free: 16 * 1024 ** 3 } }).ok, true);
  const low = defaultResourceCheck({ devices: [{ vram_free: 1024 ** 3 }], system: { ram_free: 1024 ** 3 } });
  assert.equal(low.ok, false);
  assert.match(low.reason, /不足/);
});

test('ImageJobs 取消：preparing 阶段不调用全局中断', async () => {
  const store = makeStore();
  const assetMedia = new AssetMedia(store);
  const pngB64 = png.toString('base64');
  let release; const gate = new Promise(r => { release = r; });
  let interruptCalls = 0;
  const fetchFn = async (url) => {
    const u = new URL(url);
    if (u.pathname === '/system_stats') return new Response(JSON.stringify({}), { status: 200 });
    if (u.pathname === '/queue') return new Response(JSON.stringify({ queue_running: [], queue_pending: [] }), { status: 200 });
    if (u.pathname === '/object_info') return new Response(JSON.stringify(minimalObjectInfo()), { status: 200 });
    if (u.pathname === '/local_qwen/catalog') return new Response(JSON.stringify(minimalCatalog()), { status: 200 });
    if (u.pathname === '/upload/image') { await gate; return new Response(JSON.stringify({ name: 'up.png', subfolder: '', type: 'input' }), { status: 200 }); }
    if (u.pathname === '/interrupt') { interruptCalls++; return new Response('', { status: 200 }); }
    throw new Error('unexpected ' + u.pathname);
  };
  const refs = { image: async () => ({ data: png, type: 'image/png' }) };
  const jobs = new ImageJobs(store, assetMedia, { refs, fetchFn, resourceCheck: () => ({ ok: true }) });
  jobs.saveSettings({ baseUrl: 'http://127.0.0.1:8188' });
  const job = jobs.enqueue({ recipeId: 'qwen-ref-create', slots: { person: { dataUrl: 'data:image/png;base64,' + pngB64 }, garment: { refId: 'x' } }, params: {} });
  await waitFor(() => jobs.active?.phase === 'preparing');
  const cancelled = jobs.cancel(job.id);
  assert.equal(interruptCalls, 0);
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.externalUnknown, false);
  release();
  await waitFor(() => !jobs.active);
  store.close();
});

test('ImageJobs 取消（已提交）：停止本地等待，标注外部状态未知，不中断', async () => {
  const store = makeStore();
  const assetMedia = new AssetMedia(store);
  const pngB64 = png.toString('base64');
  let interruptCalls = 0;
  const { fetchFn } = fullFetch();
  const gated = async (url, opts = {}) => {
    const u = new URL(url);
    if (u.pathname === '/history/p1') return new Response(JSON.stringify({}), { status: 200 }); // 挂起轮询
    if (u.pathname === '/interrupt') { interruptCalls++; return new Response('', { status: 200 }); }
    return fetchFn(url, opts);
  };
  const refs = { image: async () => ({ data: png, type: 'image/png' }) };
  const jobs = new ImageJobs(store, assetMedia, { refs, fetchFn: gated, resourceCheck: () => ({ ok: true }) });
  jobs.saveSettings({ baseUrl: 'http://127.0.0.1:8188' });
  const job = jobs.enqueue({ recipeId: 'qwen-ref-create', slots: { person: { dataUrl: 'data:image/png;base64,' + pngB64 }, garment: { refId: 'x' } }, params: {} });
  await waitFor(() => jobs.active?.phase === 'generating' && jobs.active?.promptId === 'p1');
  const cancelled = jobs.cancel(job.id);
  assert.equal(interruptCalls, 0);
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.externalUnknown, true);
  await waitFor(() => !jobs.active);
  store.close();
});

test('缺陷6a：提交失联标记 externalUnknown', async () => {
  const store = makeStore();
  const assetMedia = new AssetMedia(store);
  const pngB64 = png.toString('base64');
  const { fetchFn } = fullFetch({ promptThrow: new TypeError('Response lost after external acceptance') });
  const refs = { image: async () => ({ data: png, type: 'image/png' }) };
  const jobs = new ImageJobs(store, assetMedia, { refs, fetchFn, resourceCheck: () => ({ ok: true }) });
  jobs.saveSettings({ baseUrl: 'http://127.0.0.1:8188' });
  const job = jobs.enqueue({ recipeId: 'qwen-ref-create', slots: { person: { dataUrl: 'data:image/png;base64,' + pngB64 }, garment: { refId: 'x' } }, params: { seed: 1 } });
  await waitFor(() => store.get('comfyJobs', job.id).status === 'failed');
  const saved = store.get('comfyJobs', job.id);
  assert.equal(saved.externalUnknown, true);
  assert.match(saved.error, /外部推理可能已开始/);
  store.close();
});

test('缺陷6b：取消后迟到提交响应不覆写终态', async () => {
  const store = makeStore();
  const assetMedia = new AssetMedia(store);
  const pngB64 = png.toString('base64');
  let release; const gate = new Promise(r => { release = r; });
  const { fetchFn } = fullFetch({ promptGate: gate });
  const refs = { image: async () => ({ data: png, type: 'image/png' }) };
  const jobs = new ImageJobs(store, assetMedia, { refs, fetchFn, resourceCheck: () => ({ ok: true }) });
  jobs.saveSettings({ baseUrl: 'http://127.0.0.1:8188' });
  const job = jobs.enqueue({ recipeId: 'qwen-ref-create', slots: { person: { dataUrl: 'data:image/png;base64,' + pngB64 }, garment: { refId: 'x' } }, params: {} });
  await waitFor(() => jobs.active?.phase === 'submitting');
  const cancelled = jobs.cancel(job.id);
  assert.equal(cancelled.externalUnknown, true);
  release(); // 迟到提交响应返回
  await waitFor(() => !jobs.active);
  const row = store.get('comfyJobs', job.id);
  assert.equal(row.status, 'cancelled');
  assert.equal(row.externalUnknown, true, '迟到提交响应不得清掉外部未知标记');
  store.close();
});

test('缺陷6c：取消后迟到 view 响应不把 cancelled 改成 succeeded', async () => {
  const store = makeStore();
  const assetMedia = new AssetMedia(store);
  const pngB64 = png.toString('base64');
  let release; const gate = new Promise(r => { release = r; });
  const { fetchFn } = fullFetch({ viewGate: gate });
  const refs = { image: async () => ({ data: png, type: 'image/png' }) };
  const jobs = new ImageJobs(store, assetMedia, { refs, fetchFn, resourceCheck: () => ({ ok: true }) });
  jobs.saveSettings({ baseUrl: 'http://127.0.0.1:8188' });
  const job = jobs.enqueue({ recipeId: 'qwen-ref-create', slots: { person: { dataUrl: 'data:image/png;base64,' + pngB64 }, garment: { refId: 'x' } }, params: {} });
  await waitFor(() => jobs.active?.phase === 'downloading');
  const cancelled = jobs.cancel(job.id);
  assert.equal(cancelled.externalUnknown, true);
  release(); // 迟到 view 响应返回
  await waitFor(() => !jobs.active);
  const row = store.get('comfyJobs', job.id);
  assert.equal(row.status, 'cancelled', '迟到 view 响应不得把 cancelled 改成 succeeded');
  assert.equal(row.externalUnknown, true);
  store.close();
});

test('Store：重启后 comfyJobs 未完成任务标记 interrupted，且不自动补跑', () => {
  const dir = temp();
  const s1 = new Store(dir);
  s1.put('comfyJobs', { id: 'j1', recipeId: 'qwen-ref-create', recipeName: 'x', slots: {}, params: {}, status: 'running', createdAt: new Date().toISOString() });
  s1.put('comfyJobs', { id: 'j2', recipeId: 'qwen-ref-create', recipeName: 'x', slots: {}, params: {}, status: 'queued', createdAt: new Date().toISOString() });
  s1.put('comfyJobs', { id: 'j3', recipeId: 'qwen-ref-create', recipeName: 'x', slots: {}, params: {}, status: 'succeeded', createdAt: new Date().toISOString() });
  s1.close();
  const s2 = new Store(dir);
  assert.equal(s2.get('comfyJobs', 'j1').status, 'interrupted');
  assert.equal(s2.get('comfyJobs', 'j2').status, 'interrupted');
  assert.equal(s2.get('comfyJobs', 'j3').status, 'succeeded');
  s2.close();
});

test('缺陷2：AssetMedia.referenced 对 slots 含文本槽不崩溃且正确识别引用', () => {
  const store = makeStore();
  const assetMedia = new AssetMedia(store);
  const id = 'a'.repeat(64);
  store.put('comfyJobs', { id: 'job-result', recipeId: 'qwen-ref-create', recipeName: 'x', slots: {}, params: {}, status: 'succeeded', mediaId: id, createdAt: new Date().toISOString() });
  assert.equal(assetMedia.referenced(id), true, '结果图 mediaId 应被识别为已引用');
  const id2 = 'b'.repeat(64);
  store.put('comfyJobs', { id: 'job-input', recipeId: 'qwen-ref-create', recipeName: 'x', slots: { person: { mediaId: id2 }, prompt: 'hello', empty: null }, params: {}, status: 'failed', createdAt: new Date().toISOString() });
  assert.equal(assetMedia.referenced(id2), true, '输入图 slots.*.mediaId 应被识别为已引用');
  assert.equal(assetMedia.referenced('c'.repeat(64)), false, '无关 ID 不应误判，且文本槽不抛 malformed JSON');
  store.close();
});

test('缺陷8：完整备份导出纳入 comfy 二进制，缺图校验可识别', async () => {
  const store = makeStore();
  const assetMedia = new AssetMedia(store);
  const pngB64 = png.toString('base64');
  const { fetchFn } = fullFetch();
  const refs = { image: async () => ({ data: png, type: 'image/png' }) };
  const jobs = new ImageJobs(store, assetMedia, { refs, fetchFn, resourceCheck: () => ({ ok: true }) });
  jobs.saveSettings({ baseUrl: 'http://127.0.0.1:8188' });
  const job = jobs.enqueue({ recipeId: 'qwen-ref-create', slots: { person: { dataUrl: 'data:image/png;base64,' + pngB64 }, garment: { refId: 'x' } }, params: {} });
  await waitFor(() => store.get('comfyJobs', job.id).status === 'succeeded');
  const comfyJobs = store.list('comfyJobs');
  const saved = store.get('comfyJobs', job.id);
  // 结果图 mediaId 应被收集（person 上传图与结果图同内容则 id 相同，至少收集到结果图）
  const ids = assetMedia.comfyJobMediaIds(comfyJobs);
  assert.ok(ids.includes(saved.mediaId), '应收集结果图 mediaId');
  assert.ok(ids.includes(saved.slots.person.mediaId), '应收集上传输入图 mediaId');
  assert.equal(assetMedia.missingComfyMedia(comfyJobs).length, 0, '文件齐全时无缺图');
  // 删除结果图后应识别为缺图
  unlinkSync(assetMedia.file(saved.mediaId));
  assert.deepEqual(assetMedia.missingComfyMedia(comfyJobs), [saved.mediaId]);
  // exportFiles 对缺图应抛「备份不完整」
  assert.throws(() => assetMedia.exportFiles([{ media: ids.map(id => ({ id })) }]), /素材文件缺失/);
  store.close();
});

test('HTTP 接口：设置、健康检查、配方与任务校验', async () => {
  const app = await createWorkbench({ port: 0, dataDir: temp(), comfyFetcher: async (url) => {
    const u = new URL(url);
    if (u.pathname === '/system_stats') return new Response(JSON.stringify({}), { status: 200 });
    if (u.pathname === '/object_info') return new Response(JSON.stringify(minimalObjectInfo()), { status: 200 });
    if (u.pathname === '/local_qwen/catalog') return new Response(JSON.stringify(minimalCatalog()), { status: 200 });
    throw new Error('unexpected ' + u.pathname);
  } });
  try {
    const root = 'http://127.0.0.1:' + app.port;
    const cookie = (await fetch(root)).headers.get('set-cookie').split(';')[0];
    const api = (route, body, method) => fetch(root + '/api/' + route, { method: method || (body ? 'POST' : 'GET'), headers: { cookie, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    assert.equal((await (await api('comfy/settings')).json()).settings, null);
    const s = (await (await api('comfy/settings', { baseUrl: 'http://127.0.0.1:8188' })).json()).settings;
    assert.equal(s.baseUrl, 'http://127.0.0.1:8188');
    assert.equal((await api('comfy/settings', { baseUrl: 'http://192.168.example.com' })).status, 400);
    const h = await (await api('comfy/health', {})).json();
    assert.equal(h.online, true);
    assert.equal((await (await api('comfy/recipes')).json()).recipes.length, 3);
    assert.equal((await (await api('comfy/jobs')).json()).total, 0);
    const bad = await api('comfy/jobs', { recipeId: 'qwen-ref-create', slots: { garment: { refId: 'x' } }, params: {} });
    assert.equal(bad.status, 400);
  } finally { await app.close(); }
});
