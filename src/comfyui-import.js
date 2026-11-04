// 有界工作流导入。只解释数据，不执行 JSON 中的脚本；原 ComfyUI 文件保持只读。
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { getRecipe } from './comfyui-workflows.js';

const MAX_BYTES = 2 * 1024 * 1024;
const WIDGETS = {
  LocalQwenPrompt: ['task', 'prompt', 'negative_prompt', 'references_state', 'optimizer', 'llama_model', 'read_media', 'optimizer_options'],
  LocalQwenEncode: ['unet_name', 'clip_name', 'vae_name', 'width', 'height', 'reference_size', 'loader_options', 'lora_stack', 'reference_fit'],
  SamplerCustom: ['add_noise', 'noise_seed', null, 'cfg'],
  KSamplerSelect: ['sampler_name'], ManualSigmas: ['sigmas'], ModelSamplingAuraFlow: ['shift', 'sampling'],
  KSampler: ['seed', null, 'steps', 'cfg', 'sampler_name', 'scheduler', 'denoise'],
  LocalQwenCanvas: ['ratio', 'based_on', 'size', 'sizing_mode', 'custom_width', 'custom_height'],
  QwenImage21Cache: ['device', 'dtype'], VAEDecode: [], SaveImage: ['filename_prefix'],
  SaveImageAdvanced: ['filename_prefix', 'format', 'format.bit_depth', 'format.input_color_space']
};

