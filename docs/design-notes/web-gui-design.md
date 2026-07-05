# Web GUI 设计（`council serve` 本地 Web 控制台）

- **日期**: 2026-07-05
- **状态**: 设计定稿（实施前）
- **关联任务**: #28（本设计）→ #29（server 层）/ #30（前端）
- **触及接口契约**: 无 core 接口变更（关键结论，见决策 3）。新增 `src/server/` 层与 `web/` 前端，复用 `types/renderer.ts` 的 `Renderer` 接口作为唯一接入点。

---

## 1. 背景与范围

产品决策已定：形态为**本地 Web GUI**——`council serve` 启动一个绑定 `127.0.0.1` 的 HTTP 服务，浏览器访问。

**MVP 范围（仅此三项）**：
1. **发起辩论**：表单填问题 + 选模式/模型 → 提交。
2. **实时观看**：多专家流式发言 → 评审 → 共识 → Chairman 综合，逐阶段实时呈现。
3. **历史会话只读列表**：列出过往 session，点开只读详情。

**明确不做**：配置向导（仍走 CLI `council setup`）、编辑/删除会话、鉴权、多用户、远程访问。

**设计的核心支点**：`Orchestrator` 通过依赖注入接收一个 `Renderer`（`src/types/renderer.ts`）。CLI 注入 `PlainRenderer`/`TuiRenderer`；GUI 只需注入一个 **`WebRenderer`**，把 7 个回调转成 SSE 事件推给浏览器。**core 零改动**即可支撑 GUI——这是整套设计能保持轻量与合规的根因。

---

## 2. 决策记录（结论 / 理由 / 被否选项）

### 决策 1 — HTTP 框架：采用 **hono + @hono/node-server**

- **结论**：新增两个依赖 `hono`（核心零传递依赖）与 `@hono/node-server`（Node 适配）。
- **理由**：
  - API 面虽小（5 条路由），但真正麻烦的是三件事：**静态资源目录托管**（`web/` 多文件 + 正确 MIME）、**路径遍历防护（SEC-04）**、**SSE 流 + JSON body 解析**。手写安全的静态托管正是团队警告的"路由地狱"，且极易踩 SEC-04。
  - hono 的 `serveStatic` 提供经过审计的安全静态托管；`streamSSE` 提供一等的 SSE 支持；路由 `:param` 匹配干净；类型完备。核心包 gzip ~14KB、**零运行时传递依赖**。
  - 让 `serve` 命令与 `src/server/` 都能保持精简，不为省一个依赖去重造安全轮子。
- **被否**：
  - **Node 内置 `http`**：为省依赖而手写静态托管 + 遍历防护 + body 解析 + SSE 头，正是要避免的样板与 SEC-04 风险。否。
  - **fastify**：插件体系与 schema 编译对本 MVP 过重，传递依赖多。否。
  - **express**：回调式、体积大、维护态一般，无原生 ESM/流式优势。否。

### 决策 2 — 流式传输：**SSE**（Server-Sent Events）

- **结论**：用 SSE，不用 WebSocket。事件类型与 `Renderer` 方法一一映射（见 §4）。
- **理由**：
  - 交互模式是"**POST 发起 + 单向进度流**"，天然单向 server→client，SSE 完美契合。
  - SSE 走普通 HTTP，无 upgrade 握手；`EventSource` **自带断线重连**并在重连时携带 `Last-Event-ID`，与我们的事件回放（决策 3）无缝配合。
  - WebSocket 的双向能力在 MVP 里用不到，反而多一套帧协议与连接生命周期管理。
- **被否**：**WebSocket**——双向能力过剩、复杂度更高、无自带 Last-Event-ID 语义。将来若要"观众向进行中辩论插话/打断"再评估。

### 决策 3 — WebRenderer + 服务端 `debateId`（避免 core 破坏性变更）

- **结论**：
  - `WebRenderer implements Renderer`，把回调转成事件写入该辩论的内存 **EventLog**。
  - **服务端自生成 `debateId`** 作为实时流的键，**不复用/不注入** `Orchestrator` 内部生成的 `session_id`。
