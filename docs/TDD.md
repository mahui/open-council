# Open Council — 技术设计文档 (TDD)

**Technical Design Document v3.1**

| 项目 | 内容 |
|------|------|
| 文档状态 | Draft |
| 版本 | 3.1 |
| 日期 | 2026-07-06 |
| 对应 PRD | docs/PRD.md v8.1 |
| 主语言 | TypeScript (Node.js ≥ 20) |
| 包管理 | pnpm |
| 分发方式 | npm 全局包 (`npm install -g @open-council/cli`) |

**修订记录**

| 版本 | 日期 | 变更 |
|------|------|------|
| 3.1 | 2026-07-06 | 模型配置流程改进（§2、§3.4、§7.1）：`discoverModels(credentials)` 走 CredentialManager，新增 `discoverEndpointModels`（自定义端点发现）、`CredentialManager.resolveOfficialKey(protocol)`、`ConfigLoader.deleteModelConfig(name)`；`rateModelCapability` 及 flagship/推荐规则（`MODEL_TIER_RULES`/`flagshipRank`/`isRecommendedModel`）归位 `shared/model-catalog.ts`，消除 providers/ui→core 反向边；`commands/models.ts` 拆分为 `commands/models/`。设计依据：`design-notes/model-config-flow.md` |
| 3.0 | 2026-07-06 | **标准 API 收敛**：移除 `@mariozechner/pi-ai`，改用官方 `@anthropic-ai/sdk` + `openai`；删除 CLI/Auto 适配器、OAuth 凭证发现、provider 家族映射；新增 `providers/protocol/`（ProtocolClient 双 SDK）与 `config/migrate.ts`；ModelConfig 升 v2（`protocol` 取代 `invocation`+`provider`）。设计依据：`design-notes/standard-api-convergence.md` |
| 2.3 | 2026-07-05 | §8.4 增设置面五条 REST 路由（`config-routes.ts`）与 `RuntimeConfig` 热换快照；`ConfigLoader` 增 `loadAllModelConfigs`，纯函数下沉至 `config/assemble-council.ts` + `providers/model-assembly.ts`。详见设计笔记 `docs/design-notes/web-gui-config.md` |
| 2.2 | 2026-07-05 | 新增 `src/server/` 层与 `web/` 零构建前端（`council serve` 本地 Web GUI，见 §8.4）；新增依赖 `hono` + `@hono/node-server`；`WebRenderer` 为 `Renderer` 第三实现。详见设计笔记 `docs/design-notes/web-gui-design.md` |
| 2.1 | 2026-07-04 | 依设计笔记 consensus-review-dataflow 同步实现：`ConsensusResult` 增 `agreement_score`（判停用）；`calculateConsensus` filter 纳入 partial；`kendallsW` 均值秩填补 + N=2 回退；`InvocationResult` 增 `truncated`；补 `role_generator_model` 配置项与 `InvocationTimeoutError` 错误类型 |
| 2.0 | 2026-03-26 | 迁移至 pi-ai 统一 LLM 层 |

---

## 1. 技术选型总览

### 1.1 语言与运行时

| 决策 | 选择 | 理由 |
|------|------|------|
| 语言 | **TypeScript 5.x** | 官方 `@anthropic-ai/sdk` / `openai` 均以 TS 为一等公民；类型安全减少运行时错误 |
| 运行时 | **Node.js ≥ 20** | 原生 `fetch`、`AbortController`、`node:test`；LTS 稳定 |
| 包管理 | **pnpm** | workspace 支持好、磁盘占用小、lockfile 确定性强 |
| 编译 | **tsup** (esbuild) | 编译为单个 CJS bundle，启动速度比 tsc 快 10x+ |

### 1.2 核心依赖

> 与 `package.json` 保持一致（以 `package.json` / 附录 A 为准）。凭证降级为 API key（env / 0o600 文件），无 OAuth / JWT 解码需求，故不引入 `jose` 等依赖（见 §1.3）。

| 模块 | 库 | 版本策略 | 选型理由 |
|------|-----|---------|---------|
| **Anthropic SDK** | `@anthropic-ai/sdk` | ^0.110 | 官方 Anthropic API 客户端（`messages.create`）；覆盖官方及 anthropic 兼容端点（`baseURL`）；结构化 `APIError`、原生 `AbortSignal` |
| **OpenAI SDK** | `openai` | ^6.45 | 官方 OpenAI API 客户端（`chat.completions.create`）；`baseURL` 覆盖一切 OpenAI 兼容端点（DeepSeek / Ollama / vLLM 等） |
| **CLI 框架** | `commander` | ^12 | 命令解析、子命令、选项管理；最成熟的 Node CLI 框架 |
| **交互式 Prompt** | `@inquirer/prompts` | ^7 | Setup Wizard 的多选、确认、列表选择；模块化按需导入 |
| **TUI 仪表盘** | `ink` (+ `react`) | ^7 | React 范式渲染终端 UI；组件化、声明式更新、天然支持实时刷新 |
| **Web 服务器** | `hono` + `@hono/node-server` | ^4 / ^2 | `council serve` 本地 Web GUI：经审计的安全静态托管（`serveStatic`，SEC-04）、一等 SSE 支持（`streamSSE`）、干净的路由；核心零传递依赖 |
| **SQLite** | `better-sqlite3` | ^12 | **同步 API**（事务原子性保证）；WAL 模式；FTS5 支持；原生 C binding 性能优异 |
| **YAML** | `yaml` (eemeli/yaml) | ^2 | 完整 YAML 1.2；保留注释（用户手编配置不丢注释） |
| **Schema 校验** | `zod` | ^3 | 配置文件校验、API 响应校验；TS 类型推导一体化 |
| **测试** | `vitest` | ^2 | 与 TypeScript 零配置集成；watch mode 快；内置 mock/spy |

### 1.3 不引入的依赖（及理由）

| 库 | 不选理由 |
|----|---------|
| `@mariozechner/pi-ai` | 标准 API 收敛后只剩 anthropic/openai 两协议，pi-ai 的 20+ Provider 适配与 OAuth 价值不再；直接用官方 SDK 更直白、错误结构化、类型一等公民（见 `design-notes/standard-api-convergence.md`） |
| `@google/genai` | Gemini 走其 OpenAI 兼容端点（`openai` SDK + `base_url`），无需专用 SDK |
| `jose` | 无 OAuth / JWT 场景（凭证降为 API key），无需 JWT 解码 |
| `axios` | Node 20 原生 `fetch` 已足够；两 SDK 内部已封装 HTTP |
| `knex` / `drizzle` | SQLite 查询简单（< 10 种 query），直接用 `better-sqlite3` 的 prepared statement，无需 ORM 抽象 |
| `blessed` / `neo-blessed` | 过时，API 复杂；`ink` 的 React 范式更易维护 |
| `chalk` | `ink` 内置颜色支持；CLI 输出少量颜色用 ANSI 常量即可 |
| `ora` | spinner 逻辑简单，自行实现 < 20 行，避免多余依赖 |

### 1.4 分发策略

```bash
# 主分发渠道：npm 全局安装
npm install -g @open-council/cli

# 零安装试用
npx @open-council/cli "Redis vs Memcached 怎么选?"

# 开发者本地
pnpm install && pnpm build
node dist/cli.js "question"
```

**打包产物**：`tsup` 将所有 TS 源码编译为单个 `dist/cli.js`（CJS bundle），Provider SDK 和 `better-sqlite3` 等原生模块作为 external 依赖。`package.json` 的 `bin` 字段指向 `dist/cli.js`。

**原生模块处理**：`better-sqlite3` 包含 C++ addon，通过 npm 安装时自动编译。对于不想编译的用户，提供 prebuilt binaries（`prebuild-install`）。

---

## 2. 项目结构

