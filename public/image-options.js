// 浏览器与服务端共用的确定性选项规则；名称推断只作候选提示，不代表实际接口验收。
export const IMAGE_RATIOS = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'];
export function imageModelKind(id) {
  const name = String(id || '').toLowerCase().replace(/^models\//, '');
  if (/image|dall-e|flux|nano-banana/.test(name)) return 'candidate';
  if (/^(?:grok-\d|gpt-\d|o[134](?:-|$)|claude-|deepseek-|qwen\d|gemini-)/.test(name)) return 'chat';
  return 'unknown';
}
export function imageSize(protocol, model, raw = 'auto', resolution = '') {
  const size = String(raw || 'auto');
  if (protocol === 'gemini') {
    if (size !== 'auto' && !IMAGE_RATIOS.includes(size)) throw Error('Gemini 请选择支持的画幅比例');
    if (!['', '1K', '2K', '4K'].includes(resolution)) throw Error('Gemini 分辨率档位无效');
    if (resolution && /gemini-2\.5.*image/i.test(model)) throw Error('该 Gemini 模型不支持自定义分辨率档位，请选择模型默认');
    return { size, resolution };
  }
  if (size === 'auto') return { size, resolution: '' };
  const match = /^(\d{2,4})x(\d{2,4})$/.exec(size);
  if (!match) throw Error('图片尺寸请使用 宽×高 像素');
  const w = Number(match[1]), h = Number(match[2]);
  if (w < 64 || h < 64 || w > 4096 || h > 4096 || w % 16 || h % 16 || w * h > 8294400) throw Error('宽高须为64–4096内的16倍数，总像素不超过8294400');
  if (/gpt-image-(?:1(?:\.|-|$))|chatgpt-image/i.test(model) && !['1024x1024', '1024x1536', '1536x1024'].includes(size)) throw Error('此型号请选择1024×1024、1024×1536或1536×1024；自定义尺寸取决于型号');
  return { size: `${w}x${h}`, resolution: '' };
}
export function fitImageRatio(value, ratio, axis = 'width') {
  const match = /^(\d{1,2}):(\d{1,2})$/.exec(ratio);
  if (!match || !Number(match[1]) || !Number(match[2])) throw Error('比例须为正整数，例如16:9');
  const gcd = (a,b) => b ? gcd(b,a%b) : a;
  const a = Number(match[1]), b = Number(match[2]), d = gcd(a,b), rw=a/d, rh=b/d;
  const scale = Math.max(1, Math.round(Number(value) / (16 * (axis === 'width' ? rw : rh))));
  return { width: rw*16*scale, height: rh*16*scale };
}
