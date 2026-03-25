# Local AI Council — 项目开发指南

## 强制遵守的文档

**以下文档是开发时的强制约束，所有代码变更必须符合这些文档的要求：**

1. **`CONTRIBUTING.md`** — 开发规范。所有规则以 ID 编号（ARCH-01、SEC-03 等），**规则已内嵌到各 agent 定义中，无需每次任务重复阅读**。
2. **`docs/PRD.md`** (v6.3) — 产品需求文档。功能设计的权威来源。
3. **`docs/TDD.md`** (v1.0) — 技术设计文档。架构、接口、数据结构的权威来源。

**文档查阅策略**：agent 的关键设计约束和规则已内嵌在各自的 `.claude/agents/*.md` 定义中。开发时**不需要全量阅读 PRD/TDD**，仅在对具体细节有疑问时用 Grep 定向搜索对应章节。

**文档优先级**：当文档间出现冲突时，CONTRIBUTING.md（规范） > TDD（技术设计） > PRD（产品需求）。发现冲突时应主动提出并解决，而非静默选择一方。

## 开发流程

### 两种执行粒度

- **单任务流**: 一个工作项独立走完 编码→测试→审查→提交。适用于无跨模块依赖的任务。
- **批量流**: 多个并行工作项编码完成后，集成验证→统一测试→审查→提交。适用于跨模块功能。

`@pm` 在 Step 0 拆解时标注每个工作项走哪种粒度。

### 流程总览

```
@pm 拆解 → [设计审查] → 编码(可并行) → [集成] → 测试+文档(并行) → 审查 → 提交 → @pm 更新
```

### Step 0: 任务拆解

**执行者**: `@pm`

- 收到"开始 Phase N"或具体功能描述后，拆解为独立工作项
- 每个工作项明确：负责 agent、涉及文件、依赖关系、验收标准
- 用 TaskCreate 创建，用 addBlockedBy 设置依赖
- **标注两件事**：
  1. 哪些工作项可并行，哪些必须串行
  2. 哪些工作项需要 Step 1（标记 `needs-architect`：触及接口/架构/数据模型）
- 给出启动建议（先启动哪些、并行哪些）

**产出**: 工作项列表（含依赖 DAG + 并行分组 + needs-architect 标记）

**进度查询**: 任何时候说"进度"、"状态"或直接 `@pm` 即可获取当前工作项状态报告。

### Step 1: 设计审查（仅 needs-architect 的工作项）

**执行者**: `@architect`
**触发**: `@pm` 在 Step 0 标记了 `needs-architect` 的工作项。未标记的直接进入 Step 2。

标记条件（由 @pm 判断）：新增/修改接口定义、数据模型字段增删、新增模块或改变依赖、技术方案不确定。

### Step 2: 编码

**执行者**: 对应的 dev agent

| 涉及模块 | 调用 agent |
|---------|-----------|
| `src/core/` | `@core-dev` |
| `src/providers/` | `@provider-dev` |
| `src/storage/` | `@storage-dev` |
| `src/commands/` + `src/ui/` + `src/config/` | `@cli-dev` |
| benchmark 相关 | `@benchmark-dev` |

**并行**: 无依赖的工作项同时分派。并行前提是接口契约已确定（Step 1 产出或 TDD 已定义）。每个 dev agent 只改自己负责的目录。

**编码中的异常升级**:

| 异常 | 处理 |
|------|------|
| 发现需要改接口 | 暂停 → 通知 @pm → @pm 创建 `needs-architect` 子任务 → @architect 审查 → 继续 |
| 被其他任务阻塞 | 通知 @pm → @pm 调整依赖和优先级 |
| 发现现有代码 Bug | 通知 @pm → @pm 创建 Bug 修复工作项（场景 C） |

### Step 2.5: 集成验证（跨模块批量流时）

**触发**: 并行编码涉及 ≥ 2 个模块时。单任务流跳过。

**执行者**: @pm 指定一个 dev agent（通常 @cli-dev 或 @core-dev）

- 检查各模块能否正确组装（接口匹配、类型兼容）
- 运行端到端冒烟测试
- 发现问题 → 定位模块 → 对应 dev agent 修复

### Step 3: 测试 + 文档（并行）

```
├─ @tester: 编写测试 + pnpm test + 覆盖率检查
│                                                  并行
└─ @doc-keeper: 对照变更类型判断文档是否需更新
```

**测试失败时**: @tester 反馈 → 对应 dev agent 修复 → @pm 标记任务为 fixing → @tester 重跑 → 通过后进入 Step 4。

### Step 4: 代码审查

**执行者**: `@reviewer`

**审查通过条件**: 零 CRITICAL、零 MAJOR（或标注 accepted risk + TODO）。

**审查未通过时**: @reviewer 输出问题（含规则 ID）→ @pm 将任务回退 in_progress → 对应 dev agent 修复 → 重走 Step 3 → Step 4。

### Step 5: 提交与状态更新

