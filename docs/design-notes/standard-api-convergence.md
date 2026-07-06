# 标准 API 收敛（Standard-API Convergence）

| 属性 | 值 |
|------|-----|
| 主题 | 放弃订阅额度接入，收敛到「标准 API」双协议；弃用 pi-ai，改官方 SDK |
| 日期 | 2026-07-06 |
| 状态 | 设计定稿（待实施） |
| 触发 | 产品决策：厂商订阅额度接入（OAuth/CLI）效果差、不稳定；pi-ai 收敛后只剩两协议，价值不再，弃用 |
| 关联 | [information-architecture-review.md](./information-architecture-review.md)、[web-gui-config.md](./web-gui-config.md)、PRD §4.2、TDD §3.1–3.3 |

---

## 0. 决策摘要（TL;DR）

**范围变更**：Open Council 只支持**标准 API**，两种线协议：

- **anthropic 协议**（`@anthropic-ai/sdk` `messages.create`）—— 官方 Anthropic API，及任意 anthropic 兼容端点。
- **openai 协议**（`openai` `chat.completions.create`）—— 官方 OpenAI API，及任意 OpenAI 兼容端点（DeepSeek / Moonshot / Ollama / vLLM / LM Studio / Gemini 的 OpenAI 兼容端点等，靠 SDK 的 `baseURL` 参数）。

**凭证模型统一为**：`API key`（来自 env var 或 0o600 key 文件）+ 可选 `base_url`。**不再有** OAuth 登录、Token 刷新、keychain 读取、CLI subprocess 调用、订阅额度复用。

**pi-ai 去留（已拍板）**：**弃用 pi-ai**，依赖换官方 `@anthropic-ai/sdk` + `openai`。api-adapter 内部实现换 SDK，但对外 `InvocationAdapter` 契约不变。详见 §3。

**核心简化**：`resolveModel`（pi-ai 注册表模糊匹配）与所有 provider 家族映射表（`RELATED_PROVIDERS` / `LEGACY_TO_PIAI` / `OAUTH_ALSO_TRY` / `PIAI_TO_LEGACY` / `GOOGLE_FAMILY` / `PROVIDER_PRIORITY` / `PROVIDER_SUFFIX`）**全部删除**。每个模型都变成「SDK client（protocol + baseURL + apiKey）+ model id」。可靠性骨架（超时/重试/熔断/截断）保留在 api-adapter，SDK 差异下沉到两个薄客户端类。

---

## 1. 拆除清单（精确到文件 / 字段 / 函数）

图例：🗑 整文件删除 · ✂️ 局部删除 · ✏️ 改写 · ⬇️ 降级

### 1.1 CLI invocation 通道（整体拆除）

| 目标 | 处置 | 说明 |
|------|------|------|
| `src/providers/cli-adapter.ts` | 🗑 | 整个 `CliAdapter`（spawn/SIGTERM-SIGKILL/codex JSONL 解析/stdin EPIPE 守卫）删除 |
| `src/providers/adapter.ts`（`AutoAdapter`） | 🗑 | API-first + CLI 回退编排器删除。回退目标（CLI）不存在后无意义 |
| `CLI_FALLBACKS` / `tryCliFallback` / `mapCliParams` / `MappedParams` / `CliFallback` | 🗑 | 随 adapter.ts 删除 |
| `src/shared/env.ts` `hasBinary()` | 🗑（评估）| 仅 CLI 探测使用；收敛后调用点全消失 → 删除；文件若清空则删 |

所有原 `new AutoAdapter(new ApiAdapter(cm), new CliAdapter())` 调用点改为 `new ApiAdapter(cm)`（§1.7 调用点）。

### 1.2 OAuth / 凭证发现（大幅拆除，credentials/discovery.ts）

| 目标 | 处置 |
|------|------|
| `discoverOAuthCredentials()` / `discoverLegacyCredentials()` | 🗑 |
| `readCodexAuthFile()` / `readGeminiOAuthFile()` / `readClaudeCodeKeychain()` / `discoverGoogleProjectId()` | 🗑 |
| `login()` / `getLoginableProviders()` / `loadOAuthCredentials()` / `saveOAuthCredentials()` / `oauthCredentialPath()` | 🗑 |
| `getOAuthCredentials()` / `getPiaiProvider()` / `getDirectSource()` / `getAvailableProviders()` | 🗑 |
| `LEGACY_TO_PIAI` / `PIAI_TO_LEGACY` | 🗑 |
| `CachedCredential.source: 'oauth' \| 'legacy-file'` / `oauthCredentials` / `piaiProvider` | ✂️ 只保留 `'env' \| 'file'` |
| import `@mariozechner/pi-ai/oauth`、`getEnvApiKey`、`OAuthCredentials`/`OAuthLoginCallbacks` | 🗑（getEnvApiKey → 直接读 `process.env`） |
| `KNOWN_CREDENTIALS`（paths.ts） | 🗑 |

