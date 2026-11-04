import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync,mkdtempSync,readdirSync } from 'node:fs';
import path from 'node:path';
import { Store } from '../src/store.js';
import { setTimeout as sleep } from 'node:timers/promises';
import {spawnSync} from 'node:child_process';
const temp=()=>{mkdirSync('work',{recursive:true});return mkdtempSync(path.resolve(process.env.PW_TEST_ROOT||'work','backup-sched-'));};
const backups=store=>readdirSync(path.join(store.dir,'backups')).filter(n=>/^backup-.*\.json$/.test(n));

test('延迟备份写盘失败保留错误与脏状态，进程继续服务，人工重试可恢复',()=>{
  const dir=temp();
  const code=`import {Store} from './src/store.js';import {renameSync,writeFileSync,unlinkSync} from 'node:fs';
    import {setTimeout as sleep} from 'node:timers/promises';
    const s=new Store(${JSON.stringify(dir)});s._backupDebounce=10;
    renameSync(s.dir+'/backups',s.dir+'/backups.saved');writeFileSync(s.dir+'/backups','simulate unavailable backup directory');
    s.scheduleBackup();await sleep(50);
    const failed=s.backupStatus();
    unlinkSync(s.dir+'/backups');renameSync(s.dir+'/backups.saved',s.dir+'/backups');s.backup();
    console.log(JSON.stringify({failed,recovered:s.backupStatus(),alive:true}));s.close();`;
  const child=spawnSync(process.execPath,['--input-type=module','-e',code],{encoding:'utf8',windowsHide:true});
  assert.equal(child.status,0,child.stderr);
  const r=JSON.parse(child.stdout.trim());assert.equal(r.alive,true);assert.equal(r.failed.pending,true);assert.ok(r.failed.error);
  assert.equal(r.recovered.pending,false);assert.equal(r.recovered.error,null);
});

test('任务完成不再同步备份：防抖合并、max-wait 兜底、同步备份仍保留',async()=>{
  const s=new Store(temp());
  try{
    const initial=backups(s).length; // 构造时一次同步备份
    s._backupDebounce=40;s._backupMaxWait=120;
    s.scheduleBackup();assert.equal(backups(s).length,initial,'调度不立即落盘');
    s.scheduleBackup();await sleep(10);s.scheduleBackup();
    await sleep(70);assert.equal(backups(s).length,initial+1,'防抖期间多次调用合并为一次');
    // 超过 max-wait 立即备份，并清掉挂起的防抖定时器
    s.scheduleBackup();s._backupDirtySince=Date.now()-s._backupMaxWait-1;s.scheduleBackup();
    assert.equal(backups(s).length,initial+2,'max-wait 到点立即备份');
    // 同步 backup 重置脏状态
    s.scheduleBackup();s.backup();assert.equal(backups(s).length,initial+3);
    await sleep(70);assert.equal(backups(s).length,initial+3,'同步备份清掉挂起定时器，不再重复');
  }finally{s.close();}
});
