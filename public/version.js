// 版本号与侧栏标语的单一来源。
// 浏览器端 app.js 与 Node 端 server.js 共同 import；
// scripts/check.mjs 断言此 VERSION 与 package.json.version 一致，漏改会被拦住。
export const VERSION='0.4.1-beta.1';
export const SLOGAN='让每一次灵感都有去处';