export function importWorkflow(input, name = '导入的工作流') {
  if (Buffer.byteLength(JSON.stringify(input) || '') > MAX_BYTES) throw new Error('工作流超过 2MB');
  let graph = structuredClone(input?.prompt && !input.prompt.class_type && !input?.nodes ? input.prompt : input);
  const converted = Array.isArray(graph?.nodes);
  if (converted) {
    const ui = graph; graph = {};
    const links = new Map((ui.links || []).map(l => [l[0], l]));
    for (const n of ui.nodes) {
      if (['MarkdownNote', 'Note'].includes(n.type)) continue;
      if (!Object.hasOwn(WIDGETS, n.type) || (n.mode ?? 0) !== 0) throw new Error(`界面工作流含不支持的节点或禁用/旁路：${n.type}，请在 ComfyUI 导出 API 格式`);
      const inputs = {};
      const values = n.widgets_values || [];
      for (const [i, field] of WIDGETS[n.type].entries()) if (field && values[i] !== undefined) inputs[field] = values[i];
      for (const port of n.inputs || []) if (port.link != null) {
        const link = links.get(port.link);
        if (!link || String(link[3]) !== String(n.id)) throw new Error('工作流连线无效');
        inputs[port.name] = [String(link[1]), link[2]];
      }
      graph[String(n.id)] = { class_type: n.type, inputs };
    }
  }
  if (!graph || typeof graph !== 'object' || Array.isArray(graph) || Object.keys(graph).length > 200) throw new Error('需要 ComfyUI API 节点对象');
  const entries = Object.entries(graph);
  for (const [id, n] of entries) {
    if (!/^[\w-]{1,80}$/.test(id) || !Object.hasOwn(WIDGETS, n?.class_type) || !n.inputs || Array.isArray(n.inputs)) throw new Error('当前支持本地 Qwen 参考创作链；不支持节点：' + (n?.class_type || id));
    for (const v of Object.values(n.inputs)) if (Array.isArray(v) && (v.length !== 2 || !graph[String(v[0])] || !Number.isInteger(v[1]) || v[1] < 0)) throw new Error('工作流连线目标无效');
  }
  const one = types => {
    const nodes = entries.filter(([, n]) => types.includes(n.class_type));
    if (nodes.length !== 1) throw new Error('工作流必须包含一个 ' + types.join(' / ') + ' 节点');
    return nodes[0][0];
  };
  const promptNode = one(['LocalQwenPrompt']), encodeNode = one(['LocalQwenEncode']);
  const samplerNode = one(['KSampler', 'SamplerCustom']), outputNode = one(['SaveImage', 'SaveImageAdvanced']);
  const base = structuredClone(getRecipe('qwen-character'));
  const encode = graph[encodeNode].inputs, sampler = graph[samplerNode].inputs;
  // 工作台替换参考图和最终提示词，并关闭额外的提示词模型调用。
  Object.assign(graph[promptNode].inputs, { references_state: '[]', optimizer: '关闭', read_media: false, optimizer_options: '{"optimize_on_run":false}' });
  graph[outputNode].inputs.filename_prefix = 'pw/comfy';
  let loraStack;
  try { loraStack = JSON.parse(encode.lora_stack || '[]'); } catch { throw new Error('LoRA 配置不是有效 JSON'); }
  if (!Array.isArray(loraStack) || loraStack.length > 20 || loraStack.some(l => typeof l.name !== 'string' || !Number.isFinite(l.strength))) throw new Error('LoRA 配置无效');
  // 画布连线必须按其真实计算规则求尺寸，随后由工作台尺寸控件接管。
  let width = encode.width, height = encode.height;
  if (Array.isArray(width) || Array.isArray(height)) {
    const canvasId = Array.isArray(width) ? width[0] : height[0];
    const canvas = graph[canvasId];
    if (canvas?.class_type !== 'LocalQwenCanvas') throw new Error('无法识别画幅连线，请导出固定画幅的 API 工作流');
    const c = canvas.inputs;
    if (c.sizing_mode === '自定义像素') { width = Math.max(32, Math.round(c.custom_width / 32) * 32); height = Math.max(32, Math.round(c.custom_height / 32) * 32); }
    else {
      const ratio = /^(\d+):(\d+)$/.exec(c.ratio || '');
      if (!ratio || !Number.isFinite(c.size) || !['宽度', '高度'].includes(c.based_on)) throw new Error('无法解析画布比例');
      const gcd = (a, b) => b ? gcd(b, a % b) : a;
      const a0 = Number(ratio[1]), b0 = Number(ratio[2]), d = gcd(a0, b0);
      if (!d || !a0 || !b0 || (c.sizing_mode && c.sizing_mode !== '按比例计算')) throw new Error('画布比例或尺寸模式无效');
      const a = a0 / d, b = b0 / d;
      const scale = Math.max(1, Math.round(c.size / ((c.based_on === '宽度' ? a : b) * 32)));
      width = a * 32 * scale; height = b * 32 * scale;
    }
    encode.width = width; encode.height = height;
  }
  const custom = graph[samplerNode].class_type === 'SamplerCustom';
  if (custom) {
    const sigmas = graph[sampler.sigmas?.[0]];
    if (sigmas?.class_type !== 'ManualSigmas' || typeof sigmas.inputs.sigmas !== 'string') throw Error('自定义采样链需要 ManualSigmas');
    const values = sigmas.inputs.sigmas.split(',').map(v => Number(v.trim()));
    if (values.length < 2 || values.length > 101 || sigmas.inputs.sigmas.split(',').some(v => !v.trim()) || values.some((v, i) => !Number.isFinite(v) || v < 0 || (i > 0 && v >= values[i - 1])) || values.at(-1) !== 0) throw Error('ManualSigmas 序列无效');
  }
  const params = base.params.filter(p => !custom || p.key !== 'steps').map(p => ({ ...p, node: ['width', 'height'].includes(p.key) ? encodeNode : samplerNode,
    field: custom && p.key === 'seed' ? 'noise_seed' : p.field,
    default: p.key === 'seed' ? (custom ? sampler.noise_seed : -1) : p.key === 'width' ? width : p.key === 'height' ? height : sampler[p.field] ?? p.default }));
  const digest = createHash('sha256').update(JSON.stringify(graph)).digest('hex');
  return { ...base, id: 'import-' + digest.slice(0, 20), name: String(name).replace(/\.json$/i, '').slice(0, 120),
    description: converted ? '由本地 Qwen 界面工作流转换；保留模型、LoRA 与采样参数，参考图和提示词由合成台提供。' : '本地 Qwen API 工作流；参考图和提示词由合成台提供。',
    workflow: graph, file: undefined, promptNode, encodeNode, samplerNode, outputNode, params,
    presetName: '', embeddedPreset: { name: '工作流原配套', values: { unet_name: encode.unet_name, clip_name: encode.clip_name, vae_name: encode.vae_name, reference_size: encode.reference_size }, sampler_types: [graph[samplerNode].class_type] },
    prompt: '', loraStack, converted, sourceHash: digest };
}

export function scanWorkflows(directory) {
  if (typeof directory !== 'string' || !directory.trim() || !path.isAbsolute(directory) || directory.startsWith('\\\\')) throw new Error('请填写本机工作流目录的绝对路径');
  const files = readdirSync(directory, { withFileTypes: true }).filter(f => f.isFile() && /\.json$/i.test(f.name)).slice(0, 100);
  return files.map(f => {
    try {
      const file = path.join(directory, f.name);
      if (statSync(file).size > MAX_BYTES) throw new Error('工作流超过 2MB');
      const recipe = importWorkflow(JSON.parse(readFileSync(file, 'utf8')), f.name);
      return { name: f.name, recipe };
    } catch (e) { return { name: f.name, error: e.message }; }
  });
}
