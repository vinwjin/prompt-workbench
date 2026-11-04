// 图像生成工作流配方框架（通用）。
// 一个 recipe 描述一种可执行的 ComfyUI 工作流：输入槽（slot）、参数（param）、提示词节点、编码节点与输出节点。
// 新增工作流 = 在 REGISTRY 登记一条 recipe + 放入对应 API 格式工作流 JSON，核心代码零改动。
// 工作流 JSON 为 ComfyUI「Export (API)」格式：{ 节点ID: { class_type, inputs } }，连线用 ["上游ID", 槽号]。
//
// 本机（D:\Comfy-Desktop）真实链路：LocalQwenPrompt → LocalQwenEncode → QwenImage21Cache → KSampler → VAEDecode → SaveImage。
// 参考图经 LocalQwenPrompt.references_state 注入：JSON 字符串 [{ filename, role }]，role 为中文参考角色（如「人物身份」「服装」）。
// 模型配套（unet/clip/vae/reference_size）不硬编码，运行时从 GET /local_qwen/catalog 匹配 preset 注入并快照。

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WORKFLOW_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'workflows');

// 内置配方注册表。
// - slot.kind='image'：参考图，按 slot 顺序进入 references_state，role 为参考角色；<imageN> 编号 = slot 顺序（1 起）。
// - slot.kind='text' 且 key='prompt'：追加到 recipe.prompt 之后。
// - param：注入到 param.node 的 param.field。
export const RECIPES = [
  {
    id: 'qwen-ref-create',
    name: 'Qwen 参考创作（换装）',
    description: '人物 + 服装 → 参考创作合成（保留人物身份，迁移服装）',
    file: 'qwen-ref-create.json',
    outputNode: 'save',
    promptNode: 'prompt',
    encodeNode: 'encode',
    samplerNode: 'sampler',
    // 模型配套按名称从 catalog 匹配；名称对应本机 catalog 的 preset.name。
    presetName: '03【Qwen】Noct-V4_写实人物',
    // 换装 LoRA（本机 catalog.loras 已含）；reference 语义见 qwen-ref-create.json 注释。
    loraStack: [{ name: 'qwen21-nsfw-image-edit.safetensors', strength: 1, enabled: true }],
    prompt: '<image1>提供人物身份，<image2>提供服装。请把<image1>中的人物换上<image2>中的服装，生成一张照片级写实图片。保留人物的五官、脸型、发型、肤色、体型与姿态不变，自然穿着<image2>的服装，完整保留其颜色、图案、领口、袖型、面料质感与结构细节，贴合身体、光线自然。',
    negativePrompt: '',
    slots: [
      { key: 'person', label: '人物图', kind: 'image', source: 'upload', role: '人物身份', required: true, hint: '上传人像照片（提供人物身份）' },
      { key: 'garment', label: '服装', kind: 'image', source: 'ref:costume', role: '服装', required: true, hint: '从服装库选择一套服装' },
      { key: 'prompt', label: '补充要求', kind: 'text', source: 'text', required: false, maxLength: 2000, hint: '可选，追加到生成指令之后' }
    ],
    params: [
      { key: 'seed', label: '随机种子', kind: 'number', node: 'sampler', field: 'seed', default: 0, min: -1, integer: true, hint: '-1 表示每次随机' },
      { key: 'steps', label: '采样步数', kind: 'number', node: 'sampler', field: 'steps', default: 25, min: 1, max: 100, integer: true },
      { key: 'cfg', label: 'CFG', kind: 'number', node: 'sampler', field: 'cfg', default: 1.5, min: 0, max: 100 },
      { key: 'width', label: '宽度', kind: 'number', node: 'encode', field: 'width', default: 288, min: 64, max: 4096, integer: true, align: 16 },
      { key: 'height', label: '高度', kind: 'number', node: 'encode', field: 'height', default: 384, min: 64, max: 4096, integer: true, align: 16 }
    ],
    // 总像素预算（本机 Qwen-Image 建议 ≤ 约 4M 像素，防非法超大画幅撑爆显存）
    maxTotalPixels: 4 * 1024 * 1024
  }
];

const byId = new Map(RECIPES.map(r => [r.id, r]));

// 三参考合成沿用同一条本地编码/采样链，不暗中叠加换装 LoRA。
const character = { ...structuredClone(RECIPES[0]), id: 'qwen-character', name: 'Qwen 角色合成',
  description: '人像、服装、姿势自由组合；也可只写提示词创作。', prompt: '', loraStack: [],
  slots: [
    { key: 'person', label: '人像', kind: 'image', source: 'ref:face', role: '人物身份', required: false },
    { key: 'garment', label: '服装', kind: 'image', source: 'ref:costume', role: '服装', required: false },
    { key: 'pose', label: '姿势', kind: 'image', source: 'ref:pose', role: '姿势动作', required: false },
    { key: 'prompt', label: '提示词', kind: 'text', source: 'text', maxLength: 12000 }
  ] };
