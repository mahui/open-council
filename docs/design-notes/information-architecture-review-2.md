# 信息架构审阅报告 · 第二轮（模型配置流程批次）

> 审阅日期：2026-07-07 · 审阅者：@info-architect
> 范围：模型配置流程改进批次（10 笔提交 `36b4a3e..627e941`，HEAD=`627e941`）落地后的结构复审
> 性质：**结构审阅，非缺陷排查**。回答"东西放得对不对、边界清不清楚、信息有没有一致的家"。正确性/安全属 @reviewer。
> 方法论范本：`information-architecture-review.md`（2026-07-05，第一轮）。本轮对照上一轮核销 + 核该批次新增结构。
>
> 说明：审计基于 HEAD。工作树中未提交产物（`.claude/agents/*`、`README/CLAUDE.md/web/*/docs/assets` hunk，以及 `test/commands/models-name-guard.test.ts`〔未跟踪〕、`test/ui/wizard/first-run.test.ts`〔已改〕）为其他会话产物，**不计入本轮发现**。

---

## 0. 上一轮（2026-07-05）核销

| 上轮项 | 结论 | 现状证据 |
|--------|------|----------|
| P0-1 `Renderer` 接口迁 `types/renderer.ts` | ✅ 已修 | `src/types/renderer.ts` 存在；`core/orchestrator.ts:34`、6 处 renderer 实现均从 `types/renderer.js` 引入，无 `core→ui` 边 |
| P0-2 新建 `src/shared/`，迁 `safePath`/`hasBinary` | ✅ 已修 | `src/shared/paths.ts:16 safePath`；`config→shared`、`storage→shared` 已建，`config→providers`/`storage→providers` 反向边 grep=0 |
| P1-1 静态角色模板死资产（`loadRoleSet` 零调用者） | ✅ 已修（走"方案 B 复活"） | `council.ts:62 loadRoleSetOrExit`、`serve.ts:58`/`debate-manager.ts:129` 均消费 `loadRoleSet`；`--role-set` 现有真实通路 |
| P2-1 `types/index.ts` barrel 零消费 | ✅ 已删 | `src/types/index.ts` 不存在 |
| P2-2 `TuiRenderer.ts` 命名破 kebab-case | ✅ 已修 | `src/ui/tui/tui-renderer.ts`（PascalCase 仅剩 `Dashboard.tsx`，React 组件合法例外） |
| P2-4 `credentials/types.ts` 冗余再导出 | ✅ 已删 | `src/providers/credentials/` 仅剩 `discovery.ts` |
| P1-2 `CLAUDE.md` 版本/阶段自相矛盾 | ✅ 已修 | 见下 §2，版本号全仓库一致 |
| P1-3 `design-notes/` 缺索引 + 文档职责矩阵 | ✅ 已修 | `design-notes/README.md` 索引表 + `CLAUDE.md` 文档职责矩阵均已落成 |

**上一轮 8 项修正全部核销通过。** 本轮无未修项需重提。

---

## 1. 依赖图（grep 事实，非文档理想图）

按 `src/<dir>` 出边统计（`import ... from '../<dir>/...'` 全量解析，`types` 为叶子层）：

```
types      → （无出边，叶子层）✓
shared     → types ✓（唯一出边；无任何业务模块导入）✓
core       → types ✓ | shared ✓
providers  → types ✓ | shared ✓ | config ✓ | storage ✓(有意：熔断状态落盘 health→database)
storage    → types ✓ | shared ✓ | config ✓
config     → types ✓ | shared ✓
ui         → types core config storage providers shared ✓（消费层，合法）
server     → types core config storage providers ✓（外层消费，无 server→ui/shared 越界）
commands   → 全部 ✓（顶层薄壳，合法；无任何层→commands 反向边）
```

**健康结论（本批次的核心成果）：**

