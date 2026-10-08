# 提示词工坊

默认中文。先读README.md、docs/PRD.md、docs/STATUS.md、docs/adr和CONTEXT.md。
Node.js 24+，原生ESM、内置SQLite、浏览器原生模块，生产运行零第三方依赖。
私人数据、密钥密文、日志、模型、备份及工作证据不得提交。Windows密钥必须使用当前用户DPAPI。
生命周期串行控制，只停止自有进程，不改变外部模型配置。生成仅由用户明确发起，失败不自动重发。
不直接暴露公网；不在正式数据环境执行外部PR。
执行npm run check、npm test、npm run check:release、npm run test:smoke；界面变更执行npm run test:ui。
需求与规范分别审查。功能/证据边界更新docs/STATUS.md；数据变更附迁移/恢复说明。
协作规则见CONTRIBUTING.md，安全报告见SECURITY.md，发布见docs/MAINTENANCE.md。
