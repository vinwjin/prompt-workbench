import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {waitForServiceExit} from '../public/service-exit.js';
test('旧后台版本仍允许保存草稿/关闭，生成和业务修改继续禁止，轮询不循环报错',async()=>{
 const text=readFileSync('public/app.js','utf8'),start=text.indexOf('async function api('),end=text.indexOf('\nfunction toast(',start),calls=[];
 const api=new Function('backendVersion','VERSION','fetch','return ('+text.slice(start,end)+')')('old','new',async(url,config)=>{calls.push({url,method:config.method});return {ok:true,json:async()=>({ok:true})};});
 await api('draft',{input:'用户未保存文字'});await api('shutdown',{});await api('progress');assert.equal(calls.length,3);
 for(const route of ['jobs','assets','providers'])await assert.rejects(api(route,{}),/旧版/);assert.equal(calls.length,3);
});
test('健康超时/损坏/离线不算退出，恢复成功重置计数，连续三次连接失败才确认',async()=>{
 let calls=0;const errors=[{name:'TimeoutError'},{name:'SyntaxError'},new TypeError('connection failed'),new TypeError('connection failed'),null,new TypeError('connection failed'),new TypeError('connection failed'),new TypeError('connection failed')];
 const result=await waitForServiceExit('old',{pause:async()=>{},fetcher:async()=>{const e=errors[calls++];if(e)throw e;return {ok:true,json:async()=>({app:'prompt-workbench',version:'old'})};}});assert.equal(result,'closed');assert.equal(calls,8);
 assert.equal(await waitForServiceExit('old',{attempts:3,pause:async()=>{},fetcher:async()=>{throw {name:'TimeoutError'};}}),'pending');
 assert.equal(await waitForServiceExit('old',{attempts:3,pause:async()=>{},online:()=>false,fetcher:async()=>{throw new TypeError('offline');}}),'pending');
 assert.equal(await waitForServiceExit('old',{pause:async()=>{},fetcher:async()=>({ok:true,json:async()=>({app:'prompt-workbench',version:'new'})})}),'restarted');
});