- **`providers→core` 反向边已消除** ✓。`rateModelCapability` 从 `core/role-generator.ts` 迁至 `shared/model-catalog.ts` 后，`providers/model-assembly.ts:22` 改为 `import ... from '../shared/model-catalog.js'`。grep 确认 `src/providers`、`src/ui`、`src/config`、`src/storage`、`src/server` **无一 import `role-generator`**（仅剩 `repl.ts`/`first-run.ts` 两处注释文字命中）。
- **`ui→core`（就 `rateModelCapability` 而言）反向边已消除** ✓。`first-run.ts:10` 改从 shared 引入 `rateModelCapability`/`isRecommendedModel`。`ui→core` 仅剩 `repl.ts`/`follow-up.ts → orchestrator`——消费层调编排，合法。
- **`shared/` 纪律守住** ✓。`shared` 唯一出边是 `→ types`（`model-catalog.ts`/`format-model.ts → types/config.js`）；无反向 import 任何业务模块，未变成垃圾抽屉。
- **家族排名/推荐逻辑无残留私有副本** ✓。`rateModelCapability`/`flagshipRank`/`isRecommendedModel` 定义**全库唯一**，均在 `shared/model-catalog.ts`；`flagshipBonus` 旧内联已删（grep=0）。三层消费者（core orchestrator/role-generator、providers model-assembly、ui first-run）全部从 shared 单一数据源推导。
- **本批次 7 个新导出全部有消费路径**，无死导出：`MODEL_TIER_RULES`（内部 + 3 处测试消费）、`ModelTierRule`、`flagshipRank`（model-assembly）、`isRecommendedModel`（first-run）、`discoverEndpointModels`（first-run 向导已接线）、`resolveOfficialKey`（model-discovery + getApiKey 内部）、`deleteModelConfig`（models/mutations）。
- `providers→config`、`providers→storage`、`storage→config` 均为**前向/同级基础设施依赖**，非违规（与上一轮裁定一致：storage 与 providers 为基础设施同级，config 为下层基础设施）。

**本批次未引入任何反向边、越界边或死导出。依赖图比批次前更干净。P0 = 空。**

---

## 2. 文档一致性

- **版本号全仓库一致** ✅：`docs/PRD.md:5` 自声明 v8.1，`docs/TDD.md:3` 自声明 v3.1；`CLAUDE.md:8-9,200-201` 与 `README.md:293-294` 引用值与之全部吻合。上一轮 P1-2 的多处打架已根除。
- **TDD §3.4 已据设计笔记修订** ✅：`discoverModels(credentials)`、`discoverEndpointModels`、`resolveOfficialKey`、`deleteModelConfig`、`MODEL_TIER_RULES`/`flagshipRank`/`isRecommendedModel` 归位 `shared`、`commands/models/` 拆分——均在 TDD §3.4/结构树/变更记录 v3.1 中登记。`shared/` 层定位与"两条反向边消除"写入 TDD 关键设计决策。
- **design-notes 索引已登记** ✅：`model-config-flow.md` 在 README 索引表就位。
- 唯一漂移见 **P2-3**（TDD 测试树列了不存在的文件）。

---

## P0 — 明确该做的结构修正

**无。** 依赖图无反向边、类型归属到位、新导出面全部有消费者、文档职责矩阵与版本一致。本批次结构纪律优秀，无需结构性返工。

---

## P1 — 应该做，但需一次决策或跨关注点

### P1-1 · `invocation_mode: 'cli'` 生产端已死，但读取端仍服务历史会话——需一次"是否支持旧会话"的决策

**现状事实**
- 类型 `src/types/provider.ts:11 invocation_mode: 'cli' | 'api'`（`Dashboard.tsx:14` 另有本地同款联合）。
- **生产端全部只发 `'api'`**：6 处赋值点（`orchestrator.ts:397/529/586/743`、`api-adapter.ts:344`、`tui-renderer.ts:101`）全为 `invocation_mode: 'api'`；`invocation_mode: 'cli'` 赋值 grep=0。标准 API 收敛拆除 CLI 通道后，`'cli'` 生产端已死。
- **读取端有 4 处 `=== 'api' ? 'API' : 'CLI'` 回退分支**：`plain-renderer.ts:64`、`live-renderer.ts:211`、`viewer.ts:175`、`Dashboard.tsx:154`（team-lead 清单列了前两+Dashboard，**漏了 `viewer.ts:175`**，本轮补上）。
- **关键 nuance**：`invocation_mode` 是**持久化字段**——`storage/database.ts:86 invocation_mode TEXT` 列 + `session.ts:53 result: InvocationResult`。收敛前创建的旧会话，磁盘上可能存 `'cli'`；`viewer.ts`/`history`/`replay` 读回这些记录时，`'CLI'` 分支**仍是有效的向后兼容读路径**，并非纯死代码。

