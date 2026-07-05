# Open Council — 技术设计文档 (TDD)

**Technical Design Document v2.2**

| 项目 | 内容 |
|------|------|
| 文档状态 | Draft |
| 版本 | 2.2 |
| 日期 | 2026-07-05 |
| 对应 PRD | docs/PRD.md v7.1 |
| 主语言 | TypeScript (Node.js ≥ 20) |
| 包管理 | pnpm |
| 分发方式 | npm 全局包 (`npm install -g open-council`) |

**修订记录**

| 版本 | 日期 | 变更 |
|------|------|------|
| 2.2 | 2026-07-05 | 新增 `src/server/` 层与 `web/` 零构建前端（`council serve` 本地 Web GUI，见 §8.4）；新增依赖 `hono` + `@hono/node-server`；`WebRenderer` 为 `Renderer` 第三实现。详见设计笔记 `docs/design-notes/web-gui-design.md` |
| 2.1 | 2026-07-04 | 依设计笔记 consensus-review-dataflow 同步实现：`ConsensusResult` 增 `agreement_score`（判停用）；`calculateConsensus` filter 纳入 partial；`kendallsW` 均值秩填补 + N=2 回退；`InvocationResult` 增 `truncated`；补 `role_generator_model` 配置项与 `InvocationTimeoutError` 错误类型 |
| 2.0 | 2026-03-26 | 迁移至 pi-ai 统一 LLM 层 |

---

## 1. 技术选型总览

### 1.1 语言与运行时

| 决策 | 选择 | 理由 |
|------|------|------|
| 语言 | **TypeScript 5.x** | pi-ai 和主流 Provider SDK 均以 TS 为一等公民；类型安全减少运行时错误 |
| 运行时 | **Node.js ≥ 20** | 原生 `fetch`、`crypto.subtle`（PKCE）、`node:test`；LTS 稳定 |
| 包管理 | **pnpm** | workspace 支持好、磁盘占用小、lockfile 确定性强 |
| 编译 | **tsup** (esbuild) | 编译为单个 CJS bundle，启动速度比 tsc 快 10x+ |

### 1.2 核心依赖

> 与 `package.json` 保持一致（以 `package.json` / 附录 A 为准）。凭证管理、Provider SDK、JWT 解码等已统一委托 `@mariozechner/pi-ai`，故不再单列 `jose` 等依赖（见 §1.3）。

| 模块 | 库 | 版本策略 | 选型理由 |
|------|-----|---------|---------|
| **统一 LLM 库** | `@mariozechner/pi-ai` | ^0.62 | 统一 LLM 接口，内置 20+ Provider 适配（Anthropic/OpenAI/Google/Mistral/Bedrock 等）、OAuth 凭证管理、模型自动发现、流式输出；替代原来分散的 3 个 Provider SDK |
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
| `@anthropic-ai/sdk` / `openai` / `@google/genai` | 已被 `@mariozechner/pi-ai` 统一替代；pi-ai 内部封装了这些 SDK，无需直接依赖 |
| `axios` | Node 20 原生 `fetch` 已足够；pi-ai 内部已封装 HTTP |
| `knex` / `drizzle` | SQLite 查询简单（< 10 种 query），直接用 `better-sqlite3` 的 prepared statement，无需 ORM 抽象 |
| `blessed` / `neo-blessed` | 过时，API 复杂；`ink` 的 React 范式更易维护 |
| `chalk` | `ink` 内置颜色支持；CLI 输出少量颜色用 ANSI 常量即可 |
| `ora` | spinner 逻辑简单，自行实现 < 20 行，避免多余依赖 |

### 1.4 分发策略

