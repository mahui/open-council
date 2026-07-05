# Web GUI 配置能力设计（`council serve` 设置面）

- **日期**: 2026-07-05
- **状态**: 设计定稿（实施前）
- **关联任务**: #39（本设计）→ #40（server 层）/ #41（前端）→ #42（集成+文档）
- **前置设计**: [web-gui-design.md](./web-gui-design.md)（HTTP/SSE 架构、安全边界、WebRenderer）。本篇是其"MVP 明确不做：配置向导"决策的**受控放开**。
- **触及接口契约**:
  - **无 core / Renderer 接口变更**。
  - `ConfigLoader` 新增 `loadAllModelConfigs()`（config 层，向后兼容的新增方法）。
  - `src/server/` 内部：`DebateManagerDeps` / `RouteDeps` 由"持有 models 快照"改为"持有 `RuntimeConfig` 引用"——**server 私有契约的 breaking change，须同步 serve.ts / app.ts / routes.ts**（均在 server 边界内，不外溢）。
  - 从 `src/ui/wizard/first-run.ts` **下沉提取** 5 个纯函数到可被 server 向下依赖的层（见决策 7）。

---

## 1. 背景与范围

GUI MVP（web-gui-design.md §1）明确排除配置："配置向导仍走 CLI `council setup`"。用户现要求 GUI 具备配置能力。本设计在**不破坏原安全边界**（尤其"凭证绝不过 API 出线"）的前提下，为 GUI 增加**日常配置调整 + 轻量接入**能力。

**职责划分（决策 6 的结论前置）**：

| 场景 | 归属 | 理由 |
|------|------|------|
| 冷启动全量引导（OAuth 登录、设备码、首次凭证发现） | **CLI `council setup`** | 交互面大（浏览器重定向/设备码/逐 provider 登录），复制到 Web 是超出 Phase 的大工程 |
| 日常调整（模式/主席/agent 数/语言/prefer 顺序/模型开关） | **GUI 设置页** | 高频、低风险、纯表单 |
| 轻量接入（rescan 拾取新凭证、加一个 OpenAI 兼容端点） | **GUI 设置页** | 一键即可，无需回终端 |

`serve` 仍保持 `models.length === 0 → exit(1)`（serve.ts 现状）：**GUI 配置面向"已配置的安装"**，零模型时引导用户去 CLI。放开"零模型也能起 serve 并从浏览器冷启动"列为后续项（§9）——它要求把 OAuth 登录流搬进浏览器，超出本次范围。

---

## 2. 决策 1 — 可编辑字段面

**原则**：只放开"高频、幂等、改了不会破坏进行中会话或数据完整性"的字段。凡是"改了会孤立数据 / 属运维调优 / 属结构性字段"的一律只读，靠文件编辑。

### 可编辑（写）

| 字段 | 落点 | 校验（沿用 schema） |
|------|------|------|
| `general.default_mode` | council.yaml | enum `quick\|compare\|debate\|auto` |
| `general.default_chairman` | council.yaml（同步写 `routing.default.chairman`，见下） | 必须 ∈ 已启用模型名 或 空 |
| `general.role_generator_model` | council.yaml | ∈ 模型名 或 空（空=运行时自动） |
| `general.min_agents` / `max_agents` | council.yaml | int ≥1，且 `max ≥ min` |
| `general.devil_advocate` | council.yaml | enum `auto\|always\|never` |
| `general.language` | council.yaml | enum `auto\|zh\|en` |
| `routing.default.prefer`（顺序） | council.yaml | string[]，元素 ∈ 模型名 |
| 每模型 `enabled` | `models/<name>.yaml` | boolean |
| 新增自定义 OpenAI 兼容端点 | 新 `models/custom:*.yaml` + `custom-*.key` | 见决策 3 |

**`default_chairman` 与 `routing.default.chairman` 冗余说明**：编排实际读 `config.general.default_chairman`（见 `assemble.resolveModels`）；`routing.default.chairman` 目前近乎 vestigial。`assembleConfig` 一贯把两者写成同值。GUI 沿用此约定——设主席时两处同步写，避免二次漂移。**不**在本次尝试消除该冗余（属独立清理项，见 [[project_role-yamls-dead-asset]] 类似的"死资产"治理，不夹带进功能任务）。

### 只读（GUI 展示但不可改；改动须编辑文件）