**收敛后的 `CredentialManager`**（✏️ 薄壳，§2.2）：只保留「env var 探测（ANTHROPIC_API_KEY / OPENAI_API_KEY）+ 0o600 key 文件存在性」，供向导/GUI 报告用。api-adapter 的 key 解析内联（§2.6），不再经 pi-ai。

### 1.3 家族映射表（全删）

`RELATED_PROVIDERS`/`GOOGLE_FAMILY`（api-adapter）、`LEGACY_TO_PIAI`/`PIAI_TO_LEGACY`（credentials）、`OAUTH_ALSO_TRY`（discovery）、`PROVIDER_PRIORITY`/`PROVIDER_SUFFIX`/`bareNameRank`/`providerSuffix`（assembly）—— 全删。

**收敛后「同 id 冲突面」还剩多少？** 官方 anthropic/openai 各一个端点，family 内部消歧（google/vertex/antigravity/codex 同 id）**完全消失**。但**自定义端点之间仍可能冲突**（两个网关都暴露 `gpt-4o`）。因此 `resolveModelNames` 去重/唯一化**保留**，判据从「family 优先级」简化为「官方持裸名、自定义端点后缀 source 标签、末尾 `-2/-3` 兜底」。`modelDedupeKey` 从 `(name, provider)` 改为 `(name, base_url)`。

### 1.4 api-adapter.ts（✏️ 内部换 SDK，骨架保留）

| 目标 | 处置 |
|------|------|
| `resolveModel()` / `applyOAuthModifications()` / invoke 中「pi-ai 注册表」整条分支 | 🗑 |
| `buildCustomModel()`（构造 pi-ai `Model<Api>` 字面量） | 🗑 → 由 `ProtocolClient` 工厂取代（§2.4） |
| `invokeStreaming()` / `invokeComplete()` 中对 `streamSimple`/`completeSimple` 的调用体 | ✏️ 改调 `ProtocolClient.stream/complete`，返回归一化结果（§2.5） |
| import `@mariozechner/pi-ai`（getModel/getModels/streamSimple/completeSimple/类型 Api/Model/KnownProvider）、`/oauth` | 🗑 |
| `createTimeoutGuard`（空闲超时）/ `withRetry`（退避）/ `backoffDelay` / `executeWithHealth` / 熔断记账 / `defaultMaxTokens` / `extractText` / 截断标记 / usage 兜底 | ✅ **保留**（可靠性骨架，§2.1）—— guard 的「racing expired promise」兜底可简化（§2.3） |
| circuit-breaker「falling back to CLI」文案 | ✏️ 改「skip model / fail fast」 |

### 1.5 model-discovery.ts（✏️ 改用官方 `/models` 端点）

- 🗑 `OAUTH_ALSO_TRY`、OAuth 扩展循环、`modifyModels`、`discoverCliModels()`、`DiscoveredModel.invocation`、pi-ai `getModels`。
- ✏️ `discoverModels()`：`ANTHROPIC_API_KEY` 存在 → `anthropicClient.models.list()`；`OPENAI_API_KEY` 存在 → `openaiClient.models.list()`。**比 pi-ai 静态注册表更准**——反映账号实际可访问模型。离线/无 key → 回退硬编码目录（§1.7）。自定义端点由用户手填 model id（openai 兼容端点的 `/models` 自动枚举为可选增强，本波不做）。
- `DiscoveredModel` 新形态：`{ id, name, protocol: 'anthropic'|'openai', source: 'official' }`。

### 1.6 model-assembly.ts（✂️ 塌缩 family 命名）

