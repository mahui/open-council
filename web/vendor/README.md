# Vendored front-end libraries

零构建策略（web-gui-design 决策 5）：前端不引入 Vite/构建链，第三方库以单文件 ESM
形式本地 vendored，**离线可用、不外链 CDN**。升级时重新下载对应版本单文件并更新下表。

| 文件 | 库 | 版本 | 用途 | 来源 |
|------|----|------|------|------|
| `petite-vue.es.js` | petite-vue | 0.4.1 | 声明式响应式 DOM 绑定 | unpkg.com/petite-vue@0.4.1/dist/petite-vue.es.js |
| `marked.esm.js` | marked | 12.0.2 | Markdown → HTML | cdn.jsdelivr.net/npm/marked@12.0.2/lib/marked.esm.js |
| `purify.es.js` | DOMPurify | 3.1.6 | HTML 净化（XSS 硬红线，SEC） | cdn.jsdelivr.net/npm/dompurify@3.1.6/dist/purify.es.mjs |

导出约定：
- petite-vue → `{ createApp, reactive, nextTick }`
- marked → `{ marked, parse, ... }`
- DOMPurify → `default`

> LLM 输出的 markdown 一律先 `marked.parse()` 再 `DOMPurify.sanitize()` 才写入 DOM。
> 见 `web/md.js`。

## 本地补丁

- `petite-vue.es.js`（0.4.1）：任务调度 flush（原 `Ft`）加 try/catch/finally。上游实现中任一 effect 抛错会让 `queued` 标志永久卡死，整个应用的响应式静默冻结（表现为"页面卡在初始状态、无任何报错"）。补丁改为 console.error 上报并自愈。升级 vendored 版本时需重新应用（搜 `job flush error`）。
