# 模型配置流程改进：发现凭证收敛 + 模型家族知识归位

> 状态：设计定稿（2026-07-06）· 作者：@architect · 供 @provider-dev 实施
> 覆盖工作项 #1（模型发现凭证收敛 + 自定义端点发现）与 #3（推荐/flagship 数据源统一 + `rateModelCapability` 依赖方向裁决）。
> 本笔记记录**接口契约 + 落位裁决 + 迁移步骤 + trade-off**。落地后系统"当前状态"以 TDD §3.4 为权威（需据本笔记修订）。

---

## 1. 背景与问题

审计确认的三个事实（均已读源码核对）：

1. `src/providers/model-discovery.ts:41-49` 的 `discoverModels()` 直接读 `process.env['ANTHROPIC_API_KEY'/'OPENAI_API_KEY']`，**绕过 `CredentialManager`**。凭证解析出现两份真相源（`CredentialManager.DEFAULT_ENV_BY_PROTOCOL` 与 discovery 内联），存在漂移风险。
2. `src/ui/wizard/first-run.ts:405` `isRecommended` 与 `src/providers/model-assembly.ts:121` `selectBestChairman.flagshipBonus` **各自维护硬编码模型家族正则**，且后者残留 `gemini-2.5-pro`/`gemini-pro` 条目。
3. `src/providers/model-assembly.ts:22` 从 `core/role-generator.js` 导入 `rateModelCapability`，形成 providers→core 的具体依赖边。

另外审计中隐含、但**当前缺失**的能力：自定义/自托管端点（ollama、vLLM、网关、Google OpenAI-compat 等）无法列举模型，向导只能让用户手输 model id（`first-run.ts:534`）。

---

## 2. 工作项 #1 契约

### 2.1 (#1a) 模型发现改走 CredentialManager

**新增方法**（`src/providers/credentials/discovery.ts`，additive、非破坏）：

```typescript
/**
 * Resolve the official API key for a protocol's *standard* endpoint, or null.
 * The single resolver for "official protocol key" — currently the protocol's
 * default env var (ANTHROPIC_API_KEY / OPENAI_API_KEY). Custom-endpoint key
 * files (custom-<name>.key) are NOT consulted here: they belong to a specific
 * base_url, resolved per-ModelConfig by getApiKey, not to a protocol's official
 * endpoint. Never returns key material to logs/DTOs (SEC-02).
 */
resolveOfficialKey(protocol: Protocol): string | null
```

- 实现即 `getApiKey` 第 3 步（`DEFAULT_ENV_BY_PROTOCOL[protocol]` env）。建议（非强制）把 `getApiKey` 第 3 步重构为调用本方法以 DRY，但属实现细节。
- **裁定**：官方端点凭证在标准 API 模型下**只来自 env var**。这不是简化取巧——custom-`<name>`.key 文件本质绑定某个 `base_url`（自定义端点），不是某个 protocol 的官方端点凭证；把它们塞进"官方 key 解析"会引入语义错配。因此 `resolveOfficialKey` 只读 env 是**正确且完整**的。

**`discoverModels` 新签名**（`src/providers/model-discovery.ts`，**breaking，内部**）：

```typescript
// before: export async function discoverModels(): Promise<DiscoveredModel[]>
export async function discoverModels(credentials: CredentialManager): Promise<DiscoveredModel[]>
```

内部改为：

```typescript
const anthropicKey = credentials.resolveOfficialKey('anthropic');
if (anthropicKey) models.push(...(await discoverAnthropic(anthropicKey)));
const openaiKey = credentials.resolveOfficialKey('openai');
if (openaiKey) models.push(...(await discoverOpenAI(openaiKey)));
```

**注入 vs 内部构造裁定**：采用**依赖注入**（要求传入 `CredentialManager` 实例，无默认参数）。理由：(a) 与 `ApiAdapter` 的 DI 模式一致（`new ApiAdapter(new CredentialManager())`）；(b) 依赖显式；(c) 调用点极少（3 处），均已在近旁持有 `CredentialManager` 实例。不给默认参数 `= new CredentialManager()`，避免隐藏依赖。`CredentialManager` 无缓存/无状态，重复实例无害，但复用近旁实例更干净。

**Mock 约定**：`CredentialManager` 是具体类（非 6 个边界接口之一，无需接口化）。发现测试**构造真实 `new CredentialManager()` 并经 `process.env` 驱动**——凭证解析本身已在 `discovery.test.ts` 单测覆盖，`discoverModels` 测试只需继续 mock SDK 构造器（`Anthropic`/`OpenAI`）这一有趣部分。禁止 `as any` 造部分 mock（TS-02）。

