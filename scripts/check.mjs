import { readdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
const files=[];
for(const dir of ['src','public','tests','scripts'])for(const f of readdirSync(dir,{withFileTypes:true}))if(f.isFile()&&/\.(js|mjs)$/.test(f.name))files.push(path.join(dir,f.name));
let failed=false;for(const f of files){const r=spawnSync(process.execPath,['--check',f],{encoding:'utf8',windowsHide:true});if(r.status){failed=true;console.error(f,r.stderr);}}
console.log(`${files.length} 个 JavaScript 文件语法检查${failed?'失败':'通过'}`);
const {VERSION}=await import('../public/version.js');
const pkg=JSON.parse(readFileSync('package.json','utf8'));
if(VERSION!==pkg.version){failed=true;console.error(`版本不一致：version.js=${VERSION} package.json=${pkg.version}`);}
console.log(`版本号单一来源检查${VERSION===pkg.version?'通过':'失败'}（VERSION=${VERSION}）`);
process.exitCode=failed?1:0;