**问题**
这不是"发现即删"的死代码，而是"生产端已移除、读取端为兼容旧数据保留"的半死态。盲目收窄类型到 `'api'` 会让读回旧 `'cli'` 会话时类型失真。是否清理取决于一个未表态的产品问题：**收敛前的历史会话是否仍需受支持？**

**建议动作（二选一，需 @pm/@architect 决策）**
- **方案 A（旧会话视为不受支持/可弃）**：类型收窄 `invocation_mode` 到 `'api'`；删 4 处 `'CLI'` 回退分支（恒为 `'API'`，显示"API"已无区分意义，可一并考虑移除该展示列）；评估 DB 列去留。信息架构最干净——invocation_mode 只有一个取值即等于"没有模式概念"。
- **方案 B（保留向后兼容）**：类型与 4 处分支**原样保留**（它们正确服务历史数据），仅在 `types/provider.ts:11` 注一句"`'cli'` 为收敛前遗留取值，生产端不再产生"，把默契写成明规则，防止下一轮审计重复纠结。

**影响面/风险**：A 触及持久化类型 + 4 处 UI，需确认无旧数据依赖；B 纯注释，零风险。**这是数据兼容策略决策，不是纯 dev 活。**
**建议负责**：@pm 拉 @architect 定"旧会话支持面"→ 方案 A 走 @provider-dev（类型）+ @cli-dev（UI 分支）；方案 B 走 @doc-keeper 一行注释。

**架构裁决（@architect，2026-07-07，任务 #16）：采纳方案 B（保留向后兼容），拒绝方案 A。**

info-architect 标记的"未表态产品问题"其实**已由权威文档表态**，无需重新论证：

1. **PRD v8.1 §3 数据模型（PRD:672）**明文：`invocation_mode … 新写恒为 api。历史遗留：读取旧 session 时可能出现 cli，仅作兼容`。**TDD v3.1 §3.1（TDD:259）**同款：`'cli' 仅为读旧 session 的历史兼容`。产品与技术两个真相源均已声明 `'cli'` 是**保留的只读遗留取值**。方案 A（类型收窄到 `'api'`）直接与两份文档冲突——按文档优先级（此处 TDD、PRD 一致），A 不予采纳。
2. **PRD §6.5 辩论回放**承诺 `council replay {session_id}` 回放历史 session，**无版本门槛**（不存在"仅收敛后 session 可回放"的限定）。方案 A 若判定旧会话不再受支持，等于毁约。
3. **session 是不可变历史记录，不是可迁移配置——schema_version 1→2 先例不适用。** 已核实 `config/migrate.ts` 只重写配置（council.yaml + model YAML），**从不触碰 session/invocation**；session 无任何 schema_version 或迁移机制，读回即原样。一次真实发生过的辩论若确经 CLI 运行，`invocation_mode:'cli'` 是**真实史实**。记录层是 append-only 事实日志，配置层的非破坏迁移语义不能挪用过来。

**对 team-lead 三个子问的明确回答：**
- DB 迁移改写 cli→api？**否**——不改写历史记录。
- 读取时归一？**否**——同上；且会连带掩盖 `exit_code`/`stderr`/`truncated` 等同类遗留字段的真实语义。
- 判定旧会话不再支持回放？**否**——违反 PRD §6.5。

**方案 B 落地要点（纯注释/文档，零代码风险，场景 A，负责 @doc-keeper）：**
- `src/types/provider.ts:11`：把 TDD:259 已有的注释**同步到源码**——`invocation_mode: 'cli' | 'api'; // 新写恒为 'api'；'cli' 仅为读旧 session 的历史兼容，勿新产`。顺带核对 `exit_code`/`stderr` 源码注释与 TDD:260/262 齐备（它们是同类遗留字段）。
- `src/ui/tui/Dashboard.tsx:14` 的本地重复联合 `'api' | 'cli'`：**保留两值** + 加同款一行注释。其"本地重复了 provider.ts 类型"是独立的类型归属/导出面问题，若要收敛（Dashboard 改 import 共享类型）另立工作项，**不在本裁决内**。
- 4 处读取分支（`plain-renderer:64`/`live-renderer:211`/`viewer:175`/`Dashboard:154`）与 `storage/database.ts:86 invocation_mode TEXT` 列**原样保留**——正确的向后兼容读路径 + 历史值存储，replay 依赖之。
- `server/web-renderer.ts:72` 原样转发 `result.invocation_mode`（旧 session 会转发 `'cli'`），与 B 一致，无需改。