```
council/
├── package.json
├── pnpm-lock.yaml
├── tsconfig.json
├── tsup.config.ts                  # 构建配置
├── vitest.config.ts                # 测试配置
│
├── src/
│   ├── cli.ts                      # 入口：#!/usr/bin/env node + commander 注册
│   │
│   ├── commands/                   # CLI 命令实现（每个文件对应一个子命令）
│   │   ├── council.ts                # 主命令 council "question"
│   │   ├── setup.ts                  # council setup
│   │   ├── models/                   # council models 子命令族（各文件一命令 + 纯 mutation）
│   │   │   ├── list.ts                 # models（默认）/ list：含已禁用模型（✓/✗）
│   │   │   ├── check.ts                # models check：健康检查 + 熔断重置
│   │   │   ├── add.ts                  # models add：官方发现 / 自定义端点（交互，需 TTY）
│   │   │   ├── manage.ts               # models remove / enable / disable 处理器（提示 + 退出码）
│   │   │   ├── mutations.ts            # 纯注册表变更（add/remove/setEnabled，注入 ConfigLoader）
│   │   │   └── shared.ts               # requireConfiguredLoader 等命令共用工具
│   │   ├── benchmark.ts              # council benchmark
│   │   ├── history.ts                # council history / show / recall / thread
│   │   ├── stats.ts                  # council stats
│   │   ├── rate.ts                   # council rate
│   │   ├── replay.ts                 # council replay
│   │   ├── serve.ts                   # council serve（薄命令：装配 deps → 启动 server）
│   │   └── export.ts                 # council export
│   │
│   ├── core/                       # 核心编排引擎（纯逻辑，不依赖 CLI/UI）
│   │   ├── orchestrator.ts           # 辩论流程编排状态机
│   │   ├── router.ts                 # 路由引擎：模式判定 + Agent 席位分配
│   │   ├── consensus.ts              # 共识度计算（Kendall's W + model_diversity_factor）
│   │   ├── anonymizer.ts             # Review 阶段三层匿名化
│   │   ├── compression.ts            # Pre-Synthesis Compression
│   │   ├── prompt-builder.ts         # 各阶段 prompt 模板构建
│   │   └── score-parser.ts           # Review JSON 评分解析 + fallback
│   │
│   ├── providers/                  # 标准 API 调用适配层
│   │   ├── api-adapter.ts            # ApiAdapter implements InvocationAdapter：可靠性骨架（超时/重试/熔断/截断）
│   │   ├── protocol/                 # SDK 差异下沉：ProtocolClient 双薄客户端
│   │   │   ├── types.ts                # ProtocolClient / GenRequest / NormalizedResult 契约
│   │   │   ├── anthropic-client.ts     # @anthropic-ai/sdk 客户端（messages.create）
│   │   │   ├── openai-client.ts        # openai SDK 客户端（chat.completions.create）
│   │   │   └── index.ts                # makeProtocolClient 工厂（按 protocol/baseURL/key）
│   │   ├── error-classifier.ts       # SDK APIError.status → InvocationError 分类
│   │   ├── model-discovery.ts        # 官方 /models 端点发现（无 key 回退硬编码目录）
│   │   ├── model-assembly.ts         # 发现结果 → ModelConfig 装配 + 命名去重
│   │   ├── credentials/
│   │   │   └── discovery.ts            # CredentialManager 薄壳：env key 探测 + key 文件存在性
│   │   └── health.ts                 # 本地可用性判断 + 熔断器 + 自适应节流
│   │
│   ├── storage/                    # 持久化层
│   │   ├── database.ts               # SQLite 初始化、迁移、表定义
│   │   ├── session-store.ts          # Session JSON 读写（文件系统）
│   │   ├── checkpoint.ts             # Checkpoint 写入 / 恢复 / 清理
│   │   ├── concurrency.ts            # resource_slots 原子调度
│   │   └── migration.ts              # schema_version 迁移逻辑
│   │
│   ├── config/                     # 配置管理
│   │   ├── loader.ts                 # YAML 加载 + 合并 + 校验（挂载 schema_version<2 迁移）
│   │   ├── schema.ts                 # zod schema（council.yaml + ModelConfig v2 + OFFICIAL_BASE_URL）
│   │   ├── migrate.ts                # schema_version 1→2 纯函数迁移（可转即转，不可转禁用+标注）
│   │   ├── assemble-council.ts       # 装配 CouncilConfig（纯函数）
│   │   ├── presets.ts                # 内置目录预设（官方两协议 + 兼容端点 base_url）
│   │   └── paths.ts                  # 路径常量（~/.council/config、~/.council/credentials 等）
│   │
│   ├── ui/                         # 用户界面层
│   │   ├── tui/                      # ink 组件（Phase 5 TUI 仪表盘）
│   │   │   ├── App.tsx                 # TUI 根组件
│   │   │   ├── Dashboard.tsx           # 辩论进度仪表盘
│   │   │   ├── AgentStatus.tsx         # 单个 Agent 状态行
│   │   │   ├── ConsensusBar.tsx        # 共识度进度条
│   │   │   ├── ConflictSummary.tsx     # Human Gate 冲突摘要视图
│   │   │   └── ReplayView.tsx          # 辩论回放视图
│   │   ├── plain-renderer.ts        # 纯文本进度输出（非 TTY / pipe 场景）
│   │   ├── follow-up.ts             # 追问模式交互 prompt
│   │   └── wizard/                   # Setup Wizard 交互界面
│   │       ├── first-run.ts            # 首次运行引导
│   │       ├── model-add.ts            # 添加模型向导
│   │       └── setup-modules.ts        # 完整配置向导各模块
│   │
│   ├── server/                     # 本地 Web GUI 服务端（council serve；见 §8.4）
│   │   ├── app.ts                    # createApp(deps)：装配 Hono（security → /api → 静态 web/），不监听端口
│   │   ├── routes.ts                 # 五条 REST + SSE 路由（薄传输层）
│   │   ├── debate-manager.ts         # Map<debateId, EventLog>；装配 Orchestrator + WebRenderer 后台跑
│   │   ├── event-log.ts              # 单辩论事件缓冲 + 订阅 + 单调 id + 回放 + 驱逐
│   │   ├── web-renderer.ts           # implements Renderer（第三实现）：回调 → EventLog.push
│   │   ├── protocol.ts               # SSE 线协议 TS 类型（server 私有，纯类型 ARCH-04）
│   │   └── security.ts               # Host/Origin 校验中间件（DNS-rebinding / CSRF 防护）
│   │
│   ├── shared/                     # 跨层、领域无关的纯工具（零 I/O；core 可安全依赖）
│   │   ├── model-catalog.ts          # 离线目录 + 模型家族知识：rateModelCapability / MODEL_TIER_RULES / flagshipRank / isRecommendedModel
│   │   ├── format-model.ts           # 模型行格式化（list / 向导共用）
│   │   ├── config-errors.ts          # 配置错误信息格式化
│   │   ├── match.ts                  # 通用匹配工具
│   │   ├── paths.ts                  # 共享路径辅助
│   │   └── resources.ts              # 内置资源加载
│   │
│   └── types/                      # 共享类型定义
│       ├── session.ts                # Session, Stage, Invocation, Agent
│       ├── config.ts                 # ModelConfig, CouncilConfig, RouteRule
│       ├── provider.ts               # Provider, Credential, InvocationResult
│       └── benchmark.ts              # BenchmarkQuestion, BenchmarkReport
│
├── defaults/                       # 内置默认资源（编译时嵌入）
│   ├── roles/
│   │   ├── default.yaml              # 默认角色集 (analyst, engineer, innovator)
│   │   ├── code-review.yaml          # 代码审查角色集
│   │   └── architecture.yaml         # 架构设计角色集
│   └── benchmark.yaml                # 内置基准测试问题集
│
├── web/                            # 本地 Web GUI 前端（零构建静态资源，随包发布）
│   ├── index.html
│   ├── app.js                       # petite-vue 应用：发起表单 / 实时观看 / 历史列表+详情
│   ├── store.js  transport.js  md.js  styles.css
│   └── vendor/                      # 本地 vendored：petite-vue / marked / DOMPurify（离线、不外链）
│
└── test/                           # 测试镜像 src/ 结构（vitest；无独立 fixtures/ 目录，夹具就地构造/临时目录）
    ├── commands/                   # CLI 命令层
    │   ├── models.test.ts  models-name-guard.test.ts
    │   └── serve.test.ts
    ├── config/                     # 配置加载 / 迁移 / 预设
    │   └── loader.test.ts  migrate.test.ts  presets.test.ts
    ├── core/                       # 编排引擎单元测试
    │   ├── orchestrator.test.ts  orchestrator-agent-bounds.test.ts  orchestrator-coverage-gaps.test.ts
    │   ├── consensus.test.ts  anonymizer.test.ts  router.test.ts  compression.test.ts
    │   ├── prompt-builder.test.ts  score-parser.test.ts  review-aggregator.test.ts  evaluator.test.ts
    │   ├── role-generator.test.ts  chairman-role-gen.test.ts  role-set-override.test.ts
    │   └── language.test.ts  self-review-exclusion.test.ts
    ├── providers/                  # 适配层测试（SDK mock）
    │   ├── api-adapter.sdk.test.ts  error-classifier.test.ts  health.test.ts
    │   ├── model-discovery.test.ts  model-assembly.test.ts
    │   └── credentials/discovery.test.ts
    ├── server/                     # 本地 Web GUI 服务端测试
    │   ├── routes.test.ts  config-routes.test.ts  config-routes-rescan.test.ts
    │   ├── event-log.test.ts  web-renderer.test.ts  security.test.ts
    │   ├── lifecycle.test.ts  reconnect.test.ts  concurrency.test.ts
    │   └── runtime-helpers.ts        # 共享测试辅助（非 .test.ts）
    ├── shared/                     # 跨层纯工具测试
    │   └── model-catalog.test.ts  resources.test.ts
    ├── storage/                    # 持久化测试
    │   └── checkpoint.test.ts  concurrency.test.ts  session-store.test.ts
    ├── integration/                # 集成 / 端到端
    │   └── debate-flow.test.ts  wizard-custom-endpoint-e2e.test.ts
    └── ui/wizard/                  # Setup Wizard 交互测试
        ├── first-run.test.ts  run-quick-setup.test.ts
        ├── collect-custom-providers.test.ts  select-discovered-models.test.ts
        └── verify-model-connectivity.test.ts
```

**关键设计决策**：

- `core/` 是**纯逻辑层**，不依赖 I/O、CLI、UI。它接收抽象的 `InvocationAdapter` 接口，可独立单元测试。
- `shared/` 是跨层、领域无关的纯工具（零 I/O、零编排语义），可被 core / providers / ui / commands 任意层安全依赖（`shared` 仅依赖 `types/`）。模型家族知识（`rateModelCapability` + `MODEL_TIER_RULES` + `flagshipRank` + `isRecommendedModel` + 离线目录 `MODEL_CATALOG`）统一收敛于 `shared/model-catalog.ts`。此前 `rateModelCapability` 位于 `core/role-generator.ts`，被 `providers/model-assembly.ts` 与 `ui/wizard/first-run.ts` 导入，构成 providers→core、ui→core 反向依赖边；下沉至 `shared` 后**两条反向边消除**，`core` 改为 `core→shared`（合法）。
- `providers/` 是唯一与外部系统交互的层（官方 SDK 的 HTTP API 调用、文件系统 key 读取）。无 subprocess 调用点。
- `commands/` 薄层，只负责解析 CLI 参数 → 调用 `core/` → 通过 `ui/` 渲染结果。
- `ui/` 分为 `tui/`（ink 组件，Phase 5）和 `plain-renderer.ts`（Phase 0-4 的纯文本输出），通过 `process.stdout.isTTY` 自动切换。
- `server/` 是 `council serve` 的 HTTP 层，位于 core 之外的外层：可依赖 core/storage/config/providers/commands.shared，**core 严格不反向依赖**（ARCH-02）。它经 `Renderer` 接口接入编排（`WebRenderer`），**core 零改动**即可支撑 Web GUI（见 §8.4 与设计笔记 `web-gui-design.md`）。

---

## 3. 核心抽象与接口设计

### 3.1 Provider 调用适配层

这是系统的关键抽象——编排层只依赖 `InvocationAdapter` 接口，唯一实现是 `ApiAdapter`。**接口契约在标准 API 收敛中保持不变**（ARCH-05），换引擎不动 core。

```typescript
// src/types/provider.ts

export interface InvocationResult {
  response: string;                    // 模型回复的完整文本
  elapsed_ms: number;                  // 调用耗时
  invocation_mode: 'cli' | 'api';     // 新写恒为 'api'；'cli' 仅为读旧 session 的历史兼容
  exit_code?: number;                  // 历史遗留（CLI 退出码）；API 调用不写
  http_status?: number;                // HTTP 状态码
  stderr?: string;                     // 历史遗留（CLI stderr）；API 调用不写
  token_usage?: {                      // token 用量（兼容端点缺失时兜底 0）
    input_tokens: number;
    output_tokens: number;
  };
  timed_out: boolean;
  truncated?: boolean;                 // 回答因达 max_tokens/长度上限被截断（有实质内容，与 timed_out 正交）；缺省 undefined ≡ false
}

// 截断回答照常参与 review/consensus/synthesis，orchestrator 仅发 onDegradation 提示，不剔除、不重试。
// 该字段随 Invocation.result 整体落盘到 Session JSON，无需新增 Invocation 顶层字段（见 PRD §3.4.3）。

export type OnChunk = (chunk: string) => void;

export interface InvocationAdapter {
  /**
   * 调用模型，返回完整响应。传入 onChunk 则走流式（逐 chunk 回调）；不传则非流式。
   * 编排层通过此接口与所有模型交互，无需关心协议差异。
   */
  invoke(config: ModelConfig, prompt: string, onChunk?: OnChunk): Promise<InvocationResult>;

  /**
   * 健康检查（纯本地判断，无网络调用）：api_key_env 有值 / api_key_path 文件存在 / localhost 端点允许空 key。
   */
  healthCheck(config: ModelConfig): Promise<HealthStatus>;
}

export type HealthStatus = {
  level: 'healthy' | 'unhealthy' | 'degraded' | 'unavailable';
  message: string;
  checked_at: string;  // ISO 8601
};
```

> **契约不变，实现层收敛**：`AutoAdapter`（API-first + CLI 回退编排器）与 `CliAdapter`（subprocess）两个实现类**已删除**；`ApiAdapter` 成为唯一实现。原 `new AutoAdapter(new ApiAdapter(cm), new CliAdapter())` 调用点全部改为 `new ApiAdapter(cm)`。**core 层零改动**。

### 3.2 ProtocolClient 抽象（SDK 差异下沉）

api-adapter 不再散落 SDK 细节，而是面向一个协议无关的内部接口编程；两个薄客户端类隔离 `@anthropic-ai/sdk` 与 `openai` 的差异。加第三个协议 = 加一个 ProtocolClient，不动 adapter。

```typescript
// src/providers/protocol/types.ts

export interface NormalizedEvent { textDelta: string; }

export interface NormalizedResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
  truncated: boolean;   // anthropic stop_reason==='max_tokens' | openai finish_reason==='length'
}

export interface GenRequest {
  model: string;
  prompt: string;
  maxTokens: number;
  temperature?: number;
  reasoningEffort?: ReasoningEffort;
  signal: AbortSignal;  // 由 adapter 的空闲超时守卫驱动；两 SDK 原生尊重
}

export interface ProtocolClient {
  /** 流式：逐块回调 textDelta，返回最终归一化结果。 */
  stream(req: GenRequest, onEvent: (e: NormalizedEvent) => void): Promise<NormalizedResult>;
  /** 非流式：一次性归一化结果。 */
  complete(req: GenRequest): Promise<NormalizedResult>;
}

// src/providers/protocol/index.ts
// 工厂：按 (protocol, baseURL, apiKey) 造/复用 client
export function makeProtocolClient(config: ModelConfig, apiKey: string): ProtocolClient;
```