- 🗑 `PROVIDER_PRIORITY`/`PROVIDER_SUFFIX`/`bareNameRank`/`providerSuffix`。
- ✏️ `resolveModelNames`：官方持裸名；自定义端点后缀 = sanitize(source 标签)；`-cli` 后缀删；`-2/-3` 唯一化保留。
- ✏️ `discoveredToModelConfig`：删 CLI 分支（binary/args/input_mode），产出 `protocol`+`model`。
- ✏️ `buildCustomModelConfig`：`provider: 'custom:<name>'` 保留为标签，新增 `protocol`（默认 `'openai'`），`api_credential_path`→`api_key_path`。
- ✏️ `selectBestChairman`/`rateModelCapability`：删 `invocation === 'cli'` 分支。

### 1.7 CLI 硬编码目录 & presets & 目录真相源

| 目标 | 文件 | 处置 |
|------|------|------|
| `MODEL_CATALOG` 的 `cliModels`/`binary`/`cliOrder`/`catalogForBinary` | shared/model-catalog.ts | ✂️ 删 CLI 维；保留 flagship/balanced/economy + `apiKeyEnv`（仅 anthropic/openai） |
| **pi-ai `getModels` 对目录的校验（`safeGetModels`/`resolveTier`/guard test）** | shared/model-catalog.ts | 🗑 → 目录变**硬编码字面量**（无 pi-ai 校验，见下方 trade-off） |
| `MODEL_PRESETS` 所有 `invocation: 'cli'` 项 | config/presets.ts | 🗑 |
| `discoverModelsFromEnv()` OAuth/CLI/google 分支 | config/presets.ts | ✂️ 只留 env-var → 官方 anthropic/openai |
| `presetToModelConfig` binary/args/input_mode | config/presets.ts | ✂️ |

> **Trade-off（接受）**：pi-ai 弃用后，静态目录失去 pi-ai 注册表的「ID 真实性」校验，可能与厂商实际模型漂移。缓解：目录仅用于「无 key 时的兜底建议」，有 key 时以 §1.5 的 live `/models` 为准；ID 硬编码需手工维护（用 `defaults/` 或常量集中一处）。被否：继续依赖 pi-ai 仅为拿目录——与「弃用 pi-ai」决策冲突。

### 1.8 health.ts —— ✅ 保留（熔断器 + 节流）

- `BASE_THROTTLE` 键 `google` 删；留 `anthropic`/`openai`，自定义端点默认 1000ms。
- 「skip API → go straight to CLI」文案 ✏️（语义改快速失败）。

### 1.9 向导（first-run.ts，✏️ 重写，§5）

删：`runOAuthLogins`/`getLoginableProviders`/`missingProviders` 分支、`PROVIDER_DISPLAY_NAMES` family 项、provider family checkbox、`credentialHint` 的 CLI/OAuth 文案、CLI binary 探测、`testConnectivity` 的 CLI 分支。保留并前置：env-var 快速路径 + 自定义端点录入。

### 1.10 server/config-routes.ts

- ✏️ `/setup/rescan`：不再触发 OAuth 发现；改「探测 env var + 列已配置 key 文件 + 两官方目录建议」。`RescanSummaryDTO.credentials.source ∈ {'env','file'}`。
- ✏️ `toModelDTO`：`isCustom` 判据改 `base_url !== undefined`；去 `invocation` 字段。
- custom endpoint POST + `buildCustomModelConfig`：✅ 保留，增可选 `protocol`。

### 1.11 类型层（types/，ARCH-04）

| 目标 | 处置 |
|------|------|
| `types/config.ts` `InvocationMode`、`ModelConfig.invocation`、CLI 字段块 | 🗑 |
| `api_base_url`→`base_url`、`api_credential_path`→`api_key_path`；新增 `protocol`、`legacy_disabled_reason` | ✏️ |
| `types/provider.ts` `InvocationResult.invocation_mode: 'cli' \| 'api'` | ✏️ 新写恒 `'api'`；读旧 session 容忍 `'cli'`。CLI 专属字段 `exit_code`/`stderr` 标注历史遗留 |

### 1.12 依赖（package.json）

- 🗑 `@mariozechner/pi-ai`。
- ➕ `@anthropic-ai/sdk`、`openai`（TDD §1.3 曾把二者标为「被 pi-ai 替代」——现回归直接依赖）。
- `@types/*`：两 SDK 自带类型，无需额外。

### 1.13 测试（大面积失效，§7 风险）

