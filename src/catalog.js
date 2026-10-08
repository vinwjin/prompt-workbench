export const PRESETS = [
  ['router','本机 llama.cpp Router','router','http://127.0.0.1:18180/v1',''],
  ['ollama','Ollama','ollama','http://127.0.0.1:11434',''],
  ['openai','OpenAI','openai','https://api.openai.com/v1',''],
  ['anthropic','Anthropic / Claude','anthropic','https://api.anthropic.com/v1',''],
  ['gemini','Google Gemini','gemini','https://generativelanguage.googleapis.com/v1beta',''],
  ['deepseek','DeepSeek','openai','https://api.deepseek.com/v1','deepseek-chat'],
  ['qwen','阿里百炼 / 通义千问','openai','https://dashscope.aliyuncs.com/compatible-mode/v1','qwen-plus'],
  ['zhipu','智谱 / GLM','openai','https://open.bigmodel.cn/api/paas/v4',''],
  ['moonshot','Moonshot / Kimi','openai','https://api.moonshot.cn/v1',''],
  ['minimax','MiniMax','openai','https://api.minimax.io/v1',''],
  ['doubao','火山方舟 / 豆包','openai','https://ark.cn-beijing.volces.com/api/v3',''],
  ['siliconflow','硅基流动','openai','https://api.siliconflow.cn/v1',''],
  ['xai','xAI / Grok','openai','https://api.x.ai/v1',''],
  ['custom','自定义兼容服务','openai','http://127.0.0.1:8080/v1',''],
  ['llama','独立 llama-server','llama','http://127.0.0.1:18443/v1','local-model']
].map(([id,name,protocol,baseUrl,model])=>({id,name,protocol,baseUrl,model}));

export const BUILTINS = [
  {id:'optimize',name:'通用 · 精准优化',category:'通用',system:'你是提示词编辑。保留用户目标、事实和硬约束，补全清楚的任务步骤与输出要求。不要编造事实，不添加无关角色，只输出可直接使用的提示词。',user:'请优化以下提示词，输出语言为{{language}}：\n{{input}}'},
  {id:'expand',name:'绘图 · 画面扩写',category:'绘图',system:'将创意整理为可执行的绘图提示词。明确主体、空间、动作、构图、材质、光照、风格。未知细节可作为创作选择，但不得改写指定人物或物体。只输出提示词。',user:'输出语言：{{language}}。创意：\n{{input}}'},
  {id:'h3',name:'H3 · 场景与镜头',category:'视频',system:'你是视频提示词编辑。写出场景、主体动作、镜头运动和声音。保持参考素材编号 <Picture N> / <Video N> / <Audio N> 与用户输入一致，不创造不存在的素材引用。只输出可供用户审阅的视频提示词，不声称已生成视频。',user:'输出语言：{{language}}。时长：{{duration}}秒。要求：\n{{input}}'},
  {id:'translate',name:'翻译 · 保留约束',category:'通用',system:'准确翻译提示词，保留专名、数字、引用标签与所有约束，不扩写。只输出译文。',user:'翻译为{{language}}：\n{{input}}'},
  {id:'reverse',name:'反推 · 可见事实',category:'图像',system:'根据参考图片生成绘图提示词。仅描述可见的主体、构图、材质、光照和环境。不推测姓名、品牌、模型、seed或原始提示词。无法确定的细节省略。只输出正文。',user:'输出语言：{{language}}。额外要求：{{input}}'},
  {id:'tags',name:'打标 · 英文标签',category:'训练素材',system:'根据图片输出一行英文逗号分隔的可见内容标签。保留指定触发词，禁止推测身份，不输出分析或Markdown。',user:'触发词或要求：{{input}}'},
  {id:'code',name:'开发 · 明确验收',category:'开发',system:'把需求改写为编程提示词，包含背景、范围、约束、实施步骤和验收标准。不要自行增加技术栈、付费服务或破坏性操作。只输出提示词。',user:'输出语言：{{language}}。需求：\n{{input}}'}
];

export function renderTemplate(template, variables) {
  const missing = new Set();
  const render = text => String(text || '').replace(/\{\{\s*([\w-]+)\s*\}\}/g, (_,key) => {
    if (variables[key] == null || String(variables[key]).trim()==='') missing.add(key);
    return String(variables[key] ?? '');
  });
  const result={system:render(template.system),user:render(template.user)};
  if(missing.size) throw new Error(`请填写模板变量：${[...missing].join('、')}`);
  return result;
}
