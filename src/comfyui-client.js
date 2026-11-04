// ComfyUI 原生 HTTP 客户端（零第三方依赖，仅用 Node 内置 fetch）。
// 只封装服务器端点，不持有工作流、不落库、不做业务判断。
// 端点依据：https://docs.comfy.org/zh/development/comfyui-server/comms_routes
// 调用范式参照 nvzhuang backend/internal/logic/tryon/comfyui.go（MIT，独立重写）。

const MAX_RESPONSE = 64 << 20; // 64 MiB，防异常响应撑爆内存

// 仅允许明确回环地址。这是最底层共享纯函数：备份导入、每次构造客户端（连接前）、保存设置都统一经过它，
// 拒绝公网/伪局域网域名（如 192.168.example.com / 10.example.com）、userinfo 凭据、查询参数/片段与非许可协议，
// 以免把私人参考图发往公网。如需局域网实例，须另行验证字面 IP 与实际连接边界，当前版本不开放。
export function validateBaseUrl(raw) {
  let u;
  try { u = new URL(String(raw || '').trim()); } catch { throw new Error('ComfyUI 地址无效'); }
  if (u.username || u.password) throw new Error('地址不能包含账号或密码');
  if (u.search || u.hash) throw new Error('地址不能包含查询参数或片段');
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('地址须为 HTTP/HTTPS');
  const host = u.hostname.toLowerCase();
  if (!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(host)) throw new Error('ComfyUI 地址仅允许本机回环地址');
  return u.href.replace(/\/+$/, '');
}

function timeoutSignal(ms, signal){ return AbortSignal.any([AbortSignal.timeout(ms), ...(signal ? [signal] : [])]); }

// 有界读取响应体：先按 Content-Length 预检，再在流式读取中计数，超限即中止；避免全量读入后再判大导致重复分配。
async function readBounded(res, limit = MAX_RESPONSE) {
  const cl = res.headers.get('content-length');
  if (cl !== null && cl !== '' && Number.isFinite(Number(cl)) && Number(cl) > limit) throw new Error('ComfyUI 响应超过大小限制');
  if (!res.body) {
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > limit) throw new Error('ComfyUI 响应超过大小限制');
    return buf;
  }
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) { try { await reader.cancel(); } catch {} throw new Error('ComfyUI 响应超过大小限制'); }
    chunks.push(value);
  }
  return Buffer.concat(chunks, total);
}

async function readBoundedText(res, limit = MAX_RESPONSE) {
  return (await readBounded(res, limit)).toString('utf8');
}

export class ComfyUIClient {
  constructor({ baseUrl, fetchFn = fetch, timeoutMs = 30000 } = {}) {
    // 每次实际连接前统一校验（防御旧持久设置、备份导入等绕过 saveSettings 的路径）。
    this.baseUrl = validateBaseUrl(baseUrl);
    this.fetchFn = fetchFn;
    this.timeoutMs = timeoutMs;
  }

  async getJSON(path, signal) {
    const res = await this.fetchFn(this.baseUrl + path, { method: 'GET', headers: { Accept: 'application/json' }, signal: timeoutSignal(this.timeoutMs, signal), redirect: 'error' });
    const text = await readBoundedText(res);
    let data; try { data = JSON.parse(text); } catch { data = null; }
    if (!res.ok) throw new Error(`ComfyUI HTTP ${res.status}`);
    return data;
  }

  // 服务器设备 / 显存 / 版本信息。只读，健康检查用。
  systemStats(signal) { return this.getJSON('/system_stats', signal); }

  // 已安装节点类型与模型下拉列表。只读，健康检查校验节点/模型用。
  objectInfo(signal) { return this.getJSON('/object_info', signal); }

  // 共享实例当前队列（running/pending）。只读，提交前忙闲保护用，不清空外部队列。
  queue(signal) { return this.getJSON('/queue', signal); }

  // 本地 Qwen 自定义节点的模型配套目录（presets + loras）。只读，运行时解析模型配套快照用。
  catalog(signal) { return this.getJSON('/local_qwen/catalog', signal); }