- **理由（关键架构判断）**：
  - `Orchestrator.run()` 在 `createSession()` **内部**生成 `session_id`，POST 返回时该 id 尚不存在；而 EventLog 必须在 `run()` 启动前就以某个键注册好（否则早期事件无处可存 / 订阅有竞态）。
  - 若改成"外部注入 session_id"，需修改 `RunOptions` / `createSession` 语义（`RunOptions.sessionId` 目前专用于 resume，复用会造成语义重载）——**这是对 core 的破坏性变更，MVP 不值当**。
  - 因此服务端生成独立 `debateId`：实时流键为 `debateId`，辩论完成后终态 `result` 事件携带完整 `Session`（含其 `session_id`），前端据此跳转到历史详情。**core 零改动**。
  - 内存 EventLog 天然消除"POST 返回→前端 EventSource 订阅"之间的事件丢失竞态：订阅时从 buffer 回放 id > Last-Event-ID 的事件。
- **并发路由**：`DebateManager` 持有 `Map<debateId, EventLog>`，支持多辩论并发；每个 `WebRenderer` 绑定一个 `debateId`。
- **断线重连 / 回放策略**：
  - 每个 EventLog 为事件分配**单调递增整数 id**（SSE `id:` 字段）。重连时 `EventSource` 发 `Last-Event-ID`，SSE handler 回放 `id > lastEventId` 的缓冲事件后转入实时订阅。
  - **驱逐策略（内存有界）**：事件分两类——
    - **生命周期事件**（phase / agent_start / agent_complete / consensus / degradation / result / error）：**保留**，是回放正确性的基础。
    - **进度事件**（agent_progress 流式 chunk）：**可丢弃**。当单辩论缓冲字节超过阈值（建议 4 MB）时，从最旧的 progress 事件开始丢弃——因为每个 agent 的完整文本最终由权威的 `agent_complete` 携带，进度 chunk 只是"打字机"体验，丢失不影响正确性。
  - 辩论**完成后保留 buffer TTL 5 分钟**供迟到重连回放，随后驱逐。命中已驱逐/不存在的 `debateId` → SSE handler 返回 404，前端降级到 `GET /api/sessions/:id` 读取已持久化的完整会话。
- **被否**：注入 session_id 到 core（破坏性、语义重载）；无缓冲直连（订阅竞态、无法回放）。

### 决策 4 — REST API 最小集（5 条）

见 §5 完整契约。最小集：
- `POST /api/debates` — 发起，返回 `{ debateId }`（202）。
- `GET /api/debates/:debateId/events` — SSE 实时流。
- `GET /api/sessions` — 历史列表（复用 `SessionStore.listSessions`）。
- `GET /api/sessions/:id` — 历史详情（复用 `SessionStore.getSession`）。
- `GET /api/models` — 可用模型 + 模式枚举，供发起表单渲染（复用 `assemble.resolveModels`）。**只返回名称/元数据，绝不返回凭证**。

**理由**：`/api/models` 是发起表单的必要输入（否则表单无从渲染模型选项），故纳入最小集。历史两条直接复用既有 `SessionStore`，零新逻辑。`debates`（进行中）与 `sessions`（已持久化）命名分离，语义清晰：辩论完成即成为 session。

### 决策 5 — 前端栈：**零构建**（原生 ES modules + petite-vue + 本地 vendored 库）

- **结论**：不引入 Vite/React 构建链。`web/` 为纯静态源码，服务端直接托管：
  - 响应式 DOM：**petite-vue**（~6KB，声明式绑定，无构建步骤），本地 vendored 到 `web/vendor/`。
  - Markdown 渲染：**marked**（ESM 单文件）+ **DOMPurify**（ESM 单文件）净化，二者均本地 vendored。
  - 无 CDN、无 import-map 外链——本地工具应**离线可用且不外泄**。
- **理由**：
  - MVP 就是"一个发起表单 + 一个事件流视图 + 一个历史列表"，复杂度低，不值当引入第二套构建管线。
  - 项目现有 `react` 依赖是给 **ink（终端 TUI）** 用的，`tsup.config.ts` 把它标为 external、**不为浏览器打包**。为 GUI 复用它需引入 Vite + `web/dist` 产物 + 双构建协调，与"降低使用门槛"目标背道而驰。
  - 零构建 = 只保留一套构建（tsup 编译服务端 TS），`pnpm build` 不变；`web/` 原样发布。维护成本最低。
  - `ui/markdown.ts` 是**终端向**（ANSI 转义），浏览器不可复用——必须另选浏览器 markdown 方案，marked 是标准选择。