🗑 `cli-adapter.test.ts`、`adapter.test.ts`、`table-symmetry.test.ts`、model-catalog 的 pi-ai guard test。
✏️ 重写 `credentials/discovery.test.ts`、`api-adapter.test.ts`（SDK mock 取代 pi-ai mock）、`model-discovery.test.ts`、`model-assembly.test.ts`、`presets.test.ts`、wizard/config-routes 测试。

---

## 2. 保留面与新数据模型

### 2.1 保留的可靠性能力（骨架不动，实现换 SDK）

重试（指数退避+jitter）、熔断器（`health.ts`）、**空闲**超时守卫、`truncated` 截断标记、usage 缺失兜底、AbortError→timeout 重分类、`reasoning_effort` 分层 max_tokens —— 全部保留在 api-adapter，只把「调 pi-ai」换成「调 ProtocolClient」。

**重试策略与 SDK 原生重试的关系（关键）**：官方 SDK 自带 `maxRetries`（默认 2）与 `timeout`。**必须把 SDK 的 `maxRetries` 设为 `0`**，由我们自己的 `withRetry` 统管——因为我们的重试要协调 (a) 流式已 emit 则不重试（避免重复吐字）、(b) 熔断器分类只记一次、(c) 自适应节流。让 SDK 在底层偷偷重试会双重重试并对熔断器隐藏失败。SDK 的 `timeout` 可设很大或依赖我们的空闲 guard。

### 2.2 收敛后的凭证模型

```
凭证 = API key，来源二选一（或无）：
  1. api_key_env  → 读环境变量
  2. api_key_path → 读 0o600 key 文件（SEC-02：key 永不进 YAML/DTO/日志）
  3. 皆无         → 空串（localhost 无鉴权，如 ollama）
可选 base_url：省略 → 协议官方端点
```
`CredentialManager` 薄壳：`discoverEnvKeys()`（仅两 env）+ 文件存在性。无 OAuth/keychain/pi-ai。

### 2.3 新 ModelConfig Schema（zod + TS）

**决策：`protocol` + `base_url`，而非 `provider` 枚举**（provider 混淆身份与协议；protocol+baseURL 正交，直接对应 SDK 选择）。`provider` 降级为可选展示/熔断键标签。

```typescript
// src/config/schema.ts
export const OFFICIAL_BASE_URL = {
  anthropic: 'https://api.anthropic.com',
  openai:    'https://api.openai.com/v1',
} as const;

export const ModelConfigSchema = z.object({
  name: z.string(),
  protocol: z.enum(['anthropic', 'openai']),   // 取代 invocation + provider 语义 → 选哪个 SDK
  model: z.string(),                            // 透传给端点的 model id
  base_url: z.string().url().optional(),        // 省略 → OFFICIAL_BASE_URL[protocol]

  api_key_env: z.string().optional(),
  api_key_path: z.string().optional(),
  provider: z.string().optional(),              // 展示 / 熔断键标签（默认派生）

  reasoning_effort: z.enum(['minimal','low','medium','high','xhigh']).optional(),
  temperature: z.number().optional(),
  max_tokens: z.number().int().positive().optional(),

  timeout_seconds: z.number().int().positive().default(120),
  capabilities: z.array(z.string()).default(['general']),
  priority: z.number().int().nonnegative().default(100),
  max_concurrent: z.number().int().positive().default(1),
  resource_weight: z.number().int().positive().default(1),
  enabled: z.boolean().default(true),
  streaming: z.boolean().default(true),

  legacy_disabled_reason: z.string().optional(),
});
```
**删字段**：`invocation`/`binary`/`model_args`/`args`/`input_mode`/`output_mode`/`output_json_field`/`env`/`health_check`。**重命名**：`api_base_url`→`base_url`、`api_credential_path`→`api_key_path`。删原 `.refine('CLI mode requires binary...')`。`schema_version` 默认 `1`→**`2`**（§4）。

### 2.4 `ProtocolClient` 抽象（SDK 差异下沉，骨架保持协议无关）

api-adapter 不再散落 SDK 细节，而是面向一个内部接口编程；两个薄类隔离 SDK 差异。这是比现状（单文件塞满 pi-ai 细节）**更干净**的分层。