- `schema_version`
- `storage.*`（data_dir / checkpoint_dir / log_dir / retention…）——**改路径会孤立进行中 serve 进程持有的 SQLite 连接与已存会话**，风险高、收益低。
- `concurrency.*`、`circuit_breaker.*`——运维调优参数，误改影响稳定性。
- `output.*`（含 `tui_mode`）——面向 CLI/TUI 呈现，与 GUI 无关。
- `storage_security.session_retention_days`——数据留存策略，谨慎变更。
- `routing.strategy / dynamic_weight* / exploration_rate / rules`——路由算法调参，超出"日常"范畴。
- 模型的结构性字段（`invocation / provider / model / binary / args / api_base_url / priority / capabilities…`）——除自定义端点新增流程外不可改；改错即模型失效。

**被否**：放开 `output.*` / `circuit_breaker` 等全字段编辑——扩大校验面与误操作面，违反 Phase 纪律"不引入超出当前阶段的复杂度"。只读段仍在 `GET /api/config` 里**投影展示**（便于用户知道现值），只是无写路径。

---

## 3. 决策 3 — 凭证录入边界裁定（关键）

### 裁定：**放行**（自定义 OpenAI 兼容端点 + API key 经浏览器表单提交），附强制条件。

**理由**：
1. **方向正交于原禁令**。web-gui-design.md §7 的"凭证绝不过 API（SEC-02）"约束的是**出线**（GET 绝不返回 token/key）。浏览器→loopback 的**入线**提交是另一个方向，不违反"出线"边界——该边界在本设计中**继续不可逾越**。
2. **与既有 CLI 行为同构**。CLI `collectCustomProviders`（first-run.ts）已经做完全相同的事：收 key → 写 `custom-<name>.key`（`chmod 0o600`）→ 存 `api_credential_path`。GUI 只是把同一次落盘的触发点从终端 prompt 换成 loopback POST。key 全程**不出本机**。
3. **不放行则功能残废**。"轻量接入"的核心就是加端点；逼用户回终端违背 GUI-config 的立项目的。

**强制条件（实施须全部满足，缺一不放行）**：
1. **仅限自定义端点这一条路径**。不通过 API 编辑/录入 env / OAuth 凭证（那些仍归 CLI）。
2. **专用状态变更路由** `POST /api/providers/custom`——经现有 `security.ts` 的 Host+Origin 校验（loopback + 同源），CORS 不开。
3. **立即落盘 0o600**，key 只进 `custom-<name>.key`，`ModelConfig` 仅存 `api_credential_path`（路径，非 key）。council.yaml / 模型 YAML **绝不含 key 明文**。
4. **绝不记日志**：该路由 body 不进任何日志；EventLog 本就不记录配置操作（EventLog 只服务辩论流）。请求日志（若有）一律不落 body。
5. **绝不回显**：`GET /api/config`、`GET /api/models` 对自定义模型只返回 `api_base_url` + `hasCredentialFile: boolean`，**绝不**返回 key、绝不返回文件内容。任何响应体不含 key。
6. **响应最小**：POST 成功返回 `{ name, ok: true, tested?: boolean }`，不回显任何凭证。

**被否**：维持禁令（GUI 只给"去终端跑 council setup"指引）。否——key 既不出本机、CLI 已做等价落盘，禁令只带来体验损失而无实际安全增益；原禁令本意是"出线"，被误读为"入线"会无谓阉割功能。

---

## 4. 决策 2 — API 契约

所有配置路由挂在 `/api` 下，经 `security.ts` 中间件（Host 全量校验、写请求额外 Origin 校验）。新增一个 `createConfigRoutes(deps)`，在 `routes.ts` 里 `api.route('/', createConfigRoutes(...))` 挂载（保持 routes.ts 不臃肿；server 层不受 ARCH-03 的 ≤150 行约束，但仍按职责分文件）。

### 4.1 DTO 与脱敏规则（`src/server/protocol.ts` 追加纯类型）