character.params.find(p => p.key === 'seed').default = -1;
RECIPES.unshift(character); byId.set(character.id, character);

const turbo = { ...structuredClone(character), id: 'qwen-turbo', name: 'Qwen Turbo 日常创作',
  description: 'Turbo 专用采样链：Euler + ManualSigmas 固定8步；保留原文件 CFG 1.5 和画幅，可使用参考图或文生图。',
  file: 'qwen-turbo.json', promptNode: '11', encodeNode: '2', samplerNode: '3', outputNode: '5',
  presetName: '01【Qwen】Turbo_日常创作', loraStack: [],
  params: character.params.filter(p => p.key !== 'steps').map(p => ({ ...p,
    node: ['width', 'height'].includes(p.key) ? '2' : '3', field: p.key === 'seed' ? 'noise_seed' : p.field,
    default: p.key === 'seed' ? 239091111501857 : p.key === 'width' ? 768 : p.key === 'height' ? 1024 : p.default })) };
RECIPES.push(turbo); byId.set(turbo.id, turbo);

export function getRecipe(id) {
  const r = byId.get(String(id || ''));
  if (!r) throw new Error('工作流配方不存在');
  return r;
}

// 给前端展示的配方清单：剥离 node/field/role/promptNode 等内部细节，只保留标签与输入约束。
export function recipeCatalog(recipes = RECIPES) {
  return recipes.map(r => ({
    id: r.id, name: r.name, description: r.description,
    prompt: r.prompt, presetName: r.presetName, model: r.embeddedPreset?.values?.unet_name || '',
    loras: (r.loraStack || []).filter(l => l.enabled !== false).map(l => l.name),
    slots: r.slots.map(s => ({ key: s.key, label: s.label, kind: s.kind, source: s.source, required: !!s.required, hint: s.hint || '', maxLength: s.maxLength || 0 })),
    params: r.params.map(p => ({ key: p.key, label: p.label, kind: p.kind, default: p.default, min: p.min, max: p.max, step: p.align || (p.integer ? 1 : 0.1), hint: p.hint || '' }))
  }));
}

export function loadWorkflow(recipe) {
  if (recipe.workflow) { validateShape(recipe.workflow, recipe); return structuredClone(recipe.workflow); }
  const file = path.join(WORKFLOW_DIR, recipe.file);
  let data;
  try { data = readFileSync(file, 'utf8'); } catch { throw new Error('工作流文件缺失：' + recipe.file); }
  let workflow;
  try { workflow = JSON.parse(data); } catch { throw new Error('工作流文件格式错误：' + recipe.file); }
  validateShape(workflow, recipe);
  return workflow;
}

// 校验工作流与配方结构一致：prompt/encode/output 节点存在，image 槽有 role，params 引用节点存在。
function validateShape(workflow, recipe) {
  if (!workflow || typeof workflow !== 'object' || Array.isArray(workflow)) throw new Error('工作流须为节点对象');
  const keyed = { promptNode: '提示词', encodeNode: '编码', outputNode: '输出' };
  for (const [key, label] of Object.entries(keyed)) {
    const id = recipe[key];
    const node = workflow[id];
    if (!id || !node || typeof node.class_type !== 'string' || !node.inputs || typeof node.inputs !== 'object') throw new Error(`工作流缺少${label}节点 ${id}`);
  }
  if (recipe.samplerNode && !workflow[recipe.samplerNode]) throw new Error(`工作流缺少采样节点 ${recipe.samplerNode}`);
  for (const slot of recipe.slots) {
    if (slot.kind === 'image' && !slot.role) throw new Error(`图像槽 ${slot.key} 缺少参考角色 role`);
    if (slot.kind === 'text' && slot.key !== 'prompt' && !workflow[slot.node]) throw new Error(`工作流缺少节点 ${slot.node}（${slot.key}）`);
  }
  for (const p of recipe.params) if (!workflow[p.node]) throw new Error(`工作流缺少节点 ${p.node}（${p.key}）`);
}

