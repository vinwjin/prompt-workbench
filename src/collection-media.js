import {coverUrl} from './image-cache.js';
import {sourceVideoUrl} from './gallery-policy.js';
// Public, bounded source references. They never authorize a download by themselves.
export function collectionMedia(raw){
  if(!raw)return null;
  if(typeof raw!=='object'||Array.isArray(raw)||!Array.isArray(raw.images)||raw.images.length>8||!Array.isArray(raw.failures)||raw.failures.length>9)throw Error('收藏素材信息无效');
  const images=raw.images.map(r=>{const url=coverUrl(r?.url);if(!url||!/^[a-f0-9]{64}$/.test(r.id)||typeof r.label!=='string'||r.label.length>180)throw Error('收藏图片信息无效');return {url,id:r.id,label:r.label};});
  const failures=raw.failures.map(r=>{const url=r?.url?coverUrl(r.url):'';if((r?.url&&!url)||typeof r?.message!=='string'||r.message.length>180)throw Error('收藏素材失败信息无效');return {url,message:r.message};});
  const videoUrl=raw.videoUrl?sourceVideoUrl(raw.videoUrl):'';if(raw.videoUrl&&!videoUrl)throw Error('收藏视频地址无效');
  return {images,videoUrl,failures};
}