```typescript
// —— 配置读投影（脱敏，绝不含任何 secret）—— //
export interface GeneralSettingsDTO {
  default_mode: 'quick' | 'compare' | 'debate' | 'auto';
  default_chairman: string;
  role_generator_model: string;
  min_agents: number;
  max_agents: number;
  devil_advocate: 'auto' | 'always' | 'never';
  language: 'auto' | 'zh' | 'en';
}

export interface ModelSettingDTO {
  name: string;
  provider?: string;
  invocation: 'cli' | 'api' | 'auto';
  capabilities: string[];
  enabled: boolean;
  isCustom: boolean;            // provider 以 "custom:" 前缀
  apiBaseUrl?: string;          // 仅自定义端点展示
  hasCredentialFile: boolean;   // api_credential_path 是否存在 —— 绝不含 key
}

/** 只读段：仅供展示现值，无写路径。 */
export interface ReadOnlyConfigDTO {
  schema_version: number;
  storage: { data_dir: string; checkpoint_dir: string; log_dir: string };
  routing: { strategy: string };
  concurrency: { global_resource_limit: number };
  circuit_breaker: { enabled: boolean; failure_threshold: number; recovery_seconds: number };
  storage_security: { session_retention_days: number };
}

export interface ConfigDTO {
  version: string;              // 乐观锁令牌（council.yaml 内容 sha256，见 4.3）
  general: GeneralSettingsDTO;
  prefer: string[];             // routing.default.prefer
  models: ModelSettingDTO[];    // 含禁用模型（需 loadAllModelConfigs）
  readOnly: ReadOnlyConfigDTO;
}
```

**脱敏投影不变量**（实施须用测试锁定）：`ConfigDTO` 的任何字段都**不得**来源于 `api_key_env` 的值、`api_credential_path` 指向的文件内容、或 OAuth token。`api_key_env` 本身是环境变量**名**（非值），本设计**也不透传** env var 名（避免暗示凭证结构）——自定义端点用 `hasCredentialFile` 布尔即可。

### 4.2 路由表

| 方法 | 路径 | 请求 | 响应 | 复用 |
|------|------|------|------|------|
| GET | `/api/config` | — | `200 ConfigDTO` | `ConfigLoader.loadCouncilConfig` + `loadAllModelConfigs`（新增） |
| PUT | `/api/config` | `UpdateConfigRequest` | `200 ConfigDTO`（新值） / `409`（版本冲突） / `400`（校验失败） | `assembleConfig`（下沉后）+ `saveCouncilConfig` |
| PATCH | `/api/models/:name` | `{ enabled: boolean, version: string }` | `200 ModelSettingDTO` / `409` / `404` | `loadModelConfig`+`saveModelConfig` |
| POST | `/api/providers/custom` | `{ name, baseUrl, modelIds: string[], apiKey?: string }` | `200 { added: string[], tested?: boolean }` / `400` | 决策 3 落盘 + `buildCustomModelConfig`（下沉后） |
| POST | `/api/setup/rescan` | `{}` | `200 RescanSummaryDTO` | `discoverCredentials` + `discoverModels` + 下沉的 `buildNamedModels`/`discoveredToModelConfig` |

```typescript
export interface UpdateConfigRequest {
  general?: Partial<GeneralSettingsDTO>;
  prefer?: string[];
  version: string;              // 必填：GET 拿到的令牌，用于乐观锁
}

/** rescan 结果摘要 —— 无任何 secret 出线。 */
export interface RescanSummaryDTO {
  credentials: Array<{
    provider: string;
    status: 'valid' | 'refreshed' | 'expired' | 'not_found' | 'parse_error';
    source: 'env' | 'file';
    // 注意：DiscoveryResult.path 被刻意剔除（泄露 home 目录结构，对 GUI 无价值）
  }>;
  models: { added: string[]; existing: string[] };  // 名称
}
```

**PUT 合并语义（绝不整体覆写）**：路由读当前 `council.yaml` 为 `base` → 用 `base` 填充 `UpdateConfigRequest` 未给出的字段 → 调下沉后的 `assembleConfig({ generalOverride, prefer, chairman, base })` → `saveCouncilConfig`（内部 `schema.parse` 保证完整且合法）。**与 CLI 向导同源**（同一 `assembleConfig`），语义不分裂。

**模型 enable/disable 落点裁定：`PATCH /api/models/:name`（独立资源路由）**。
- **理由**：模型是**独立 YAML 文件**（`models/*.yaml`），与 `council.yaml` 是**两个持久化单元**。折进 `PUT /api/config` 会把两个 store 的写混在一次请求里，污染乐观锁的作用域（council.yaml 的 version 无法覆盖模型文件的并发写）。独立路由让每个持久化单元各自锁、各自 404 语义清晰。
- **被否**：并入 `PUT /api/config`——混淆两个 store、乐观锁语义含糊。否。

