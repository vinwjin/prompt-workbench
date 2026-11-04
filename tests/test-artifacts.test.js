import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,existsSync,rmdirSync} from 'node:fs';
import path from 'node:path';
import {removeOwnedArtifact} from '../scripts/test-artifacts.mjs';
test('测试临时清理限制实际根路径，拒绝根目录/外部路径/Git，保留旁边证据',()=>{
  const root=mkdtempSync(path.resolve(process.env.PW_TEST_ROOT||'work','cleanup-test-')),temp=path.join(root,'temp'),evidence=path.join(root,'result.json');mkdirSync(temp);writeFileSync(path.join(temp,'fixture.txt'),'regenerable');writeFileSync(evidence,'{}');
  assert.throws(()=>removeOwnedArtifact(root,root),/越界/);assert.throws(()=>removeOwnedArtifact(path.dirname(root),root),/越界/);
  mkdirSync(path.join(temp,'.git'));assert.throws(()=>removeOwnedArtifact(temp,root),/Git/);assert.ok(existsSync(temp));rmdirSync(path.join(temp,'.git'));
  const safe=path.join(root,'safe');mkdirSync(safe);writeFileSync(path.join(safe,'fixture.txt'),'regenerable');removeOwnedArtifact(safe,root);assert.equal(existsSync(safe),false);assert.ok(existsSync(evidence));
});