**结论**：本项从"需 Step 1 决策"降级为"一行级注释同步"（场景 A），无 breaking、无接口签名变更、无 @provider-dev/@cli-dev 参与。

---

### P1-2 · `commands/models/add.ts` 是本批次唯一无测试镜像的新模块

**现状事实**
- `commands/models.ts` 拆分为 barrel + `models/` 7 文件。`test/commands/models.test.ts` **只覆盖 `models/mutations.ts`**（`addModelConfig`/`removeModelConfig`/`setModelEnabled`）。
- `models/add.ts`（147 行，本批次发现接线核心：`runModelsAdd`/`collectFromDiscovery`/`collectCustomEndpoint`/`parseModelIds`）**无测试导入**（`grep -rl "models/add.js" test/` = 0）。
- 其中 `parseModelIds`（`add.ts:145`，纯函数：逗号分隔→trim→去空）是零成本可测的纯逻辑，当前无单测（`first-run.ts` 有同概念但独立的解析路径，不覆盖本函数）。
- 对比：批次其余触及模块镜像齐全——`shared/model-catalog`、`providers/model-discovery`（`discoverEndpointModels`）、`credentials/discovery`（`resolveOfficialKey`）、`config/loader`（`deleteModelConfig`）、`ui/wizard/first-run`（5 个测试文件）均有对应测试。

**问题**
`test/` 未完整镜像 `models/` 拆分。`add.ts` 是 CLI 交互壳（TTY 依赖部分难测可接受），但 `parseModelIds` 纯函数无测属明确缺口。

**建议动作**
1. 补 `parseModelIds` 单测（纯函数，优先，低成本）。
2. `add.ts` 的交互装配部分按 ROI 评估（TTY 依赖，可低优或以 mock prompt 覆盖分支逻辑）。

**影响面/风险**：纯补测试（场景 B），零代码风险。
**建议负责**：@tester。

---

## P2 — 可做可不做 / 已评估明确不做（附理由与再议阈值）

### P2-1 · `tsup.config.ts:13-14` pi-ai external 死条目（清理，低风险）
`@mariozechner/pi-ai` 已从 `package.json` 依赖移除（grep=0），`tsup.config.ts` 的 `external: ['@mariozechner/pi-ai', '.../oauth']` 是对不存在依赖的 no-op，且误导读者以为 pi-ai 仍是运行时依赖。另有 `api-adapter.ts:87`、`shared/match.ts:3` 等 5 处 src/test 注释仍提 "pi-ai"（历史语境）。**建议**：删 external 两行；注释按 @doc-keeper 顺手清理（非阻塞）。零功能影响。**建议负责**：@cli-dev（config）+ @doc-keeper（注释）。

### P2-2 · `ui/wizard/first-run.ts` 797 行——测试已切好缝，src 尚未拆
`first-run.ts` 单文件 797 行，含 `runFirstRunWizard`/`buildModelChoices`/`verifyModelConnectivity`/`resolveEndpointModelIds`（导出）+ `runQuickSetup`/`selectDiscoveredModels`/`collectCustomProviders`（私有）。而 `test/ui/wizard/` **已按 5 个逻辑关注点分文件**：`collect-custom-providers`/`select-discovered-models`/`verify-model-connectivity`/`run-quick-setup`/`first-run`。即**测试比 src 更细粒度**——测试结构已替 src 划好了低风险的拆分缝。属"test 应镜像 src"的逆向缺口（通常是 src 有 test 无，此处相反）。**评估**：ui/ 无 ARCH-03 行数限制，故非硬违规；拆分是纯搬家（私有函数转导出 + 建 `wizard/` 子文件），收益是"src 与其自身测试对齐 + 797 行降到可读"。**倾向：值得做，但不紧急**——下次触碰 `first-run.ts` 时顺势拆；单为整齐而动可缓。再议阈值：文件继续增长或新增第 6 个 wizard 测试文件时执行。**建议负责**：@cli-dev（若做，落位无需 architect，测试缝已验证）。