- **AnthropicClient**（`anthropic-client.ts`）：`new Anthropic({ apiKey, baseURL, maxRetries: 0, timeout })`；`messages.create({ model, max_tokens, temperature, messages, stream, thinking? }, { signal })`。`thinking` 由 `reasoningEffort` 映射为 `{ type:'enabled', budget_tokens }`（或省略）。
- **OpenAIClient**（`openai-client.ts`）：`new OpenAI({ apiKey, baseURL, maxRetries: 0, timeout })`；`chat.completions.create({ model, max_tokens, temperature, messages, stream, stream_options:{include_usage:true}, reasoning_effort? }, { signal })`。兼容端点不支持 `stream_options`/`reasoning_effort`/`max_tokens` 时在此类内温和降级。

**流式事件映射（两 SDK → 归一化）：**

| 归一化 | anthropic SDK | openai SDK |
|--------|---------------|------------|
| textDelta | `content_block_delta` 且 `delta.type==='text_delta'` → `delta.text` | chunk `choices[0].delta.content` |
| inputTokens | `message_start.message.usage.input_tokens` | 末块 `usage.prompt_tokens`（需 include_usage） |
| outputTokens | `message_delta.usage.output_tokens`（累计） | 末块 `usage.completion_tokens` |
| truncated | 终态 `stop_reason==='max_tokens'` | `finish_reason==='length'` |
| 非流式 text | `message.content` 里 `type==='text'` 拼接 | `choices[0].message.content` |

### 3.3 ApiAdapter 实现（可靠性骨架 + 双 SDK）

`ApiAdapter` 保留全部可靠性能力（**空闲**超时守卫、指数退避重试 + jitter、熔断记账、截断标记、usage 兜底、AbortError→timeout 重分类），只把最内两个调用点从 pi-ai 换成 `ProtocolClient.stream/complete`。

```typescript
// src/providers/api-adapter.ts

import { makeProtocolClient } from './protocol/index.js';

export class ApiAdapter implements InvocationAdapter {
  constructor(private cm: CredentialManager) {}

  async invoke(config: ModelConfig, prompt: string, onChunk?: OnChunk): Promise<InvocationResult> {
    const provider = config.provider ?? deriveProviderLabel(config);   // 熔断键
    return this.executeWithHealth(provider, config, prompt, onChunk);
  }

  // executeWithHealth: 自适应节流 → resolveApiKey → makeProtocolClient → withRetry(invoke) → 熔断记账
  // withRetry: 流式已 emit chunk 则不再重试（避免重复吐字）；重试仅针对 retryable 分类
  // invokeStreaming: guard.reset() per event → onChunk(e.textDelta) → 归一化结果
  // invokeComplete:  client.complete() → 归一化结果

  /** 凭证解析：env → key 文件 → 空串（仅 localhost 允许）。无 OAuth / token 刷新。 */
  private resolveApiKey(config: ModelConfig): string {
    if (config.api_key_env) {
      const v = process.env[config.api_key_env];
      if (v) return v;
    }
    if (config.api_key_path) {
      return readFileSync(expandHome(config.api_key_path), 'utf8').trim();
    }
    if (isLocalHost(config.base_url)) return '';   // localhost 无鉴权
    throw new CredentialNotFoundError(config.name);
  }

  /** 纯本地判断，无网络调用。 */
  async healthCheck(config: ModelConfig): Promise<HealthStatus> {
    const ok = (config.api_key_env && process.env[config.api_key_env])
      || (config.api_key_path && existsSync(expandHome(config.api_key_path)))
      || isLocalHost(config.base_url);
    return {
      level: ok ? 'healthy' : 'unavailable',
      message: ok ? 'API credentials available' : 'No credentials',
      checked_at: new Date().toISOString(),
    };
  }
}
```

> **SDK 原生重试必须关（maxRetries: 0）**：官方 SDK 默认 `maxRetries: 2`。必须设 `0`，让自研 `withRetry` 统管，以协调 (a) 流式已 emit 则不重试、(b) 熔断器分类只记一次、(c) 自适应节流。否则 SDK 底层偷偷重试会双重重试并对熔断器隐藏失败。

> **错误分类以 status 为主路径**：SDK 抛结构化 `APIError`（带 `.status`；`RateLimitError`=429、`APIConnectionError`/`APIConnectionTimeoutError`=网络）。`error-classifier.ts` 的 `extractStatus` 直接命中 status，字符串关键字匹配降级为「非 APIError 兜底」（兼容网关抛裸文本）。`isRateLimit` 优先 `err instanceof RateLimitError || status===429`。

### 3.4 模型发现与凭证管理

**模型发现**（`model-discovery.ts` + `model-assembly.ts`），两个入口：

```typescript
// 官方端点发现：凭证经 CredentialManager 解析（不再直读 process.env，消除凭证双真相源）
export async function discoverModels(credentials: CredentialManager): Promise<DiscoveredModel[]>

// 自定义 / 标准 API 端点发现（ollama / vLLM / 网关 / Google OpenAI-compat 等）
export async function discoverEndpointModels(opts: {
  protocol: Protocol;
  baseUrl: string;
  apiKey?: string;      // 缺省/空 → 传非空占位 'no-auth' 适配无鉴权端点，避免 SDK 回退读 env
  sourceLabel: string;  // 命名来源标签，调用方已 sanitize
}): Promise<DiscoveredModel[]>
```

- `discoverModels`：`credentials.resolveOfficialKey('anthropic'|'openai')` 有值 → 对应 `models.list()`；离线/无 key/失败 → stderr 警告 + 回退硬编码目录（`shared/model-catalog.ts`）。保留官方 OpenAI 的 `^(gpt-|o[0-9]|chatgpt)` 家族过滤。
- `discoverEndpointModels`：best-effort，与 `discoverModels` 同形态吞错——失败/超时/空集 → stderr 警告 + 返回 `[]`（**无 catalog 兜底**，调用方回退手输 model id），绝不抛出。**不套用**官方 OpenAI 家族过滤（自定义端点可返回 `llama3.2`/`mistral` 等任意 id）；每条必带 `base_url`。复用 `DISCOVERY_TIMEOUT_MS=5s`、`maxRetries:0`。
- 发现结果形态 `{ id, name, protocol, base_url?, source }`，由 `model-assembly` 装配为 ModelConfig（官方持裸名，自定义端点后缀 source 标签，`-2/-3` 兜底唯一化；`modelDedupeKey` 为 `(name, base_url)`）。

**凭证管理**（`credentials/discovery.ts`）：`CredentialManager` 收敛为薄壳，只保留「env var 探测（ANTHROPIC_API_KEY / OPENAI_API_KEY）+ key 文件存在性」，供向导 / GUI 报告用。

```typescript
// 「官方协议 key」的唯一解析器（当前即协议默认 env var）；SEC-02：绝不将 key 材料写入日志/DTO
resolveOfficialKey(protocol: Protocol): string | null
```

> 自定义端点的 `custom-<name>.key` 绑定某个具体 `base_url`、不属任何协议的官方端点，故**不在 `resolveOfficialKey` 内解析**——它由 `getApiKey` 按 ModelConfig（`api_key_env` / `api_key_path`）逐个解析。这使「官方端点凭证只来自 env」成为语义正确而非取巧。

```typescript
// src/types/provider.ts
export interface DiscoveryResult {
  source: 'env' | 'file';   // 不再有 'oauth' | 'legacy-file'
  status: 'valid' | 'refreshed' | 'expired' | 'not_found' | 'parse_error';
  path?: string;
  env_var?: string;
}
export type DiscoveryReport = Record<string, DiscoveryResult>;
```

**已移除**：`discoverOAuthCredentials` / `readClaudeCodeKeychain` / `readCodexAuthFile` / `readGeminiOAuthFile` / `login` / `saveOAuthCredentials`、`LEGACY_TO_PIAI` / `PIAI_TO_LEGACY`、所有 provider 家族映射表（`RELATED_PROVIDERS` / `OAUTH_ALSO_TRY` / `PROVIDER_PRIORITY` / `PROVIDER_SUFFIX` / `GOOGLE_FAMILY`）、`paths.ts` 的 `KNOWN_CREDENTIALS`。

#### 3.4.1 Key 文件存储约定

向导录入 raw API key 时落盘为 key 文件，被模型配置的 `api_key_path` 引用：

| 项 | 约定 |
|----|------|
| 存储路径 | `~/.council/credentials/<name>.key` |
| 文件 mode | `0o600`（chmodSync 显式设置，符合 SEC-03） |
| 父目录 mode | `0o700`（首次写入时 mkdirSync recursive） |
| 文件内容 | 单行 raw API key（读取时 trim 去尾随换行） |
| 熔断键标签 | `provider`（默认从 protocol / base_url 派生，可显式如 `custom:<name>`）；同标签多模型共享熔断状态 |
| 孤儿清理 | wizard 中途取消时，已写入但未持久化到 ModelConfig 的 key 文件由 wizard 主动 `unlinkSync` 删除 |

---

## 4. 辩论编排引擎

### 4.1 状态机设计

编排器是一个显式状态机，每个阶段对应一个状态转换。Checkpoint 在每次状态转换后写入。

```typescript
// src/core/orchestrator.ts

export type DebatePhase =
  | 'route'
  | 'broadcast'
  | 'review'
  | 'human_gate'
  | 'consensus'
  | 'pre_synthesis_compression'
  | 'synthesis'
  | 'completed'
  | 'failed';

/** 各辩论模式的阶段执行序列 */
const PHASE_SEQUENCES: Record<DebateMode, DebatePhase[]> = {
  quick:   ['route', 'broadcast'],
  compare: ['route', 'broadcast', 'pre_synthesis_compression', 'synthesis'],
  debate:  ['route', 'broadcast', 'review', 'human_gate', 'consensus',
            'pre_synthesis_compression', 'synthesis'],
};

export class Orchestrator {
  constructor(
    private adapter: InvocationAdapter,
    private sessionStore: SessionStore,
    private checkpointManager: CheckpointManager,
    private config: CouncilConfig,
    private renderer: Renderer,  // plain 或 TUI
  ) {}

  async run(question: string, options: RunOptions): Promise<Session> {
    // 1. 恢复或创建 Session
    let session = options.resume
      ? await this.checkpointManager.restore(options.sessionId)
      : this.createSession(question, options);

    // 2. 确定阶段序列
    const phases = PHASE_SEQUENCES[session.resolved_mode];
    const startIndex = this.findResumePoint(session, phases);

    // 3. 逐阶段执行
    for (let i = startIndex; i < phases.length; i++) {
      const phase = phases[i];

      // 可选阶段跳过逻辑
      if (phase === 'human_gate' && !options.interactive) continue;
      if (phase === 'pre_synthesis_compression' && !this.needsCompression(session)) continue;

      session.status = this.phaseToStatus(phase);
      this.renderer.onPhaseStart(phase, i, phases.length);

      try {
        session = await this.executePhase(phase, session);
      } catch (err) {
        session = this.handlePhaseError(phase, session, err);
        if (session.status === 'failed') break;
        // 降级后继续
      }

      // Checkpoint
      await this.checkpointManager.save(session);
    }

    // 4. 完成
    session.status = session.status === 'failed' ? 'failed' : 'completed';
    session.completed_at = new Date().toISOString();
    session.total_elapsed_ms = Date.now() - new Date(session.created_at).getTime();

    if (!options.noStore) {
      await this.sessionStore.save(session);
      await this.checkpointManager.remove(session.session_id);
    }

    return session;
  }

  private async executePhase(phase: DebatePhase, session: Session): Promise<Session> {
    switch (phase) {
      case 'route':      return this.executeRoute(session);
      case 'broadcast':  return this.executeBroadcast(session);
      case 'review':     return this.executeReview(session);
      case 'consensus':  return this.executeConsensus(session);
      case 'pre_synthesis_compression': return this.executeCompression(session);
      case 'synthesis':  return this.executeSynthesis(session);
      case 'human_gate': return this.executeHumanGate(session);
      default: return session;
    }
  }
}
```