**rescan 语义裁定：discover + 非破坏性 upsert + 摘要**。
- 服务端跑 `discoverCredentials()`（新建 `CredentialManager`）+ `discoverModels()` → 用 `buildNamedModels`/`discoveredToModelConfig` 塑形 → 对**新发现**的模型 `saveModelConfig`（**upsert，绝不 clearAllModels**，与 quick-setup 的合并语义一致）→ 返回 `{ added, existing }` 摘要。
- rescan 后触发 runtime reload（决策 4），且因可能拾取到新的 env/OAuth 凭证 → **重建 adapter**（用新 `CredentialManager`）。
- **被否**：rescan 只预览不落盘、再开一个"apply 选择"端点——多一个端点与一轮往返，对"一键拾取新凭证"过重。非破坏性 upsert 已足够安全（不想要的模型事后 disable 即可）。

### 4.3 并发写保护 — **内容哈希乐观锁（If-Match 语义）**

- **裁定**：`GET /api/config` 返回 `version = sha256(council.yaml 原始字节)`；`PUT` / `PATCH` 必须回带 `version`。服务端写前 **stat+读+哈希** 当前文件，与 `version` 比对：
  - 一致 → 应用合并并写。
  - 不一致 → `409 Conflict`，body 携带**当前** `ConfigDTO`，前端据此 rebase 后重试。
- **理由**：GUI 与 CLI（`council setup`）可能同时改 `council.yaml`；配置是**手工调优、丢更新代价高**（比会话行更痛）。内容哈希比 mtime 更稳（不受时钟精度/同秒写影响），代价仅一次 `readFileSync`+哈希，对本地低频写可忽略。也覆盖多 GUI tab 并发。
- **被否**：最后写赢 + 提示——静默 clobber 掉并发 CLI setup 的成果，对手工配置不可接受。否。mtime 锁——同秒/克隆场景不稳，改用内容哈希。
- **模型文件的锁**：`PATCH /api/models/:name` 的 `version` 是**该模型文件字节**的哈希（与 council.yaml 的 version 相互独立）。

---

## 5. 决策 4 — 配置变更的生效时机（最小侵入）

**现状**：`serve.ts` 启动时一次性 `resolveModels()` 装配 `models/chairman/roleGenModel`，把它们**值传**给 `DebateManager`（构造即固化）和 `createApp`（`/api/models`、`defaultChairman`）。配置改后两处快照都陈旧。

**裁定：引入 server 私有的 `RuntimeConfig` 持有器（单一可变引用），DebateManager 与路由都在"读时"从它取值，写操作后调 `reload()` 换快照。**

```typescript
// src/server/runtime-config.ts —— server 私有，无 core 变更
export interface RuntimeSnapshot {
  adapter: InvocationAdapter;
  models: ModelConfig[];        // 仅启用集 —— 供编排（禁用模型不应参与辩论）
  allModels: ModelConfig[];     // 全集含禁用 —— 供 /api/config 投影
  defaultChairman: string;
  roleGenModel?: ModelConfig;
}

export class RuntimeConfig {
  constructor(private snap: RuntimeSnapshot) {}
  get current(): RuntimeSnapshot { return this.snap; }
  replace(next: RuntimeSnapshot): void { this.snap = next; }
}
```

- **DebateManager 改动**：`DebateManagerDeps` 去掉 `adapter/models/defaultChairman/roleGenModel` 四个值字段，改持 `runtime: RuntimeConfig`；`startDebate` 在**调用时**读 `this.deps.runtime.current`。→ 下一场辩论自动拿新值；**进行中的辩论已在其 Orchestrator 里捕获了旧快照，不受影响（正确且符合预期——不该中途换模型）**。
- **routes 改动**：`RouteDeps` 的 `models/defaultChairman` 改为读 `runtime.current`；`/api/models`、`/api/config` 都从持有器取。
- **reload 触发**：任一成功的 `PUT /PATCH /POST-custom /rescan` 后，调一个 `reloadRuntime(runtime, { credentialManager? })`：重跑 `resolveModels` + `loadAllModelConfigs`，构造新 `RuntimeSnapshot`，`runtime.replace()`。
- **adapter 是否重建**：
  - `PUT` / `PATCH` / `POST-custom`：**不重建**。自定义端点 key 由 `ApiAdapter` 在 **invoke 时**从 `api_credential_path` 磁盘现读（已核实 api-adapter.ts:386-388），故新增 key 文件立即生效，无需换 adapter；仅模型列表需刷新。
  - `rescan`：**重建**（新 `CredentialManager` 可能含新 env/OAuth 凭证，adapter 依赖其缓存）。