```bash
# 主分发渠道：npm 全局安装
npm install -g open-council

# 零安装试用
npx council "Redis vs Memcached 怎么选?"

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
│   │   ├── models.ts                 # council models / models add / models check
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
│   ├── providers/                  # 双模调用适配层
│   │   ├── adapter.ts                # 统一接口 invoke(config, prompt) → InvocationResult
│   │   ├── cli-adapter.ts            # CLI 模式：child_process.spawn + stdin/stdout pipe
│   │   ├── api-adapter.ts            # API 模式：通过 pi-ai 统一接口调用
│   │   ├── pi-ai-bridge.ts           # pi-ai 集成层：模型发现、凭证委托、Context 桥接
│   │   └── health.ts                 # 健康检查 (CLI L1-L3 + API L1-L3) + 熔断器
│   │
│   ├── storage/                    # 持久化层
│   │   ├── database.ts               # SQLite 初始化、迁移、表定义
│   │   ├── session-store.ts          # Session JSON 读写（文件系统）
│   │   ├── checkpoint.ts             # Checkpoint 写入 / 恢复 / 清理
│   │   ├── concurrency.ts            # resource_slots 原子调度
│   │   └── migration.ts              # schema_version 迁移逻辑
│   │
│   ├── config/                     # 配置管理
│   │   ├── loader.ts                 # YAML 加载 + 合并 + 校验
│   │   ├── schema.ts                 # zod schema（council.yaml + model YAML）
│   │   ├── presets.ts                # 内置预设库（CLI + API 双模）
│   │   └── paths.ts                  # 路径常量（~/.council/config、~/.codex/auth.json 等）
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
└── test/
    ├── core/                       # 编排引擎单元测试
    │   ├── orchestrator.test.ts
    │   ├── consensus.test.ts
    │   ├── anonymizer.test.ts
    │   └── router.test.ts
    ├── providers/                   # 适配层测试
    │   ├── cli-adapter.test.ts
    │   ├── api-adapter.test.ts
    │   └── credentials/
    │       └── discovery.test.ts
    ├── storage/                     # 持久化测试
    │   ├── database.test.ts
    │   ├── checkpoint.test.ts
    │   └── concurrency.test.ts
    ├── integration/                 # 集成测试（需要真实 CLI/API）
    │   ├── debate-flow.test.ts
    │   └── benchmark.test.ts
    └── fixtures/                    # 测试数据
        ├── sessions/
        ├── configs/
        └── credentials/              # mock 凭证文件
```

**关键设计决策**：

- `core/` 是**纯逻辑层**，不依赖 I/O、CLI、UI。它接收抽象的 `InvocationAdapter` 接口，可独立单元测试。
- `providers/` 是唯一与外部系统交互的层（subprocess、HTTP API、文件系统凭证读取）。
- `commands/` 薄层，只负责解析 CLI 参数 → 调用 `core/` → 通过 `ui/` 渲染结果。
- `ui/` 分为 `tui/`（ink 组件，Phase 5）和 `plain-renderer.ts`（Phase 0-4 的纯文本输出），通过 `process.stdout.isTTY` 自动切换。
- `server/` 是 `council serve` 的 HTTP 层，位于 core 之外的外层：可依赖 core/storage/config/providers/commands.shared，**core 严格不反向依赖**（ARCH-02）。它经 `Renderer` 接口接入编排（`WebRenderer`），**core 零改动**即可支撑 Web GUI（见 §8.4 与设计笔记 `web-gui-design.md`）。

---

## 3. 核心抽象与接口设计

### 3.1 Provider 调用适配层

这是系统的关键抽象——编排层不关心调用是通过 subprocess 还是 HTTP API 完成的。

```typescript
// src/providers/adapter.ts

export interface InvocationResult {
  response: string;                    // 模型回复的完整文本
  elapsed_ms: number;                  // 调用耗时
  invocation_mode: 'cli' | 'api';     // 实际使用的调用模式
  exit_code?: number;                  // CLI 模式：进程退出码
  http_status?: number;                // API 模式：HTTP 状态码
  stderr?: string;                     // CLI 模式：标准错误
  token_usage?: {                      // API 模式：token 用量
    input_tokens: number;
    output_tokens: number;
  };
  timed_out: boolean;
  truncated?: boolean;                 // 回答因达 max_tokens/长度上限被截断（有实质内容，与 timed_out 正交）；缺省 undefined ≡ false
}

// 截断回答照常参与 review/consensus/synthesis，orchestrator 仅发 onDegradation 提示，不剔除、不重试。
// 该字段随 Invocation.result 整体落盘到 Session JSON，无需新增 Invocation 顶层字段（见 PRD §3.4.3）。
// 注：review 的解析结果 ParsedReview（scores/strengths/weaknesses/devil_advocate_notes/reviewed_agent_id）
// 为运行期从 response_raw 重解析的派生结构，非落库 Invocation 字段。

/** pi-ai 的 ThinkingLevel 类型 */
export type ThinkingLevel = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

export interface InvocationAdapter {
  /**
   * 调用模型，返回完整响应。
   * 编排层通过此接口与所有模型交互，无需关心 CLI/API 差异。
   * @param stageEffort 阶段级推理深度覆盖（与模型配置的 reasoning_effort 取较高值）
   */
  invoke(config: ModelConfig, prompt: string, stageEffort?: ThinkingLevel): Promise<InvocationResult>;

  /**
   * 流式调用模型，通过 AsyncGenerator 逐 chunk 返回。
   * 用于 TUI 实时渲染。CLI 模式逐行读取 stdout，API 模式解析 SSE。
   * @param stageEffort 阶段级推理深度覆盖
   */
  stream(config: ModelConfig, prompt: string, stageEffort?: ThinkingLevel): AsyncGenerator<string, InvocationResult>;

  /**
   * 健康检查。CLI 模式检查 binary 存在 + version；API 模式检查凭证有效性。
   */
  healthCheck(config: ModelConfig): Promise<HealthStatus>;
}

export type HealthStatus = {
  level: 'healthy' | 'unhealthy' | 'degraded' | 'unavailable';
  message: string;
  checked_at: string;  // ISO 8601
};
```