### P2-3 · TDD 测试树漂移（列了不存在的文件）
`docs/TDD.md:205-231` 的 `test/` 树是**示意性**列举，但含具体幽灵条目：列了 `integration/benchmark.test.ts`、`storage/database.test.ts` 而二者**不存在**；漏了实际的 `integration/wizard-custom-endpoint-e2e.test.ts`、`storage/session-store.test.ts`，且未收录本批次新增的 `test/shared/`、`test/ui/wizard/`、`test/commands/`、`test/server/` 目录。**建议**：要么把该树标注为"示意（非穷举）"并删幽灵条目，要么同步实况。纯文档。**建议负责**：@doc-keeper。

### P2-4 · `shared/` 纯函数测试缺口（低 ROI）
`shared/config-errors.ts`（3 消费者）、`shared/format-model.ts`（2 消费者）、`shared/match.ts`（1 消费者：core/role-generator）无直接测试。均为纯函数，`match.ts` 因被 core 消费略高价值。`safePath`（SEC 关键）在 HEAD 亦无提交的直接测试——但工作树 WIP（`models-name-guard.test.ts`，未跟踪）正补此测，**待其落地后核验**即可，本轮不另立项。**建议**：按余力补 `match`/`format-model` 单测。**建议负责**：@tester。

### P2-5 · commands 层 ARCH-03 边界超标（评估后：暂不拆）
`council.ts`（160 行）、`serve.ts`（153 行）略超 ARCH-03 的 ≤150 行/文件（`models/*` 拆分后全部达标，`add.ts` 147 卡线通过）。二者为装配壳，超出幅度小（3–10 行）。**评估：暂不拆**——强拆装配壳会把连贯的 deps 组装逻辑打散成人为碎片，churn > 收益。再议阈值：任一文件增至 180+ 行，或新增独立子命令时顺势下沉。**建议负责**：暂无（记档）。

### P2-6 · 两个 `paths.ts` 同名不同职（评估后：明确不做）
`shared/paths.ts`（23 行，唯一导出纯函数 `safePath`，路径穿越防护）与 `config/paths.ts`（17 行，`COUNCIL_HOME`/`PATHS` 应用路径常量）basename 相同、职责不同。**评估：不重命名**——二者语义清晰（一个是通用安全函数、一个是 app 路径常量），改名纯为消歧要动 ~5 处 import，收益仅"少一次看错"。动静不配。再议阈值：出现第三个 `paths.ts` 或有人实际混淆时再议。**建议负责**：无（记档）。

### P2-7 · `role-generator.ts` 家族 trait 提示（承接设计笔记 §6.5 移交，评估后：明确不做）
`buildModelDescription`（`role-generator.ts:38-42`）含家族 trait 文案：`codex`→code-specialized、`gemini`→multimodal、`claude`→careful、`gpt`→creative。设计笔记 `model-config-flow.md` §3.3/§6.5 将"是否统一进 catalog"移交本轮评估。**裁定：不迁 shared，保留 core 私有。** 理由：这些是**role-gen prompt 的语义描述文案**（喂给 LLM 的 flavor text），与 `shared/model-catalog` 的**数值排名数据**（`rank`/`recommended`）是不同关注点，合并会把"提示词文案"与"能力排名数据"混为一表。且它们**仅被 core 单层消费**（构建 role-gen prompt），非跨层——按"仅模块内使用就近定义是对的，不搬"原则，`core/role-generator` 正是其正确的家。`gemini` trait 对 Google OpenAI-compat 托管的 gemini 仍有用。再议阈值：**当 core 以外出现第二个消费者需要这些 trait 字符串时**再评估上移。**建议负责**：无（记档，闭合设计笔记 §6.5 移交项）。

---

## 执行顺序建议

1. **P1-2**（补 `parseModelIds` 测试，纯场景 B，低成本先清）+ **P2-1**（删 pi-ai external，trivial）——两项零决策、零风险，可立即并行。
2. **P1-1**（invocation_mode 决策）——@pm 拉 @architect 先定"旧会话支持面"，再按方案 A/B 落地。这是本轮唯一需决策项。
3. **P2-3 + P2-4**（文档树同步 + shared 纯函数补测）——@doc-keeper/@tester 按余力。
4. P2-2（first-run 拆分）下次触碰时顺势做；P2-5/6/7 记档不动。

> 全程无 breaking、无接口签名变更。唯一需 Step 1 决策的是 P1-1 的数据兼容策略。本批次结构质量：**P0 空、上一轮 8 项全核销、7 新导出全消费、零反向边**——结构纪律优秀。