### 2.2 (#1b) 自定义端点发现

**新增函数**（`src/providers/model-discovery.ts`，additive）：

```typescript
/**
 * List models from a caller-supplied standard-API endpoint (custom base_url:
 * ollama, vLLM, gateways, Google OpenAI-compat…). Mirrors discoverModels'
 * best-effort contract: on any failure it warns on stderr and returns [] (never
 * throws). A custom endpoint has NO static-catalog fallback, so [] here means
 * "nothing usable discovered" and the caller falls back to manual id entry.
 */
export async function discoverEndpointModels(opts: {
  protocol: Protocol;
  baseUrl: string;
  apiKey?: string;       // omitted/empty → no-auth endpoint (e.g. local ollama)
  sourceLabel: string;   // provenance for collision-safe naming; caller-sanitized
}): Promise<DiscoveredModel[]>
```

**行为约定**：

| 关注点 | 约定 |
|--------|------|
| SDK 客户端 | 按 `protocol` 构造 `Anthropic`/`OpenAI`，`{ baseURL: opts.baseUrl, apiKey: <见下>, maxRetries: 0, timeout: DISCOVERY_TIMEOUT_MS }`（复用现有 5s 常量） |
| no-auth key | `apiKey` 缺省/空时，向 SDK 构造器传**非空占位**（如 `'noauth'`）。**关键**：不能传空串——否则 OpenAI SDK 会回退读 `OPENAI_API_KEY` env 或抛错，破坏 ollama 等无鉴权端点 |
| OpenAI 过滤 | **不套用**官方路径的 `^(gpt-|o[0-9]|chatgpt)` 家族过滤。自定义端点返回 `llama3.2`/`mistral`/`gemini-2.5-pro` 等任意 id，过滤会误杀。全量返回 |
| 落盘安全过滤（#23，2026-07-07 追加） | 对每个 id 跑 `isResolvableModelName(PATHS.modelsDir, id)`（现居 `shared/paths.ts`；providers→shared/config 合法方向）；文件名不可安全落盘的 id（含 `../` traversal）**丢弃 + stderr 汇总一行警告**（建议 `[model-discovery] endpoint <baseUrl>: dropped N unsafe model id(s): …`），不进返回集。**与上一行家族过滤正交**：家族过滤是功能性（chat-capable）；本过滤是持久化**安全性**。`isResolvableModelName` 纯路径运算（无 fs），故用真实 `PATHS.modelsDir` 即可、无需测试夹具。`safePath` 仍是落盘时的通用硬后盾（本过滤把它从"抛栈"提前为"友好丢弃+警告"）。**仅自定义端点做**（官方端点可信，见 §2.3） |
| 返回形态 | 每条 `{ id, name: id, protocol, base_url: opts.baseUrl, source: opts.sourceLabel }`。**必带 `base_url`**（区别于官方的 `base_url: undefined`），供 `model-assembly` 的裸名/后缀命名与 `modelDedupeKey` 正确工作 |
| 失败/超时 | 网络/鉴权/超时/协议不符 → **stderr 警告 + 返回 `[]`，绝不抛出**。警告格式建议 `[model-discovery] endpoint <baseUrl> /models unavailable: <msg>`（无 catalog 可回退，故不含 "using static catalog"）。实现须确保 `<msg>` 不拼接 key |
| 成功空集 | `models.list()` 成功但返回空 → `[]`（与失败同为空，CLI 用户从 stderr 有无警告区分；调用方一律回退手输） |
| 超时 | 经 SDK `timeout` 选项，复用 `DISCOVERY_TIMEOUT_MS`；`maxRetries:0` |

**返回裸数组（`DiscoveredModel[]`）而非判别式的定稿理由**（更新：初稿曾拟判别式 `{ok,error}`，后据 Phase 纪律 + 一致性推翻）：
- **一致性**：官方 `discoverModels` 就是"吞错 + stderr 警告 + 返回数组"，自定义端点采用同形态最小化认知负担与测试样板。差异仅在"无 catalog 回退"——即失败时返回 `[]` 而非 catalog，仍是裸数组。
- **Phase 纪律**：判别式是为"需机读错误原因的交互/Web 调用方"预留，而该调用方（向导接线、`council models add`、Web models add）**本轮全部不存在**。为不存在的消费者预建复杂返回形态属投机性抽象，正是本项目要避免的。
- **CLI 语义足够**：向导消费者只需"拿到模型没有？没有→手输"；失败原因经 stderr 警告已送达 CLI 用户，无需程序化分支。
- **未来演进**：若日后 Web GUI models-add 需机读错误，届时以**兄弟函数**或可选富返回**增量**引入（additive），不必现在承担 breaking 风险。