**适配器选择逻辑**（`invocation: auto` 时的分派）：

```typescript
// src/providers/adapter.ts

export class AutoAdapter implements InvocationAdapter {
  constructor(
    private apiAdapter: ApiAdapter,
    private cliAdapter: CliAdapter,
  ) {}

  async invoke(config: ModelConfig, prompt: string): Promise<InvocationResult> {
    // 1. 如果有有效 API 凭证，优先 API 模式
    if (config.invocation === 'api' || config.invocation === 'auto') {
      const apiHealth = await this.apiAdapter.healthCheck(config);
      if (apiHealth.level === 'healthy') {
        return this.apiAdapter.invoke(config, prompt);
      }
    }

    // 2. 回退到 CLI 模式
    if (config.invocation === 'cli' || config.invocation === 'auto') {
      const cliHealth = await this.cliAdapter.healthCheck(config);
      if (cliHealth.level !== 'unavailable') {
        return this.cliAdapter.invoke(config, prompt);
      }
    }

    throw new ModelUnavailableError(config.name, 'No available invocation mode');
  }
}
```

### 3.2 CLI 适配器实现

```typescript
// src/providers/cli-adapter.ts

import { spawn } from 'node:child_process';

export class CliAdapter implements InvocationAdapter {
  async invoke(config: ModelConfig, prompt: string): Promise<InvocationResult> {
    const args = [...config.args, ...(config.model_args ?? [])];
    const start = Date.now();

    return new Promise((resolve, reject) => {
      const child = spawn(config.binary!, args, {
        env: { ...process.env, ...config.env },
        timeout: config.timeout_seconds * 1000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.on('data', (chunk) => { stderr += chunk; });

      // input_mode 处理
      if (config.input_mode === 'stdin') {
        child.stdin.write(prompt);
        child.stdin.end();
      }
      // arg 模式: prompt 已在 args 中作为最后一个参数

      child.on('close', (code) => {
        const elapsed = Date.now() - start;
        resolve({
          response: this.cleanOutput(stdout),
          elapsed_ms: elapsed,
          invocation_mode: 'cli',
          exit_code: code ?? 1,
          stderr: stderr || undefined,
          timed_out: false,
        });
      });

      child.on('error', (err) => {
        reject(new InvocationError(config.name, 'cli', err.message));
      });
    });
  }

  /** 去除 ANSI 色彩码、进度条等非内容输出 */
  private cleanOutput(raw: string): string {
    return raw
      .replace(/\x1b\[[0-9;]*m/g, '')  // ANSI escape codes
      .replace(/\r/g, '')               // carriage returns
      .trim();
  }
}
```

### 3.3 API 适配器实现（基于 pi-ai）

Council 的 API 模式通过 `@mariozechner/pi-ai` 统一接口调用所有 Provider，不再分别引入各 Provider SDK。