### 4.2 Broadcast 阶段——并发调用

```typescript
private async executeBroadcast(session: Session): Promise<Session> {
  const stage = this.createStage('broadcast');
  const agents = session.agents;

  // 按模型分组：同一模型的多个 Agent 串行，不同模型间并行
  const groups = this.groupByModel(agents);

  const allInvocations = await Promise.all(
    groups.map(async (group) => {
      const results: Invocation[] = [];
      for (const agent of group) {
        const prompt = buildBroadcastPrompt(
          session.question, agent.role, session.parent_session_id
            ? session.parent_synthesis : undefined,
        );

        this.renderer.onAgentStart(agent);
        const result = await this.adapter.invoke(agent.config, prompt);
        this.renderer.onAgentComplete(agent, result);

        results.push(this.toInvocation(agent, result, prompt));
      }
      return results;
    }),
  );

  stage.invocations = allInvocations.flat();
  stage.status = 'completed';
  session.stages.push(stage);
  return session;
}

/**
 * 按模型 ID 分组。同一模型的 Agent 必须串行执行（避免同一 CLI 的并发限制），
 * 不同模型间并行执行。
 */
private groupByModel(agents: Agent[]): Agent[][] {
  const map = new Map<string, Agent[]>();
  for (const agent of agents) {
    const key = agent.config.name;
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(agent);
  }
  return [...map.values()];
}
```

### 4.3 Review 阶段——匿名化

```typescript
// src/core/anonymizer.ts

export class Anonymizer {
  /** 三层匿名化处理 */
  anonymize(responses: AgentResponse[]): AnonymizedResponse[] {
    // 随机打乱顺序（消除位置偏见）
    const shuffled = this.shuffle([...responses]);

    return shuffled.map((r, i) => ({
      label: String.fromCharCode(65 + i),  // A, B, C, ...
      content: this.pipeline(r.content),
      original_agent_index: r.agentIndex,  // 保留映射关系用于还原
    }));
  }

  private pipeline(text: string): string {
    let result = text;
    result = this.removeIdentity(result);       // Layer 1: 身份标记
    result = this.normalizeFormatting(result);   // Layer 3: 格式归一化
    return result;
  }

  /** Layer 1: 移除模型自我标识 */
  private removeIdentity(text: string): string {
    const patterns = [
      /I'm Claude\b/gi,
      /As Claude,?\s*/gi,
      /I'm Gemini\b/gi,
      /As an AI assistant created by \w+/gi,
      /I'm an AI (assistant|model) (made|created|developed) by \w+/gi,
    ];
    let result = text;
    for (const p of patterns) {
      result = result.replace(p, '');
    }
    return result;
  }

  /** Layer 3: 格式归一化（消除文风指纹） */
  private normalizeFormatting(text: string): string {
    return text
      .replace(/[\u{1F600}-\u{1F9FF}]/gu, '')           // 去除 Emoji
      .replace(/^#{1,2}\s/gm, '### ')                    // 统一标题层级
      .replace(/^\*/gm, '-')                              // 统一列表符号
      .replace(/\*\*(.+?)\*\*/g, '**$1**');               // 保留加粗（已统一）
  }

  private shuffle<T>(arr: T[]): T[] {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }
}
```

### 4.4 Consensus 计算

```typescript
// src/core/consensus.ts

export interface ConsensusResult {
  /** 评审者一致性（0-1），与供应商多样性无关。★cross-examine 判停依据★ = rawAgreement × rho。 */
  agreement_score: number;             // canonical，判停用
  consensus_score: number;             // 0.0-1.0，= agreement_score × δ；对外展示/查询/DB 用
  dimension_scores: Record<string, { score: number; divergence: number }>;
  model_diversity_factor: number;      // δ
  /** @deprecated agreement_score 的别名，读旧数据用；数值恒等于 agreement_score。 */
  raw_agreement: number;
}

// 判停用 agreement_score（不含 δ，阈值 0.6），对外展示/相似辩论复用用 consensus_score
// （含 δ 折减，保留 PRD §228 的低多样性可信度叙事）。两条语义分离。

export function calculateConsensus(
  reviews: ParsedReview[],
  agents: Agent[],
): ConsensusResult {
  // 1. 过滤有效评审（仅排除 PARSE_ERROR；partial 有有效 overall 分，纳入 —— 见 PRD §347）
  const valid = reviews.filter(r => r.status === 'valid' || r.status === 'partial');
  const N = valid.length;
  if (N < 2) {
    return { agreement_score: 0, consensus_score: 0, dimension_scores: {}, model_diversity_factor: 0, raw_agreement: 0 };
  }

  // 2. z-score 归一化（消除评审者尺度差异）
  const normalized = zScoreNormalize(valid);

  // 3. 计算每份回答的分数标准差
  const answerScores = groupScoresByAnswer(normalized);
  const sigmas = Object.values(answerScores).map(scores => standardDeviation(scores));
  const sigmaAvg = mean(sigmas);

  // 4. Kendall's W 排名一致性（按 reviewed_agent_id 分组）。自评剔除下为平衡不完全区组：
  //    每个回答恰好缺其作者 1 位评审者，对缺失项按该 rater 的均值秩 (n+1)/2 对称填补
  //    （保守地轻微压低 W）。N=2 时回退全集 review（保留自评），不触发剔除。
  const W = kendallsW(normalized, byReviewer);

  // 5. 小样本修正
  const rho = (N - 1) / N;

  // 6. Model Diversity Factor (δ)
  const uniqueProviders = new Set(agents.map(a => getProviderFamily(a.config)));
  const D = uniqueProviders.size;
  const A = agents.length;
  let delta = D / A;
  if (D < 2) delta *= 0.7;  // 纯单供应商硬折减

  // 7. 综合共识度
  const rawAgreement = 0.5 * (1 - sigmaAvg / 4.5) + 0.5 * W;
  const agreementScore = Math.max(0, Math.min(1, rawAgreement * rho));  // 判停依据，不含 δ
  const score = Math.max(0, Math.min(1, rawAgreement * rho * delta));   // consensus_score，含 δ 折减

  // 8. 分维度分歧分析
  const dimensions = ['accuracy', 'completeness', 'practicality', 'insight'];
  const dimensionScores: Record<string, { score: number; divergence: number }> = {};
  for (const dim of dimensions) {
    const dimScores = groupScoresByDimension(normalized, dim);
    const dimSigma = mean(Object.values(dimScores).map(standardDeviation));
    dimensionScores[dim] = {
      score: 1 - dimSigma / 4.5,
      divergence: dimSigma,
    };
  }

  return {
    agreement_score: agreementScore,
    consensus_score: score,
    dimension_scores: dimensionScores,
    model_diversity_factor: delta,
    raw_agreement: agreementScore,   // 别名，恒等于 agreement_score
  };
}

/** 判断模型的供应商归属（用于 diversity 计算） */
export function getProviderFamily(config: ModelConfig): string {
  if (config.provider) return config.provider;               // 显式 provider 标签优先
  if (config.base_url) {                                     // 自定义端点：protocol + host 归并同源
    try { return `${config.protocol}:${new URL(config.base_url).host}`; }
    catch { return `${config.protocol}:${config.base_url}`; }
  }
  return config.protocol;                                    // 官方端点（无 base_url）按协议归并
}
```

---

## 5. 持久化层

### 5.1 SQLite 数据库初始化与迁移

```typescript
// src/storage/database.ts

import Database from 'better-sqlite3';

const CURRENT_SCHEMA_VERSION = 1;

export function initDatabase(dbPath: string): Database.Database {
  const db = new Database(dbPath);

  // 启用 WAL 模式（并发读写性能提升）
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');

  // 检查并执行迁移
  migrate(db);

  return db;
}

function migrate(db: Database.Database) {
  const version = db.pragma('user_version', { simple: true }) as number;

  if (version < 1) {
    db.exec(`
      -- 主表
      CREATE TABLE IF NOT EXISTS sessions (
        session_id        TEXT PRIMARY KEY,
        question_hash     TEXT NOT NULL,
        question_normalized TEXT,
        question_preview  TEXT,
        synthesis_preview TEXT,
        mode              TEXT NOT NULL,
        resolved_mode     TEXT,
        status            TEXT NOT NULL,
        consensus_score   REAL,
        models_used       TEXT,
        created_at        TEXT NOT NULL,
        completed_at      TEXT,
        total_elapsed_ms  INTEGER,
        user_rating       INTEGER,
        parent_session_id TEXT,
        auto_suggested_mode TEXT,
        user_override_mode  TEXT
      );

      CREATE INDEX idx_sessions_question_hash ON sessions(question_hash);
      CREATE INDEX idx_sessions_status ON sessions(status);
      CREATE INDEX idx_sessions_created_at ON sessions(created_at);
      CREATE INDEX idx_sessions_consensus ON sessions(consensus_score);
      CREATE INDEX idx_sessions_parent ON sessions(parent_session_id);
      CREATE INDEX idx_sessions_rating ON sessions(user_rating);

      -- FTS5 全文索引
      CREATE VIRTUAL TABLE IF NOT EXISTS sessions_fts USING fts5(
        question_preview, synthesis_preview,
        content=sessions, content_rowid=rowid
      );

      -- 标签关联表
      CREATE TABLE IF NOT EXISTS session_tags (
        session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
        tag        TEXT NOT NULL,
        PRIMARY KEY (session_id, tag)
      );

      -- 模型表现统计
      CREATE TABLE IF NOT EXISTS model_stats (
        session_id          TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
        model_id            TEXT NOT NULL,
        invocation_mode     TEXT,
        avg_peer_score      REAL,
        was_chairman        INTEGER NOT NULL DEFAULT 0,
        was_devil_advocate  INTEGER NOT NULL DEFAULT 0,
        response_elapsed_ms INTEGER,
        token_usage_input   INTEGER,
        token_usage_output  INTEGER,
        PRIMARY KEY (session_id, model_id)
      );

      -- 并发调度表（运行时状态，启动时可安全清空）
      CREATE TABLE IF NOT EXISTS resource_slots (
        slot_id       INTEGER PRIMARY KEY AUTOINCREMENT,
        model_id      TEXT NOT NULL,
        pid           INTEGER NOT NULL,
        acquired_at   TEXT NOT NULL,
        resource_cost INTEGER NOT NULL DEFAULT 1
      );

      CREATE INDEX idx_resource_slots_model ON resource_slots(model_id);
      CREATE INDEX idx_resource_slots_pid ON resource_slots(pid);
    `);

    db.pragma(`user_version = ${CURRENT_SCHEMA_VERSION}`);
  }
}
```

### 5.2 Checkpoint 管理

