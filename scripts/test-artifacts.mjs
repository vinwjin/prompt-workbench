import {readdirSync,lstatSync,realpathSync,rmSync,existsSync} from 'node:fs';
import path from 'node:path';
// Only directories created by the calling test run are eligible. Never follow links.
export function removeOwnedArtifact(target,root=path.resolve('work')){
  const base=realpathSync(root),absolute=path.resolve(target),relative=path.relative(base,absolute);
  if(!relative||relative.startsWith('..')||path.isAbsolute(relative))throw Error('测试清理路径越界');
  if(!existsSync(absolute))return;
  for(let current=absolute;current!==base;current=path.dirname(current))if(lstatSync(current).isSymbolicLink())throw Error('测试清理拒绝链接');
  function inspect(dir){for(const f of readdirSync(dir,{withFileTypes:true})){const full=path.join(dir,f.name);if(f.isSymbolicLink()||f.name==='.git')throw Error('测试清理拒绝链接或Git工作副本');if(f.isDirectory())inspect(full);}}
  inspect(absolute);rmSync(absolute,{recursive:true,maxRetries:3,retryDelay:200});
}
