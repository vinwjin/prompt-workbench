import { spawn } from 'node:child_process';
import path from 'node:path';
import { mkdirSync, existsSync, realpathSync, writeFileSync, unlinkSync, copyFileSync, constants } from 'node:fs';
import { randomUUID } from 'node:crypto';

function localDirectory(value) {
  const raw = String(value || '').trim();
  const local = p => process.platform === 'win32' ? /^[a-z]:[\\/]/i.test(p) : !p.startsWith('//');
  if (!path.isAbsolute(raw) || /[\x00-\x1f]/.test(raw)) throw Error('请填写本机绝对目录');
  const directory = path.resolve(raw);
  if (!local(directory)) throw Error('仅支持本机磁盘目录，不支持网络共享或设备路径');
  let ancestor = directory;
  while (!existsSync(ancestor) && path.dirname(ancestor) !== ancestor) ancestor = path.dirname(ancestor);
  if (existsSync(ancestor) && !local(realpathSync(ancestor))) throw Error('目录链接指向网络共享，不支持写入');
  return directory;
}

// User-selected export copies; canonical assets remain in the managed media store.
// Settings are machine-local and deliberately excluded from portable JSON imports.
export function outputPrefix(job) {
  const custom = String(job.filenamePrefix || '').trim();
  const model = String(job.model || job.preset?.name || job.presetName || job.recipeSnapshot?.model || job.recipeName || 'Image');
  const name = custom || (/noct/i.test(model) ? 'Noct-V4' : /turbo/i.test(model) ? 'Qwen-Turbo' : /uc.*q5/i.test(model) ? 'Qwen-UC-Q5' : model);
  const safe = name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '-').replace(/[. ]+$/g, '').slice(0, 100);
  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(safe) ? 'Image-' + safe : safe || 'Image';
}

export class ImageOutput {
  constructor(store, media) { this.store = store; this.media = media; }
  settings() { return { directory: this.store.get('imageOutputSettings', 'default')?.directory || path.join(this.store.dir, 'generated-images'), archiveDirectory: this.media.dir }; }
  save(directory) {
    directory = localDirectory(directory);
    mkdirSync(directory, { recursive: true });
    const probe = path.join(directory, '.pw-write-test-' + randomUUID());
    writeFileSync(probe, '', { flag: 'wx' }); unlinkSync(probe);
    this.store.put('imageOutputSettings', { id: 'default', directory });
    return this.settings();
  }
  async reveal(job, launch = (file) => new Promise((resolve, reject) => {
    const child = spawn('explorer.exe', ['/select,', file], { shell: false, windowsHide: true, detached: true, stdio: 'ignore' });
    child.once('error', reject); child.once('spawn', () => { child.unref(); resolve(); });
  })) {
    if (!job.mediaId) throw Error('此任务没有已保存的图片');
    if (process.platform !== 'win32') throw Error('打开存放位置目前仅支持 Windows');
    let outputPath;
    if (job.outputPath) { try { outputPath = localDirectory(job.outputPath); } catch { /* Untrusted imported paths fall back to the managed archive. */ } }
    const file = outputPath && existsSync(outputPath) ? outputPath : this.media.file(job.mediaId);
    localDirectory(file);
    if (!existsSync(file)) throw Error('图片文件已不存在，请检查存储目录');
    await launch(file);
    return { path: file };
  }
  copy(job, directory = this.settings().directory) {
    directory = localDirectory(directory);
    const ext = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' }[job.mediaType];
    if (!job.mediaId || !ext) throw Error('此任务没有可另存的图片');
    mkdirSync(directory, { recursive: true });
    const prefix = outputPrefix(job);
    for (let n = 1; n <= 1000000; n++) {
      const file = path.join(directory, `${prefix}_${String(n).padStart(5, '0')}.${ext}`);
      try { copyFileSync(this.media.file(job.mediaId), file, constants.COPYFILE_EXCL); return file; }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
    }
    throw Error('Output sequence exhausted');
  }
}