- **安全（净化）**：LLM 输出可能含 `<img onerror>` 等。marked 不做净化 → 渲染前必过 DOMPurify。虽为本地单用户，SEC 立场要求默认净化，不留 XSS 口子。
- **被否**：
  - **Vite + React**：双构建、React 重回浏览器依赖、`web/dist` 产物协调，MVP 过重。否。
  - **CDN / import-map 外链**：破坏离线性与隐私（本地工具不应向外部发请求）。否。
  - **纯手写 DOM 无微库**：事件流驱动的增量更新用声明式绑定更省心，petite-vue 成本极低。可接受但不首选。

### 决策 6 — 目录与分层

```
src/server/                 新增层：可依赖 core / storage / config / providers / commands.shared；禁止被它们反向依赖
  app.ts                    createApp(deps): Hono —— 纯装配，可测试（不监听端口）
  debate-manager.ts         Map<debateId, EventLog>；startDebate()：装配 Orchestrator + WebRenderer，run→save→emit result
  event-log.ts              单辩论事件缓冲 + 订阅者集合 + 单调 id + 回放 + 驱逐
  web-renderer.ts           implements types/renderer.ts 的 Renderer，回调 → EventLog.push
  protocol.ts               线协议 TS 类型（server 私有契约，见 §4）
  routes/
    debates.ts              POST /api/debates, GET /api/debates/:id/events
    sessions.ts             GET /api/sessions, GET /api/sessions/:id
    models.ts               GET /api/models
  security.ts               Host/Origin 校验中间件（决策 7）

src/commands/serve.ts       薄命令 ≤150 行：解析 opts → 装配 deps → 启动服务 → 打开浏览器
web/                        前端源码（零构建静态资源）
  index.html  app.js  styles.css
  vendor/{petite-vue.es.js, marked.esm.js, purify.es.js}
```

- **构建产物去向**：前端零构建，**无产物**——服务端以 `web/` 为静态根直接托管。运行期用 `new URL('../web', import.meta.url)` 从 `dist/cli.js` 解析到包根的 `web/`（dev 与安装态一致）。
- **打包缺口（须在 #29 修复）**：`package.json` 目前**无 `files` 字段**。发布 npm 包时必须显式加入 `"files": ["dist", "bin", "web", "defaults"]`，否则 `web/` 不会随包发布。
- **ARCH 合规声明**：
  - **ARCH-01**：`core/` 完全不动，不引入任何 I/O。`server/` 通过 hono/node-server 间接用 `node:http` —— server 非 core，合规。
  - **ARCH-02**：core 不 import server（单向）。server 位于 core 之外的外层，允许依赖 core/storage/config/providers。✓
  - **ARCH-03**：`commands/serve.ts` ≤150 行，业务逻辑全部委托 `src/server/`。✓
  - **ARCH-04**：`server/protocol.ts` 含运行时类型？—— **否**，纯 `interface`/`type` 定义，无运行时代码；但它在 `server/` 而非 `types/`（见决策 8）。✓
  - **ARCH-05**：GUI 经 `Renderer` 接口接入 core（依赖倒置），不直接耦合具体编排实现。✓

### 决策 7 — 安全边界

- **默认绑定 `127.0.0.1`**（仅环回）。提供 `--host` 覆盖，但覆盖时向 stderr 打印显著警告（暴露到网络）。
- **无鉴权**——本地单用户工具的既定边界，README 显式声明。
- **CORS 不开**：不设任何 `Access-Control-Allow-*`，仅同源。
- **DNS-rebinding / CSRF 防护（廉价且必要）**：`security.ts` 中间件对**所有请求**校验 `Host` 头 ∈ `{localhost, 127.0.0.1}:<port>`；对**状态变更请求**（`POST /api/debates`）额外校验 `Origin` 同源。恶意网页即便诱导浏览器打 `localhost` 也会被 Host/Origin 校验挡下。
- **凭证绝不过 API（SEC-02）**：
  - 服务端用 `assemble.discoverCredentials/buildAdapter` 在**服务端**装配 adapter，凭证只存在于服务端进程内存，API 从不返回 token/key。
  - `GET /api/models` 只返回 `name / provider / capabilities / invocation` 等元数据。
  - **已核实**：`ModelConfig` 只含 `api_key_env`（环境变量**名**，非密钥值），故 `Session` JSON / `AgentDTO` 均不含真实凭证。即便如此，DTO 仍采用**最小字段**（见 §4 `AgentDTO`），不外泄 `config` 全量内部结构。