- **被否**：每场辩论无条件重读磁盘配置——给热路径加了每场 I/O，且多数辩论间配置未变；只在"写后 reload"更省。向 Orchestrator 注入热重载钩子——侵入 core，违反"最小侵入"。

**影响文件（server 边界内的 breaking change，须同步）**：`serve.ts`（构造 `RuntimeConfig` 并传入）、`debate-manager.ts`（改 deps 读法）、`app.ts`+`routes.ts`（改 deps 读法）。均为 server 私有契约，不外溢到 core/types。

---

## 6. 决策 7 — 复用而非重造：下沉提取纯函数

GUI 必须复用 CLI 向导已定稿的合并/命名/择优语义，但这些函数现居 `src/ui/wizard/first-run.ts`（UI 层）。**server 不得向上依赖 ui**（会与既有 `commands → ui`（`council setup` 调 `runFirstRunWizard`）形成 ui↔commands/server 跨层环）。故须**下沉**到 ui 与 server 都能**向下依赖**的层。

| 函数 | 现位置 | 下沉目标 | 依赖分析 |
|------|--------|---------|---------|
| `assembleConfig` | first-run.ts | **`src/config/assemble-council.ts`**（新增） | 仅依赖 `CouncilConfigSchema`、`PATHS`（均 config 层）。ui/server 皆可向下依赖 config。✓ |
| `discoveredToModelConfig` | first-run.ts | **`src/providers/model-assembly.ts`**（新增） | 依赖 `DiscoveredModel`（providers）。✓ |
| `buildNamedModels` | first-run.ts | 同上 | 依赖 `DiscoveredModel`。✓ |
| `selectBestChairman` | first-run.ts | 同上 | 依赖 `rateModelCapability`（core）——providers→core 合规（core 是最内层叶子，ARCH-02 只禁 core→外）。✓ |
| `sanitizeProviderName` + 自定义 ModelConfig 塑形 → 提取为 `buildCustomModelConfig` | first-run.ts | 同上 | 纯字符串/对象塑形。✓ |

- `first-run.ts` 改为从新位置 `import`（保持行为不变，向下依赖，无新环）。
- server 从 `config/assemble-council.ts` 与 `providers/model-assembly.ts` 向下依赖（server→{config,providers} 已是既有方向）。
- **ARCH 合规**：ARCH-01/02 不触（core 不动）；无跨层反向依赖；提取为纯函数模块，ARCH-04 无关（非 types/）。
- **被否**：把这些函数塞进 `src/commands/shared/`——ui 要用就得 ui→commands（上行），与 commands→ui 形成环。否。在 server 里重写一份——真相源分裂，违背"复用而非重造"。

**`ConfigLoader` 新增**（config 层，向后兼容）：
```typescript
/** 与 loadAllModels() 不同：不过滤 enabled —— GUI 需列举含禁用模型。 */
loadAllModelConfigs(): ModelConfig[];
/** 读单个模型文件（含禁用），供 PATCH 读→改→存。 */
loadModelConfig(name: string): ModelConfig | null;   // safePath 防遍历
```
`loadAllModels()`（过滤 enabled）保持不变，编排/rescan 继续用它。

---

## 7. 决策 5 — 前端

- **导航位置**：现有 hash 路由 `launch / watch / history` 增第四视图 **`settings`**（`#/settings`）。header 导航加"⚙ 设置"链接。与三视图并列、互不嵌套。
- **页面结构**（单页分区）：
  1. **通用设置**表单（general 7 字段）——本地校验镜像 schema 边界（`min≥1`、`max≥min`、enum 下拉），保存按钮 → `PUT /api/config`。
  2. **模型列表**——每行显示 `name / provider / invocation / enabled 开关 / 自定义标记`；开关即时 `PATCH /api/models/:name`。含禁用模型（灰显）。
  3. **prefer 顺序**——可上下移的列表，保存 → `PUT /api/config`（`prefer`）。
  4. **自定义端点**——name/baseUrl/modelIds/apiKey 表单 → `POST /api/providers/custom`；key 输入框 `type=password`，提交后清空、绝不回填。
  5. **重新扫描**按钮 → `POST /api/setup/rescan`。
