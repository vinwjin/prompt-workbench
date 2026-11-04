import test from 'node:test';
import assert from 'node:assert/strict';
import {AccountLogin} from '../public/account-login.js';

test('检查进行中取消请求断网，旧响应被丢弃，恢复网络后仍可继续并完成登录',async()=>{
  const previous=globalThis.document,nodes=new Map();
  globalThis.document={querySelector:selector=>{if(!nodes.has(selector))nodes.set(selector,{disabled:false,textContent:'',classList:{remove(){},toggle(){}}});return nodes.get(selector);}};
  let release,checks=0,refreshes=0,paints=0;
  const ui=Object.assign(Object.create(AccountLogin.prototype),{epoch:1,attempt:{id:'test-attempt',status:'pending'},dialog:{open:true},paint(){paints++;},c:{refresh:async()=>{refreshes++;},api:async(route,body,method)=>{
    if(method==='DELETE')throw Error('network unavailable');checks++;
    if(checks===1)return new Promise(resolve=>{release=resolve;});
    return {id:'test-attempt',status:'succeeded',providerId:'test-account'};
  }}});
  try{
    const pending=ui.poll(ui.epoch);assert.equal(document.querySelector('#account-login-check').disabled,true);
    await ui.cancel();release({id:'test-attempt',status:'pending'});await pending;
    assert.equal(ui.attempt.status,'pending');assert.equal(paints,0);assert.equal(ui.checking,false);assert.equal(document.querySelector('#account-login-check').disabled,false);assert.match(document.querySelector('#account-login-error').textContent,/取消.*未确认/);
    await ui.poll(ui.epoch);assert.equal(ui.attempt.status,'succeeded');assert.equal(checks,2);assert.equal(refreshes,1);assert.equal(paints,1);
  }finally{clearTimeout(ui.timer);if(previous===undefined)delete globalThis.document;else globalThis.document=previous;}
});