- **SEC-04**：静态资源一律经 hono `serveStatic`，不手写路径拼接。
- **SEC-03/07**：GUI 发起的辩论默认持久化（走既有 `SessionStore.saveSession`，已 `mode:0o600`）。MVP 暂不暴露 `--no-store`（可作后续项）。

### 决策 8 — 事件 payload 类型放 `server/protocol.ts`（非 `types/`）

- **结论**：线协议 payload 的 TS 类型定义在 **`src/server/protocol.ts`**（server 私有），**不放 `src/types/`**。
- **理由**：
  - `types/` 的定位是**跨层**核心契约（如 `Renderer` 是 core↔ui 的桥）。而 Web 线协议只被 **server（生产）↔ browser（消费）** 共享，**core 完全不感知**——它不是跨核心层的契约，放进 `types/` 会污染核心类型命名空间。
  - 前端零构建、不参与 TS 编译，运行时并不 `import` 这些类型；它们的价值在于**服务端单一真相源 + 文档化线格式**。故归属 server 私有最自然。
  - `protocol.ts` 可以 `import type` `types/` 里的领域类型（`ConsensusResult`/`DegradationEvent`/`Session` 等）——server 是外层，向内依赖合规。
- **被否**：放 `types/`（污染核心命名空间、错配定位）；在前后端各写一份（真相源分裂）。前端侧以本设计 §4 的线格式为准，把事件当带文档形状的普通 JS 对象消费。

---

## 3. 模块依赖图

```
                         ┌──────────────────────────┐
   browser (web/)  ◀─SSE─│  src/server/              │
        │  fetch/EventSource   app.ts / routes/*     │
        │                │     debate-manager.ts     │
        ▼                │     web-renderer.ts ──────┼──implements──▶ types/renderer.ts (Renderer)
   commands/serve.ts ───▶│     event-log.ts          │
   (≤150行, 薄)          │     protocol.ts ──import type──▶ types/{session,provider,config}
                         └──────┬────────────┬───────┘
                                │            │
                 ┌──────────────▼──┐   ┌─────▼───────────────┐
                 │ commands/shared │   │ storage/SessionStore│  (WAL, 复用既有)
                 │ .assemble       │   └─────────────────────┘
                 │ (creds/models)  │
                 └──────┬──────────┘
                        │ 注入 adapter + Renderer
                 ┌──────▼───────────────┐
                 │ core/Orchestrator     │  ← 零改动，只多了一个 Renderer 实现
                 │ (ARCH-01: 无 I/O)     │
                 └───────────────────────┘

依赖方向：server → {core, storage, config, providers, commands.shared, types}
          core ↛ server（严格单向，ARCH-02）
```

---

## 4. 线协议（`src/server/protocol.ts`，权威 TS 定义）

事件与 `Renderer` 方法一一映射，外加 `debate_start` / `error` 两个服务端注入的终态相关事件。心跳用 SSE 注释行（`:hb\n\n`，不占用事件 id）。

```typescript
// src/server/protocol.ts — 线协议（server 私有契约）。纯类型，无运行时代码（ARCH-04）。
import type { DebatePhase, DegradationEvent, ConsensusResult, Session } from '../types/session.js';

/** SSE 事件类型枚举（与 Renderer 方法一一映射 + 生命周期）。 */
export type DebateEventType =
  | 'debate_start'    // 服务端注入：流的第一个事件
  | 'phase'           // Renderer.onPhaseStart
  | 'agent_start'     // Renderer.onAgentStart
  | 'agent_progress'  // Renderer.onAgentProgress（可丢弃）
  | 'agent_complete'  // Renderer.onAgentComplete
  | 'consensus'       // Renderer.onConsensus
  | 'degradation'     // Renderer.onDegradation
  | 'result'          // Renderer.renderResult —— 终态（成功）
  | 'error';          // 服务端注入 —— 终态（异常）

/**
 * 精简 Agent 传输对象。刻意不透传 Agent.config（ModelConfig）全量，
 * 只给渲染必需字段（SEC-02 payload 卫生）。
 * 注意：agentId 可能是编排哨兵值 '__review__' / '__synthesis__'，
 * 前端据此把评审/综合分别归入独立面板。
 */
export interface AgentDTO {
  agentId: string;
  role: string;              // 形如 "🔬 研究员"
  roleDescription: string;
  modelName: string;
  isChairman: boolean;
  isDevilAdvocate: boolean;
}

/** 精简调用结果传输对象（省略 stderr 等诊断字段）。 */
export interface InvocationResultDTO {
  response: string;
  elapsedMs: number;
  invocationMode: 'cli' | 'api';
  timedOut: boolean;
  truncated?: boolean;
  tokenUsage?: { inputTokens: number; outputTokens: number };
}

// —— 各事件 payload —— //
export interface DebateStartPayload { debateId: string; question: string; mode: string; }
export interface PhasePayload { phase: DebatePhase; index: number; total: number; }
export interface AgentStartPayload { agent: AgentDTO; }
export interface AgentProgressPayload { agentId: string; role: string; chunk: string; }
export interface AgentCompletePayload { agent: AgentDTO; result: InvocationResultDTO; }
export interface ConsensusPayload { consensus: ConsensusResult; }
export interface DegradationPayload { event: DegradationEvent; }
/** 终态成功：携带完整持久化 Session（含 session_id，供前端跳历史详情）。 */
export interface ResultPayload { session: Session; }
/** 终态异常。 */
export interface ErrorPayload { message: string; }

/** 判别联合，data 随 type 变化。 */
export type DebateEvent =
  | { type: 'debate_start';   data: DebateStartPayload }
  | { type: 'phase';          data: PhasePayload }
  | { type: 'agent_start';    data: AgentStartPayload }
  | { type: 'agent_progress'; data: AgentProgressPayload }
  | { type: 'agent_complete'; data: AgentCompletePayload }
  | { type: 'consensus';      data: ConsensusPayload }
  | { type: 'degradation';    data: DegradationPayload }
  | { type: 'result';         data: ResultPayload }
  | { type: 'error';          data: ErrorPayload };
```