// 深拷贝工作流并按 slot/param 注入。
// image 槽的值 = ComfyUI 上传后返回的文件名；按 slot 顺序构造 references_state（filename + role）。
// values._preset = 运行时从 catalog 解析出的模型配套快照（可选，覆盖模板默认模型）。
export function injectWorkflow(workflow, recipe, values = {}) {
  const out = structuredClone(workflow);
  const references = [];
  for (const slot of recipe.slots) {
    const v = values[slot.key];
    const empty = v === undefined || v === null || v === '';
    if (slot.required && empty) throw new Error(`缺少输入：${slot.label}`);
    if (empty) continue;
    if (slot.kind === 'image') {
      references.push({ filename: String(v), role: slot.role });
    } else if (slot.kind === 'text' && slot.key === 'prompt') {
      // 追加要求：拼到基础指令之后（保留，供下方统一处理）
    } else if (slot.kind === 'text') {
      if (String(v).length > (slot.maxLength || 2000)) throw new Error(`${slot.label} 过长`);
      setInput(out, slot.node, slot.field, String(v));
    }
  }
  setInput(out, recipe.promptNode, 'references_state', JSON.stringify(references));
  setInput(out, recipe.promptNode, 'task', references.length ? '人物或场景参考创作' : '文生图');
  const extra = values.prompt !== undefined && values.prompt !== null ? String(values.prompt).trim() : '';
  setInput(out, recipe.promptNode, 'prompt', values._promptOverride !== undefined ? String(values._promptOverride) : extra ? recipe.prompt + '\n' + extra : recipe.prompt);
  setInput(out, recipe.promptNode, 'negative_prompt', values._negativePrompt ?? recipe.negativePrompt ?? '');
  setInput(out, recipe.encodeNode, 'lora_stack', JSON.stringify(recipe.loraStack || []));
  const preset = values._preset;
  if (preset) {
    setInput(out, recipe.encodeNode, 'unet_name', preset.unet_name);
    setInput(out, recipe.encodeNode, 'clip_name', preset.clip_name);
    setInput(out, recipe.encodeNode, 'vae_name', preset.vae_name);
    if (preset.reference_size !== undefined) setInput(out, recipe.encodeNode, 'reference_size', preset.reference_size);
  }
  for (const p of recipe.params) {
    if (values[p.key] === undefined || values[p.key] === null) continue;
    const num = Number(values[p.key]);
    if (!Number.isFinite(num)) throw new Error(`${p.label} 必须是数字`);
    if (p.key === 'seed' && num < 0) { setInput(out, p.node, p.field, randomSeed()); continue; }
    setInput(out, p.node, p.field, num);
  }
  return out;
}

function setInput(workflow, nodeId, field, value) {
  const node = workflow[nodeId];
  if (!node || !node.inputs || typeof node.inputs !== 'object') throw new Error('工作流节点输入无效');
  node.inputs[field] = value;
}

function randomSeed() { return Math.floor(Math.random() * Number.MAX_SAFE_INTEGER); }

// 从 catalog 解析模型配套快照：按 presetName 精确匹配，未命中即报错，绝不静默回退到其它配套（避免悄悄换模型/采样器）。
export function resolvePreset(recipe, catalog, selectedName) {
  if (!selectedName && recipe.embeddedPreset) return structuredClone(recipe.embeddedPreset);
  if (recipe.embeddedPreset && selectedName === `embedded:${recipe.id}:${recipe.embeddedPreset.values?.unet_name}`) return { ...structuredClone(recipe.embeddedPreset), name: `原配套 · ${recipe.embeddedPreset.values.unet_name}` };
  if (!catalog || typeof catalog !== 'object' || Array.isArray(catalog)) throw new Error('ComfyUI 模型配套目录不可用');
  const presets = Array.isArray(catalog.presets) ? catalog.presets : [];
  if (!presets.length) throw new Error('ComfyUI 未返回模型配套');
  const preset = presets.find(p => p && p.name === (selectedName || recipe.presetName));
  if (!preset) throw new Error(`ComfyUI 缺少所需模型配套：${recipe.presetName}`);
  if (!preset.values || typeof preset.values !== 'object') throw new Error('ComfyUI 模型配套无效');
  return { name: preset.name, values: { ...preset.values }, sampler_types: Array.isArray(preset.sampler_types) ? preset.sampler_types.slice() : undefined };
}