```typescript
// src/providers/api-adapter.ts

import {
  getModel, getModels, getProviders,
  streamSimple, completeSimple,
  supportsXhigh,
  type Context, type SimpleStreamOptions, type ThinkingLevel,
} from '@mariozechner/pi-ai';
import { getEnvApiKey } from '@mariozechner/pi-ai/env-api-keys';
import { getOAuthApiKey } from '@mariozechner/pi-ai/oauth';

export class ApiAdapter implements InvocationAdapter {
  /**
   * 通过 pi-ai 调用模型。pi-ai 自动处理：
   * - Provider SDK 选择（Anthropic/OpenAI/Google/Mistral/Bedrock...）
   * - 凭证获取（环境变量 > OAuth token > ADC）
   * - Token 过期自动刷新
   * - 推理深度（reasoning effort）跨 Provider 统一抽象
   * - 流式/非流式输出
   */
  async invoke(
    config: ModelConfig, prompt: string, stageEffort?: ThinkingLevel,
  ): Promise<InvocationResult> {
    const model = getModel(config.provider!, config.model!);
    const apiKey = await this.resolveApiKey(config.provider!);
    const start = Date.now();

    const context: Context = {
      systemPrompt: config.system_prompt,
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
    };

    // 解析 reasoning effort：stage_effort 与 model config 取较高值
    const reasoning = this.resolveEffort(config.reasoning_effort, stageEffort, model);

    const options: SimpleStreamOptions = {
      apiKey,
      reasoning,
      temperature: config.temperature,
      maxTokens: config.max_tokens,
    };

    try {
      const result = await completeSimple(model, context, [], options);

      return {
        response: result.content
          .filter((b) => b.type === 'text')
          .map((b) => b.text)
          .join(''),
        elapsed_ms: Date.now() - start,
        invocation_mode: 'api',
        http_status: 200,
        token_usage: result.usage ? {
          input_tokens: result.usage.inputTokens,
          output_tokens: result.usage.outputTokens,
        } : undefined,
        timed_out: false,
      };
    } catch (err) {
      throw new InvocationError(config.name, 'api',
        err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * 流式调用，通过 pi-ai 的 streamSimple() 返回事件流。
   * 自动应用 reasoning effort 配置。
   */
  async *stream(
    config: ModelConfig, prompt: string, stageEffort?: ThinkingLevel,
  ): AsyncGenerator<string, InvocationResult> {
    const model = getModel(config.provider!, config.model!);
    const apiKey = await this.resolveApiKey(config.provider!);
    const start = Date.now();

    const context: Context = {
      systemPrompt: config.system_prompt,
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
    };

    const reasoning = this.resolveEffort(config.reasoning_effort, stageEffort, model);

    const eventStream = streamSimple(model, context, [], {
      apiKey,
      reasoning,
      temperature: config.temperature,
      maxTokens: config.max_tokens,
    });
    let fullText = '';
    let usage: { inputTokens: number; outputTokens: number } | undefined;

    for await (const event of eventStream) {
      if (event.type === 'text') {
        fullText += event.text;
        yield event.text;
      }
      if (event.type === 'complete') {
        usage = event.usage;
      }
    }

    return {
      response: fullText,
      elapsed_ms: Date.now() - start,
      invocation_mode: 'api',
      http_status: 200,
      token_usage: usage ? {
        input_tokens: usage.inputTokens,
        output_tokens: usage.outputTokens,
      } : undefined,
      timed_out: false,
    };
  }

  /**
   * 解析最终使用的 reasoning effort。
   * 取 modelEffort 和 stageEffort 中较高的那个。
   * xhigh 不支持时自动降级为 high。
   */
  private resolveEffort(
    modelEffort?: string,
    stageEffort?: ThinkingLevel,
    model?: any,
  ): ThinkingLevel | undefined {
    const levels: ThinkingLevel[] = ['minimal', 'low', 'medium', 'high', 'xhigh'];
    const modelIdx = modelEffort ? levels.indexOf(modelEffort as ThinkingLevel) : -1;
    const stageIdx = stageEffort ? levels.indexOf(stageEffort) : -1;
    const maxIdx = Math.max(modelIdx, stageIdx);
    if (maxIdx < 0) return undefined;

    let resolved = levels[maxIdx];
    // xhigh 不支持时降级为 high
    if (resolved === 'xhigh' && model && !supportsXhigh(model)) {
      resolved = 'high';
    }
    return resolved;
  }

  /**
   * 凭证解析优先级：环境变量 > OAuth token。
   * 全部委托给 pi-ai，Council 不自行管理凭证。
   */
  private async resolveApiKey(provider: string): Promise<string> {
    // 1. 环境变量（pi-ai 自动检测对应的 env var）
    const envKey = getEnvApiKey(provider);
    if (envKey) return envKey;

    // 2. OAuth token（pi-ai 自动刷新过期 token）
    const oauthKey = await getOAuthApiKey(provider);
    if (oauthKey) return oauthKey;

    throw new CredentialNotFoundError(provider);
  }

  /**
   * 自定义 OpenAI 兼容端点分支（config.api_base_url 存在时进入）。
   * 完全绕过 pi-ai 的模型注册表，直接构造一个 Model<'openai-completions'> 字面量：
   * - 不继承任何注册模型的成本/上下文窗口假设
   * - `compat` 字段留空，由 pi-ai 根据 baseUrl 自动判断协议变体
   * - 用户可指向 ollama / vLLM / LM Studio / OneAPI / Azure OpenAI 等任意服务，无需 Council/pi-ai 维护注册表
   *
   * 凭证解析（resolveApiKey）三级优先级（与已注册 Provider 共用）：
   *   ① config.api_key_env 指定的环境变量（不存在 → InvocationError）
   *   ② config.api_credential_path 指向的密钥文件（整个文件 trim 后作为 key）
   *   ③ CredentialManager.getApiKey(provider) 回退（失败时返回空串）
   * 空 key 仅在 baseUrl 指向本地 host 时被允许（适配 ollama 默认无鉴权部署）。
   *
   * Provider 命名约定：`custom:<name>`，<name> 满足 [a-z0-9-]+。该字符串同时作为
   * circuit-breaker 的 key — 同一自定义 provider 的多个模型共享熔断状态。
   */
  private buildCustomModel(config: ModelConfig): Model<'openai-completions'> { /* ... */ }

  async healthCheck(config: ModelConfig): Promise<HealthStatus> {
    // 自定义端点分支：纯本地检查，不查 pi-ai registry。
    // - api_key_env 设置：检查环境变量是否存在且非空
    // - api_credential_path 设置：检查文件是否存在
    // - 都未设置：仅当 baseUrl 在 LOCAL_HOSTS 集合内时判定为 healthy
    //   LOCAL_HOSTS = { 'localhost', '127.0.0.1', '[::1]', '0.0.0.0' }
    if (config.api_base_url) { /* see source for branch logic */ }

    try {
      const apiKey = await this.resolveApiKey(config.provider!);
      return {
        level: apiKey ? 'healthy' : 'unavailable',
        message: apiKey ? 'API credentials available' : 'No credentials',
        checked_at: new Date().toISOString(),
      };
    } catch {
      return {
        level: 'unavailable',
        message: 'No credentials found',
        checked_at: new Date().toISOString(),
      };
    }
  }
}
```