```typescript
// src/storage/checkpoint.ts

import { readFileSync, writeFileSync, unlinkSync, readdirSync, statSync } from 'node:fs';

export class CheckpointManager {
  constructor(private checkpointDir: string) {}

  save(session: Session): void {
    const path = this.getPath(session.session_id);
    const data = {
      ...session,
      pid: process.pid,
      last_updated_at: new Date().toISOString(),
    };
    writeFileSync(path, JSON.stringify(data, null, 2), { mode: 0o600 });
  }

  restore(sessionId?: string): Session | null {
    // 清理僵尸 checkpoint
    this.cleanOrphans();

    if (sessionId) {
      return this.loadCheckpoint(this.getPath(sessionId));
    }

    // 找最近的有效 checkpoint
    const files = readdirSync(this.checkpointDir)
      .filter(f => f.endsWith('.ckpt.json'))
      .map(f => ({
        name: f,
        path: join(this.checkpointDir, f),
        mtime: statSync(join(this.checkpointDir, f)).mtimeMs,
      }))
      .sort((a, b) => b.mtime - a.mtime);

    for (const file of files) {
      const session = this.loadCheckpoint(file.path);
      if (session) return session;
    }

    return null;
  }

  remove(sessionId: string): void {
    const path = this.getPath(sessionId);
    try { unlinkSync(path); } catch {}
  }

  /** 清理超过 24h 或 PID 已退出的 checkpoint */
  private cleanOrphans(): void {
    const maxAge = 24 * 60 * 60 * 1000;
    const files = readdirSync(this.checkpointDir).filter(f => f.endsWith('.ckpt.json'));

    for (const file of files) {
      const path = join(this.checkpointDir, file);
      try {
        const data = JSON.parse(readFileSync(path, 'utf-8'));
        const age = Date.now() - new Date(data.last_updated_at).getTime();
        const pidAlive = isProcessAlive(data.pid);

        if (age > maxAge || !pidAlive) {
          unlinkSync(path);
        }
      } catch {
        unlinkSync(path);  // 解析失败也清理
      }
    }
  }

  private getPath(sessionId: string): string {
    return join(this.checkpointDir, `${sessionId}.ckpt.json`);
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);  // 信号 0 不发送信号，仅检查进程是否存在
    return true;
  } catch {
    return false;
  }
}
```

### 5.3 并发调度（resource_slots）

```typescript
// src/storage/concurrency.ts

export class ConcurrencyManager {
  constructor(private db: Database.Database, private globalLimit: number) {}

  /**
   * 尝试获取一个资源槽位。
   * 使用 SQLite BEGIN IMMEDIATE 保证原子性。
   * 同步 API 保证事务内无 yield，不会被中断。
   */
  acquire(modelId: string, maxConcurrent: number, resourceWeight: number): boolean {
    const txn = this.db.transaction(() => {
      // 1. 清理僵尸槽位
      const slots = this.db.prepare('SELECT slot_id, pid FROM resource_slots').all() as any[];
      for (const slot of slots) {
        if (!isProcessAlive(slot.pid)) {
          this.db.prepare('DELETE FROM resource_slots WHERE slot_id = ?').run(slot.slot_id);
        }
      }

      // 2. 检查模型并发限制
      const modelCount = this.db.prepare(
        'SELECT COUNT(*) as cnt FROM resource_slots WHERE model_id = ?'
      ).get(modelId) as any;

      if (modelCount.cnt >= maxConcurrent) return false;

      // 3. 检查全局资源池
      const totalCost = this.db.prepare(
        'SELECT COALESCE(SUM(resource_cost), 0) as total FROM resource_slots'
      ).get() as any;

      if (totalCost.total + resourceWeight > this.globalLimit) return false;

      // 4. 插入槽位
      this.db.prepare(
        'INSERT INTO resource_slots (model_id, pid, acquired_at, resource_cost) VALUES (?, ?, ?, ?)'
      ).run(modelId, process.pid, new Date().toISOString(), resourceWeight);

      return true;
    });

    return txn.immediate();  // BEGIN IMMEDIATE 保证写事务互斥
  }

  /** 释放当前进程持有的所有槽位 */
  release(): void {
    this.db.prepare('DELETE FROM resource_slots WHERE pid = ?').run(process.pid);
  }

  /** 注册进程退出时自动释放 */
  registerCleanup(): void {
    const cleanup = () => this.release();
    process.on('exit', cleanup);
    process.on('SIGINT', () => { cleanup(); process.exit(130); });
    process.on('SIGTERM', () => { cleanup(); process.exit(143); });
  }
}
```

---

## 6. 配置系统

### 6.1 Zod Schema 定义

```typescript
// src/config/schema.ts

import { z } from 'zod';

/** 协议官方端点。省略 base_url 时用协议对应的官方端点。 */
export const OFFICIAL_BASE_URL = {
  anthropic: 'https://api.anthropic.com',
  openai: 'https://api.openai.com/v1',
} as const;

/** 模型配置 Schema（v2 — 标准 API 收敛，schema_version 2） */
export const ModelConfigSchema = z.object({
  name: z.string(),
  protocol: z.enum(['anthropic', 'openai']),   // 选哪个 SDK（取代 invocation + provider 语义）
  model: z.string(),                            // 透传给端点的 model id
  base_url: z.string().url().optional(),        // 省略 → OFFICIAL_BASE_URL[protocol]

  api_key_env: z.string().optional(),
  api_key_path: z.string().optional(),
  provider: z.string().optional(),              // 展示 / 熔断键标签（默认派生）

  reasoning_effort: z.enum(['minimal', 'low', 'medium', 'high', 'xhigh']).optional(),
  temperature: z.number().optional(),
  max_tokens: z.number().int().positive().optional(),

  timeout_seconds: z.number().int().positive().default(120),
  capabilities: z.array(z.string()).default(['general']),
  priority: z.number().int().nonnegative().default(100),
  max_concurrent: z.number().int().positive().default(1),
  resource_weight: z.number().int().positive().default(1),
  enabled: z.boolean().default(true),
  streaming: z.boolean().default(true),

  // 迁移写入：旧模型无法自动转换时保留可见但禁用，附此原因（见 §6.4）
  legacy_disabled_reason: z.string().optional(),
});
// 删字段：invocation/binary/model_args/args/input_mode/output_mode/output_json_field/env/health_check
// 重命名：api_base_url→base_url、api_credential_path→api_key_path；删原 CLI .refine

export type ModelConfig = z.infer<typeof ModelConfigSchema>;

/** 主配置 Schema */
export const CouncilConfigSchema = z.object({
  schema_version: z.number().int().default(2),

  general: z.object({
    default_mode: z.enum(['quick', 'compare', 'debate', 'auto']).default('auto'),
    default_chairman: z.string(),
    role_generator_model: z.string().default(''),  // 设计专家角色面板所用模型（按名）；空 → 自动挑选均衡档模型
    min_agents: z.number().int().min(1).default(2),
    max_agents: z.number().int().min(1).default(5),
    allow_same_model_agents: z.boolean().default(true),
    review_rounds: z.number().int().min(1).max(3).default(1),
    language: z.enum(['auto', 'zh', 'en']).default('auto'),
    compression_threshold_ratio: z.number().min(0).max(1).default(0.6),
    devil_advocate: z.enum(['auto', 'always', 'never']).default('auto'),
    high_risk_keywords: z.array(z.string()).default([]),
    stage_effort: z.object({
      broadcast: z.enum(['minimal', 'low', 'medium', 'high', 'xhigh']).default('medium'),
      review: z.enum(['minimal', 'low', 'medium', 'high', 'xhigh']).default('low'),
      synthesis: z.enum(['minimal', 'low', 'medium', 'high', 'xhigh']).default('high'),
    }).optional(),
  }),

  storage: z.object({
    data_dir: z.string().default('~/.council/data'),
    checkpoint_dir: z.string().default('~/.council/checkpoints'),
    log_dir: z.string().default('~/.council/logs'),
    log_retention_days: z.number().int().default(7),
    orphan_checkpoint_hours: z.number().int().default(24),
  }),

  routing: z.object({
    strategy: z.enum(['keyword', 'llm', 'manual']).default('keyword'),
    dynamic_weight: z.boolean().default(true),
    dynamic_weight_alpha: z.number().min(0).max(1).default(0.3),
    dynamic_weight_shadow: z.boolean().default(true),
    exploration_rate: z.number().min(0).max(1).default(0.1),
    rules: z.array(z.any()).default([]),
    default: z.object({
      prefer: z.array(z.string()),
      chairman: z.string(),
      role_set: z.string().default('default'),
    }),
  }),

  concurrency: z.object({
    global_resource_limit: z.number().int().positive().default(10),
  }),

  circuit_breaker: z.object({
    failure_threshold: z.number().int().positive().default(5),
    recovery_seconds: z.number().int().positive().default(3600),
    enabled: z.boolean().default(true),
  }),

  output: z.object({
    format: z.enum(['markdown', 'json', 'plain']).default('markdown'),
    show_individual: z.boolean().default(false),
    show_scores: z.boolean().default(true),
    show_consensus: z.boolean().default(true),
    show_dimension_heatmap: z.boolean().default(true),
    show_timing: z.boolean().default(true),
    copy_to_clipboard: z.boolean().default(false),
    tui_mode: z.enum(['auto', 'always', 'never']).default('auto'),
  }),

  storage_security: z.object({
    session_retention_days: z.number().int().nonnegative().default(90),
  }),
});

export type CouncilConfig = z.infer<typeof CouncilConfigSchema>;
```

### 6.2 配置加载

```typescript
// src/config/loader.ts

import { parse as parseYaml } from 'yaml';
import { readdirSync, readFileSync, existsSync } from 'node:fs';

export class ConfigLoader {
  constructor(private configDir: string) {}

  loadCouncilConfig(): CouncilConfig {
    const path = join(this.configDir, 'council.yaml');
    if (!existsSync(path)) throw new ConfigNotFoundError(path);

    const raw = parseYaml(readFileSync(path, 'utf-8'));
    return CouncilConfigSchema.parse(raw);
  }

  loadAllModels(): ModelConfig[] {
    const modelsDir = join(this.configDir, 'models');
    if (!existsSync(modelsDir)) return [];

    return readdirSync(modelsDir)
      .filter(f => f.endsWith('.yaml'))
      .map(f => {
        const raw = parseYaml(readFileSync(join(modelsDir, f), 'utf-8'));
        return ModelConfigSchema.parse(raw);
      })
      .filter(m => m.enabled);
  }

  // 单模型 CRUD —— 支撑 commands/models/mutations.ts 的增量管理（含已禁用模型）：
  //   loadModelConfig(name) / loadAllModelConfigs()（不 filter enabled）/ saveModelConfig(config)
  //   已存在；deleteModelConfig 为增量删除新增。

  /**
   * 按名称删除单个模型 YAML。删除成功返回 true，文件不存在返回 false
   * （供调用方给出 "not found" 错误）。safePath 阻断经构造 `name` 的路径穿越。
   */
  deleteModelConfig(name: string): boolean {
    const path = safePath(join(this.configDir, 'models'), `${name}.yaml`);
    if (!existsSync(path)) return false;
    unlinkSync(path);
    return true;
  }

  loadRoleSet(name: string): RoleSet {
    // 先查用户自定义，再查内置默认
    const userPath = join(this.configDir, 'roles', `${name}.yaml`);
    if (existsSync(userPath)) {
      return parseYaml(readFileSync(userPath, 'utf-8'));
    }

    // 内置默认角色集（编译时嵌入）
    const builtinPath = join(__dirname, '..', 'defaults', 'roles', `${name}.yaml`);
    if (existsSync(builtinPath)) {
      return parseYaml(readFileSync(builtinPath, 'utf-8'));
    }

    throw new RoleSetNotFoundError(name);
  }
}
```

### 6.3 路径常量

```typescript
// src/config/paths.ts

import { homedir } from 'node:os';
import { join } from 'node:path';

export const COUNCIL_HOME = join(homedir(), '.council');

export const PATHS = {
  config:       join(COUNCIL_HOME, 'config'),
  councilYaml:  join(COUNCIL_HOME, 'config', 'council.yaml'),
  modelsDir:    join(COUNCIL_HOME, 'config', 'models'),
  rolesDir:     join(COUNCIL_HOME, 'config', 'roles'),
  dataDir:      join(COUNCIL_HOME, 'data'),
  database:     join(COUNCIL_HOME, 'data', 'council.db'),
  sessionsDir:  join(COUNCIL_HOME, 'data', 'sessions'),
  checkpoints:  join(COUNCIL_HOME, 'checkpoints'),
  credentials:  join(COUNCIL_HOME, 'credentials'),   // API key 文件（被 api_key_path 引用）
  logs:         join(COUNCIL_HOME, 'logs'),
} as const;

// 已删除 KNOWN_CREDENTIALS（OAuth/keychain/CLI 客户端凭证路径）—— 凭证降为 env / key 文件
```

