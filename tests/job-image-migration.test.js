import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,readFileSync,readdirSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import {Store} from '../src/store.js';
import * as images from '../src/job-images.js';
const temp=()=>{mkdirSync('work',{recursive:true});return mkdtempSync(path.resolve(process.env.PW_TEST_ROOT||'work','image-migration-'));};
const dataUrl='data:image/png;base64,'+readFileSync('public/icon-256.png').toString('base64');
test('历史图迁移保留正文、时间和字节，重复迁移不再改变记录；出错时整批回滚',()=>{
  const s=new Store(temp());try{
    const original=s.put('jobs',{id:'old',input:'原文',output:'结果',status:'succeeded',createdAt:'2026-01-01',images:[{name:'原'.repeat(190)+'.png',dataUrl}]});
    const unnamed=s.put('jobs',{id:'unnamed',status:'failed',images:[{dataUrl}]});
    const result=images.migrateInlineJobImages(s);assert.equal(result.images,2);assert.equal(result.jobs,2);
    assert.deepEqual(images.hydrateImages(s,s.get('jobs','unnamed').images),unnamed.images);
    const migrated=s.get('jobs','old');assert.equal(migrated.updatedAt,original.updatedAt);assert.equal(migrated.input,original.input);
    assert.deepEqual(images.hydrateImages(s,migrated.images),original.images);assert.equal(images.migrateInlineJobImages(s).jobs,0);
    const existingFiles=readdirSync(path.join(s.dir,'media/assets')).sort();
    s.put('jobs',{id:'a-new',status:'failed',images:[{name:'new.png',dataUrl:'data:image/png;base64,'+'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZ1kAAAAASUVORK5CYII='}]});
    s.put('jobs',{id:'broken',status:'failed',images:[{dataUrl:'data:image/png;base64,invalid!'}]});
    const before=s.list('jobs');assert.throws(()=>images.migrateInlineJobImages(s),/图片/);assert.deepEqual(s.list('jobs'),before);
    assert.deepEqual(readdirSync(path.join(s.dir,'media/assets')).sort(),existingFiles,'整批失败移除本批新增文件，保留已有图片');
    const file=path.join(s.dir,'media/assets',migrated.images[0].id+'.bin');writeFileSync(file,'bad');
    assert.throws(()=>images.hydrateImages(s,migrated.images),/校验/);
    assert.throws(()=>images.externalizeImages(s,original.images),/校验/);
    assert.equal(readdirSync(path.dirname(file)).filter(n=>n.endsWith('.tmp')).length,0);
  }finally{s.close();}
});