**pi-ai 集成层**（模型发现与 Provider 注册）：

```typescript
// src/providers/pi-ai-bridge.ts

import { getProviders, getModels, getModel, supportsXhigh } from '@mariozechner/pi-ai';
import { getEnvApiKey } from '@mariozechner/pi-ai/env-api-keys';
import {
  getOAuthProviders,
  getOAuthApiKey,
  type OAuthProviderId,
} from '@mariozechner/pi-ai/oauth';

/**
 * 发现所有可用的 API Provider 和模型。
 * Council 的模型注册不再硬编码 Provider 列表，而是动态从 pi-ai 获取。
 */
export async function discoverApiModels(): Promise<DiscoveredProvider[]> {
  const results: DiscoveredProvider[] = [];

  for (const providerId of getProviders()) {
    // 检查是否有可用凭证
    const envKey = getEnvApiKey(providerId);
    const oauthProviders = getOAuthProviders();
    const hasOAuth = oauthProviders.some(p => p.id === providerId);

    let hasCredential = !!envKey;
    if (!hasCredential && hasOAuth) {
      try {
        const oauthKey = await getOAuthApiKey(providerId as OAuthProviderId);
        hasCredential = !!oauthKey;
      } catch {
        // OAuth 凭证不可用
      }
    }

    if (hasCredential) {
      const models = getModels(providerId);
      results.push({
        provider: providerId,
        authMethod: envKey ? 'env' : 'oauth',
        models: models.map(m => ({
          id: m.id,
          name: m.name ?? m.id,
          contextWindow: m.contextWindow,
          maxTokens: m.maxTokens,
          reasoning: m.reasoning ?? false,
          supportsXhigh: supportsXhigh(m),
        })),
      });
    }
  }

  return results;
}

interface DiscoveredModel {
  id: string;
  name: string;
  contextWindow?: number;     // pi-ai 动态提供
  maxTokens?: number;         // pi-ai 动态提供
  reasoning: boolean;         // 模型是否支持推理/思考
  supportsXhigh: boolean;     // 是否支持 xhigh 级别思考
}

interface DiscoveredProvider {
  provider: string;
  authMethod: 'env' | 'oauth';
  models: DiscoveredModel[];
}
```

