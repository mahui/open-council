# 信息架构审阅报告（Information Architecture Review）

> 审阅日期：2026-07-05 · 审阅者：@architect
> 范围：全项目信息架构（模块边界、类型归属、配置/文档/命名/导出面）
> 性质：**结构审阅，非缺陷排查**。正确性问题上一轮已清理，本报告只回答"东西放得对不对、边界清不清楚、信息有没有一致的家"。

---

## 0. 实际依赖图（grep 事实，非 TDD 理想图）

按 `src/<dir>` 出边统计（仅跨模块边，`../types/*` 视为合法的类型依赖，已省略计数细节）：

```
types      → （无出边，叶子层）✓
core       → types ✓ | ui/renderer ✗(见 P0-1)
providers  → types ✓ | config/paths | storage/database ✗(见 P2-6)
storage    → types ✓ | config/paths | providers/utils ✗(见 P0-2)
config     → types ✓ | providers/utils ✗(见 P0-2)
ui         → types core config storage providers ✓（消费层，合法）
commands   → 全部 ✓（顶层薄壳，合法）
```

**健康结论（先说好消息）：**
- `src/core/` **零 I/O 导入**——无 `node:*` / `fs` / `child_process` / `better-sqlite3`。ARCH-01 干净。✓
- `src/types/` 除 `errors.ts` 的 Error 子类外**零运行时代码**。ARCH-04 基本达标（Error 类见 §附注）。✓
- core 各实现文件里导出的接口（`ParsedReview`、`AnswerReviewSummary`、`CompressionPlan`、`ModeDecision` 等）**均为模块私有**——grep 确认无一被跨模块 import。类型"就近定义"在此是对的，**不需要搬进 types/**。✓
- TUI（`TuiRenderer`/`Dashboard.tsx`）经 `renderer-factory` 动态挂载，**是活代码**，非死资产。✓

**问题边只有两类**（下方 P0 各对应一条）：`core→ui/renderer`（接口错位）与 `{config,storage}→providers/utils`（共享工具错位）。整体分层比预期干净。

---

## P0 — 明确该做的结构修正

### P0-1 · `Renderer` 接口错位，导致 core→ui 违规

**现状事实**
- `Renderer` 接口定义在 `src/ui/renderer.ts:8`。
- `src/core/orchestrator.ts:31` `import type { Renderer } from '../ui/renderer.js'` —— **core 反向依赖 ui**。
- 该接口正是 ARCH-05 点名的五大边界接口之一（ui ↔ core 桥）。

**问题**
边界接口住在其中一个实现方（ui）家里，另一实现方/消费方（core）就被迫跨层 import。这违反 ARCH-02（core 禁止导入 ui）与 ARCH-05（模块间通过接口交互——接口应中立）。虽是 `import type` 编译期无残留，但**依赖方向图上是一条实打实的违规边**，也是 IA 意义上"接口没有一致的家"的典型。

**建议动作**
1. 新建 `src/types/renderer.ts`，迁入 `Renderer` 接口（纯类型，符合 ARCH-04）。
2. `src/ui/renderer.ts` 改为从 `types/renderer.js` re-export（或直接删除，让实现方/工厂直接引 types）。
3. 更新 4 处 import：`core/orchestrator.ts`、`commands/benchmark/report.ts`、`ui/renderer-factory.ts`、以及各 Renderer 实现（`plain-renderer.ts`/`live-renderer.ts`/`tui/TuiRenderer.ts`）。

**影响面/风险**：type-only 迁移，~6 处 import 改动，零运行时行为变化。**非 breaking**（接口签名不变，仅换 import 路径）。风险极低。
**建议负责**：@cli-dev（改 ui/commands 侧）+ @core-dev（改 orchestrator 一行）；@architect 确认 types/renderer.ts 落位。

---

### P0-2 · `safePath` / `hasBinary` 共享工具错位，导致 config/storage→providers 反向边

**现状事实**
- `src/providers/utils.ts` 导出两个**与 provider 领域无关的纯工具**：`safePath`（路径穿越防护，纯计算）与 `hasBinary`（PATH 探测）。
- 消费方遍布三层：
  - `config/loader.ts` → `safePath`
  - `config/presets.ts` → `hasBinary`
  - `storage/session-store.ts` → `safePath`
  - `storage/checkpoint.ts` → `safePath`（团队已知项）
  - `ui/wizard/first-run.ts` → `hasBinary`
- 结果：`config→providers`、`storage→providers` 两条反向依赖边，只为借一个通用函数。

**问题**
`safePath` 是安全关键（SEC）且完全领域无关的纯函数，却被囚禁在 `providers/` 里。任何需要它的模块都得反向依赖 providers——这正是团队提出"是否该有 `src/shared/`"的根因。当前没有一个"框架无关纯工具"的家，工具被迫寄居在第一个用到它的模块。

**建议动作**
1. 新建 `src/shared/`（纯函数、无 I/O 副作用之外零依赖的工具层，位于 types 旁、core 之下的地位）。
   - `src/shared/path.ts` ← `safePath`
   - `src/shared/env.ts` ← `hasBinary`（`hasBinary` 内部调 `which`/PATH，含轻 I/O，但语义是环境探测通用工具，仍属 shared）
2. `providers/utils.ts` 若清空则删除，否则只保留 provider 专属工具。
3. 更新 5 处 import。
4. 在 CONTRIBUTING/TDD 补一句 `src/shared/` 的定位：**只放跨层、领域无关、无业务语义的工具；不得反向 import 任何业务模块**（否则 shared 会变成垃圾抽屉）。

**影响面/风险**：5 处 import 改动 + 1 个新目录。纯搬家，但**收益明确**——消除两条反向依赖边、给安全关键函数一个中立的家、并为未来同类工具立规矩。动静小、收益配得上。**非 breaking**。
**建议负责**：@architect 定 `src/shared/` 契约 → @storage-dev + @cli-dev 改各自 import。

> 备注：`hasBinary` 是否进 shared 可讨论——若团队认为它偏"运行环境探测"更像 providers 职责，可只迁 `safePath`（纯函数、零疑义），保留 `hasBinary` 在 providers 并让 config/ui 显式依赖。但 §P0-2 首选方案是两者同迁，让 shared 有清晰语义。

---

## P1 — 应该做，但需一次决策或涉及非结构面

### P1-1 · 静态角色模板 `defaults/roles/*.yaml` 已成死资产

**现状事实**
- `ConfigLoader.loadRoleSet()`（`config/loader.ts:58`）**零调用者**——grep 全库无 `.loadRoleSet(` 调用。
- `defaults/roles/{architecture,code-review,default}.yaml` 只经 `loadRoleSet` 读取，故**运行时从不加载**。其 payload（`system_prompt` 等长文本）是死负载。
- `--role-set <name>` CLI 选项存在（`cli.ts:32`），经 `council.ts:72` 以**字符串**传入，但 `router` 的 `SeatAllocationInput.roleSet?: RoleSet`（对象字段，`router.ts:252`）**从未被任何加载出的 RoleSet 对象填充**——`orchestrator` 走的是 `role-generator.generateRoles()`（AI 动态生成）。
- 幸存的只是**角色集名字**：`router` 里 `suggestedRoleSet: 'code-review' | 'architecture' | 'default'` 仍作为输出标签（`roleSetUsed`）使用。

**问题**
AI 动态角色生成上线后，静态 YAML + `loadRoleSet` + router 里 `roleSet?: RoleSet` 对象通路成了一整套**没有消费路径的平行机制**。它既误导读者（以为改 YAML 能调角色），也是维护负担。

**建议动作（二选一，需产品决策）**
- **方案 A（推荐·彻底）**：删除 3 个 YAML + `loadRoleSet` + `router` 的 `roleSet?: RoleSet` 对象分支（`getRoleNames/getRoleDescription/getRoleSystemPrompt` 的 `roleSet` 参数），保留 `suggestedRoleSet` 名字作为路由标签。信息架构变干净：角色只有"动态生成"一条真相源。
- **方案 B（保守·复活）**：把 `loadRoleSet` 接回 orchestrator——当用户显式 `--role-set` 时用静态模板覆盖动态生成。让 YAML 重新有真实消费路径。

**影响面/风险**：A 删代码降复杂度，但需确认 PRD v7.0 是否仍承诺"用户可自定义 role set YAML"（若承诺则走 B 或补文档）。**这是产品/架构联合决策，不是纯 dev 活。**
**建议负责**：@pm 拉 @architect 定方向 → 对应 @core-dev/@cli-dev 执行。落方案前先 `grep "role.set\|角色集" docs/PRD.md` 确认承诺面。

---

### P1-2 · `CLAUDE.md` 版本/阶段信息自相矛盾且过时

**现状事实**（同一文件内三处打架）
- 顶部：`PRD.md (v7.0)`、`TDD.md (v2.0)`。
- "项目概述"节（`CLAUDE.md:178-179`）：`PRD (v6.3)`、`技术设计 (v1.0)`。
- "当前开发阶段"（`CLAUDE.md:219-221`）：`Phase 0（最小可运行原型）… 不含配置系统、持久化、TUI`——但代码早已含全部三者。
- 实际权威：`docs/TDD.md` 自声明 **v2.1**（非 v2.0），`docs/PRD.md` v7.0。

**问题**
文档 IA 最基础的一致性失守：读者无法判断哪个版本号、哪个 Phase 是真的。"当前开发阶段"卡在 Phase 0 会让 agent 的 Phase 纪律判断全部失准（例如误以为不该碰 TUI）。

**建议动作**
1. 统一 `CLAUDE.md` 内两处版本号为权威值（PRD v7.0 / TDD v2.1），删除 v6.3/v1.0 旧引用。
2. 重写"当前开发阶段"节，反映真实进度（全功能已实现，当前处于结构/质量收敛期）。
3. 顺带明确各文档职责边界（见 P1-4）。

**影响面/风险**：纯文档。零代码风险。属场景 A。
**建议负责**：@doc-keeper。

---

### P1-3 · 文档职责边界与 `design-notes/` 缺索引

**现状事实**
- 文档集：`README.md`(8.3KB)、`CLAUDE.md`、`docs/PRD.md`、`docs/TDD.md`、`CONTRIBUTING.md`、`docs/design-notes/`（现有 `consensus-review-dataflow.md` + 本报告，共 2 篇，**无 README/索引，无命名约定**）。
- `design-notes/` 是新目录，尚无"它承载什么、何时该新增一篇、命名规则"的说明。

**问题**
六处文档缺一张"谁装什么"的地图，易重复（如版本号在 CLAUDE.md 与 PRD/TDD 各写一份就已打架）与漂移。design-notes 无索引会随篇数增长变成散沙。

**建议动作**
1. 在 `docs/design-notes/README.md` 写一句话职责（"记录跨模块设计决策、数据流、trade-off 的定稿笔记；每篇聚焦一个主题；kebab-case 命名"）+ 篇目索引表。
2. 在 CLAUDE.md 或 CONTRIBUTING 补一张文档职责矩阵：
   - README = 用户视角（装什么、怎么跑）
   - PRD = 产品需求真相源
   - TDD = 技术/接口/数据结构真相源
   - CONTRIBUTING = 规则（ARCH/SEC/TS 编号）
   - CLAUDE.md = 开发流程 + 指针（**不复制版本号/需求正文，只引用**，避免 P1-2 类漂移）
   - design-notes = 决策/数据流定稿笔记

**影响面/风险**：纯文档。
**建议负责**：@doc-keeper。

---

### P1-4 · 核心/命令层测试镜像缺口（触及 core 覆盖率硬规则）

**现状事实**
- `src/core/language.ts` **无对应测试**（core 其余 11 个模块均有）。CONTRIBUTING 要求 core 覆盖率 ≥ 90%，此缺口可能直接拉低达标。
- `test/ui/`、`test/commands/` 目录**完全不存在**——UI 与命令层零测试。
- `commands/benchmark/report.ts` = **232 行**，超 ARCH-03 的 `≤150 行/文件` 上限，且无测试。
- `config/paths.ts`、`config/presets.ts`、`config/schema.ts` 无测试。

**问题**
既是测试覆盖问题，也是 IA 问题——`test/` 未完整镜像 `src/`，且有文件破 ARCH-03 行数约束。

**建议动作**
1. 补 `test/core/language.test.ts`（**优先**，护 core 90% 规则）。
2. 评估 `commands/benchmark/report.ts` 拆分：把渲染/统计逻辑下沉，命令层回到薄壳（ARCH-03）。拆完顺带补测试。
3. ui/commands 层测试按 ROI 补（薄壳可低优，`report.ts`/`live-renderer.ts` 这类含逻辑的优先）。

**影响面/风险**：`report.ts` 拆分是唯一涉代码结构的项（core 逻辑外移可能触及边界，建议先走 Step 1）；其余是纯补测试（场景 B）。
**建议负责**：@tester（补测试）+ @cli-dev（report.ts 拆分，若涉 core 逻辑外移则 @architect 先审）。

---

## P2 — 可做可不做的美化 / 已评估为不值得动的项

### P2-1 · `types/index.ts` barrel 零消费
`src/types/index.ts` re-export 全部类型，但**全库 0 次引用**，63 处类型 import 全是深路径（`types/session.js` 等）。要么将来作为对外 API 面正式启用，要么删除以免误导。当前无公开包 API，**低价值**。建议：暂留一行注释说明"预留给未来对外导出面"，或删。@cli-dev 顺手。

### P2-2 · `TuiRenderer.ts` 命名破 kebab-case 一致性
`src/ui/tui/TuiRenderer.ts` 是 kebab-case 群里唯一的 PascalCase `.ts`（它是类文件非组件）。`Dashboard.tsx` 的 PascalCase 是 ink/React 组件约定，**合理保留**。建议仅把 `TuiRenderer.ts` → `tui-renderer.ts`（改 1 处动态 import）。低优。@cli-dev。

### P2-3 · `src/ui/` 12 文件扁平（暂不建议动）
可按族分组：渲染族（renderer/plain-renderer/live-renderer/renderer-factory/markdown）vs 交互族（repl/input/interactive/follow-up/slash-picker/viewer）。但**仅 12 个文件、全是纯搬家、要动十余处 import，收益不配动静**。`tui/`、`wizard/` 子目录先例已足够。**明确建议不做**，除非 ui 文件数继续增长到 20+ 再议。

### P2-4 · `credentials/types.ts` 是冗余再导出
`src/providers/credentials/types.ts` 仅 `export type { ... } from '../../types/provider.js'`——一层无实质内容的间接。可删，让消费方直接引 `types/provider.js`。低优、需查其 import 者数量再定。@provider-dev。

### P2-5 · providers ↔ storage 双向耦合（评估后：可接受，记档即可）
`providers/health.ts:1` import `storage/database`（熔断器状态持久化 SQLite），同时 storage 又借 providers 的 safePath。P0-2 会消除后一条边；前一条（health→storage）是**有意的设计**（断路器状态需落盘）。结论：**不改代码**，但在 TDD 明确 storage 与 providers 的层级关系——二者是"基础设施同级层"，storage 可被 providers 消费。避免未来误判为违规。@doc-keeper 记一句。

---

## 附注 · `types/errors.ts` 的 Error 类 vs ARCH-04

`src/types/errors.ts` 含 8 个 Error 子类（运行时代码），字面上与 ARCH-04"types/ 零运行时代码"冲突。但 Error 类是类型系统与运行时的天然交叉点，放 types/ 是社区惯例。**结论：接受为 ARCH-04 的显式豁免**，建议在 CONTRIBUTING 的 ARCH-04 条目补一句"Error 类与 zod schema 的类型推导为允许的例外"，把默契写成明规则，免得未来审查反复纠结。@doc-keeper。

---

## 执行顺序建议

1. **先 P0-1 + P0-2**（结构修正，互不冲突，可并行；两者都 type-only/纯搬家，风险最低，先清依赖图）。
2. **P1-2 + P1-3 + 附注**（文档批，@doc-keeper 一趟做完）。
3. **P1-1**（需产品决策，@pm 拉 @architect 先定方向再动手）。
4. **P1-4**（补 core/language 测试优先；report.ts 拆分排后）。
5. P2 视余力，其中 **P2-3 明确不做**。

> 全程不改行为、不涉接口签名变更（P0-1 仅换 import 路径，非 breaking）。唯一需 Step 1 架构审查的是 P1-1 的方向决策与 P1-4 的 report.ts 逻辑外移。