**调用方（不在 #1 provider 范围内，另行 cli 落地）**：
- 向导 `collectCustomProviders`（`first-run.ts:487`，@cli-dev）：用户输入 base_url+protocol+apiKey 后调用 `discoverEndpointModels`；返回非空 → 渲染 checkbox 供选（默认全选）；返回空 → 回退现有手输逗号分隔 id 路径（stderr 警告已告知原因）。
- `council models add`：**当前不存在**（`src/commands/models.ts` 只有 list/check）。本契约支持它，但新增命令是独立 cli 工作项，不在 #1 范围。见 §6 范围旗标。

### 2.3 (#1c) 明确不变的行为（防过度重构）

- 官方 `discoverModels` 失败/空 → 仍回退 `staticCatalog(protocol)`（来自 `MODEL_CATALOG`）。
- stderr 警告格式不变：`[model-discovery] <protocol> /models unavailable, using static catalog: <msg>`。
- 官方 OpenAI 路径的 `^(gpt-|o[0-9]|chatgpt)` 家族过滤**保留**（避免 embeddings/tts 灌满面板）。仅自定义端点跳过过滤。
- **官方 `discoverModels` 不加 #23 的落盘安全过滤**（Q2 裁决，2026-07-07）：官方 Anthropic/OpenAI 端点与其 completion 响应同属可信基础设施，`../` id 需厂商被攻陷才可能出现；给官方加过滤是恒不触发的死分支（YAGNI）。paranoid 情形由 `safePath` 落盘硬后盾兜底。
- `DISCOVERY_TIMEOUT_MS=5s`、`maxRetries:0` 不变。
- `DiscoveredModel` 形态不变（`{ id, name, protocol, base_url?, source }`）。
- `model-assembly` 的裸名/后缀/`-2/-3` 命名与 `modelDedupeKey` 不变（自定义端点带 `base_url`，天然走后缀分支）。

---

## 3. 工作项 #3 契约

### 3.1 (#3a) 推荐/flagship 单一数据源

现状：`isRecommended`（bool）与 `flagshipBonus`（0–9 数值）各自硬编码家族正则。两者用**家族级**正则（`opus`、`gpt-5`、`sonnet-4`）而非精确 id，是**刻意的**——发现返回账户里的实时 id，可能含目录未及更新的新 id（如 `claude-opus-4-7`），家族匹配才能对未来 id 稳健。因此**不能**改成"精确匹配 catalog 的三档 id"（会对新 id 漏判）。

**裁定**：把家族级排名/推荐规则作为**数据**下沉到 `src/shared/model-catalog.ts`（已持 `MODEL_CATALOG`），两个消费者都从这一张表推导。新增：

```typescript
/**
 * Ordered model-family tier rules matched against a lowercased model id
 * (family-level regex, NOT exact id — so newly-released ids in a known family
 * still rank). First matching rule wins.
 */
export interface ModelTierRule {
  readonly pattern: RegExp;      // family matcher against lowercased id
  readonly rank: number;         // flagship strength (chairman tie-break); higher = stronger
  readonly recommended: boolean; // default debate participant? (excludes mini/nano/lite)
}

export const MODEL_TIER_RULES: readonly ModelTierRule[] = [
  { pattern: /opus/,                               rank: 9, recommended: true },
  { pattern: /gpt-5(?!.*(mini|nano))/,             rank: 8, recommended: true },
  { pattern: /^o3$/,                               rank: 7, recommended: true },
  { pattern: /claude-sonnet-4|claude-3-5-sonnet/,  rank: 5, recommended: true },
  { pattern: /^o4$/,                               rank: 5, recommended: true },
  { pattern: /gpt-4o$/,                            rank: 4, recommended: true },
];

/** Flagship strength of a model id (0 = no known flagship family). */
export function flagshipRank(id: string): number {
  const lower = id.toLowerCase();
  for (const r of MODEL_TIER_RULES) if (r.pattern.test(lower)) return r.rank;
  return 0;
}

/** Is this id a recommended default debate participant? */
export function isRecommendedModel(id: string): boolean {
  const lower = id.toLowerCase();
  for (const r of MODEL_TIER_RULES) if (r.pattern.test(lower)) return r.recommended;
  return false;
}
```