### 3.4 凭证管理（委托给 pi-ai）

Council **不再自行实现**凭证解析、Token 刷新、OAuth 流程。所有鉴权逻辑统一委托给 `@mariozechner/pi-ai`。

**原有的 `src/providers/credentials/` 目录整体移除**，替换为 `src/providers/pi-ai-bridge.ts` 中的薄封装（见 §3.3）。

**pi-ai 鉴权能力总结**：

| 能力 | pi-ai 函数 | Council 原实现 |
|------|-----------|---------------|
| 环境变量 API Key | `getEnvApiKey(provider)` | `CredentialManager` 的 ENV_VARS 字典 → **删除** |
| OAuth 凭证发现 | `getOAuthProviders()` + `getOAuthApiKey()` | `CredentialManager` 的 `parseCredentialFile()` → **删除** |
| Token 自动刷新 | `getOAuthApiKey()` 内部自动处理 | `CredentialManager` 的 `refreshToken()` → **删除** |
| OAuth 登录流程 | `OAuthProviderInterface.login()` | 原计划 Phase 4+ 自行实现 → **不再需要** |
| 模型发现 | `getProviders()` + `getModels(provider)` | 硬编码预设列表 → **替换为动态发现** |
| 自定义 OAuth Provider | `registerOAuthProvider()` | 无 → **可扩展** |

**迁移影响**：

- 删除 `src/providers/credentials/` 目录（`discovery.ts`, `anthropic.ts`, `openai.ts`, `google.ts`, `types.ts`）
- 删除 `src/types/provider.ts` 中的 `ProviderCredential` 接口
- 新增 `src/providers/pi-ai-bridge.ts`（模型发现 + 凭证委托）
- `ApiAdapter` 简化为统一的 `complete()` / `stream()` 调用，不再 switch-case 各 Provider

#### 3.4.1 自定义 Provider 凭证存储约定

针对自定义 OpenAI 兼容端点（`config.api_base_url` 存在），Council 自行管理 raw API key 文件（pi-ai 不参与）：