### 6.4 配置迁移（schema_version 1 → 2）

`config/migrate.ts` 是纯函数（逻辑与文件写分离）。`ConfigLoader` 首次加载检测到 `schema_version < 2` 时触发一次性**非破坏式迁移**：可转换即转，不可转换「禁用 + 标注 `legacy_disabled_reason`」保留，绝不硬报错、绝不静默丢弃。迁移重写 model YAML、升 `schema_version`、向 stderr 打印摘要。转换规则见 PRD §4.4.4。

```typescript
// src/config/migrate.ts
export interface MigrationResult {
  models: ModelConfig[];        // 迁移后（含被禁用+标注的）
  converted: number;
  disabled: { name: string; reason: string }[];
}
// 纯函数：读入旧 model 字面量 + 当前 env 可用性 → 决定转换 or 禁用+标注
export function migrateModelsV1ToV2(rawModels: unknown[], env: NodeJS.ProcessEnv): MigrationResult;
```

- `invocation: api/auto` + `api_base_url` + key → `protocol:'openai'`、`base_url`←`api_base_url`、`api_key_path`←`api_credential_path`（enabled）
- `provider: anthropic/openai` + 对应 env key 存在 → `protocol` 官方（enabled）
- `invocation: cli` / OAuth-only / `google*` / `github-copilot` → 禁用 + 标注（见 PRD §4.4.4 表）

---

## 7. CLI 命令实现

### 7.1 入口与命令注册

```typescript
// src/cli.ts
#!/usr/bin/env node

import { Command } from 'commander';

const program = new Command()
  .name('council')
  .description('Open Council — 多模型辩论编排系统')
  .version('0.1.0');

// 主命令：council "question"
program
  .argument('[question]', '要辩论的问题')
  .option('-m, --mode <mode>', '辩论模式: quick | compare | debate', 'auto')
  .option('-c, --chairman <model>', '指定 Chairman 模型')
  .option('--models <models...>', '指定参与模型')
  .option('-i, --interactive', '启用交互式 Human-in-the-Loop')
  .option('--no-interactive', '强制禁用交互模式')
  .option('-j, --json', 'JSON 格式输出')
  .option('--no-store', '不持久化本次辩论结果')
  .option('--resume [sessionId]', '恢复中断的辩论')
  .option('--force', '强制开启新辩论')
  .option('--tag <tags...>', '标签')
  .option('--copy', '自动复制结果到剪贴板')
  .option('--devil-advocate', '强制启用反方角色')
  .option('--role-set <name>', '指定角色集')
  .option('--follow [sessionId]', '追问（基于已有辩论结果）')
  .action(async (question, options) => {
    const { runCouncil } = await import('./commands/council.js');
    await runCouncil(question, options);
  });

// 子命令
program.command('setup').description('完整配置向导').action(async (opts) => {
  const { runSetup } = await import('./commands/setup.js');
  await runSetup(opts);
});

const modelsCmd = program.command('models').description('模型管理');
modelsCmd.command('list').description('列出所有模型（含已禁用）').action(/* ... */);
modelsCmd.command('check').description('健康检查').action(/* ... */);
modelsCmd.command('add').description('添加模型（官方发现 / 自定义端点）').action(/* ... */);
modelsCmd.command('remove <name>').description('按名称删除模型').action(/* ... */);
modelsCmd.command('enable <name>').description('启用模型').action(/* ... */);
modelsCmd.command('disable <name>').description('禁用模型').action(/* ... */);
modelsCmd.action(/* 无子命令 → 等价 list */);

program.command('benchmark').description('运行基准测试').action(async (opts) => {
  const { runBenchmark } = await import('./commands/benchmark.js');
  await runBenchmark(opts);
});

program.command('history').description('查看历史辩论').action(/* ... */);
program.command('show <sessionId>').description('查看辩论详情').action(/* ... */);
program.command('recall <keyword>').description('搜索历史结论').action(/* ... */);
program.command('stats').description('模型表现统计').action(/* ... */);
program.command('rate <sessionId> <score>').description('评分').action(/* ... */);
program.command('replay <sessionId>').description('回放辩论').action(/* ... */);
program.command('export <sessionId>').description('导出').action(/* ... */);
program.command('prune').description('清理旧数据').action(/* ... */);
program.command('reload').description('重新加载配置').action(/* ... */);

program.parseAsync();
```

### 7.2 主命令执行流程

```typescript
// src/commands/council.ts

export async function runCouncil(question: string | undefined, options: any) {
  // 0. 首次运行检测
  if (!existsSync(PATHS.config)) {
    const { runFirstRunWizard } = await import('../ui/wizard/first-run.js');
    await runFirstRunWizard();
  }

  // 1. 加载配置
  const loader = new ConfigLoader(PATHS.config);
  const config = loader.loadCouncilConfig();
  const models = loader.loadAllModels();

  // 2. 初始化各层
  const db = initDatabase(PATHS.database);
  const cm = new CredentialManager();   // 薄壳：env key 探测 + key 文件存在性
  const adapter = new ApiAdapter(cm);   // 唯一实现：ProtocolClient(anthropic|openai) 双 SDK
  const sessionStore = new SessionStore(PATHS.sessionsDir, db);
  const checkpointManager = new CheckpointManager(PATHS.checkpoints);
  const concurrencyManager = new ConcurrencyManager(db, config.concurrency.global_resource_limit);
  concurrencyManager.registerCleanup();

  // 3. 选择渲染器
  const renderer = process.stdout.isTTY && config.output.tui_mode !== 'never'
    ? new TuiRenderer()
    : new PlainRenderer();

  // 4. 如果没有问题，进入交互模式或报错
  if (!question) {
    if (options.resume) {
      // 恢复模式
    } else {
      console.error('Usage: council "your question"');
      process.exit(1);
    }
  }

  // 5. 执行编排
  const orchestrator = new Orchestrator(adapter, sessionStore, checkpointManager, config, renderer);
  const session = await orchestrator.run(question!, {
    mode: options.mode,
    chairman: options.chairman,
    models: options.models,
    interactive: options.interactive,
    noStore: options.noStore === false,  // --no-store
    resume: !!options.resume,
    tags: options.tag,
    devilAdvocate: options.devilAdvocate,
    roleSet: options.roleSet,
    parentSessionId: options.follow,
  });

  // 6. 输出结果
  if (options.json) {
    console.log(JSON.stringify(session, null, 2));
  } else {
    renderer.renderResult(session);
  }

  // 7. 追问模式（仅 TTY）
  if (process.stdout.isTTY && options.interactive !== false) {
    await enterFollowUpMode(session, orchestrator, renderer);
  }
}
```

---

## 8. UI 与渲染

### 8.1 渲染器接口

```typescript
// src/types/renderer.ts

export interface Renderer {
  onPhaseStart(phase: DebatePhase, index: number, total: number): void;
  onAgentStart(agent: Agent): void;
  onAgentProgress(agent: Agent, chunk: string): void;
  onAgentComplete(agent: Agent, result: InvocationResult): void;
  onConsensus(result: ConsensusResult): void;
  onDegradation(event: DegradationEvent): void;
  renderResult(session: Session): void;
}
```

### 8.2 Plain Renderer（Phase 0-4）

```typescript
// src/ui/plain-renderer.ts

export class PlainRenderer implements Renderer {
  onPhaseStart(phase: DebatePhase, index: number, total: number) {
    const label = PHASE_LABELS[phase];
    process.stderr.write(`[${index + 1}/${total}] ${label}...\n`);
  }

  onAgentComplete(agent: Agent, result: InvocationResult) {
    process.stderr.write(
      `  ✓ ${agent.config.name} (${agent.role}) ${result.elapsed_ms / 1000}s\n`
    );
  }

  onConsensus(result: ConsensusResult) {
    const bar = '█'.repeat(Math.round(result.consensus_score * 20))
              + '░'.repeat(20 - Math.round(result.consensus_score * 20));
    const level = result.consensus_score >= 0.8 ? '高'
                : result.consensus_score >= 0.5 ? '中等'
                : result.consensus_score >= 0.2 ? '低' : '极低';
    process.stderr.write(
      `  共识度: ${result.consensus_score.toFixed(2)} ${bar} (${level})\n`
    );

    if (result.model_diversity_factor < 0.5) {
      process.stderr.write(
        `  ⚠ 模型多样性较低 (δ=${result.model_diversity_factor.toFixed(2)})，置信度已折减\n`
      );
    }
  }

  renderResult(session: Session) {
    if (session.synthesis) {
      process.stdout.write(session.synthesis + '\n');
    }
  }

  onDegradation(event: DegradationEvent) {
    process.stderr.write(`  [!] ${event.phase}: ${event.reason}\n`);
  }
}
```

### 8.3 TUI Dashboard（Phase 5，ink 组件）

```tsx
// src/ui/tui/Dashboard.tsx

import React, { useState } from 'react';
import { Box, Text, useApp } from 'ink';

// 纯文本 spinner：ink 无内置 spinner 组件，用一组 braille 帧按耗时轮转即可，
// 避免额外依赖（示例自洽）。
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const spinnerFrame = (elapsedSec: number): string =>
  SPINNER_FRAMES[Math.floor(elapsedSec * 10) % SPINNER_FRAMES.length];

interface Props {
  question: string;
  mode: string;
  agents: AgentState[];
  currentPhase: DebatePhase;
  phaseIndex: number;
  totalPhases: number;
  consensus?: ConsensusResult;
  elapsed: number;
}

export function Dashboard(props: Props) {
  const { question, mode, agents, currentPhase, phaseIndex, totalPhases, consensus, elapsed } = props;

  const progressBar = '█'.repeat(Math.round((phaseIndex / totalPhases) * 20))
                    + '░'.repeat(20 - Math.round((phaseIndex / totalPhases) * 20));

  return (
    <Box flexDirection="column" borderStyle="single" paddingX={1}>
      <Text bold>Open Council - {mode.toUpperCase()} Mode</Text>
      <Text dimColor>Question: "{question.slice(0, 60)}..."</Text>

      <Box marginY={1}>
        <Text>Phase: [{progressBar}] {phaseIndex}/{totalPhases} {PHASE_LABELS[currentPhase]}</Text>
      </Box>

      <Text bold>Agents:</Text>
      {agents.map((a) => (
        <AgentStatusLine key={a.id} agent={a} />
      ))}

      {consensus && (
        <Box marginTop={1}>
          <Text>
            Consensus: {consensus.consensus_score.toFixed(2)}{' '}
            {'█'.repeat(Math.round(consensus.consensus_score * 12))}
            {'░'.repeat(12 - Math.round(consensus.consensus_score * 12))}
          </Text>
        </Box>
      )}

      <Box marginTop={1}>
        <Text dimColor>Elapsed: {(elapsed / 1000).toFixed(1)}s</Text>
      </Box>

      <Box borderStyle="single" borderTop borderBottom={false} borderLeft={false} borderRight={false}>
        <Text dimColor>[q] quit  [p] pause  [v] view responses</Text>
      </Box>
    </Box>
  );
}

function AgentStatusLine({ agent }: { agent: AgentState }) {
  const modeTag = agent.invocationMode === 'api' ? 'API' : 'CLI';
  switch (agent.status) {
    case 'running':
      return (
        <Text>
          {'  '}{spinnerFrame(agent.elapsed)} {agent.name} ({agent.role}) [{modeTag}] {agent.elapsed}s
        </Text>
      );
    case 'done':
      return <Text>  ✓ {agent.name} ({agent.role}) [{modeTag}] {agent.elapsed}s</Text>;
    case 'failed':
      return <Text color="red">  ✗ {agent.name} ({agent.role}) [{modeTag}] {agent.error}</Text>;
    default:
      return <Text dimColor>  ○ {agent.name} ({agent.role}) [{modeTag}] pending</Text>;
  }
}
```