// 健康检查（只读）：校验工作流节点与所用模型文件在 ComfyUI 中可用。
// objectInfo：{ classType: { input: { required: { param: [typeOrOptions, ...] } } } }
export function validateAgainstObjectInfo(workflow, recipe, objectInfo) {
  if (!objectInfo || typeof objectInfo !== 'object' || Array.isArray(objectInfo)) throw new Error('ComfyUI 节点信息不可用');
  for (const [nodeId, node] of Object.entries(workflow)) {
    if (!node || typeof node.class_type !== 'string') continue;
    if (!(node.class_type in objectInfo)) throw new Error(`ComfyUI 缺少节点：${node.class_type}`);
    const meta = objectInfo[node.class_type]?.input?.required;
    if (!meta || typeof meta !== 'object') continue;
    for (const [paramName, paramVal] of Object.entries(node.inputs || {})) {
      if (typeof paramVal !== 'string' || paramVal.startsWith('__')) continue; // 连线引用或占位符跳过
      const fieldMeta = meta[paramName];
      if (!Array.isArray(fieldMeta) || !Array.isArray(fieldMeta[0])) continue; // 无下拉选项，跳过
      if (fieldMeta[0].length && !fieldMeta[0].includes(paramVal)) throw new Error(`ComfyUI 缺少模型文件：${paramVal}`);
    }
  }
  return true;
}

// 校验 catalog 解析出的配套（unet/clip/vae）在 object_info 下拉中可用，且 recipe 声明的 LoRA 在 catalog.loras 中，
// 以及配套声明的 sampler_types 与工作流采样节点 class_type 兼容（缺失或采样链不兼容即报错，不回退适配）。
export function validatePreset(recipe, workflow, objectInfo, catalog, preset) {
  const encodeNode = workflow[recipe.encodeNode];
  const meta = objectInfo?.[encodeNode.class_type]?.input?.required;
  if (!meta || typeof meta !== 'object') throw new Error('ComfyUI 缺少编码节点信息');
  for (const field of ['unet_name', 'clip_name', 'vae_name']) {
    const val = preset.values[field];
    if (typeof val !== 'string' || !val) throw new Error(`ComfyUI 模型配套缺少 ${field}`);
    const fieldMeta = meta[field];
    if (Array.isArray(fieldMeta) && Array.isArray(fieldMeta[0]) && fieldMeta[0].length && !fieldMeta[0].includes(val)) throw new Error(`ComfyUI 缺少模型文件：${val}`);
  }
  // 采样器类型兼容：本机 Turbo 用 SamplerCustom、Noct/UC-Q5 用 KSampler，不能盲套同一模板。
  if (recipe.samplerNode && Array.isArray(preset.sampler_types) && preset.sampler_types.length) {
    const samplerNode = workflow[recipe.samplerNode];
    if (samplerNode && typeof samplerNode.class_type === 'string' && !preset.sampler_types.includes(samplerNode.class_type)) {
      throw new Error(`模型配套 ${preset.name} 的采样器与工作流不兼容：使用 ${preset.sampler_types.join('/')}，当前工作流使用 ${samplerNode.class_type}；请切换到对应专用工作流`);
    }
  }
  const loras = Array.isArray(catalog?.loras) ? catalog.loras : [];
  for (const lora of (recipe.loraStack || []).filter(l => l.enabled !== false)) {
    if (!loras.includes(lora.name)) throw new Error(`ComfyUI 缺少 LoRA：${lora.name}`);
  }
  return true;
}

// 校验并规范化一次生成的参数：整数、min/max、seed 安全整数、画幅对齐与总像素预算。
// 返回仅含已提供键的规范化参数对象；非法值抛错（在私人图落盘/上传前由调用方执行）。
export function normalizeParams(recipe, input = {}) {
  const out = {};
  for (const p of recipe.params || []) {
    const raw = input[p.key];
    if (raw === undefined || raw === null || raw === '') continue;
    const num = Number(raw);
    if (!Number.isFinite(num)) throw new Error(`${p.label} 必须是数字`);
    if (p.integer && !Number.isInteger(num)) throw new Error(`${p.label} 必须是整数`);
    if (p.key === 'seed') { if (!Number.isSafeInteger(num)) throw new Error(`${p.label} 超出安全整数范围`); }
    if (p.min !== undefined && num < p.min) throw new Error(`${p.label} 不能小于 ${p.min}`);
    if (p.max !== undefined && num > p.max) throw new Error(`${p.label} 不能大于 ${p.max}`);
    if (p.align && num % p.align !== 0) throw new Error(`${p.label} 必须是 ${p.align} 的倍数`);
    out[p.key] = num;
  }
  if (recipe.maxTotalPixels) {
    const w = out.width !== undefined ? out.width : recipe.params.find(p => p.key === 'width')?.default;
    const h = out.height !== undefined ? out.height : recipe.params.find(p => p.key === 'height')?.default;
    if (w && h && w * h > recipe.maxTotalPixels) throw new Error('宽度×高度总像素超过上限');
  }
  return out;
}