```typescript
// src/providers/protocol/types.ts
export interface NormalizedEvent { textDelta: string; }
export interface NormalizedResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
  truncated: boolean;         // anthropic stop_reason==='max_tokens' | openai finish_reason==='length'
}
export interface GenRequest {
  model: string; prompt: string; maxTokens: number;
  temperature?: number; reasoningEffort?: ReasoningEffort; signal: AbortSignal;
}
export interface ProtocolClient {
  /** 流式：逐块回调 textDelta，返回最终归一化结果。 */
  stream(req: GenRequest, onEvent: (e: NormalizedEvent) => void): Promise<NormalizedResult>;
  /** 非流式：一次性归一化结果。 */
  complete(req: GenRequest): Promise<NormalizedResult>;
}

// 工厂：按 config 造/复用 client（可按 (protocol,baseURL,apiKey) 记忆化）
export function makeProtocolClient(config: ModelConfig, apiKey: string): ProtocolClient;
```

- **AnthropicClient**（`src/providers/protocol/anthropic-client.ts`）：`new Anthropic({ apiKey, baseURL, maxRetries: 0, timeout })`；`messages.create({ model, max_tokens, temperature, messages:[{role:'user',content}], stream, thinking? }, { signal })`。thinking 由 `reasoningEffort` 映射为 `{ type:'enabled', budget_tokens }`（或省略）。
- **OpenAIClient**（`.../openai-client.ts`）：`new OpenAI({ apiKey, baseURL, maxRetries: 0, timeout })`；`chat.completions.create({ model, max_tokens, temperature, messages, stream, stream_options:{include_usage:true}, reasoning_effort? }, { signal })`。

> 兼容端点鲁棒性：部分 OpenAI 兼容端点不支持 `stream_options.include_usage` / `reasoning_effort` / `max_tokens`(要 `max_completion_tokens`)。OpenAIClient 内做温和降级（usage 缺失→0；不支持字段可先按官方发，端点报错则纳入 error-classifier 的 permanent）。这是集中在**一个类**里的已知维护点。

### 2.5 流式事件映射（两 SDK → 归一化）

| 归一化 | anthropic SDK | openai SDK |
|--------|---------------|------------|
| textDelta | `content_block_delta` 且 `delta.type==='text_delta'` → `delta.text` | chunk `choices[0].delta.content` |
| inputTokens | `message_start.message.usage.input_tokens` | 末块 `usage.prompt_tokens`（需 include_usage） |
| outputTokens | `message_delta.usage.output_tokens`（累计） | 末块 `usage.completion_tokens` |
| truncated | 终态 `stop_reason==='max_tokens'` | `finish_reason==='length'` |
| 非流式 text | `message.content` 里 `type==='text'` 拼接（`extractText` 逻辑复用） | `choices[0].message.content` |

空闲超时 guard 在 `stream` 消费循环里对每个 event `reset()`；SDK 原生尊重 `AbortSignal`，超时 abort → SDK 抛 `APIUserAbortError` → 我们 `guard.timedOut` 重分类为 `InvocationTimeoutError`。可**简化**掉现有 guard 的 `expired` racing promise（那是防 pi-ai 忽略 signal 的兜底；官方 SDK 忠实 abort，留 AbortController 即可）。

### 2.6 错误分类（更干净）

官方 SDK 抛**结构化错误对象**（`Anthropic.APIError` / `OpenAI.APIError`，带 `.status`；`RateLimitError`=429、`APIConnectionError`/`APIConnectionTimeoutError`=网络）。`error-classifier.ts` 现有 `extractStatus(.status/.statusCode)` 直接命中——**status 驱动成为主路径**，字符串关键字匹配降级为「非 APIError 兜底」（如某兼容网关抛裸文本）。`isRateLimit` 优先用 `err instanceof RateLimitError || status===429`。注释更新：不再提「pi-ai 把错误 stringify」。api-adapter 的 key 解析 `resolveApiKey`（env→file→''）保留，去掉对 pi-ai CredentialManager 的家族回退。

### 2.7 InvocationAdapter 接口契约（**不破坏**）

```typescript
InvocationAdapter { invoke, healthCheck }   // 实际签名（无 stream 方法；流式经 invoke 的 onChunk 回调）
```
`ApiAdapter implements InvocationAdapter` 保持，`invoke(config, prompt, onChunk?)` / `healthCheck(config)` 签名不变。**破坏点仅在实现层**：删 `AutoAdapter`/`CliAdapter` 两个实现类、内部换 SDK。**core 层零改动**——ARCH-05 接口边界是本次「换引擎不动核心」的关键。`healthCheck` 简化为本地判断（api_key_env 有值 / api_key_path 存在 / localhost 无鉴权），无网络调用。