| 项 | 约定 |
|----|------|
| 存储路径 | `~/.council/credentials/custom-<name>.key` |
| 文件 mode | `0o600`（chmodSync 显式设置，符合 SEC-03） |
| 父目录 mode | `0o700`（首次写入时 mkdirSync recursive） |
| 文件内容 | 单行 raw API key（读取时 trim 去尾随换行） |
| `<name>` 规则 | `[a-z0-9-]+`，由 first-run wizard 通过 `sanitizeProviderName()` 强制 |
| Provider 命名 | `provider: 'custom:<name>'`，作为 circuit-breaker key（同 name 下多模型共享熔断状态） |
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
function getProviderFamily(config: ModelConfig): string {
  if (config.provider) return config.provider;
  // CLI 模式通过 binary 推断
  const binary = config.binary ?? '';
  if (binary.includes('claude')) return 'anthropic';
  if (binary.includes('codex')) return 'openai';
  if (binary.includes('gemini')) return 'google';
  if (binary.includes('ollama')) return 'ollama';
  return binary;  // 未知工具以 binary 名作为 family
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

/** 模型配置 Schema */
export const ModelConfigSchema = z.object({
  // 通用字段
  name: z.string(),
  invocation: z.enum(['cli', 'api', 'auto']).default('auto'),
  provider: z.string().optional(),  // pi-ai 支持的所有 Provider ID（通过 getProviders() 动态获取）
  model: z.string().optional(),
  timeout_seconds: z.number().int().positive().default(120),
  capabilities: z.array(z.string()).default(['general']),
  priority: z.number().int().nonnegative().default(100),
  max_concurrent: z.number().int().positive().default(1),
  resource_weight: z.number().int().positive().default(1),
  enabled: z.boolean().default(true),

  // CLI 专用
  binary: z.string().optional(),
  model_args: z.array(z.string()).optional(),
  args: z.array(z.string()).optional(),
  input_mode: z.enum(['stdin', 'arg', 'file']).optional(),
  output_mode: z.enum(['stdout', 'file', 'json_field']).optional(),
  output_json_field: z.string().optional(),
  env: z.record(z.string()).optional(),
  health_check: z.object({
    command: z.array(z.string()),
    expect_exit_code: z.number().int().default(0),
    cache_seconds: z.number().int().default(300),
    timeout_seconds: z.number().int().default(10),
  }).optional(),

  // 推理与生成参数
  reasoning_effort: z.enum(['minimal', 'low', 'medium', 'high', 'xhigh']).optional(),
  temperature: z.number().min(0).max(2).optional(),
  max_tokens: z.number().int().positive().optional(),

  // API 专用
  api_credential_path: z.string().optional(),
  api_base_url: z.string().url().optional(),
  api_key_env: z.string().optional(),
  streaming: z.boolean().default(true),
}).refine(
  // CLI 模式必须有 binary + args + input_mode
  (data) => {
    if (data.invocation === 'cli') {
      return !!data.binary && !!data.args && !!data.input_mode;
    }
    return true;
  },
  { message: 'CLI mode requires binary, args, and input_mode' },
);

export type ModelConfig = z.infer<typeof ModelConfigSchema>;

/** 主配置 Schema */
export const CouncilConfigSchema = z.object({
  schema_version: z.number().int().default(1),

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
  credentials:  join(COUNCIL_HOME, 'credentials'),
  logs:         join(COUNCIL_HOME, 'logs'),
} as const;

// 凭证路径不再由 Council 管理，统一委托给 pi-ai
```

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

program.command('models').description('模型管理')
  .addCommand(new Command('list').description('列出所有模型').action(/* ... */))
  .addCommand(new Command('add').description('添加模型').action(/* ... */))
  .addCommand(new Command('check').description('健康检查').action(/* ... */))
  .addCommand(new Command('enable').argument('<id>').action(/* ... */))
  .addCommand(new Command('disable').argument('<id>').action(/* ... */))
  .addCommand(new Command('reset').argument('<id>').action(/* ... */))
  .addCommand(new Command('scan').action(/* ... */));

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

  // 2. 初始化各层（鉴权由 pi-ai 管理，无需手动创建 CredentialManager）
  const db = initDatabase(PATHS.database);
  const adapter = new AutoAdapter(
    new ApiAdapter(),   // 内部通过 pi-ai 的 getEnvApiKey / getOAuthApiKey 获取凭证
    new CliAdapter(),
  );
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
    const mode = result.invocation_mode === 'api' ? 'API' : 'CLI';
    process.stderr.write(
      `  ✓ ${agent.config.name} (${agent.role}) ${result.elapsed_ms / 1000}s [${mode}]\n`
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
import Spinner from 'ink-spinner';

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
          {'  '}<Spinner type="dots" /> {agent.name} ({agent.role}) [{modeTag}] {agent.elapsed}s
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
| `protocol.ts` | SSE 线协议 TS 类型（server 私有契约，纯类型无运行时代码，ARCH-04） |
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
| **适配器测试** | `providers/` CLI 适配器（mock subprocess）+ API 适配器（mock HTTP） | mock 外部调用 | vitest + msw (HTTP mock) |
| **存储测试** | `storage/` SQLite 操作、Checkpoint 读写、并发调度 | 临时 SQLite（`:memory:` 或 tmpdir） | vitest |
| **集成测试** | 完整 debate 流程端到端 | 需要至少 1 个真实 CLI/API 可用 | vitest，标记为 `@slow` |
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

describe('CredentialManager', () => {
  it('读取 ~/.codex/auth.json 并解析 OpenAI token', () => {
    // 使用 fixtures/credentials/codex-auth.json
    const manager = new CredentialManager();
    const cred = manager.parseCredentialFile('openai', fixturePath);
    expect(cred.access_token).toBeDefined();
    expect(cred.refresh_token).toBeDefined();
  });

  it('过期 token 自动刷新', async () => {
    // mock token endpoint
    const manager = new CredentialManager();
    // ... mock fetch
    const cred = await manager.getValidCredential('openai');
    expect(cred.expires_at).toBeGreaterThan(Date.now());
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
| `src/providers/adapter.ts` | InvocationAdapter 接口 + AutoAdapter | ~50 |
| `src/providers/api-adapter.ts` | Anthropic + OpenAI + Google SDK 调用 | ~150 |
| `src/providers/cli-adapter.ts` | spawn + stdin/stdout pipe | ~80 |
| `src/providers/credentials/discovery.ts` | 扫描凭证 + token 刷新 | ~180 |
| `src/core/orchestrator.ts` | 仅 Broadcast + Synthesis | ~100 |
| `src/core/prompt-builder.ts` | Broadcast + Synthesis prompt 模板 | ~60 |
| `src/ui/plain-renderer.ts` | stderr 进度 + stdout 结果 | ~40 |
| `src/types/*.ts` | 核心类型定义 | ~80 |
| `src/config/paths.ts` | 路径常量 | ~20 |

**合计**：~850 行。不含配置系统、持久化、TUI。

**验收标准**：
```bash
npx council "Redis vs Memcached 怎么选?"
# → 2 个模型并行回答 → Chairman 综合 → 输出到 stdout
# → stderr 显示进度 "✓ claude-opus (12.3s) [API]" "✓ gemini-pro (8.7s) [API]"
```

### Phase 1: MVP + 配置系统（3-5 天）

在 Phase 0 基础上增加：

- `src/config/` — YAML 加载、zod 校验、预设库
- `src/ui/wizard/first-run.ts` — 5 步引导（inquirer）
- `src/storage/session-store.ts` — Session JSON 写入
- `src/commands/models.ts` — `council models` 列出状态
- 健康检查 L1（CLI binary 存在 / API 凭证存在）
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
| 凭证文件被意外读取 | 凭证路径 hardcode，不接受用户任意路径输入；只读取已知格式 |
| token 泄露到日志 | pino 日志中 redact `access_token`、`refresh_token` 字段 |
| `input_mode: arg` 进程列表暴露 | 启动时 warn；配置引导标注风险；推荐 stdin |
| Session JSON 明文存储 | 文件权限 `0o600`；`--no-store` 模式不写盘 |
| refresh_token 写回失败 | catch + 日志记录，不阻塞主流程；下次使用时重新刷新 |
| SQLite 注入 | 所有查询使用 prepared statement，无字符串拼接 |
| 依赖供应链 | pnpm lockfile 锁定版本；CI 中运行 `npm audit` |

---

## 14. 性能预期

| 场景 | 瓶颈 | 预估耗时 | 优化手段 |
|------|------|---------|---------|
| quick 模式 | 单次 API 调用 | 5-15s | API 模式减少 1-3s subprocess 开销 |
| compare 模式（3 模型） | 最慢模型的响应时间 | 15-40s | 并行调用 |
| debate 模式（3 模型） | Broadcast + Review + Synthesis 串行 | 45-120s | Broadcast 并行；Review 并行 |
| 启动时间 | Node.js 启动 + 配置加载 + SQLite 连接 | ~200ms | tsup 单文件 bundle 减少模块解析 |
| 凭证刷新 | OAuth token refresh HTTP 调用 | 0.5-2s | 提前 60s 判定过期，在主流程前异步刷新 |

---

## 附录 A: 依赖版本锁定

> 与 `package.json` 保持一致（以 `package.json` 为准）。鉴权/Provider SDK 已统一委托 `@mariozechner/pi-ai`，不再直接依赖各家 SDK（见 §1.3）。

```json
{
  "dependencies": {
    "@hono/node-server": "^2.0.8",
    "@inquirer/prompts": "^7.0.0",
    "@mariozechner/pi-ai": "^0.62.0",
    "better-sqlite3": "^12.8.0",
    "commander": "^12.0.0",
    "hono": "^4.12.27",
    "ink": "^7.0.1",
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

| 变量 | 用途 | 优先级 |
|------|------|--------|
| `ANTHROPIC_API_KEY` | Anthropic API Key（替代 OAuth 凭证） | 最高 |
| `OPENAI_API_KEY` | OpenAI API Key | 最高 |
| `GEMINI_API_KEY` | Google Gemini API Key | 最高 |
| `COPILOT_GITHUB_TOKEN` / `GH_TOKEN` | GitHub Copilot Token | 最高 |
| `COUNCIL_HOME` | 自定义 Council 数据目录（默认 `~/.council`） | — |
| `COUNCIL_LOG_LEVEL` | 日志级别（debug/info/warn/error） | — |
| `NO_COLOR` | 禁用终端颜色（遵循 no-color.org 标准） | — |