**SSE 线格式**（每帧）：
```
id: <单调整数>
event: <DebateEventType>
data: <JSON.stringify(payload)>
\n
```
心跳（不占 id）：`:hb\n\n`，每 15s 一次。

**终态语义**：前端收到 `result` 或 `error` 后**主动 `eventSource.close()`**（避免 EventSource 在流结束后自动重连）。服务端在辩论已终态且缓冲未驱逐时，对新连接**回放全部事件 + 终态事件后正常结束**；缓冲已驱逐则该 SSE 路由返回 404，前端降级到 `GET /api/sessions/:id`。

**droppable 语义**：仅 `agent_progress` 可被驱逐；其完整文本由 `agent_complete.result.response` 权威承载，故回放缺失早期 chunk 不影响正确性。

---

## 5. REST API 契约

| 方法 | 路径 | 请求 | 响应 | 复用 |
|------|------|------|------|------|
| POST | `/api/debates` | `{ question: string, mode?: 'quick'\|'compare'\|'debate'\|'auto', models?: string[], chairman?: string, devilAdvocate?: boolean, roleSet?: string }` | `202 { debateId: string }` | `assemble.*` + `Orchestrator` + `WebRenderer` |
| GET | `/api/debates/:debateId/events` | `Last-Event-ID` 头（可选，重连用） | `text/event-stream`（见 §4）；未知/已驱逐 `debateId` → `404` | `EventLog` |
| GET | `/api/sessions` | query `?limit&mode&offset` | `200 { sessions: SessionSummary[] }` | `SessionStore.listSessions` |
| GET | `/api/sessions/:id` | — | `200 { session: Session }` / `404` | `SessionStore.getSession` |
| GET | `/api/models` | — | `200 { models: {name,provider?,capabilities,invocation}[], modes: string[], defaultChairman?: string }` | `assemble.resolveModels` |

- `POST /api/debates`：校验 body（zod）→ 生成 `debateId` → `DebateManager.startDebate()`（**不 await 编排完成**，立即 202 返回）→ 编排在后台跑，事件流经 SSE 输出。
- `SessionSummary`：列表用精简投影（`session_id / question 预览 / resolved_mode / status / consensus_score / created_at / user_rating`），避免整表回传大 JSON。可在 `SessionStore` 增一个 summary 查询或复用 `listSessions` 后在 route 里投影（route 薄，投影逻辑属展示层，可接受）。

---

## 6. 关键接口（`src/server/` 内部，非跨核心层契约）