### 2.8 持久化兼容

旧 session 的 `invocation_mode==='cli'`/`exit_code`/`stderr` 仍可能存在；读取类型保留宽松 `'cli'|'api'`，新写恒 `'api'`，不迁移历史 session。

---

## 3. pi-ai 移除（产品决策，不可协商）

**决策**：移除 `@mariozechner/pi-ai`，api-adapter 内核换 `@anthropic-ai/sdk` + `openai` 官方 SDK。openai SDK 的 `baseURL` 天然覆盖一切 OpenAI 兼容端点。这是用户 2026-07-06 的直接产品决策——收敛后 pi-ai 只剩两协议 invoke，其核心价值（20+ provider 适配 + OAuth）全被放弃，留着等于扛一个大依赖只用其零头。官方 SDK 直白、类型一等公民、错误对象结构化（分类更干净）、原生 AbortSignal。pi-ai 内部本就是包这两个 SDK，去中间层无能力损失。

**替换范围（澄清：不是大重写）**：超时守卫 / 重试退避 / 错误分类 / 截断检测**全部包在 `invoke` 调用的外层**（`executeWithHealth`/`withRetry`/`createTimeoutGuard`），换的只是最内两个点——`streamSimple` / `completeSimple`。接口签名不变，583 测试兜底语义。

### W2 实施注意事项 / 重接清单（= api-adapter 工作项验收要点）

原「风险论证」降级为下面的重接检查项；每项都是 W2a 的验收门槛，逐项过测即完成：

| # | 重接点 | 要求 | 参见 |
|---|--------|------|------|
| R1 | AbortSignal 透传 | 空闲 guard 的 `signal` 传入两 SDK 请求选项（anthropic `{ signal }`、openai `{ signal }`）；超时 abort → SDK 抛 `APIUserAbortError` → 重分类 `InvocationTimeoutError`。可删现有防 pi-ai 的 `expired` racing promise | §2.5 |
| R2 | SDK 原生错误类型接入现有 `classifyError` | 不重写分类器；`APIError.status` 直接命中现有 `extractStatus` → status 主路径；字符串匹配降为非-APIError 兜底；`isRateLimit` 优先 `instanceof RateLimitError \|\| status===429` | §2.6 |
| R3 | 流式事件映射 | anthropic `content_block_delta.text_delta` / openai `choices[0].delta.content` → `onChunk` | §2.5 表 |
| R4 | usage 字段映射 | anthropic `input_tokens/output_tokens`（message_start + message_delta）/ openai `prompt_tokens/completion_tokens`（需 `stream_options.include_usage`）→ `token_usage`；缺失兜底 0 | §2.5 表 |
| R5 | stop_reason/finish_reason → `truncated` | anthropic `stop_reason==='max_tokens'` / openai `finish_reason==='length'` → `truncated:true` | §2.5 表 |
| R6 | SDK 原生 `maxRetries` 设 **0** | 否则与自研 `withRetry` 双重叠加、对熔断器隐藏失败 | §2.1 |
| R7 | 兼容端点字段降级 | `stream_options`/`reasoning_effort`/`max_tokens(→max_completion_tokens)` 支持差异，集中在 OpenAIClient 一处温和降级 | §2.4 |

**验收口径**：`InvocationAdapter` 契约不变，**现有 provider 测试语义全过**（pi-ai mock 换 SDK mock，断言的行为语义不变）。

**放弃的能力（可接受）**：pi-ai 目录 ID 真实性校验、pi-ai 未来自动新增 provider——与「只要两协议」的收敛方向一致，由 §1.5 live `/models` 补偿。

---

## 4. 配置迁移（真实环境 28 模型）

**决策：非破坏式迁移 —— 可转换即转、不可转换「禁用+标注」保留，绝不硬报错、绝不静默丢弃、绝不伪造必失败模型。** `schema_version` 升 `1→2`，首次加载检测 `<2` 触发一次性迁移（新增纯函数 `src/config/migrate.ts`，逻辑与文件写分离），重写 model YAML + 升版，向 stderr 打印摘要。

