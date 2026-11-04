// 在线生图复用已保存连接；不发现即调用、不重试，不把文本回答误当作图片。
import { validateProvider } from './providers.js';
import { imageModelKind, imageSize } from '../public/image-options.js';

export function imageProvider(saved, model) {
  if (!saved || !['openai', 'gemini'].includes(saved.protocol)) throw new Error('请选择 Gemini 或 OpenAI 兼容连接');
  const p = validateProvider({ ...saved, model: String(model || '').trim() });
  if (!p.model || p.model.length > 200) throw new Error('请填写服务实际支持的生图模型 ID');
  if (imageModelKind(p.model) === 'chat') throw new Error('所选模型是聊天/推理型号，请获取模型列表并选择生图模型，不会发送本次生成');
  return p;
}

function mime(buf) {
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (buf.toString('ascii', 0, 4) === 'RIFF') return 'image/webp';
  return 'image/png';
}

export async function generateImage(provider, { prompt, images = [], size = 'auto', resolution = '' }, { fetchFn = fetch, signal } = {}) {
  const p = imageProvider(provider, provider.model);
  ({ size, resolution } = imageSize(p.protocol, p.model, size, resolution));
  let url, body, headers;
  if (p.protocol === 'gemini') {
    url = p.baseUrl + `/models/${encodeURIComponent(p.model.replace(/^models\//, ''))}:generateContent`;
    headers = { 'Content-Type': 'application/json', 'x-goog-api-key': p.apiKey || '' };
    body = JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }, ...images.map(data => ({ inlineData: { mimeType: mime(data), data: data.toString('base64') } }))] }],
      generationConfig: { responseModalities: ['TEXT', 'IMAGE'], ...(size !== 'auto' || resolution ? { imageConfig: { ...(size !== 'auto' ? { aspectRatio: size } : {}), ...(resolution ? { imageSize: resolution } : {}) } } : {}) } });
  } else {
    url = p.baseUrl + '/images/' + (images.length ? 'edits' : 'generations');
    headers = { Authorization: 'Bearer ' + (p.apiKey || '') };
    if (images.length) {
      body = new FormData();
      body.set('model', p.model); body.set('prompt', prompt); body.set('n', '1'); body.set('size', size);
      images.forEach((data, i) => body.append('image[]', new Blob([data], { type: mime(data) }), `reference-${i + 1}.${mime(data).split('/')[1]}`));
    } else {
      headers['Content-Type'] = 'application/json'; body = JSON.stringify({ model: p.model, prompt, n: 1, size });
    }
  }
  let res;
  try {
    res = await fetchFn(url, { method: 'POST', headers, body, redirect: 'error', signal: AbortSignal.any([AbortSignal.timeout(300000), ...(signal ? [signal] : [])]) });
    const limit = 40 * 1024 * 1024;
    if (Number(res.headers.get('content-length')) > limit) throw new Error('图片响应超过 40MB');
    const chunks = []; let length = 0;
    for await (const chunk of res.body) { length += chunk.length; if (length > limit) throw new Error('图片响应超过 40MB'); chunks.push(chunk); }
    const text = Buffer.concat(chunks).toString('utf8');
    // 不将上游原文错误落盘，避免反射回密钥/私人图片。
    if (!res.ok) {
      const route = new URL(url).pathname;
      const advice = res.status === 404 ? '所选地址上的此接口或模型未找到。请核对生图模型与服务的图片接口路径；聊天接口可用不代表图片接口可用' : res.status === 401 || res.status === 403 ? '请检查此连接的密钥及模型访问权限' : res.status === 429 ? '服务限流或配额不足，请核对服务端记录' : res.status === 400 || res.status === 422 ? '服务不接受本次模型或参数，请核对画幅、参考图与模型要求' : '服务端处理失败，请核对服务端记录';
      const e = new Error(`生图服务 HTTP ${res.status} · ${route}。${advice}；未自动重试`); e.definite = res.status >= 400 && res.status < 500; throw e;
    }
    let data; try { data = JSON.parse(text); } catch { throw new Error('生图服务返回了无效响应'); }
    const parts = data.candidates?.[0]?.content?.parts || [];
    const encoded = p.protocol === 'gemini' ? parts.find(part => !part.thought && (part.inlineData?.data || part.inline_data?.data)) : null;
    const b64 = p.protocol === 'gemini' ? (encoded?.inlineData?.data || encoded?.inline_data?.data) : data.data?.[0]?.b64_json;
    if (!b64) { const e = new Error(p.protocol === 'openai' && data.data?.[0]?.url ? '服务仅返回远程链接，请使用支持 base64 图片输出的接口；未自动重试' : '服务未返回图片，请核对生图模型及提示词；未自动重试'); e.definite = true; throw e; }
    if (typeof b64 !== 'string' || !/^[A-Za-z0-9+/=\r\n]+$/.test(b64)) throw new Error('服务返回的图片编码无效');
    const bytes = Buffer.from(b64, 'base64');
    if (!bytes.length || bytes.length > 20 * 1024 * 1024) throw new Error('生成图片为空或超过 20MB');
    return { data: bytes, text: parts.filter(part => !part.thought && part.text).map(part => part.text).join('\n').slice(0, 12000) };
  } catch (error) {
    const unknown = !error.definite;
    const wrapped = new Error(unknown ? '生图响应未能完整确认，服务可能已处理或计费；请先核对服务记录。' + (res ? ' ' + error.message : '') : error.message);
    wrapped.submitUnknown = unknown;
    throw wrapped;
  }
}