**消费者改造**：
- `first-run.ts` `isRecommended(m: DiscoveredModel)` 保留导出，收敛为一行委托：`return isRecommendedModel(m.id);`（向导测试不变——仍传 `DiscoveredModel`）。
- `model-assembly.ts` `selectBestChairman` 内联 `flagshipBonus` 删除，改用 `flagshipRank(id)`。

**MODEL_CATALOG 与 MODEL_TIER_RULES 并存、不冲突**：前者是离线精确 id 兜底（`staticCatalog`），后者是对**任意** id 的家族排名。catalog 的精确 flagship id（如 `claude-opus-4-6`）会命中 `/opus/`→rank 9，两者天然一致，分层清晰。

**两字段（rank + recommended）分离的价值**：允许"推荐但非顶配"（gpt-4o：recommended, rank 4）独立表达；当前所有 recommended 家族 rank>0 且反之，但未来可独立调优（如便宜但推荐的模型）。

**刻意的行为修正**（相对旧正则）：
1. `gpt-5-mini`/`gpt-5-nano` 不再获得 flagship bonus（旧 `flagshipBonus` 的 `/gpt-5/` 会误给 mini +8）——修正一处潜在 bug。
2. `isRecommendedModel` 额外排除 `gpt-5-nano`（旧 `isRecommended` 仅 `(?!.*mini)`）——nano 属 economy，本不应默认入选。
3. `o4` 纳入 recommended + rank 5（旧 `flagshipBonus` 漏了 o4，但旧 `isRecommended` 的 `^o[34]$` 已含）。

以上均需 @tester 补断言（`gpt-5-mini`→rank 0/非推荐；`gpt-5-nano`→非推荐；`o4`→推荐）。无既有测试依赖旧的 gpt-5-mini flagship bonus（已核对）。

### 3.2 (#3b) `rateModelCapability` 依赖方向裁决

**结论：providers→core 这条边就本函数而言应消除；`rateModelCapability` 搬到 `src/shared/model-catalog.ts`。**

**依赖方向分析**：
- ARCH-01/02 约束的是 **core 导入什么**，不约束"谁导入 core"。providers→core（外层→内层）在分层架构里本身**合法**，不构成 ARCH 违规，也不构成 import 环（core 未静态导入 providers；运行时 core→providers 仅经 `InvocationAdapter` 接口注入）。
- 但 `rateModelCapability` 是**领域无关的纯字符串启发式**（id→档位数），零 I/O、零编排语义，被 **core（orchestrator ×4、role-generator ×2）+ providers（model-assembly ×1）+ ui（first-run ×1）三层**共用。这正是 `shared/` 的定义："跨层、领域无关的纯工具"。它当前落在 core 只是历史位置。
- 搬到 shared 后：providers→core、ui→core 两条边（就本函数）一并消除；core 改为 core→shared（合法，shared 零业务依赖）。三层的模型家族知识（`rateModelCapability` + `flagshipRank` + `isRecommendedModel` + `MODEL_CATALOG`）**统一在一个模块**。

**签名保持不变**（`rateModelCapability(m: ModelConfig): number`）：
- 只做**纯搬迁**（从 `core/role-generator.ts` 剪切到 `shared/model-catalog.ts`）+ 改导入路径，不改签名 → 调用点零逻辑改动。
- `shared/model-catalog.ts` 已 `import type { Protocol }`，再加 `ModelConfig` 类型导入即可——types/ 是纯类型零运行时，shared 导入 types 合规，不违反 shared 纪律。
- 为何不改成 `(id: string)` 与 `flagshipRank`/`isRecommendedModel` 对齐：那会波及 ~7 处非测试 + ~10 处测试调用点（含 core-dev 的 orchestrator.ts），churn 远大于收益。`flagshipRank`/`isRecommendedModel` 取 `string` 是因其调用点本就持裸 id（`m.id` / 已抽取的 `id`）；`rateModelCapability` 调用点本就持 `ModelConfig`。签名按调用点形态取，是务实取舍，接受同模块内混合入参。