| 旧模型形态 | 新处置 | 结果 |
|-----------|--------|------|
| `invocation: api/auto` + `api_base_url` + key（已是自定义端点） | 自动转换：`protocol:'openai'`、`base_url`←`api_base_url`、`api_key_path`←`api_credential_path` | ✅ enabled |
| `provider: anthropic` + 有 `ANTHROPIC_API_KEY`/api_key_env | 自动转换：`protocol:'anthropic'` 官方 | ✅ enabled |
| `provider: openai` + 有 `OPENAI_API_KEY` | 自动转换：`protocol:'openai'` 官方 | ✅ enabled |
| `provider: anthropic/openai` 仅靠 OAuth/订阅（无 env、无 key 文件） | 禁用+标注：`需要 API key（设置 ANTHROPIC_API_KEY/OPENAI_API_KEY 或重跑 council setup）` | ⛔ disabled |
| `invocation: cli`（claude/codex/gemini binary） | 禁用+标注：`CLI 模式已移除，请改用标准 API` | ⛔ disabled |
| `provider: google/google-*` | 禁用+标注：`Gemini 请改用其 OpenAI 兼容端点（protocol: openai, base_url: …/v1beta/openai）` | ⛔ disabled |
| `provider: github-copilot` | 禁用+标注：`Copilot 订阅接入已移除` | ⛔ disabled |

迁移后 `prefer`/`default_chairman`/`role_generator_model` 若指向被禁用模型，保留引用（运行时有 `selectStrongestModel`/`chairmanWarning` 兜底），摘要额外提示。禁用模型仍在 `council models list`（带 reason），补 key 后可重启用。**为何不自动转换 OAuth/google/cli**：无法凭空得到可用 API key；自动「转换」只造必失败模型，禁用+清晰指引更诚实。

---

## 5. 向导 / GUI 简化后的形态

### 5.1 CLI 向导（first-run.ts）
1. 探测 `ANTHROPIC_API_KEY`/`OPENAI_API_KEY` → 有则列对应官方模型（`discoverModels` 走 §1.5 live `/models`）。
2. 无 env → 直接引导「添加标准 API 模型」：选 protocol、填 model id、填 base_url（默认官方，可改兼容端点）、填 key（env 名 或 直接输入落 0o600 文件）。
3. Chairman / 默认模式 / agent 数量（不变）。

删：OAuth 登录、provider family checkbox、CLI binary 发现、`credentialHint` OAuth/CLI 文案。自定义端点录入（`collectCustomProviders`）升为主路径，允许选 protocol。

### 5.2 Web GUI 设置页
- **凭证分区**：OAuth 状态/keychain → env var 探测（存在/缺失）+ key 文件（仅存在性）。
- **模型分区**：不变；DTO 去 `invocation`，`isCustom` 判据改 `base_url`。
- **自定义端点**：POST `/api/providers/custom` 不变，增可选 `protocol`（默认 openai）。
- **rescan**：只扫 env + key 文件 + 两官方目录；`source ∈ {'env','file'}`。

---

## 6. 文档修订面

| 文档 | 修订 |
|------|------|
| **PRD** | **v7.2 → v8.0**（范围变更）。改写 §1「CLI/API 双模」为「标准 API 双协议」；删「订阅额度/Zero-Cost First/OAuth 五 provider 表」；§4.2 凭证改「API key（env/文件）+ base_url」；§3.4.3 `invocation_mode`/`exit_code`/`stderr` 标注历史遗留；模型配置示例改 protocol schema |
| **TDD** | **v2.3 → v3.0**。删 §3.1 AutoAdapter/CliAdapter 与「适配器选择逻辑」；§3.3 ApiAdapter 改写为 ProtocolClient 双 SDK；**依赖表：移除 pi-ai，加 `@anthropic-ai/sdk`+`openai`（撤销 §1.3「被 pi-ai 替代」条目）**；删 pi-ai-bridge.ts 叙述；ModelConfig 表更新；新增迁移（schema_version 2）小节 |
| **README** | 删 CLI 模式/订阅叙述；配置示例改 protocol；凭证说明改 env/key 文件；安装依赖变更 |
| **CONTRIBUTING** | 检查是否引用 `invocation: cli`/CLI 适配器；SEC-01 subprocess 条款保留但注明当前无 subprocess 调用点 |
| **design-notes** | 本篇已登记；`web-gui-config.md` 凭证入线边界注明 OAuth 作废 |
| **CLAUDE.md** | 「技术栈」pi-ai → 两官方 SDK；provider-dev 职责删 CLI/Token 刷新；文档指针版本号更新 |