### 8.4 Web GUI（`council serve`，Renderer 第三实现）

`council serve` 启动一个绑定 `127.0.0.1` 的本地 Web 控制台。**核心支点**：`Orchestrator` 经依赖注入接收一个 `Renderer`（`src/types/renderer.ts`）；CLI 注入 `PlainRenderer` / `TuiRenderer`，Web 只需注入 **`WebRenderer`**（第三实现），把回调转成 SSE 事件推给浏览器——**core 零改动**。

**server 模块拆分**（`src/server/`，均见 §2 结构树）：

| 模块 | 职责 |
|------|------|
| `app.ts` | `createApp(deps): Hono` 纯装配（security → `/api` → 静态 `web/`），不监听端口，可 `app.request()` 单测 |
| `routes.ts` | 五条 REST + SSE 路由，薄传输层（校验 → 委托 → 投影） |
| `debate-manager.ts` | `Map<debateId, EventLog>`；`startDebate()` 装配 `Orchestrator + WebRenderer`，后台 `run → saveSession → emit result` |
| `event-log.ts` | 单辩论事件缓冲 + 订阅者集合 + 单调 id + 断线回放 + 有界驱逐（progress 事件可丢弃） |
| `web-renderer.ts` | `implements Renderer`；回调 → `EventLog.push`，`Agent`/`InvocationResult` → 精简 DTO（SEC-02） |
| `config-routes.ts` | 设置面五条 REST 路由（GET/PUT `/config`、PATCH `/models/:name`、POST `/providers/custom`、POST `/setup/rescan`）；内容哈希乐观锁 + 脱敏投影 |
| `runtime-config.ts` | `RuntimeConfig` 持有器：编排 + 路由在**读时**取当前快照，配置写后 `reloadRuntime()` 原子换快照 |
| `protocol.ts` | SSE 线协议 + 配置 DTO 的 TS 类型（server 私有契约，纯类型无运行时代码，ARCH-04） |
| `security.ts` | Host 头校验（所有请求）+ Origin 校验（状态变更请求），防 DNS-rebinding / CSRF |

**REST + SSE 契约（五条）**：

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/debates` | 发起辩论（zod 校验 body），`202 { debateId }`，不 await 编排完成 |
| GET | `/api/debates/:debateId/events` | SSE 实时流；未知/已驱逐 `debateId` → `404`（前端降级到历史详情） |
| GET | `/api/sessions` | 历史列表（复用 `SessionStore.listSessions`，投影为精简 summary） |
| GET | `/api/sessions/:id` | 历史详情（复用 `SessionStore.getSession`） |
| GET | `/api/models` | 模型元数据 + 模式枚举供发起表单渲染，**绝不返回凭证** |

**SSE 事件协议**：事件类型与 `Renderer` 方法一一映射（`phase` / `agent_start` / `agent_progress` / `agent_complete` / `consensus` / `degradation`），外加服务端注入的 `debate_start` / `result` / `error` 终态事件；每帧带单调 `id:` 供 `Last-Event-ID` 重连回放，心跳用 SSE 注释行 `:hb`。**权威 TS 定义与回放/驱逐语义见设计笔记 `docs/design-notes/web-gui-design.md` §4。**

**设置面 REST 契约（五条，见设计笔记 `docs/design-notes/web-gui-config.md`）**：

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/config` | 脱敏配置投影（可编辑 general/prefer + 含禁用模型列表 + 只读段）；`version` 为 `council.yaml` 内容 sha256，各模型另带独立 per-file 令牌 |
| PUT | `/api/config` | 合并 general/prefer（复用 `assembleConfig`）；乐观锁不符 → `409 { error, current }`（前端据 `current` rebase） |
| PATCH | `/api/models/:name` | 翻转单模型 `enabled`（独立 per-file 乐观锁）；`404` 未知模型 |
| POST | `/api/providers/custom` | 接入自定义 OpenAI 兼容端点；key 立即写 `0o600` 文件，仅存路径不入 YAML，响应绝不回显（SEC-02） |
| POST | `/api/setup/rescan` | 重扫凭证 + 模型，非破坏性 upsert，返回摘要（无 path/secret 出线）；重建 adapter |

写路径统一经 `security.ts`（Host + Origin），成功后调 `reloadRuntime()` 换 `RuntimeConfig` 快照——**下一场辩论自动读到新配置，进行中的辩论保持其已捕获的旧快照**。凭证边界与乐观锁裁定见设计笔记。

**`web/` 零构建前端**：`web/` 为纯静态源码，由 `app.ts` 的 hono `serveStatic` 直接托管（SEC-04），**无构建产物**——不引入 Vite/React 构建链。响应式 DOM 用 petite-vue、Markdown 渲染用 marked + DOMPurify 净化（LLM 输出必过净化，SEC），三者均本地 vendored 到 `web/vendor/`（离线、不外链）。运行期从包根解析 `web/`；`package.json` 的 `files` 已含 `web`，随 npm 包发布。

---

## 9. Benchmark 与效果验证

### 9.1 四组消融实验实现

```typescript
// src/commands/benchmark.ts

export async function runBenchmark(options: BenchmarkOptions) {
  const questions = loadBenchmarkSuite(options.suite);

  for (const q of questions) {
    // A. best-single-quick: 最佳单模型 + 基础 prompt
    const groupA = await runSingleModel(q, bestModel, 'quick');

    // B. best-single-deep: 最佳单模型 + 精细化 prompt（与 debate 同级）
    const groupB = await runSingleModel(q, bestModel, 'deep');

    // C. compare+synthesis: 多模型 + Synthesis（跳过 Review）
    const groupC = await runOrchestrator(q, 'compare');

    // D. full-debate: 完整流程
    const groupD = await runOrchestrator(q, 'debate');

    // 评估覆盖率
    const coverageA = evaluateCoverage(groupA.response, q.expected_points);
    const coverageB = evaluateCoverage(groupB.response, q.expected_points);
    const coverageC = evaluateCoverage(groupC.synthesis!, q.expected_points);
    const coverageD = evaluateCoverage(groupD.synthesis!, q.expected_points);

    // 输出消融分析
    report.addQuestion(q, { A: coverageA, B: coverageB, C: coverageC, D: coverageD });
  }

  // Release gate 检查（D vs B）
  const passed = report.checkReleaseGate();
  process.exit(passed ? 0 : 1);
}
```

### 9.2 评估方式

```typescript
/**
 * 使用 LLM 评估回答是否覆盖了预期关键点。
 * 这里复用 Chairman 模型做评估（消耗少量额外 token）。
 */
async function evaluateCoverage(
  response: string,
  expectedPoints: string[],
): Promise<CoverageResult> {
  const prompt = `
请判断以下回答是否覆盖了这些关键点。
对每个关键点，回答 "hit" 或 "miss"，以 JSON 格式输出。

关键点：
${expectedPoints.map((p, i) => `${i + 1}. ${p}`).join('\n')}

回答内容：
${response}

输出格式：
{"results": [{"point": "...", "verdict": "hit|miss", "confidence": "high|low"}]}
`;

  const result = await adapter.invoke(chairmanConfig, prompt);
  return parseCoverageResult(result.response, expectedPoints);
}
```

---

## 10. 错误处理与降级

### 10.1 错误类型体系

```typescript
// src/types/errors.ts

export class CouncilError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message);
    this.name = 'CouncilError';
  }
}

export class ModelUnavailableError extends CouncilError {
  constructor(modelName: string, reason: string) {
    super(`Model ${modelName} unavailable: ${reason}`, 'MODEL_UNAVAILABLE');
  }
}

export class InvocationError extends CouncilError {
  constructor(modelName: string, mode: 'cli' | 'api', reason: string) {
    super(`${mode.toUpperCase()} invocation of ${modelName} failed: ${reason}`, 'INVOCATION_FAILED');
  }
}

// 调用超时（区别于 InvocationError）：单次调用未在时限内完成，触发局部降级而非中断整场辩论。
export class InvocationTimeoutError extends CouncilError {
  constructor(
    public readonly modelName: string,
    public readonly mode: 'cli' | 'api',
    public readonly timeoutSeconds: number,
  ) {
    super(`${mode.toUpperCase()} invocation of ${modelName} timed out after ${timeoutSeconds}s (timeout)`, 'INVOCATION_TIMEOUT');
  }
}

export class CredentialNotFoundError extends CouncilError {
  constructor(provider: string) {
    super(`No credentials found for ${provider}`, 'CREDENTIAL_NOT_FOUND');
  }
}

export class CredentialExpiredError extends CouncilError {
  constructor(provider: string) {
    super(`Credentials for ${provider} expired and refresh failed`, 'CREDENTIAL_EXPIRED');
  }
}

export class LowConsensusError extends CouncilError {
  constructor(score: number) {
    super(`Consensus score ${score} below threshold`, 'LOW_CONSENSUS');
  }
}
```

### 10.2 降级策略（编排器内）

```typescript
// 在 Orchestrator 内部

private handlePhaseError(phase: DebatePhase, session: Session, err: unknown): Session {
  const event: DegradationEvent = {
    phase,
    reason: err instanceof Error ? err.message : String(err),
    impact: '',
  };

  switch (phase) {
    case 'broadcast': {
      // 已成功的回答 ≥ 2 → 继续；仅 1 个 → 降级为 quick；0 个 → failed
      const completed = session.stages.at(-1)?.invocations.filter(i => !i.timed_out && i.response_raw) ?? [];
      if (completed.length >= 2) {
        event.impact = `${session.agents.length - completed.length} Agent(s) failed, continuing with ${completed.length}`;
      } else if (completed.length === 1) {
        event.impact = 'Only 1 Agent succeeded, degrading to quick mode';
        session.resolved_mode = 'quick';
      } else {
        session.status = 'failed';
        event.impact = 'All agents failed';
      }
      break;
    }

    case 'review': {
      // 有效评审 < 2 → 跳过 Review + Consensus，降级为 compare
      event.impact = 'Review failed, degrading to compare mode (skipping consensus)';
      session.resolved_mode = 'compare';
      break;
    }

    case 'synthesis': {
      // Chairman 失败 → 尝试 fallback 模型；全失败 → 输出最佳单 Agent 回答
      event.impact = 'Synthesis failed, outputting best individual response';
      session.synthesis = this.getBestIndividualResponse(session);
      break;
    }

    default:
      event.impact = `Phase ${phase} failed, skipping`;
  }

  session.degradation_events = session.degradation_events ?? [];
  session.degradation_events.push(event);
  this.renderer.onDegradation(event);

  return session;
}
```

---

## 11. 测试策略

### 11.1 测试分层

| 层级 | 覆盖目标 | 运行条件 | 框架 |
|------|---------|---------|------|
| **单元测试** | `core/` 纯逻辑（共识计算、匿名化、prompt 构建、评分解析） | 无外部依赖，CI 中运行 | vitest |
| **适配器测试** | `providers/` ApiAdapter + ProtocolClient（mock 两个官方 SDK）、错误分类、发现/装配 | mock SDK 调用 | vitest（SDK mock） |
| **存储测试** | `storage/` SQLite 操作、Checkpoint 读写、并发调度 | 临时 SQLite（`:memory:` 或 tmpdir） | vitest |
| **集成测试** | 完整 debate 流程端到端 | 需要至少 1 个真实 API 端点可用 | vitest，标记为 `@slow` |
| **Snapshot 测试** | TUI 组件渲染输出 | 无外部依赖 | vitest + ink-testing-library |

### 11.2 关键测试用例