**importer 改造（含跨 lane，见 §5）**：
- `providers/model-assembly.ts:22`：从 shared 导入（**消除 providers→core**，本裁决主目标）。
- `ui/wizard/first-run.ts:10`：从 shared 导入（消除 ui→core）。
- `core/role-generator.ts`：删除本地定义，从 shared 导入供 `buildModelDescription`/`pickRoleGenModel` 内部使用。
- `core/orchestrator.ts:38`：把 `rateModelCapability` 从 `./role-generator.js` 的导入拆出，改从 `../shared/model-catalog.js` 导入（其余 `generateRoles` 等仍来自 role-generator）。
- 测试 `test/core/chairman-role-gen.test.ts:3`：导入路径改为 shared。（`rateModelCapability` 逻辑不变，gemini/flash/lite 等 fixture 仍有效。）

> **低 churn 备选**（若 @pm 要本轮少动 core lane）：`core/role-generator.ts` 从 shared 导入并 `export { rateModelCapability }` 再导出（compat shim）。则 orchestrator.ts 与 core 测试**字节不变**，仅 model-assembly/first-run 切到 shared——**反向边消除的架构目标同样达成**（反向边在 model-assembly/first-run，与 shim 无关）。代价是 core 留一处"再导出 shared 工具"的轻微 indirection，未来可清理。**架构师推荐主方案（无 shim）**以保图干净；备选留给 @pm 按协调成本裁量。

### 3.3 gemini 清理裁定（验收口径已按任务书收窄，风险已闭合）

> **更新**：team-lead 下发的 #3 任务书已把 gemini grep=0 收窄到 `model-assembly.ts` + `model-catalog.ts` 两个文件（criterion 1、2），未含 `role-generator.ts:53`。这正确回应了初稿的风险旗标——本节据此定稿，**不再要求"整个代码库 grep=0"**。

grep 命中分四类，处置如下：

| 位置 | 处置 | 理由 |
|------|------|------|
| `providers/model-assembly.ts:125,128`（flagshipBonus gemini 条目） | **删除**（随 #3a 下沉，MODEL_TIER_RULES 不含 gemini）→ 满足 criterion 1 | 死条目；且 §3.1 已核验删除后 `model-assembly.test.ts` gemini-compat 用例仍通过（`rateModelCapability` 的 `pro` 使其 tier=3，score 30>24，非靠 flagship bonus） |
| `shared/model-catalog.ts` | MODEL_TIER_RULES **不引入** gemini 条目 → 满足 criterion 2（"彻底移除而非搬进 catalog"） | 双协议下 gemini 非任何官方 protocol 的合法 id；家族排名不为其保留 |
| `core/role-generator.ts:53`（`buildModelDescription` 的 `/gemini/` trait 提示） | **本轮不动**（不在 #3 文件清单） | 任务书未列 role-generator.ts；且它是 core-dev lane。此 trait 对 Google OpenAI-compat 托管的 gemini 仍有用（"multimodal" 提示）。留待 @info-architect 下次审计一并评估家族 trait 归属，非本工作项 |
| `config/migrate.ts:112-114`、`docs/PRD.md`、`defaults/roles/*.yaml`、`test/**` | **保留** | migrate.ts 匹配 legacy provider 以**禁用**旧配置（删除会破坏 v1→v2 迁移）；PRD/roles/tests 是示例/数据/fixture，gemini 代表"Google OpenAI-compat"这一**真实支持场景**（见 `model-assembly.test.ts:182`） |

**验收口径**：与任务书一致——gemini grep=0 仅约束 `model-assembly.ts` + `model-catalog.ts`。其余合法保留。风险闭合。

---

## 4. 影响与 breaking change 一览