- Commit message 遵循 CONTRIBUTING.md §5.2
- `@pm` 标记工作项 completed → 检查是否释放后续阻塞任务 → 提示可启动的下一批
- Phase 最后一个工作项 → 触发场景 D

### 完整流程图

```
  ┌──────────────────────────────────────┐
  │  Step 0: @pm 拆解                     │
  │  工作项 + 依赖DAG + needs-architect    │
  └──────────────┬───────────────────────┘
                 │
  ┌──────────────▼────────────────┐
  │  needs-architect?             │
  ├── 是 → Step 1: @architect ────┤
  └── 否 ─────────────────────────┘
                 │
  ┌──────────────▼────────────────┐
  │  Step 2: 编码 (可并行)         │
  │  异常 → 通知 @pm 处理          │
  └──────────────┬────────────────┘
                 │
  ┌──────────────▼────────────────┐
  │  跨模块? → Step 2.5: 集成验证  │
  │  单任务? → 跳过                │
  └──────────────┬────────────────┘
                 │
  ┌──────────────▼────────────────┐
  │  Step 3: @tester + @doc-keeper │
  │  (并行)                        │
  │  失败 → dev 修复 → 重新 Step 3  │
  └──────────────┬────────────────┘
                 │ 通过
  ┌──────────────▼────────────────┐
  │  Step 4: @reviewer             │
  │  未通过 → @pm 回退 → Step 2    │
  └──────────────┬────────────────┘
                 │ 通过
  ┌──────────────▼────────────────┐
  │  Step 5: 提交 + @pm 更新状态   │
  │  释放后续任务 / 触发场景 D      │
  └────────────────────────────────┘
```

### 特殊场景

**场景 A: 纯文档变更**
```
@doc-keeper 执行 → @reviewer 审查 → 提交
```

**场景 B: 纯测试补充**
```
@tester 执行 → 通过 → 提交
```

**场景 C: Bug 修复**
```
@pm 创建 Bug 工作项 → dev agent 修复 → @tester 回归 → @reviewer 审查 → 提交
按需加 @architect（接口变更）或 @doc-keeper（行为变更）
```

**场景 D: Phase 里程碑**
```
@pm 确认全部 completed → @pm Phase 总结 → @doc-keeper 更新 README + CLAUDE.md
→ 提交 "chore: complete Phase N" → @pm 拆解下一 Phase
```

## 项目概述

Local AI Council 是一个基于 TypeScript/Node.js 的多 Agent 辩论编排系统，支持 CLI 和 API 双模调用。

- **开发规范**: `CONTRIBUTING.md` (强制)
- **PRD**: `docs/PRD.md` (v6.3)
- **技术设计**: `docs/TDD.md` (v1.0)
- **角色模板**: `defaults/roles/*.yaml`
- **基准测试集**: `defaults/benchmark.yaml`

## 技术栈

- TypeScript 5.x + Node.js ≥ 20
- pnpm 包管理
- commander (CLI) + @inquirer/prompts (交互)
- better-sqlite3 (持久化, 同步 API, WAL 模式)
- @anthropic-ai/sdk + openai + @google/genai (Provider SDK)
- ink (TUI, Phase 5)
- zod (Schema 校验)
- vitest (测试)
- tsup (构建)

## 项目结构

```
src/
├── core/        纯逻辑层，禁止 I/O 依赖 [ARCH-01, ARCH-02]
├── providers/   外部交互层（subprocess, HTTP API, 凭证）
├── commands/    CLI 薄层，≤150 行/文件 [ARCH-03]
├── storage/     SQLite + JSON 持久化
├── config/      YAML 加载 + zod 校验
├── ui/          渲染层（plain + TUI）
└── types/       纯类型定义，零运行时代码 [ARCH-04]
defaults/        内置角色集 + benchmark 问题集
test/            测试（对应 src/ 结构）
```

## 关键约束速查

- **架构**: core 不依赖 I/O，模块间通过接口交互 → 见 CONTRIBUTING.md §1
- **类型**: strict 模式，禁止 as any，类型从 zod 推导 → 见 CONTRIBUTING.md §2
- **安全**: prepared statement、凭证 redact、文件权限 0o600 → 见 CONTRIBUTING.md §3
- **测试**: 新功能必须带测试，core 覆盖率 ≥ 90% → 见 CONTRIBUTING.md §4
- **Git**: conventional commits，scope 限定模块名 → 见 CONTRIBUTING.md §5
- **日志**: stdout 只输出结果，stderr 输出进度，文件输出结构化日志 → 见 CONTRIBUTING.md §8

## 当前开发阶段

Phase 0（最小可运行原型），目标：
1. 端到端跑通 council "question" → 多模型并行回答 → Chairman 综合 → stdout 输出
2. 优先 API 模式（读取本地凭证），CLI 模式作为 fallback
3. 不含配置系统、持久化、TUI（Phase 纪律，见 CONTRIBUTING.md §1.3）