```typescript
// test/core/consensus.test.ts

describe('calculateConsensus', () => {
  it('3 个不同模型高度一致 → score > 0.8', () => {
    const reviews = mockReviews({ agents: 3, providers: 3, scoreSigma: 0.3 });
    const result = calculateConsensus(reviews, mockAgents(3, 3));
    expect(result.consensus_score).toBeGreaterThan(0.8);
    expect(result.model_diversity_factor).toBe(1);  // 3/3 = 完全多样
  });

  it('单模型多角色 → diversity factor 折减', () => {
    const reviews = mockReviews({ agents: 3, providers: 1, scoreSigma: 0.3 });
    const result = calculateConsensus(reviews, mockAgents(3, 1));
    expect(result.model_diversity_factor).toBeLessThan(0.5);  // 1/3 * 0.7
    expect(result.consensus_score).toBeLessThan(0.5);  // 即使评分一致也被折减
  });

  it('PARSE_ERROR 评审被排除', () => {
    const reviews = [
      mockValidReview(8), mockValidReview(7), mockParseErrorReview(),
    ];
    const result = calculateConsensus(reviews, mockAgents(3, 2));
    // 只用 2 个有效评审计算
    expect(result.consensus_score).toBeGreaterThan(0);
  });
});

// test/providers/credentials/discovery.test.ts
//   标准 API 收敛后 CredentialManager 是三方法薄壳（无 OAuth / keychain / CLI / token 刷新）；
//   TEST-04：对 tmpdir 走真实文件系统，不整体 mock node:fs（已无可隔离的 OAuth 面）。

describe('CredentialManager.getApiKey — 解析顺序', () => {
  it('api_key_env 优先于 api_key_path 与协议默认 env', () => {
    process.env['MY_CUSTOM_KEY'] = 'sk-from-env';
    const cm = new CredentialManager();
    expect(cm.getApiKey(makeConfig({ api_key_env: 'MY_CUSTOM_KEY' }))).toBe('sk-from-env');
  });

  it('回退 api_key_path（0o600 key 文件，内容 trim 去尾随换行）', () => {
    writeFileSync(keyPath, '  sk-from-file  \n');
    const cm = new CredentialManager();
    expect(cm.getApiKey(makeConfig({ api_key_path: keyPath }))).toBe('sk-from-file');
  });

  it('皆无 → 回退协议默认 env（anthropic→ANTHROPIC_API_KEY）；仍无 → null', () => {
    const cm = new CredentialManager();
    expect(cm.getApiKey(makeConfig({ protocol: 'anthropic' }))).toBeNull();
  });
});

describe('CredentialManager.discoverAll / resolveOfficialKey', () => {
  it('discoverAll 汇报 env 官方 key 与磁盘上的 custom-<name>.key', () => {
    process.env['OPENAI_API_KEY'] = 'sk-oai';
    writeFileSync(join(dir, 'custom-gw.key'), 'sk-custom', { mode: 0o600 });
    const report = new CredentialManager().discoverAll();
    expect(report['openai']).toEqual({ source: 'env', status: 'valid', env_var: 'OPENAI_API_KEY' });
    expect(report['custom:gw']).toEqual({ source: 'file', status: 'valid', path: join(dir, 'custom-gw.key') });
  });

  it('resolveOfficialKey 只读 env——绝不读 custom-<name>.key（后者绑定 base_url，非协议官方端点）', () => {
    writeFileSync(join(dir, 'custom-anthropic.key'), 'sk-ignored', { mode: 0o600 });
    expect(new CredentialManager().resolveOfficialKey('anthropic')).toBeNull();
  });
});

// test/storage/concurrency.test.ts

describe('ConcurrencyManager', () => {
  it('超过 global_resource_limit 时返回 false', () => {
    const db = new Database(':memory:');
    migrate(db);
    const mgr = new ConcurrencyManager(db, 3);

    expect(mgr.acquire('model-a', 5, 2)).toBe(true);   // 消耗 2
    expect(mgr.acquire('model-b', 5, 2)).toBe(false);  // 2+2=4 > 3
  });

  it('僵尸槽位被自动清理', () => {
    // 插入一个不存在 PID 的槽位
    db.prepare('INSERT INTO resource_slots VALUES (NULL, ?, 99999, ?, 1)')
      .run('model-a', new Date().toISOString());

    expect(mgr.acquire('model-a', 1, 1)).toBe(true);  // 僵尸被清理后可获取
  });
});
```

---

## 12. 分阶段实现计划

### Phase 0: 最小可运行原型（1-2 天）

**目标**：端到端跑通 `council "question"` → 多模型回答 → Chairman 综合 → stdout 输出

| 文件 | 内容 | 预估行数 |
|------|------|---------|
| `src/cli.ts` | commander 入口，仅主命令 | ~30 |
| `src/commands/council.ts` | 硬编码 2 模型，直接调用 | ~60 |
| `src/types/provider.ts` | InvocationAdapter 接口 | ~50 |
| `src/providers/api-adapter.ts` | ApiAdapter：可靠性骨架 + ProtocolClient 分派 | ~200 |
| `src/providers/protocol/*.ts` | ProtocolClient 契约 + Anthropic/OpenAI 双客户端 | ~180 |
| `src/providers/credentials/discovery.ts` | env key 探测 + key 文件存在性（薄壳） | ~80 |
| `src/core/orchestrator.ts` | 仅 Broadcast + Synthesis | ~100 |
| `src/core/prompt-builder.ts` | Broadcast + Synthesis prompt 模板 | ~60 |
| `src/ui/plain-renderer.ts` | stderr 进度 + stdout 结果 | ~40 |
| `src/types/*.ts` | 核心类型定义 | ~80 |
| `src/config/paths.ts` | 路径常量 | ~20 |

**合计**：~900 行。不含配置系统、持久化、TUI。

**验收标准**：
```bash
npx council "Redis vs Memcached 怎么选?"
# → 2 个模型并行回答 → Chairman 综合 → 输出到 stdout
# → stderr 显示进度 "✓ claude-opus (12.3s)" "✓ openai-o4mini (8.7s)"
```

### Phase 1: MVP + 配置系统（3-5 天）

在 Phase 0 基础上增加：

- `src/config/` — YAML 加载、zod 校验（v2 schema）、migrate.ts、预设目录
- `src/ui/wizard/first-run.ts` — 5 步引导（inquirer）
- `src/storage/session-store.ts` — Session JSON 写入
- `src/commands/models.ts` — `council models` 列出状态
- 本地凭证可解析性校验（env key 有值 / key 文件存在 / localhost）
- `council.yaml` + `models/*.yaml` 生成

### Phase 2: 完整辩论流程（3-5 天）

- `src/core/anonymizer.ts` — 三层匿名化
- `src/core/score-parser.ts` — Review JSON 解析 + fallback
- `src/core/consensus.ts` — 共识度计算（含 model_diversity_factor）
- `src/storage/checkpoint.ts` — Checkpoint 写入/恢复
- `src/storage/database.ts` — SQLite 初始化、sessions 表
- `src/storage/concurrency.ts` — resource_slots 原子调度
- 编排器扩展：Review → Consensus → 完整 debate 流程
- SIGINT 捕获 + 恢复提示

### Phase 3: 效果验证（3-5 天）

- `src/commands/benchmark.ts` — 四组消融实验
- `src/commands/rate.ts` — 用户评分
- `src/commands/history.ts` + `recall` — FTS5 搜索
- `src/commands/stats.ts` — 模型表现统计
- Release gate 自动检查

### Phase 4: 智能路由与完整配置（3-5 天）

- `src/core/router.ts` — keyword 路由、能力匹配
- `src/ui/wizard/` — 完整 setup 向导、model-add 向导
- `src/providers/health.ts` — L2+L3 检查、熔断器
- 动态权重 shadow mode
- `council history`、`council export`

### Phase 5: 高级 UX（3-5 天）

- `src/ui/tui/` — ink 组件：Dashboard、AgentStatus、ConsensusBar
- `src/ui/follow-up.ts` — 追问模式
- `src/core/compression.ts` — Pre-Synthesis Compression
- `src/commands/replay.ts` — 辩论回放
- `--copy`、快捷操作

---

## 13. 安全考量

| 风险 | 缓解措施 |
|------|---------|
| 凭证文件被意外读取 | key 文件路径来自配置的 `api_key_path`，落盘时 `0o600`（SEC-03）；父目录 `0o700` |
| API key 泄露到日志 / DTO | 日志层 redact `api_key_env` 的值与 key 文件内容；key 绝不进入 DTO / YAML / Session（SEC-02） |
| prompt 经命令行 / 进程列表暴露 | 无 subprocess 调用点（CLI 适配器已移除）；prompt 仅经 HTTPS 请求体发送，不入进程参数或 shell 历史（SEC-05） |
| Session JSON 明文存储 | 文件权限 `0o600`（SEC-03）；`--no-store` 模式不写盘（SEC-07） |
| 恶意模型名构造路径穿越 | 读写 / 删除模型 YAML 前经 `safePath` 校验，确认解析路径仍在 `models/` 目录内（SEC-04） |
| SQLite 注入 | 所有查询使用 prepared statement，无字符串拼接（SEC-01） |
| 依赖供应链 | pnpm lockfile 锁定版本；CI 中运行 `npm audit` |

---

## 14. 性能预期

| 场景 | 瓶颈 | 预估耗时 | 优化手段 |
|------|------|---------|---------|
| quick 模式 | 单次 API 调用 | 5-15s | 原生 HTTP 流式，无 subprocess 开销 |
| compare 模式（3 模型） | 最慢模型的响应时间 | 15-40s | 并行调用 |
| debate 模式（3 模型） | Broadcast + Review + Synthesis 串行 | 45-120s | Broadcast 并行；Review 并行 |
| 启动时间 | Node.js 启动 + 配置加载 + SQLite 连接 | ~200ms | tsup 单文件 bundle 减少模块解析 |
| 凭证解析 | 读 env / key 文件（本地，无网络） | < 1ms | 无 OAuth 刷新往返 |

---

## 附录 A: 依赖版本锁定

> 与 `package.json` 保持一致（以 `package.json` 为准）。标准 API 收敛后直接依赖官方 `@anthropic-ai/sdk` + `openai`，移除 `@mariozechner/pi-ai`（见 §1.3）。

```json
{
  "dependencies": {
    "@anthropic-ai/sdk": "^0.110.0",
    "@hono/node-server": "^2.0.8",
    "@inquirer/prompts": "^7.0.0",
    "better-sqlite3": "^12.8.0",
    "commander": "^12.0.0",
    "hono": "^4.12.27",
    "ink": "^7.0.1",
    "openai": "^6.45.0",
    "react": "^19.2.5",
    "yaml": "^2.0.0",
    "zod": "^3.0.0"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.13",
    "@types/node": "^22.0.0",
    "@types/react": "^19.2.14",
    "@vitest/coverage-v8": "2.1.9",
    "tsup": "^8.0.0",
    "typescript": "^5.0.0",
    "vitest": "^2.0.0"
  }
}
```

## 附录 B: 环境变量一览

| 变量 | 用途 | 说明 |
|------|------|------|
| `ANTHROPIC_API_KEY` | anthropic 协议官方端点凭证 | 向导内置探测 |
| `OPENAI_API_KEY` | openai 协议官方端点凭证 | 向导内置探测 |
| `<自定义>_API_KEY` | 兼容端点凭证（如 `DEEPSEEK_API_KEY`），由模型配置的 `api_key_env` 指定 | 用户显式配置 |
| `COUNCIL_HOME` | 自定义 Council 数据目录（默认 `~/.council`） | — |
| `COUNCIL_LOG_LEVEL` | 日志级别（debug/info/warn/error） | — |
| `NO_COLOR` | 禁用终端颜色（遵循 no-color.org 标准） | — |