  // 上传输入图（multipart），返回服务端保存的文件名（必须用它回填 LoadImage，不能用本地名）。
  async uploadImage(data, prefix, signal) {
    if (!data || !data.length) throw new Error('待上传图片为空');
    const form = new FormData();
    form.append('image', new Blob([new Uint8Array(data)]), prefix + imageExtension(data));
    form.append('type', 'input');
    form.append('overwrite', 'true');
    const res = await this.fetchFn(this.baseUrl + '/upload/image', { method: 'POST', body: form, signal: timeoutSignal(this.timeoutMs, signal), redirect: 'error' });
    const text = await readBoundedText(res);
    let r; try { r = JSON.parse(text); } catch { r = null; }
    if (!res.ok || !r || typeof r.name !== 'string' || !r.name) throw new Error('ComfyUI 图片上传失败');
    return { name: r.name, subfolder: String(r.subfolder || ''), type: String(r.type || 'input') };
  }

  // 提交 API 格式工作流，返回 prompt_id；node_errors 非空视为校验失败。
  // 区分「明确拒绝」（服务返回 4xx/node_errors，未开始推理）与「提交结果不明」（fetch 网络错误/超时，服务可能已接受）。
  async queuePrompt(workflow, clientId, signal) {
    const body = JSON.stringify({ prompt: workflow, client_id: clientId });
    let res;
    try {
      res = await this.fetchFn(this.baseUrl + '/prompt', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal: timeoutSignal(this.timeoutMs, signal), redirect: 'error' });
    } catch (e) {
      const err = new Error('提交后未收到确认，外部推理可能已开始，结果未知');
      err.submitUnknown = true;
      throw err;
    }
    const text = await readBoundedText(res);
    let r; try { r = JSON.parse(text); } catch { r = null; }
    if (!res.ok) throw new Error(`ComfyUI 拒绝工作流（HTTP ${res.status}）`);
    if (!r || typeof r.prompt_id !== 'string' || !r.prompt_id) throw new Error('ComfyUI 未返回任务编号');
    if (r.node_errors && typeof r.node_errors === 'object' && Object.keys(r.node_errors).length) throw new Error('ComfyUI 工作流校验失败：' + JSON.stringify(r.node_errors).slice(0, 200));
    return r.prompt_id;
  }

  // 查询任务历史。未完成时返回不含该 prompt_id 的对象（或空）。
  async history(promptId, signal) { return this.getJSON('/history/' + encodeURIComponent(promptId), signal); }

  // 下载结果图（按 filename + subfolder + type），返回二进制 Buffer。
  async view(imageRef, signal) {
    const q = new URLSearchParams();
    q.set('filename', imageRef.filename);
    q.set('subfolder', String(imageRef.subfolder || ''));
    q.set('type', String(imageRef.type || 'output'));
    const res = await this.fetchFn(this.baseUrl + '/view?' + q.toString(), { method: 'GET', signal: timeoutSignal(this.timeoutMs, signal), redirect: 'error' });
    if (!res.ok) throw new Error('无法读取 ComfyUI 结果图片');
    const buf = await readBounded(res);
    if (!buf.length) throw new Error('ComfyUI 结果图片为空');
    return buf;
  }

  // 中断 ComfyUI 当前执行。注意：这是无目标全局中断（会停掉当前队列头，可能是其他客户端的任务）。
  // 默认禁止在未确认 prompt_id 归属时调用；本工作台取消任务不使用此方法，仅停止本地等待。
  async interrupt(signal) {
    const res = await this.fetchFn(this.baseUrl + '/interrupt', { method: 'POST', signal: timeoutSignal(this.timeoutMs, signal), redirect: 'error' });
    if (!res.ok) throw new Error('ComfyUI 中断失败');
    return true;
  }
}

function imageExtension(data) {
  const b = Buffer.isBuffer(data) ? data : Buffer.from(data);
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return '.jpg';
  if (b.length >= 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return '.webp';
  return '.png';
}