- **只读段**：折叠面板展示 `ConfigDTO.readOnly`，标注"编辑 council.yaml 修改"。
- **保存反馈**：分区独立保存；成功 inline toast，失败显示后端 `error`。
- **rescan 进度**：**同步 await + spinner**（凭证/模型发现是秒级；无需轮询）。返回后内联渲染 `RescanSummaryDTO`（新增/已存模型、凭证状态表）。
- **乐观锁 409 处理**：任何 `PUT/PATCH` 收 409 → 横幅"配置已被外部修改，已重新加载" → 用响应体里的当前 `ConfigDTO` 覆盖本地状态（rebase），用户复核后重提。
- **传输**：沿用 `store.js` 的 `getJSON/postJSON`，补 `putJSON/patchJSON`。所有请求同源、带现有 header；写请求天然带 Origin（浏览器发出），过 security 中间件。
- **MOCK 模式**：为设置页提供静态 `ConfigDTO` fixture（`web/dev-fixtures/config-sample.json`），使 #41 可脱离真实 server 独立开发。

---

## 8. 工作项拆分建议（#40 / #41 能否并行）

**能并行。** 本文档 §4（DTO+路由契约）+ §6（下沉位置）即冻结契约，冻结后两侧独立开发，#42 集成。

| 工作项 | 负责 | 内容 | 依赖 | 粒度 |
|--------|------|------|------|------|
| **#40 server+config** | `@cli-dev`（server/config/装配域） | ①下沉提取（§6）：`config/assemble-council.ts`、`providers/model-assembly.ts`，改 first-run.ts 引用 ②`ConfigLoader.loadAllModelConfigs/loadModelConfig` ③`server/runtime-config.ts` + 改 DebateManager/app/routes/serve 读法 ④`server/routes/config.ts`：GET/PUT/PATCH/custom/rescan + 哈希乐观锁 + 脱敏投影 ⑤`protocol.ts` 追加配置 DTO | 本设计 | 批量流 |
| **#41 前端设置页** | `@cli-dev` | `settings` 视图 + 导航 + 4 分区表单 + prefer 排序 + rescan 呈现 + 409 rebase + `putJSON/patchJSON` + `config-sample.json` fixture | 本设计 §4/§7 | 批量流 |
| **#42 集成+文档** | Step 2.5 集成 + `@doc-keeper` | 端到端冒烟（起 serve→改配置→下一场辩论生效→rescan→自定义端点）；脱敏不变量测试；README `council serve` 增配置说明；TDD 增配置路由与 RuntimeConfig | #40 #41 | — |

**并行前提**：#41 用 §4 的 DTO fixture 驱动 UI；#40 用 `curl` 手测路由。契约（本文档）先冻结。

**`@architect` 复审触发点**：
- 若实现中发现 `assembleConfig` 的浅合并不足以表达某可编辑字段（如需要改 routing 深层字段）→ 暂停回 architect（可能需扩合并语义）。
- 若发现需要经 API 编辑 env/OAuth 凭证（超出决策 3 的自定义端点边界）→ **暂停回 architect**，这是安全边界的再裁定，不得由 dev 自行放开。
- `RuntimeConfig` 若被发现需要暴露给 core（而非仅 server）→ 那将触及 ARCH-02，暂停。

---

## 9. 遗留与后续（非本次范围）

- **零模型冷启动**：放开 `serve` 在无模型时也能起、从浏览器走 rescan/自定义端点完成首配（需把 OAuth 登录流搬进 Web——大工程）。
- 消除 `general.default_chairman` 与 `routing.default.chairman` 冗余（独立清理项）。
- 经 API 管理 OAuth 登录（设备码/浏览器重定向的 Web 化）。
- 模型结构性字段（priority/capabilities/timeout）的 GUI 编辑。
- 配置变更审计（谁在何时改了什么）。

---

## 10. ARCH 合规声明

- **ARCH-01/02**：core 完全不动，不引入 I/O，不被 server 反向依赖。✓
- **ARCH-03**：`commands/serve.ts` 仍 ≤150 行，仅多构造 `RuntimeConfig` 一步，业务在 server。✓
- **ARCH-04**：新增配置 DTO 全部纯 `interface`，置于 `server/protocol.ts`（server 私有线协议），非 `types/`。✓
- **ARCH-05**：GUI 仍经既有接口接入；配置写经 `ConfigLoader`（config↔commands 契约）与下沉的纯函数，未新增跨层耦合。✓
- **SEC-02**：出线不变量保持——响应绝不含 key/token；入线 key 仅落 0o600 文件、不记日志、不回显（决策 3）。✓
- **SEC-04**：静态托管仍走 hono `serveStatic`；模型文件读写经 `safePath` 防遍历。✓
</content>
</invoke>