---

## 7. 分批实施建议（波次 + 依赖 + 风险）

| 波次 | 工作项 | 负责 agent | 依赖 | 并行性 |
|------|--------|-----------|------|--------|
| **W0（本篇）** | schema/类型/ProtocolClient 契约定稿 | architect | — | — |
| **W1 地基** | `types/config.ts` + `config/schema.ts`（protocol schema、删 CLI 字段、schema_version=2、OFFICIAL_BASE_URL）；`package.json` 换依赖（-pi-ai +两 SDK） | cli-dev(config) | W0 | 串行（阻塞下游） |
| **W2a api-adapter 重写**（独立工作项） | ProtocolClient 接口 + AnthropicClient + OpenAIClient；api-adapter invoke 体改调（R1–R7 重接清单，§3）；错误分类改 status 主路径；删 resolveModel/family/adapter.ts/cli-adapter.ts。**验收 = 现有 provider 测试语义全过（pi-ai mock→SDK mock，断言行为不变）** | provider-dev | W1 | 与 W2b/c 并行 |
| **W2b 凭证瘦身** | credentials/discovery.ts → env+file 薄壳；删 OAuth/keychain/legacy/getEnvApiKey；paths.ts 删 KNOWN_CREDENTIALS | provider-dev | W1 | 并行 |
| **W2c 发现/装配/目录** | model-discovery（live `/models`）、model-assembly（塌缩命名）、model-catalog（硬编码，删 pi-ai 校验）、presets | provider-dev | W1 | 并行 |
| **W3 迁移** | `config/migrate.ts` + loader 挂载（schema_version<2 触发） | cli-dev(config) | W1,W2 | 依赖 schema |
| **W4a 调用点** | 8 处 `new AutoAdapter(...)` → `new ApiAdapter(cm)` | cli-dev + provider-dev | W2a | 集成点 |
| **W4b 向导/GUI** | first-run.ts 重写、config-routes rescan/DTO、runtime-config | cli-dev | W2,W3 | 与 W4a 协调 |
| **W5 测试** | 删 4 个测试文件；重写 SDK-mock 测试（api-adapter/discovery/assembly/presets/wizard/config-routes） | tester | W2–W4 | Step 3 |
| **W6 文档** | PRD v8.0 / TDD v3.0 / README / CLAUDE.md / CONTRIBUTING | doc-keeper | W1–W4 | 与 W5 并行 |

**风险点（测试大面积失效 + 实施校验）**：
- 🗑 直接删：`cli-adapter.test.ts`、`adapter.test.ts`、`table-symmetry.test.ts`、model-catalog pi-ai guard test。
- 大改（pi-ai mock → SDK mock）：`api-adapter.test.ts`（resolveModel/fuzzy 用例作废，新增双 ProtocolClient stream/complete + status 分类）、`credentials/discovery.test.ts`（OAuth/keychain 作废）、`model-discovery.test.ts`（改 mock `models.list()`）、`model-assembly.test.ts`、`presets.test.ts`。
- 中改：wizard、config-routes 测试。
- **core 层测试预期零改动**（`InvocationAdapter` 契约未变）——若失败=泄漏了 CLI 假设。
- **实施校验点**（非测试但会真错）：① 两 SDK 流式事件形状/usage 字段（§2.5）以实机为准；② 官方 anthropic/openai baseUrl 与 header/version（anthropic 需 `anthropic-version`，SDK 自带）；③ 兼容端点 `stream_options`/`reasoning_effort`/`max_tokens` 支持差异，OpenAIClient 温和降级；④ `maxRetries:0` 务必设置（否则 SDK 底层重试与我们双重叠加）；⑤ migrate 对真实 28 模型跑 dry-run 核对分类。

---

## 附：一句话给实施者

> core 不动、`InvocationAdapter{invoke,healthCheck}` 不动；providers 从「pi-ai 注册表+家族+OAuth+CLI」塌缩为「ProtocolClient(protocol,baseURL,key) 双 SDK 单骨架」；可靠性骨架（超时/重试/熔断/截断/usage）原地保留，只把「调 pi-ai」换成「调官方 SDK」，并把 SDK 的 `maxRetries` 关成 0；凭证降为 env 或 0o600 文件；迁移非破坏、可转即转、不可转即禁用标注。