| 文件 | 变更 | Breaking? | Lane |
|------|------|-----------|------|
| `providers/credentials/discovery.ts` | +`resolveOfficialKey(protocol)` | 否（additive） | @provider-dev |
| `providers/model-discovery.ts` | `discoverModels` +`credentials` 参；+`discoverEndpointModels`（返回 `DiscoveredModel[]`） | **是**（`discoverModels` 内部签名） | @provider-dev |
| `shared/model-catalog.ts` | +`ModelTierRule`/`MODEL_TIER_RULES`/`flagshipRank`/`isRecommendedModel`；+搬入 `rateModelCapability`（+`ModelConfig` 类型导入） | 否（additive；落位经 architect 确认=shared） | 触及方 dev |
| `providers/model-assembly.ts` | flagshipBonus→`flagshipRank`；`rateModelCapability` 改从 shared 导入；删 gemini | 行为微调（见 §3.1）；**消除 providers→core** | @provider-dev |
| `ui/wizard/first-run.ts` | `isRecommended`→委托 `isRecommendedModel`；`rateModelCapability` 改从 shared 导入；`discoverModels`/`discoverEndpointModels` 调用点 | 行为微调（nano 排除）；消除 ui→core | @cli-dev |
| `server/config-routes.ts:221` | `discoverModels(credentialManager)` 传参 | 跟随 breaking | @cli-dev(server) |
| `core/role-generator.ts` | 删 `rateModelCapability` 定义，改从 shared 导入（本轮**不动** `:53` gemini trait） | 无对外行为变化 | @core-dev |
| `core/orchestrator.ts:38` | `rateModelCapability` 导入拆到 shared（无 shim 时） | 无（机械改导入） | @core-dev |
| `test/providers/model-discovery.test.ts` | 传 `new CredentialManager()` | — | @tester |
| `test/core/chairman-role-gen.test.ts:3` | 导入路径→shared（无 shim 时） | — | @tester |
| `test/providers/model-assembly.test.ts` | 补 gpt-5-mini/nano/o4 断言；核验 gemini-compat 仍通过 | — | @tester |
| `test/ui/wizard/first-run.test.ts` | 补 nano 排除断言 | — | @tester |

---

## 5. 迁移步骤（建议顺序）

1. **shared 先行**：`shared/model-catalog.ts` 加 `ModelTierRule`/`MODEL_TIER_RULES`/`flagshipRank`/`isRecommendedModel`，并搬入 `rateModelCapability`（签名不变）。此步是所有下游的前置。
2. **core 跟随**：`role-generator.ts` 删本地 `rateModelCapability` 定义、改从 shared 导入（供内部用）；`orchestrator.ts:38` 导入改 shared（或按备选加 shim）。（`:53` gemini trait 本轮不动，见 §3.3。）
3. **providers**：`credentials/discovery.ts` 加 `resolveOfficialKey`；`model-discovery.ts` 改 `discoverModels` 签名 + 加 `discoverEndpointModels`；`model-assembly.ts` 换 `flagshipRank` + 删 gemini + 导入改 shared。
4. **调用方补参**：`server/config-routes.ts`、`ui/wizard/first-run.ts` 的 `discoverModels()` 传入 CredentialManager；`first-run.ts` `isRecommended` 委托 + 导入改 shared。
5. **测试**：见 §4 表；重点核验 `model-assembly.test.ts` gemini-compat 用例仍通过。
6. **文档**：@doc-keeper 据本笔记修订 TDD §3.4（模型发现段补自定义端点发现与凭证收敛；凭证段补 `resolveOfficialKey`），并在 design-notes README 索引登记本篇。

> #1b 的向导/`council models add` **调用侧接线**是 @cli-dev 的后续工作项，不阻塞 #1 provider 契约实施（函数交付后再接线）。

---

## 6. 范围旗标（提请 @pm）

1. ~~验收标准修正~~ **已闭合**：#3 任务书已把 gemini grep=0 收窄到 `model-assembly.ts` + `model-catalog.ts`（criterion 1、2），与 §3.3 一致。无需再动作。
2. **`council models add` 不存在**：`src/commands/models.ts` 仅 list/check。`discoverEndpointModels` 契约为其铺路，但新增命令是独立 cli 工作项，未包含在 #1。
3. **#1b 接线跨 lane**：`discoverEndpointModels` 函数（provider）与其在向导/GUI 的接线（cli）应拆两步；本轮 #1 只交付函数契约与实现。
4. **#3b 跨 lane 触碰 core**（**待 @pm 拍板**）：主方案（无 shim）需 @core-dev 机械改 `orchestrator.ts`/`role-generator.ts` 导入 + @tester 改 core 测试导入。若本轮想隔离，采用 §3.2 备选 shim（core 侧零改动）。这对应 #3 任务书 criterion 5"若裁决要求 rateModelCapability 搬家，登记为子任务"——即需 @pm 建一个 core-lane 子任务（或采 shim 免建）。
5. **`role-generator.ts` 家族 trait 提示（codex/claude/gpt/gemini）**：`buildModelDescription:52-55` 也是模型家族知识、与 catalog 概念重叠，但统一它属过度扩张（Phase 纪律），且 role-generator.ts 不在 #3 文件清单。本轮**完全不动**，留给 @info-architect 下次审计评估。