```typescript
// event-log.ts
export interface EventLogSubscriber { (event: DebateEvent, id: number): void; }
export class EventLog {
  push(event: DebateEvent): number;                      // 分配 id、入缓冲、广播、按需驱逐 progress
  replayFrom(lastEventId: number | null, fn: EventLogSubscriber): void;
  subscribe(fn: EventLogSubscriber): () => void;         // 返回退订函数
  markTerminal(): void;                                  // 启动 TTL 驱逐计时
  readonly terminal: boolean;
}

// web-renderer.ts —— 唯一 core 接入点
export class WebRenderer implements Renderer {           // types/renderer.ts
  constructor(private log: EventLog) {}
  // 7 个回调 → this.log.push({ type, data })；Agent/InvocationResult → DTO 映射在此完成
}

// debate-manager.ts
export class DebateManager {
  startDebate(input: StartDebateInput): string;          // 返回 debateId；内部装配 + 后台 run
  getLog(debateId: string): EventLog | undefined;
}
```

`DebateManager.startDebate` 时序：生成 `debateId` → 建 `EventLog` → push `debate_start` → 装配 `Orchestrator(adapter, new WebRenderer(log), models, …)` → **后台** `await run()` → `saveSession()`（除非 noStore）→ `log.push({type:'result', session})` → `log.markTerminal()`；`run` 若抛异常则 push `error` 后 `markTerminal()`。

---

## 7. 与 CLI 的 SQLite 并发

- serve 是**长驻进程**，持有一个 `better-sqlite3` 连接（WAL、`busy_timeout=5000`，见 `database.ts`）。CLI 每次运行是**独立进程 + 独立连接**。
- WAL 允许**多读者 + 单写者**并发：GUI 读历史 / CLI 写会话可并行，不互斥。GUI 与 CLI 同时写（各自 `saveSession` 的 `INSERT OR REPLACE`）由 `busy_timeout` 串行化，本地低频写入下足够。
- 跨进程的**模型并发额度**由既有 `storage/concurrency.ts`（`resource_slots` 表 + `BEGIN IMMEDIATE`）协调：GUI 发起的辩论与 CLI 辩论**共享同一全局并发池**，不会过量占用模型。
- **结论：既有 storage 并发设施足够，本 MVP 无需改动。** 唯一注意点：serve 进程退出时须 `SessionStore.close()` 释放连接（serve 命令注册 `SIGINT/SIGTERM` 优雅关闭）。

---

## 8. 工作项拆分建议

**契约先行，然后 #29 / #30 完全并行。** 本设计 §4（`protocol.ts` 事件类型）+ §5（REST 契约）即冻结的接口契约，冻结后两侧可独立开发，Step 2.5 集成。

| 工作项 | 负责 | 内容 | 依赖 | 粒度 |
|--------|------|------|------|------|
| **#29 server 层** | `@cli-dev`（server 属命令/装配域） | `src/server/*`（app/routes/debate-manager/event-log/web-renderer/protocol/security）+ `commands/serve.ts` + `cli.ts` 注册 `serve` + `package.json` 加 `files` 字段 + 依赖 hono/@hono/node-server | 本设计（契约） | 批量流 |
| **#30 前端** | `@cli-dev` | `web/*`（index.html/app.js/styles.css）+ vendored petite-vue/marked/DOMPurify + 三视图（发起表单 / 实时观看 / 历史列表+详情） | 本设计（§4 线格式 + §5 REST） | 批量流 |
| **#31 集成 + 文档** | Step 2.5 集成 + `@doc-keeper` | 端到端冒烟（真起 serve、发起一场辩论、SSE 回放、历史）；README 增 `council serve` 用法；TDD 增 `src/server/` 层与接口 | #29 #30 | — |

- **能否完全并行**：能。#30 用 §4 的静态事件 fixture（一段录制的 `DebateEvent[]` JSON）驱动 UI 开发，不依赖真实 server。#29 用 `curl`/EventSource 手测。集成在 #31。
- **`@architect` 复审触发点**：`WebRenderer` 严格实现现有 `Renderer`，**不改接口**；若实现中发现 `Renderer` 不足以表达 GUI 所需（例如需要 `onSessionStart` 或结构化的 review 逐条事件），**暂停并回 `@architect`**——那将是 ARCH-05 接口变更，需走破坏性变更流程（同步所有 Renderer 实现：Plain/Tui/Web）。

---

## 9. 遗留与后续（非 MVP）

- `--no-store` 支持（SEC-07 对齐，GUI 发起的临时辩论）。
- URL token / 轻量鉴权（若将来 `--host` 暴露到局域网）。
- 观众向进行中辩论"打断/追问"（届时重估 SSE→WebSocket）。
- `agent_progress` 缓冲阈值调参 / 会话结束后事件落盘以支持任意时刻回放。
