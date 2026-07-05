# Open Council

**基于本地 CLI 工具的多模型辩论编排系统**

**产品需求文档 (PRD) v7.1**

| 项目 | 内容 |
|------|------|
| 文档状态 | Draft |
| 版本 | 7.1 |
| 日期 | 2026-07-05 |
| 作者 | Henry |
| 重点模块 | 辩论流程编排 / 过程数据持久化 / 模型工具配置 / 用户交互体验 |

**修订记录**：

| 版本 | 日期 | 变更 |
|------|------|------|
| 7.1 | 2026-07-05 | 新增本地 Web 界面（`council serve`，见 §6.6 / §7.5）：发起辩论 + 实时观看 + 历史只读，仅本地环回绑定 |
| 7.0 | 2026-03-26 | 初始基线 |

---

## 1. 产品概述

### 1.1 背景与目标

Open Council 是一个本地化的多 Agent 辩论编排系统。其本质是一个**本地化的集成学习（Ensemble Learning）系统**，利用已有订阅额度，通过编排多个 AI Agent 对同一问题进行并行回答、互评、共识评分和综合，以"群蜂智慧"解决单一视角可能存在的幻觉、偏见或深度不足的问题，产出比单次调用更可靠的答案。

**双模调用架构**: 系统支持两种调用模式，可按模型独立配置：

| 调用模式 | 机制 | 优势 | 适用场景 |
|---------|------|------|---------|
| **CLI 模式** | 通过 subprocess 调用本地已安装的 CLI 工具（claude-code、codex、gemini-cli） | 零配置、复用 CLI 的完整能力（如 codex 的代码执行沙箱） | 已安装 CLI 且不需要极致性能 |
| **API 模式** | 直接调用 Provider SDK/HTTP API，复用本地 CLI 客户端已存储的 OAuth 凭证 | 更低延迟、原生流式输出、更精细的错误处理、无 subprocess 开销 | 追求性能、或 CLI 工具不可用但本地有有效凭证 |

API 模式直接依赖 [`@mariozechner/pi-ai`](https://github.com/badlogic/pi-mono/tree/main/packages/ai) 统一 LLM 库——不自行管理各 Provider SDK，而是通过 pi-ai 的统一接口接入所有主流模型。pi-ai 内置了自动模型发现、OAuth 凭证管理（含 token 刷新）、环境变量 API Key 探测等能力。Council 的 API 模式支持的 Provider 和鉴权方式与 pi-ai 保持一致——**pi-ai 支持几种模型、几种接入方式，Council 就支持几种**。

**核心概念**：Agent ≠ 模型。一个模型可以通过不同的角色 prompt 扮演多个 Agent。即使用户只安装了一个 CLI 工具（如 Claude Code），也能让同一模型分别扮演"分析师"、"工程师"、"创新者"三个 Agent 参与辩论，通过角色差异化的 prompt 激发多视角碰撞。多模型 + 多角色的组合效果最佳；**单模型多角色可用，但置信度较低**——同一底模的多角色更接近"多次有偏采样"而非独立 ensemble，系统会通过 `model_diversity_factor` 自动调低其置信度（见 Phase 3 共识评估）。

本 PRD 覆盖以下核心模块的详细设计：

- **辩论流程编排** — 完整的多阶段辩论流程定义、各模式差异、阶段间数据流
- **过程数据持久化** — 如何存储、检索、管理辩论过程中的所有中间数据和最终结果
- **模型工具配置** — 如何发现、注册、配置、监控模型（CLI 工具 + 直接 API），并支持灵活扩展
- **用户交互体验** — 实时进度反馈、人工干预机制、TUI 仪表盘

### 1.2 设计原则

- **Zero-Cost First**: 完全复用已有订阅额度（Claude Max、OpenAI Pro、Google AI），不产生额外 API 费用。无论 CLI 模式还是 API 模式，均通过已有订阅的 OAuth 凭证调用，不需要单独的 API key 或额外付费。**计量口径**：核心辩论流程（Broadcast + Review + Synthesis）的调用计入"正常使用"；可选的辅助调用（`llm` 路由分类、Benchmark 自动评分）会消耗少量额外额度，默认关闭，启用时在 CLI 输出中标注预估额外消耗
- **Offline-Capable**: 持久化层纯本地，无需外部数据库，文件系统即可运行
- **Plugin-Friendly**: 新模型通过引导式配置接入，零门槛；高级用户也可直接编辑 YAML
- **Debuggable**: 每次辩论的全部过程数据可回溯、可分析、可重放
- **Local-First Storage**: 所有数据存储在用户本地，明文持久化，不依赖外部服务。文件权限自动设为 `600`
- **Responsive UX**: 长时间辩论过程中提供实时流式反馈，降低用户等待焦虑

### 1.3 产品价值主张与效果承诺

**为什么多 Agent 辩论比单模型好？**

| 维度 | 单模型直接调用 | Council 多 Agent 辩论 |
|------|-------------|---------------------|
| 视角覆盖 | 单一视角，受 prompt 和训练偏见影响 | 多角色 prompt 激发互补视角，覆盖面更广 |
| 错误率 | 幻觉/遗漏无人兜底 | 互评阶段交叉校验，共识机制过滤低质量回答 |
| 置信度 | 无法量化回答可靠性 | consensus_score 量化模型间分歧，用户可据此判断 |
| 时间成本 | 10-30s | 60-180s（debate 模式），**适用于"值得多花 1 分钟确认"的问题** |
| 适用场景 | 日常问答、简单任务 | 架构决策、方案选型、代码审查等高价值低容错场景 |

**效果承诺与 Release Gate（发布门槛）**：

系统必须通过 `council benchmark` 验证方可发布。每个测试项必须满足以下**双门控**：

| 指标 | 目标值 | 验证方式 | Release Gate (门槛) |
|------|-------|---------|-------------------|
| 关键点覆盖率提升 | debate 比 best-single-deep（同等精细 prompt 的最佳单模型）高 15%+ | LLM 自动评估 + 四组消融实验（见 9.2） | 自动评分连续 3 次达标 |
| 明显错误率下降 | debate 的事实性错误比 best-single-deep 减少 30%+ | 人工标注 | **人工抽检通过率 ≥ 95%** |
| 可接受响应时间 | debate ≤ 180s | 系统内建 | 超时率 < 5% |
| 低共识退避 | consensus < 0.2 时拒绝输出综合结论 | 内建规则 | 100% 触发阻断 |

**人工抽检标准**：LLM 自动评审仅作为初筛。在发布正式版本前，必须对 Benchmark 结果进行至少 20% 的随机抽样人工复核。若人工判定与 LLM 判定不一致率超过 5%，则该次测试无效。

**分类通过率阈值**（不同问题类型的 benchmark 标准不同）：

| 问题类型 | 覆盖率目标 | 错误率目标 | 理由 |
|---------|-----------|-----------|------|
| code（代码） | +10% | -20% | 代码问题有客观对错，模型间差异较小 |
| architecture（架构） | +20% | -30% | 架构问题多维度，多视角收益最大 |
| security（安全） | +25% | -40% | 安全审计容错极低，必须高标准 |
| general（通用） | +15% | -25% | 基线类型 |

**统计显著性要求**（防止偶然波动误通过 Release Gate）：

| 参数 | 要求 |
|------|------|
| 最少问题数 | 每个已纳入类别 ≥ 10 题；最少覆盖 3 个类别；总计 ≥ 该类别数 × 10（如 4 类则 ≥ 40 题） |
| 抽检样本量 | 每类别人工抽检 ≥ 5 题（或该类别的 20%，取大值） |
| 显著性检验 | 覆盖率提升需通过配对 t 检验（p < 0.05）或等效非参检验 |
| 置信区间 | 报告中展示 95% 置信区间，下界仍需 > 0 才算达标 |

> **核心定位**: Council 不是要替代单模型调用，而是为**高价值决策场景**提供一个可量化置信度的增强层。日常问答用 quick，重要问题用 debate。

### 1.4 目标用户与使用场景

| 用户画像 | 典型场景 | 推荐默认模式 | 核心诉求 |
|---------|---------|------------|---------|
| **个人开发者** | 代码问题、技术选型、Bug 调试 | `auto`（多数走 quick/compare） | 快速获得多视角参考，不想花太多时间 |
| **Tech Lead / 架构师** | 架构方案评审、技术路线决策 | `debate` | 需要看到正反观点和共识度，辅助决策 |
| **代码 Reviewer** | PR 审查、安全审计、性能分析 | `compare` | 快速对比多个模型的审查意见 |
| **技术写作者** | 文档审核、方案文档优化 | `compare` | 多角度检查准确性和完整性 |

**使用场景决策树**:

```
你的问题值得多花 1 分钟反复确认吗?
├── 否 → quick (单模型, 10-30s)
│   例: "Python 中 list 和 tuple 的区别"
├── 想看看不同角度 → compare (多模型对比, 30-60s)
│   例: "这段代码有什么潜在问题"
└── 是, 需要高置信度决策 → debate (完整辩论, 60-180s)
    例: "Redis vs Memcached 我们的场景该选哪个"
```

---

## 2. 辩论流程编排

### 2.1 辩论模式定义

系统支持四种辩论模式，复杂度和耗时递增：

| 模式 | 参与 Agent 数 | 执行阶段 | 适用场景 | 预估耗时 |
|------|-------------|---------|---------|---------|
| `quick` | 1（豁免 min_agents） | Broadcast → 直接输出 | 简单问题，快速获取答案 | 10-30s |
| `compare` | 2-3 | Broadcast → [Pre-Synthesis Compression] → Synthesis | 需要多角度对比，但不需要互评 | 30-60s |
| `debate` | 2-5 | Broadcast → Review → Consensus → Synthesis | 复杂问题，需要深度辩论和质量评估 | 60-180s |
| `auto` | 自动决定 | 根据问题复杂度自动选择上述模式之一 | 默认模式，用户无需关心 | 视情况而定 |

> **Agent 的构成方式**: 每个 Agent = 模型配置 + 角色 prompt。3 个 Agent 可以是"3 个不同模型各带一个角色"，也可以是"1 个模型扮演 3 个不同角色"，或者任何混合组合。

**`auto` 模式的判定逻辑：**

1. 问题长度 < 50 字且无技术关键词 → `quick`
2. 问题长度 < 200 字或仅涉及对比类问题 → `compare`
3. 其余情况 → `debate`
4. 用户可通过 `--mode` 参数强制覆盖

**决策透明化**: auto 模式每次都输出一行决策理由，让用户理解为什么选择了这个模式：

```
[auto] → quick   理由: 问题较短且为常见知识问答 | 预估: ~20s, 1 次调用 | 用 --mode debate 可升级
[auto] → debate  理由: 检测到架构决策关键词     | 预估: ~120s, 3 Agent × 3 阶段 ≈ 9 次调用
[auto] → compare 理由: 对比类问题, 跳过互评     | 预估: ~40s, 3 次调用
```

每行包含：**选择理由 + 预估耗时 + 预估调用次数**，让用户在 1 秒内判断是否接受。不认同可 `Ctrl+C` 中断后用 `--mode` 重新指定。

**路由学习与 Override 审计**: 当前 auto 规则基于长度+关键词，可能对复杂问题误分配。系统将每次 auto 决策和用户 override 行为作为**独立事件**记录到 `sessions` 表：

- Session 新增字段 `auto_suggested_mode`（auto 建议的模式）和 `user_override_mode`（用户实际覆盖的模式，null 表示未覆盖）
- `council stats --routing` 输出路由准确率报告：override 率、按问题类型分布、常见误分配模式
- **短期**: 缓存用户的 override 偏好，相同关键词模式下优先使用用户上次选择的模式
- **长期**: 基于 override 率和 user_rating 数据，识别规则失效的问题类型并自动调优

### 2.2 完整辩论流程（debate 模式）

```
用户问题
    │
    ▼
┌─────────────────┐
│  Phase 0: Route │  路由引擎分配 Agent 席位（模型+角色组合）+ Chairman 确定
└────────┬────────┘
         │  checkpoint ✓
         ▼
┌─────────────────────┐
│  Phase 1: Broadcast │  所有 Agent 并行回答同一问题（各自带角色 prompt）
│  输入: 用户问题       │  [流式输出: 实时显示各 Agent 生成进度]
│  输出: N 份独立回答    │
└────────┬────────────┘
         │  checkpoint ✓
         ▼
┌─────────────────────┐
│  Phase 2: Review    │  每个 Agent 匿名评审其他 Agent 的回答（含反方角色挑战）
│  输入: 匿名化的回答集  │
│  输出: N×(N-1) 份评审  │  （可配置多轮: review_rounds）
└────────┬────────────┘
         │  checkpoint ✓
         ▼
┌──────────────────────────────┐
│  Phase 2.5: Human Gate       │  [可选, --interactive] 用户审阅评审结果
│  用户可剔除低质量回答或手动加权   │
└────────┬─────────────────────┘
         │
         ▼
┌─────────────────────┐
│  Phase 3: Consensus │  计算共识度，量化模型间分歧
│  输入: 评审评分矩阵    │
│  输出: consensus_score + 分歧热力图 │
└────────┬────────────┘
         │  checkpoint ✓
         ▼
┌────────────────────────────────────────┐
│  Phase 3.5: Pre-Synthesis Compression  │  [可选] 回答总长度超阈值时，基于互评分数
│  输入: 原始回答 + 互评分数              │  选择性保留全文或压缩摘要
│  输出: 压缩后的回答集                   │
└────────┬───────────────────────────────┘
         │  checkpoint ✓
         ▼
┌─────────────────────┐
│  Phase 4: Synthesis │  Chairman 综合所有回答和评审，输出最终答案
│  输入: 所有回答+评审+共识分析 │
│  输出: 最终综合答案     │
└────────┬────────────┘
         │
         ▼
    最终输出 + 持久化 + [可选] 用户评分
```

### 2.3 各阶段详细定义

#### Phase 0: Route（路由与席位分配）

- **输入**: 用户原始问题
- **输出**: Agent 席位列表（每个席位 = 模型配置 ID + 角色名）、Chairman 指定、role_set 名称
- **逻辑**: 见第 4.6 节路由规则

**席位分配策略**：

| 可用模型数 | 分配策略 | 示例 |
|-----------|---------|------|
| ≥ 3 | 每个模型分配 1 个角色，优先使用不同模型 | opus→analyst, sonnet→engineer, gemini→innovator |
| 2 | 2 个模型各 1 个角色 + 可选第 3 席位复用其中一个模型 | opus→analyst, gemini→engineer, opus→innovator |
| 1 | 同一模型扮演所有角色（**单模型多角色模式**） | opus→analyst, opus→engineer, opus→innovator |

> **单模型多角色的有效性与局限**: 同一个 LLM 通过不同 system prompt 扮演不同角色时，会产生有意义的视角差异（角色 prompt 引导模型关注不同维度），但这些回答**共享同一底模的知识边界和偏见模式**，更接近"多次有偏采样"而非独立 ensemble。因此单模型多角色场景下的 consensus_score 会被 `model_diversity_factor` 自动折减（见 Phase 3）。高置信结论应至少基于 2 个以上不同底模/供应商，或有外部证据支撑。

#### Phase 1: Broadcast（广播）

- **输入**: 用户问题 + 每个 Agent 的角色 system prompt
- **输出**: 每个 Agent 的独立回答
- **并发策略**: 所有 Agent 并行调用，受模型的 `max_concurrent` 和全局并发池限制。同一模型扮演多个 Agent 时，**串行执行**（避免同一模型的并发限制），不同模型间仍并行
- **流式输出**: 支持在终端实时显示各模型的生成进度（见第 6.3 节 TUI 设计）
- **身份隐匿**: System prompt 中明确禁止模型自报家门，防止 Review 阶段被识别
- **实际 prompt 结构**:

**首次提问的 prompt 结构**:

```
[System] {角色 system_prompt}

重要规则：
- 不要在回答中提及你是哪个 AI 模型或你的开发者
- 不要使用固定的开场白格式
- 直接回答问题，专注于内容本身

[User] 请针对以下问题给出你的分析和回答：

{用户原始问题}

要求：
1. 给出明确的结论或方案
2. 说明你的推理过程
3. 指出潜在的风险或局限性
```

**追问（Follow-up）时的 prompt 结构**:

当 `parent_session_id` 存在时，Broadcast 不携带上一轮的原始回答和互评（避免 context 爆炸），仅注入上一轮的 **Chairman 综合结论**作为背景：

```
[System] {角色 system_prompt}

重要规则：
- 不要在回答中提及你是哪个 AI 模型或你的开发者
- 不要使用固定的开场白格式
- 直接回答问题，专注于内容本身

[Background — 前置讨论背景]
原始问题: {parent_question}
委员会已达成的共识结论:
{parent_synthesis}
（共识度: {parent_consensus_score}）

[User] 基于上述背景，请针对以下追问给出你的独立分析：

{follow_up_question}

要求：
1. 基于前置结论回答，但不要被其锚定——如果追问改变了前提条件，应重新评估
2. 给出明确的结论或方案
3. 指出与前置结论的一致点和变化点
```

> **设计要点**: 仅携带上轮的 synthesis（通常 < 1K token），而非 N 份原始回答 + N×(N-1) 份互评。这样既保持上下文连贯，又将追问的 token 开销控制在与首次提问几乎相同的水平。每次追问仍然经历完整的 Route → Broadcast → Review → Synthesis 流程，确保追问的回答质量不降级。

#### Phase 2: Review（互评）

- **输入**: 匿名化后的所有模型回答
- **输出**: 结构化的评审评分
- **匿名化策略（三层防护）**:
  1. **身份标记替换**: 将回答标记为 "回答 A"、"回答 B"、"回答 C"，去除任何可能暴露模型身份的元信息
  2. **身份特征过滤**: 自动检测并移除常见的模型自我标识（如 "I'm Claude"、"As an AI assistant created by..."、"I'm Gemini" 等固定句式），替换为通用表述
  3. **格式归一化（Style Homogenizer）**: 不同模型有明显的"文风指纹"（Claude 偏好嵌套列表，Gemini 偏好 Emoji 和加粗），即使去除身份标识仍可被识别。因此在分发给评审 Agent 前，统一进行格式转换：
     - 去除所有 Emoji
     - 统一 Markdown 标题层级（全部降为 `###` 起步）
     - 统一列表符号（全部用 `-`）
     - 统一加粗/斜体风格
     - 回答顺序随机化，避免位置偏见
- **反方角色（Devil's Advocate）**: 在 `debate` 模式下，自动为其中一个模型额外注入"反方"指令，要求其在评审时重点寻找其他方案的漏洞和潜在风险（见 2.4 节角色增强）
- **评审 prompt 结构**:

```
[System] {角色 system_prompt}
[User] 以下是针对同一问题的多份独立回答，请逐一评审。

原始问题: {用户问题}

---
### 回答 A
{model_1_response}

### 回答 B
{model_2_response}

### 回答 C
{model_3_response}
---

请对每份回答按以下维度打分（1-10 分），并以 JSON 格式输出：

{
  "reviews": [
    {
      "answer": "A",
      "scores": {
        "accuracy": <1-10, 事实准确性和逻辑正确性>,
        "completeness": <1-10, 覆盖面和全面性>,
        "practicality": <1-10, 可行性和实用价值>,
        "insight": <1-10, 洞察力和深度>
      },
      "strengths": "<主要优点>",
      "weaknesses": "<主要不足>",
      "overall": <1-10, 综合评分>
    },
    ...
  ]
}
```

- **评分归一化**: 为防止不同模型评分尺度不同，对每个评审者的分数做 z-score 归一化后再汇总
- **JSON 解析容错与降权机制**: 
  - 优先尝试 JSON 解析；失败时用正则匹配 `"overall": \d+`。
  - **Fallback 策略**: 若仍无法解析评分，该评审记录被标记为 `PARSE_ERROR`。
  - **统计影响**: 在计算 `consensus_score` 时，`PARSE_ERROR` 的评审席位将被**视为无效（权重设为 0）**，而不是给默认分。如果某个回答的所有评审均解析失败，该回答将在 Synthesis 阶段被标记为"缺乏有效交叉评价"，由 Chairman 重点审视其内容。

#### Phase 2.5: Human Gate（人工干预，可选）

通过 `--interactive` 参数启用。Review 阶段完成后暂停流程，在终端展示各模型回答及其互评结果摘要，用户可以：

- **剔除回答**: 标记某个明显低质量的回答，使其不参与 Synthesis
- **手动加权**: 为某个回答设置额外权重（如 1.5x），影响 Synthesis 阶段 Chairman 的综合判断
- **跳过**: 直接按默认流程继续

**交互界面示例**:

当多个 Agent 产生大量互评时（如 5 个 Agent 产生 20 份评审），直接展示全部内容会造成阅读压力。因此 Human Gate 默认展示**冲突摘要视图**——系统自动提取互评中的关键分歧和负面反馈，让用户在 10 秒内抓住要点：

```
══════════════════════════════════════════════════════
  Review 阶段完成 - 等待你的决策
══════════════════════════════════════════════════════

  [A] analyst (claude-opus)     平均互评分: 8.2  ██████████░░
  [B] engineer (codex-o4mini)   平均互评分: 6.5  ████████░░░░
  [C] innovator (gemini-pro)    平均互评分: 7.8  █████████░░░

  共识度: 0.62 (中等)

  ⚡ 关键冲突:
  ├─ B 质疑 A: "方案在高并发下存在死锁风险" (准确性: 4/10)
  ├─ A 质疑 C: "缺乏具体的性能数据支撑" (可行性: 5/10)
  └─ C 质疑 B: "过度简化, 忽略了分布式场景" (完整性: 4/10)

  操作:
    x <letter>     剔除某个回答 (如: x B)
    w <letter> <n> 设置权重 (如: w A 1.5)
    d              展开完整评审详情
    enter           继续 Synthesis
══════════════════════════════════════════════════════
```

> **冲突提取逻辑**: 从每份 Review 的 `weaknesses` 字段和 overall < 6 分的评审中提取核心批评，按严重程度排序展示 Top 3-5 条。

#### Phase 3: Consensus（共识评估）

- **输入**: Review 阶段的评分矩阵
- **输出**: `consensus_score`（0.0 - 1.0）+ 分维度分歧分析

**共识度计算公式：**

```
对每份回答 i，收集所有评审者给出的 overall 分数: S_i = [s_i1, s_i2, ...]

1. 计算每份回答的分数标准差: σ_i = std(S_i)
2. 计算所有回答的平均标准差: σ_avg = mean(σ_1, σ_2, ..., σ_n)
3. 计算排名一致性: 每个评审者对回答的排名，计算 Kendall's W 系数 W
4. **小样本修正 (Small Sample Correction)**:
   - 当参与评审的有效席位数量 $N < 3$ 时，标准差不具备统计稳定性。
   - 引入置信度惩罚系数 $\rho = (N-1)/N$。
5. **模型多样性因子 (Model Diversity Factor)**:
   - $D$ = 参与辩论的**去重底模/供应商数量**（如 claude-opus 和 claude-sonnet 算同一供应商 Anthropic，codex 算 OpenAI，gemini 算 Google）
   - $A$ = 总 Agent 席位数
   - $\delta = D / A$（值域 (0, 1]，全部不同底模时 δ=1，全部同一底模时 δ=1/A）
   - 当 $D < 2$ 时（纯单供应商），额外施加硬折减：$\delta = \delta \times 0.7$
   - **设计原理**: 同一底模的多角色能增加视角覆盖，但不增加独立性。高置信结论（>0.8）应至少基于 2 个不同底模，否则系统会通过 δ 自动折减共识度。
6. 综合共识度: consensus_score = [0.5 × (1 - σ_avg / 4.5) + 0.5 × W] × $\rho$ × $\delta$
   - σ_avg / 4.5 归一化（10 分制下最大标准差约 4.5）
   - 最终 clamp 到 [0.0, 1.0]
```

**分维度分歧分析：**

除了总体 consensus_score，还对 accuracy / completeness / practicality / insight 四个维度分别计算分歧度，用于定位具体分歧点。例如："模型在准确性上高度一致（σ=0.3），但在可行性上分歧显著（σ=2.1）"。

**共识度可视化（CLI 输出）：**

```
共识度: 0.62 ████████████░░░░░░░░ (中等)

维度分歧热力图:
              回答A  回答B  回答C
  准确性       8.5    7.0    8.2    σ=0.6  ▓ 低分歧
  完整性       9.0    6.5    7.5    σ=1.0  ▓▓ 中分歧
  可行性       7.0    8.5    5.0    σ=1.4  ▓▓▓ 高分歧 ←
  洞察力       8.0    6.0    9.0    σ=1.2  ▓▓▓ 高分歧 ←
```

**共识度解读与处理策略：**

| 区间 | 含义 | 系统行为 | 用户引导动作 |
|------|------|---------|------------|
| 0.8 - 1.0 | 高共识 | 直接综合，高置信度输出 | 正常展示结论 |
| 0.5 - 0.8 | 中等共识 | 综合时标注分歧点 | 高亮争议维度，提示"以下观点存在分歧，请关注" |
| 0.2 - 0.5 | 低共识 | 改为**并列展示**各方观点而非强行综合 | 提供操作选项：`[r] 追加一轮 Review` `[i] 进入 interactive 人工干预` `[c] 切换为 compare 模式重跑` |
| 0.0 - 0.2 | 极低共识 | **不输出综合结论**，改为展示各 Agent 独立回答 + 分歧说明 | **产品保护线**: 阻断输出并要求用户显式选择下一步：`[1] 缩小问题范围重新提问` `[2] 切换 compare 模式仅对比` `[3] 加 -i 进入人工干预` `[4] 我了解风险，仍强制综合`。非交互模式下输出警告并退出（exit code=2），不静默输出低可信结论 |

#### Phase 3.5: Pre-Synthesis Compression（动态窗口裁剪，可选）

当所有 Agent 回答的总 token 数超过 Chairman 模型 context window 的 60% 时自动触发，防止 Synthesis 阶段溢出。**此阶段位于 Review 之后**，因此可以利用互评分数决定保留策略。

- **输入**: 各 Agent 的原始回答 + Review 阶段互评分数
- **输出**: 裁剪后的回答集（部分全文保留 + 部分结构化摘要）
- **触发阈值**: 可在 `council.yaml` 中配置 `general.compression_threshold_ratio: 0.6`

**裁剪策略 — "核心保留 + 外围摘要"**：

全量摘要会丢失 Chairman 综合时需要的细节（如具体代码段、细微逻辑差异）。因此采用分层裁剪：

| 回答排名 | 处理方式 | 理由 |
|---------|---------|------|
| 互评得分 Top 1-2 | **保留全文** | Chairman 需要看到最优质方案的每一个细节 |
| 其余回答 | **结构化摘要** | 保留差异化观点，压缩冗余 |

- **执行者**: 需要摘要的 Agent 自行摘要自己的回答（并行执行）
- **摘要 prompt**:

```
[System] 请将以下回答转换为结构化摘要，格式要求：
1. 核心观点（3-5 个要点）
2. 关键结论
3. 与其他方案的差异点
4. 提到的风险或局限
保留所有具体数据和关键论据，去除过渡性文字和重复论述。
特别注意：代码块（```...```）必须完整保留，不得摘要或截断。

[User]
原始问题: {用户问题}
你的原始回答:
{original_response}
```

**代码块保护**: 摘要前通过正则提取回答中的所有代码块（`` ``` `` 围栏），摘要过程中代码块全文保留、不经过 LLM 改写，仅对代码块之间的文字描述做精简。可通过 `general.prioritize_code_in_summary: true`（默认开启）控制。

> **compare 模式的降级处理**: compare 模式跳过 Review，无互评分数可用。此时退回为按 `priority` 排序选择 Top 1 保留全文、其余摘要。

#### Phase 4: Synthesis（综合）

- **输入**: 所有回答（或压缩后的回答集）+ 评审结果 + 共识分析 + [可选] 人工干预结果
- **执行者**: Chairman 模型
- **Synthesis prompt 结构**:

```
[System] 你是辩论的主持人和综合者。你的任务是基于多位专家的回答和互评结果，给出一份高质量的综合答案。

[User] 原始问题: {用户问题}

## 各专家回答及其互评结果

### 专家 A ({role_name}) - 平均互评分: {avg_score} {权重标记}
回答: {response}
优点: {aggregated_strengths}
不足: {aggregated_weaknesses}

### 专家 B ({role_name}) - 平均互评分: {avg_score}
...

{如果有回答被用户剔除:}
注意：专家 B 的回答已被用户标记为低质量，不纳入综合。

## 共识分析
共识度: {consensus_score} ({共识度解读})
主要共识点: {agreements}
主要分歧点: {disagreements}
分歧最大的维度: {top_divergent_dimensions}

## 请按以下结构输出综合答案

### 结论摘要
<用 2-3 句话给出最终结论/推荐方案>

### 核心论据
<支撑结论的 3-5 个关键证据点, 标注来源于哪位专家>

### 风险与局限
<列出已识别的风险, 尤其是互评中指出的问题>

### 置信度
<高/中/低, 并说明理由 — 置信度主要受共识度和证据强度影响>

### 建议后续动作
<用户接下来可以做什么: 需要进一步验证的点、可以扩展的方向、或建议的下一步>
```

### 2.4 角色增强：反方角色（Devil's Advocate）

在 `debate` 模式中，系统根据问题复杂度自动（或通过配置）为一个模型注入"反方"附加指令。反方角色不会替代该模型的原有角色，而是作为**附加层**叠加在 Review 阶段。

**触发条件**（满足任一即可）：
- 参与模型数 ≥ 3
- 问题被路由规则识别为 architecture 或 analysis 类
- 用户显式指定 `--devil-advocate`

**反方附加 prompt（Review 阶段注入）**：

```
[附加指令]
在本轮评审中，你额外承担"反方审计员"的职责。除了正常评分外，你需要：
1. 主动寻找每个方案的潜在漏洞、边界情况和长期风险
2. 质疑看起来过于乐观的假设
3. 在 JSON 输出中额外增加 "devil_advocate_notes" 字段，列出你发现的关键风险
```

**选择策略**: 优先将反方角色分配给 `capabilities` 包含 `analysis` 的模型；如无则分配给 priority 最高的模型。

---

## 3. 过程数据持久化

### 3.1 设计目标

辩论过程产生大量中间数据（各模型原始回答、互评评分、共识分析、最终综合）。持久化这些数据的核心价值：

- **可回溯性**: 当综合结果有问题时，可以追溯到哪个模型的哪个回答引入了错误
- **可分析性**: 积累足够数据后，可以分析哪个模型在哪类问题上表现更好
- **可续作性**: 支持辩论中断后恢复，避免重复调用已完成的阶段
- **可复用性**: 相似问题可以推荐历史辩论结论作为候选参考（用户确认后采纳，不自动短路执行），节省调用成本
- **可检索性**: 支持本地 RAG 式知识检索，回顾历史辩论中的共识结论

### 3.2 存储方案选型

采用本地文件系统存储，不引入外部数据库依赖。结合 SQLite 做索引和查询，JSON 文件做全量数据存储。

| 存储层 | 技术方案 | 存储内容 | 理由 |
|--------|---------|---------|------|
| 会话全量数据 | JSON 文件 (每次辩论一个) | 完整的 prompt、response、review、synthesis | 保留原始数据的完整性，方便回溯和重放 |
| 索引与查询 | SQLite (单文件) | 会话元数据、模型评分、共识度、标签 | 支持复杂查询（按时间、模型、共识度筛选），零依赖 |
| 运行时状态 | Checkpoint 文件 (JSON) | 当前执行阶段、已完成的中间结果 | 支持中断恢复，避免重复调用 |
| 配置与历史 | YAML + Git | 模型配置、角色 prompt、路由规则 | 配置变更可追踪，方便团队协作 |

### 3.3 目录结构设计

所有数据存储在用户 home 目录下的 `~/.council/` 中，结构如下：

```
~/.council/
  ├── config/                    # 配置层
  │   ├── council.yaml             # 主配置文件（含 schema_version 字段）
  │   ├── models/                  # 模型配置目录
  │   │   ├── claude-opus.yaml       # Claude Opus (CLI 模式)
  │   │   ├── claude-sonnet.yaml     # Claude Sonnet (CLI 模式)
  │   │   ├── openai-o4mini.yaml     # OpenAI o4-mini (API 模式，复用 codex 凭证)
  │   │   ├── gemini-pro.yaml        # Gemini Pro (CLI 模式)
  │   │   └── ollama-qwen.yaml       # 本地模型示例
  │   ├── roles/                   # 角色 prompt 模板
  │   │   ├── default.yaml         # 默认角色集
  │   │   ├── code-review.yaml     # 代码审查角色集
  │   │   └── architecture.yaml    # 架构设计角色集
  │   └── benchmark.yaml           # 基准测试问题集
  ├── data/                      # 数据层
  │   ├── council.db               # SQLite 索引数据库
  │   └── sessions/                # 会话全量数据
  │       ├── 2026-03-25_a1b2c3.json
  │       └── 2026-03-25_d4e5f6.json
  ├── checkpoints/               # 中断恢复点
  │   └── {session_id}.ckpt.json
  ├── credentials/               # Council 自有凭证（内置 OAuth 登录时使用，Phase 4+）
  │   └── {provider}.json         # 独立于 CLI 工具的凭证目录，权限 600
  ├── locks/                     # 进程存活标记（仅用于调试/诊断，不参与调度判定）
  │   └── {model_id}.lock        # 并发调度唯一真源为 SQLite resource_slots 表
  └── logs/                      # 运行日志（按天分文件）
      ├── council-2026-03-25.log
      └── council-2026-03-24.log
```

> **凭证来源优先级**: API 模式的凭证查找顺序为：① 环境变量（`api_key_env`）→ ② 配置中指定的 `api_credential_path` → ③ 已安装 CLI 客户端的默认凭证路径（如 `~/.codex/auth.json`）→ ④ `~/.council/credentials/` 下的自有凭证。Council 优先**复用**已有凭证，不重复存储。

### 3.4 数据模型设计

#### 3.4.1 Session（会话）—— 核心实体

每次 council 命令调用创建一个 Session。它是所有过程数据的根容器。

| 字段 | 类型 | 说明 |
|------|------|------|
| session_id | string | 唯一标识，格式: `{date}_{short_hash}`，如 `2026-03-25_a1b2c3` |
| question | string | 用户原始问题全文 |
| mode | enum | `quick` \| `compare` \| `debate` \| `auto`（auto 会记录解析后的实际模式） |
| resolved_mode | enum | auto 模式实际解析为的模式 |
| status | enum | `pending` \| `broadcasting` \| `reviewing` \| `scoring` \| `synthesizing` \| `completed` \| `failed` \| `interrupted` |
| agents | Agent[] | 参与本次辩论的 Agent 席位列表（每个 Agent = model_id + role） |
| models_used | string[] | 参与本次辩论的去重模型配置 ID 列表 |
| chairman | string | 担任综合者的模型配置 ID |
| devil_advocate | string \| null | 担任反方角色的模型配置 ID（debate 模式） |
| tags | string[] | 用户打的标签，用于后续检索 |
| created_at | ISO 8601 | 创建时间 |
| completed_at | ISO 8601 \| null | 完成时间，未完成为 null |
| total_elapsed_ms | int | 总耗时（毫秒） |
| stages | Stage[] | 各阶段详细数据，见 3.4.2 |
| consensus_score | float \| null | 0.0-1.0，quick 模式为 null |
| dimension_scores | dict \| null | 分维度共识分析 `{dimension: {score, divergence}}` |
| synthesis | string \| null | 最终综合答案 |
| user_rating | int \| null | 用户对本次结果的满意度评分（1-5），可选 |
| reused_from | string \| null | 如果用户确认采纳了历史候选推荐的结果，指向源 session_id（系统不会自动复用，仅在用户显式确认后记录） |
| parent_session_id | string \| null | 追问场景：指向上一轮辩论的 session_id，形成会话链（Thread） |
| thread_depth | int | 当前在会话链中的深度（首次提问=0，第一次追问=1，以此类推） |
| human_overrides | dict \| null | 人工干预记录（剔除的回答、权重调整等） |
| compression_triggered | bool | 是否触发了 Pre-Synthesis Compression 阶段 |

#### 3.4.2 Stage（阶段）—— 每个执行步骤的快照

每个 Stage 记录一个执行阶段的完整输入输出，是中断恢复和回溯的最小单元。

| 字段 | 类型 | 说明 |
|------|------|------|
| stage_type | enum | `route` \| `broadcast` \| `review` \| `human_gate` \| `consensus` \| `pre_synthesis_compression` \| `synthesis` |
| stage_index | int | 第几轮（review 可能有多轮，从 0 开始） |
| status | enum | `pending` \| `running` \| `completed` \| `failed` \| `skipped` |
| started_at | ISO 8601 | 阶段开始时间 |
| completed_at | ISO 8601 \| null | 阶段完成时间 |
| elapsed_ms | int | 本阶段耗时 |
| invocations | Invocation[] | 本阶段的所有模型调用记录，见 3.4.3 |

#### 3.4.3 Invocation（调用）—— 单次模型调用的完整记录

每次 subprocess 调用生成一条 Invocation 记录，是最细粒度的数据单元。

| 字段 | 类型 | 说明 |
|------|------|------|
| model_id | string | 模型配置 ID（如 claude-opus、openai-o4mini、gemini-pro） |
| invocation_mode | enum | `cli` \| `api` — 本次实际使用的调用模式 |
| role | string | 本次调用的角色名称（如 analyst、engineer、innovator） |
| is_devil_advocate | bool | 本次调用是否承担反方角色 |
| prompt_sent | string | 实际发送给模型的完整 prompt（含角色 prompt + 问题/上下文） |
| response_raw | string | 模型返回的原始完整输出 |
| response_cleaned | string \| null | 经过身份标识过滤后的输出（用于 Review 阶段输入） |
| exit_code | int \| null | CLI 模式：进程退出码，0 表示成功；API 模式：null |
| http_status | int \| null | API 模式：HTTP 状态码；CLI 模式：null |
| stderr | string \| null | 标准错误输出，用于调试 |
| elapsed_ms | int | 本次调用耗时 |
| timed_out | bool | 是否超时 |
| token_usage | dict \| null | API 模式：`{input_tokens, output_tokens}`；CLI 模式：null（无法精确获取） |
| parsed_scores | dict \| null | 仅 review 阶段：解析后的评分结构 `{answer: {accuracy, completeness, practicality, insight, overall}}` |
| devil_advocate_notes | string \| null | 仅反方角色 review：发现的关键风险点 |

### 3.5 中断恢复机制（Checkpoint）

多模型辩论可能耗时 60 秒以上。如果中间网络抖动、CLI 崩溃或用户主动中断，必须能从已完成的阶段继续，而不是重头开始。

#### 3.5.1 Checkpoint 写入时机

- **每个 Stage 完成后**: 将当前 Session 状态写入 `checkpoints/{session_id}.ckpt.json`
- **每次 Invocation 完成后**: 更新 checkpoint 中对应 stage 的 invocations 数组，实现更细粒度的恢复
- **Session 完成后**: 删除 checkpoint 文件，将全量数据写入 `sessions/` 目录

#### 3.5.2 恢复逻辑

启动时检查 `checkpoints/` 目录：

**多 Checkpoint 选择规则**（当存在多个 `.ckpt.json` 文件时）：

1. **重复问题检测**: 计算当前问题的 `question_hash`，检查是否有活跃进程（PID 存活）正在处理相同 hash 的 Session。
2. **冲突处理策略**:
   - 若检测到相同问题在跑，提示：`检测到相同问题正在辩论中 (PID: {pid})`。
   - **交互选择**: 用户可选择 `[r] 接管/等待 (resume)` 或 `[f] 强制新建 (force)`。
   - **脚本行为**: 默认退出（exit code=3）；若带 `--resume` 则等待，若带 `--force` 则忽略锁文件强制启动。
3. **清理僵尸**: 首先检查每个 checkpoint 中记录的 PID，如果该进程不再运行，自动清理并进入恢复流程。

3. **清理过期**: 超过 `orphan_checkpoint_hours`（默认 24h）的 checkpoint 视为僵尸，自动清理并记录日志
4. **时间优先**: 剩余的有效 checkpoint 按 `created_at` **降序**排列，默认恢复最近的一个
5. **多个可恢复时交互选择**: 如果存在 2 个以上有效 checkpoint，列出摘要供用户选择：

```
发现 1 个未完成的辩论:

  ┌─────────────────────────────────────────────┐
  │ "Redis vs Memcached 选型对比"                │
  │ 开始于: 2026-03-25 14:30                     │
  │ 进度:   Phase 2/4 (Review)                   │
  │ 已完成: Broadcast ✓ (3 Agent 全部完成)        │
  │ 待继续: Review → Consensus → Synthesis       │
  │ 参与模型: claude-opus, claude-sonnet, gemini  │
  └─────────────────────────────────────────────┘

  [enter] 继续辩论  [n] 放弃并重新开始  [q] 退出
```

**恢复执行逻辑**：

- 恢复时显示**恢复摘要**（已完成阶段、待继续阶段、参与模型），让用户明确知道将继续什么
- 加载 checkpoint，跳过已完成的 Stage，从第一个未完成的 Stage 继续
- 如果某个 Stage 部分完成（比如 broadcast 阶段 3 个模型只完成了 2 个），只重新调用未完成的模型
- 恢复时不允许修改参与模型和模式（避免状态不一致）；如需修改请选择"放弃并重新开始"
- Checkpoint 文件中包含 `pid`、`created_at`、`last_updated_at` 字段，用于冲突检测

#### 3.5.3 数据生命周期

| 数据类型 | 保留策略 | 清理规则 |
|---------|---------|---------|
| Session JSON | 默认 90 天 | 超过 `session_retention_days` 自动清理；也可通过 `council prune --before DATE` 手动清理；设 0 永久保留 |
| SQLite 索引 | 与 Session 同步 | 删除 Session 时自动清理对应索引记录 |
| Checkpoint | 临时 | Session 完成后立即删除；超过 24h 的 orphan checkpoint 自动清理 |
| 运行日志 | 7 天滚动 | 日志文件按天轮转，保留最近 7 天 |

### 3.6 SQLite 索引设计

SQLite 仅存储元数据索引，不存储完整的 prompt/response 内容。查询时先通过 SQLite 定位 session_id，再加载对应的 JSON 文件获取完整数据。

#### 3.6.1 表结构

**并发调度表 `resource_slots`（跨进程原子调度，见 4.9.2）：**

| 列名 | 类型 | 索引 | 用途 |
|------|------|------|------|
| slot_id | INTEGER PK AUTOINCREMENT | — | 自增槽位 ID |
| model_id | TEXT NOT NULL | ✓ | 占用该槽位的模型配置 ID |
| pid | INTEGER NOT NULL | ✓ | 占用进程的 PID |
| acquired_at | TEXT NOT NULL | — | 获取时间（ISO 8601） |
| resource_cost | INTEGER NOT NULL | — | 该槽位消耗的资源点数 |

- **清理策略**: 每次 `BEGIN IMMEDIATE` 事务开头先清理 PID 已不存活的行；进程正常退出时在 `finally` 块中 `DELETE WHERE pid = ?`
- **无需持久化保留**: 此表为运行时状态，系统启动时可安全 `DELETE FROM resource_slots` 全量清理（无存活进程 = 无有效槽位）

**主表 `sessions`：**

| 列名 | 类型 | 索引 | 用途 |
|------|------|------|------|
| session_id | TEXT PK | — | 主键，关联 JSON 文件名 |
| question_hash | TEXT | ✓ | 问题的 SHA-256 前 16 位，用于精确查重 |
| question_normalized | TEXT | ✓ | 归一化后的问题文本（去停用词、关键词排序），用于近似查重 |
| question_preview | TEXT | FTS5 | 问题前 200 字，支持全文检索 |
| synthesis_preview | TEXT | FTS5 | 综合答案前 500 字，支持对结论的全文检索 |
| mode | TEXT | ✓ | 辩论模式 |
| status | TEXT | ✓ | 会话状态 |
| consensus_score | REAL | ✓ | 0.0-1.0 |
| models_used | TEXT | — | 逗号分隔的模型 ID 列表 |
| created_at | TEXT | ✓ | ISO 8601 时间戳 |
| total_elapsed_ms | INTEGER | — | 总耗时 |
| user_rating | INTEGER | ✓ | 用户满意度评分（1-5），NULL 表示未评 |
| parent_session_id | TEXT | ✓ | 追问链：指向上一轮 session_id，NULL 表示首次提问 |

**关联表 `session_tags`：**

| 列名 | 类型 | 用途 |
|------|------|------|
| session_id | TEXT FK | 关联 sessions 表 |
| tag | TEXT | 标签值，如 architecture、redis、spring-boot |

**关联表 `model_stats`（用于模型表现分析）：**

| 列名 | 类型 | 用途 |
|------|------|------|
| session_id | TEXT FK | 关联 sessions 表 |
| model_id | TEXT | 模型 ID |
| avg_peer_score | REAL | 本次辩论中该模型获得的平均互评分（归一化后） |
| was_chairman | BOOLEAN | 是否担任综合者 |
| was_devil_advocate | BOOLEAN | 是否担任反方角色 |
| response_elapsed_ms | INTEGER | broadcast 阶段的响应时间 |

#### 3.6.2 典型查询场景

- **按时间范围查询**: `SELECT * FROM sessions WHERE created_at BETWEEN ? AND ? ORDER BY created_at DESC`
- **按共识度筛选**: `SELECT * FROM sessions WHERE consensus_score < 0.4` —— 找出分歧大的辩论
- **模型表现排名**: `SELECT model_id, AVG(avg_peer_score) FROM model_stats GROUP BY model_id`
- **相似问题查重**: 通过 `question_hash` 精确匹配 + `question_normalized` 近似匹配
- **全文检索（问题+结论）**: 通过 FTS5 索引搜索历史问题和综合答案
- **本地知识检索**: `SELECT question_preview, synthesis_preview FROM sessions WHERE question_preview MATCH '关键词' ORDER BY created_at DESC LIMIT 5` — 回顾历史辩论结论
- **用户满意度分析**: `SELECT model_id, AVG(s.user_rating) FROM model_stats ms JOIN sessions s ON ms.session_id = s.session_id WHERE s.user_rating IS NOT NULL GROUP BY model_id`

---

## 4. 模型工具配置系统

### 4.1 设计目标

模型工具配置系统解决以下问题：

- **零门槛接入**: 首次使用自动扫描本地 CLI 工具和已存储的 OAuth 凭证，引导式完成配置
- **双模发现**: 自动检测本地安装了哪些 CLI 工具（`which` 检查），**同时探测本地是否存在有效的 OAuth 凭证**（即使 CLI 未安装，只要有凭证就能通过 API 模式接入）
- **注册**: 通过引导式向导或 YAML 文件添加新模型，无需修改主代码
- **配置**: 每个模型的调用模式（CLI/API）、参数、超时、能力声明等均可独立配置
- **监控**: 跟踪每个模型的健康状态、响应时间、成功率
- **路由**: 根据问题类型和模型历史表现自动选择最佳模型组合

### 4.2 双模调用架构与本地凭证发现

#### 4.2.1 调用模式（Invocation Mode）

每个模型配置可独立选择调用模式：

| 模式 | 配置值 | 机制 | 延迟 | 依赖 |
|------|--------|------|------|------|
| **CLI** | `invocation: cli` | 通过 subprocess 调用本地 CLI 二进制（如 `claude -p "prompt"`） | 较高（进程启动 + CLI 初始化） | CLI 工具已安装且可用 |
| **API** | `invocation: api` | 直接调用 Provider SDK/HTTP API | 较低（原生 HTTP 连接） | 有效的 OAuth 凭证或 API Key |
| **Auto** | `invocation: auto`（默认） | 优先 API 模式（如有有效凭证），回退到 CLI 模式 | 自适应 | 至少一种可用 |

**API 模式的优势**：
- **更低延迟**: 省去 subprocess 启动和 CLI 初始化开销，单次调用减少 1-3s
- **原生流式输出**: 直接获取 SSE/streaming response，实时性更好
- **更精细的错误处理**: 可区分 HTTP 状态码、rate limit header、模型错误等
- **更高并发**: 无进程数限制，可通过连接池控制并发
- **Token 用量追踪**: API 响应直接包含 `usage` 字段，可精确计量

**CLI 模式不可替代的场景**：
- Codex CLI 的代码执行沙箱（`--approval-mode`）是 API 模式无法提供的
- 某些 CLI 工具提供额外的 context 管理（如 Claude Code 的项目上下文）
- 用户明确需要 CLI 特有功能时，应使用 CLI 模式

#### 4.2.2 凭证与鉴权（统一由 pi-ai 管理）

凭证发现、Token 刷新、OAuth 登录等**全部委托给 `@mariozechner/pi-ai`**，Council 不自行实现鉴权逻辑。pi-ai 支持以下鉴权方式，Council 透传使用：

**方式一：环境变量 API Key**

pi-ai 的 `getEnvApiKey(provider)` 自动检测以下环境变量：

| Provider | 环境变量 |
|----------|---------|
| OpenAI | `OPENAI_API_KEY` |
| Anthropic | `ANTHROPIC_OAUTH_TOKEN`（优先）, `ANTHROPIC_API_KEY` |
| Google | `GEMINI_API_KEY` |
| Google Vertex | `GOOGLE_CLOUD_API_KEY` 或 ADC（`GOOGLE_CLOUD_PROJECT` + `GOOGLE_CLOUD_LOCATION`） |
| Azure OpenAI | `AZURE_OPENAI_API_KEY` |
| Mistral | `MISTRAL_API_KEY` |
| Groq | `GROQ_API_KEY` |
| Cerebras | `CEREBRAS_API_KEY` |
| xAI | `XAI_API_KEY` |
| OpenRouter | `OPENROUTER_API_KEY` |
| Vercel AI Gateway | `AI_GATEWAY_API_KEY` |
| MiniMax | `MINIMAX_API_KEY` |
| HuggingFace | `HF_TOKEN` |
| GitHub Copilot | `COPILOT_GITHUB_TOKEN` / `GH_TOKEN` / `GITHUB_TOKEN` |
| Kimi/Moonshot | `KIMI_API_KEY` |
| Amazon Bedrock | AWS 标准凭证链（IAM Key / Profile / ECS / IRSA） |

**方式二：OAuth 自动凭证发现与刷新**

pi-ai 内置 5 个 OAuth Provider 的完整登录 + Token 刷新流程：

| OAuth Provider | 对应订阅 | 凭证来源 |
|---------------|---------|---------|
| **Anthropic** | Claude Pro/Max | Claude Code OAuth 会话 |
| **OpenAI Codex** | ChatGPT Plus/Pro | `~/.codex/auth.json` |
| **GitHub Copilot** | Copilot 订阅 | Device Code Flow |
| **Google Gemini CLI** | Gemini CLI OAuth | `~/.gemini/oauth_creds.json` |
| **Antigravity** | 多模型访问 via Google Cloud | Antigravity OAuth |

Council 通过 pi-ai 的 `getOAuthApiKey(providerId, credentials)` 获取有效 token，pi-ai 自动处理过期检测和 refresh_token 刷新。

**凭证发现流程（Council 启动时）**：

```
1. 调用 pi-ai 的 getEnvApiKey() 检查环境变量
   └── 有值 → 直接使用，跳过 OAuth

2. 调用 pi-ai 的 OAuth Provider 获取已存储凭证
   ├── pi-ai 自动扫描已知路径（~/.codex/auth.json 等）
   ├── 检查 token 过期 → 自动 refresh
   └── 刷新失败 → 标记为 expired，引导用户重新登录

3. 为每个有效凭证注册可用的模型配置
   └── 调用 pi-ai 的 getModels(provider) 获取可用模型列表
```

> **设计原则**: Council **不自行实现**任何凭证解析、Token 刷新、OAuth 流程。所有鉴权逻辑通过 pi-ai 统一处理。当 pi-ai 新增 Provider 支持时，Council 自动获得该 Provider 的接入能力，无需修改代码。

> **安全边界**: pi-ai 的凭证操作均在本地完成，不向外部上报凭证信息。发现的凭证状态可通过 `council models` 查看，但不显示 token 值。

#### 4.2.3 OAuth 登录流程（由 pi-ai 提供）

当本地无有效凭证且环境变量也未设置时，Council 可通过 pi-ai 的 OAuth Provider 接口触发交互式登录流程。pi-ai 内置以下 OAuth 提供者：

| OAuth Provider | 订阅要求 | 登录方式 |
|---------------|---------|---------|
| Anthropic | Claude Pro/Max | Authorization Code + PKCE |
| OpenAI Codex | ChatGPT Plus/Pro | Authorization Code + PKCE |
| GitHub Copilot | Copilot 订阅 | Device Code Flow |
| Google Gemini CLI | Gemini 访问权限 | Authorization Code + PKCE |
| Antigravity | Google Cloud 多模型 | Authorization Code + PKCE |

Council 通过 pi-ai 的 `OAuthProviderInterface` 调用 `login()` 方法触发登录，凭证由 pi-ai 管理和持久化。

> **实现简化**: 由于 pi-ai 已完整实现 OAuth 登录 + Token 刷新，Council 无需自行实现任何 OAuth 流程，大幅降低了实现复杂度。

### 4.3 引导式配置（Setup Wizard）

所有配置通过引导式交互完成，用户不需要了解 YAML 格式或配置字段含义。系统提供三个引导入口：

- **首次运行引导** (`council` 首次执行时自动触发)
- **完整配置向导** (`council setup`)
- **单模型添加** (`council models add`)

#### 4.3.1 首次运行引导（First-Run Wizard）

用户安装后首次执行任意 `council` 命令时，检测到 `~/.council/` 不存在，自动进入首次引导流程：

```
══════════════════════════════════════════════════════
  Welcome to Open Council!
  让我们花 2 分钟完成初始配置
══════════════════════════════════════════════════════

Step 1/6 — 扫描本地 AI 工具与凭证
──────────────────────────────────────────────────────
  正在扫描已安装的 CLI 工具...

  ✓ claude    Claude Code       /usr/local/bin/claude
  ✓ gemini    Gemini CLI        /usr/local/bin/gemini
  ✗ codex     Codex CLI         未找到

  正在通过 pi-ai 扫描可用 API Provider...

  ✓ anthropic       Claude Pro/Max OAuth 凭证有效
  ✓ openai          Codex OAuth 凭证有效 (via ~/.codex/auth.json)
  ✓ google          Gemini OAuth 凭证有效
  ✗ github-copilot  未发现凭证
  ✗ mistral         未发现 MISTRAL_API_KEY

  检测到 2 个 CLI 工具 + 3 个 API Provider ✓
  (即使只有 1 个来源也可以使用 — 同一模型可扮演多个角色参与辩论)

Step 2/6 — 选择模型与调用模式
──────────────────────────────────────────────────────
  每个 Provider 的可用模型列表由 pi-ai 动态获取:

  Anthropic (CLI: claude / API: OAuth):
  > [✓] claude-sonnet-4-20250514     均衡, 速度快 (推荐)
    [✓] claude-opus-4-20250514       最强, 适合 Chairman (推荐)
    [ ] claude-haiku-4-5-20251001    最快, 能力较弱

  OpenAI (API 模式 — 复用 Codex OAuth 凭证):
  > [✓] o4-mini                      均衡, 代码能力强 (推荐)
    [ ] o3                           最强, 较慢
    [ ] gpt-4.1                      通用

  Google (CLI: gemini / API: OAuth):
  > [✓] gemini-2.5-pro              综合能力强 (推荐)
    [ ] gemini-2.5-flash             快速, 适合简单问题

  [空格 选择/取消, Enter 确认]

  已选择 3 个模型: claude-opus, claude-sonnet, gemini-pro  ✓

Step 3/6 — 验证模型可用性
──────────────────────────────────────────────────────
  正在验证各模型是否正常工作...

  ✓ claude --version        → Claude Code v1.2.3
  ✓ gemini --version        → Gemini CLI v0.5.1
  ✓ anthropic API           → 凭证有效
  ✓ openai API              → 凭证有效

  全部验证通过 ✓

Step 4/6 — 配置推理深度 (Reasoning Effort)
──────────────────────────────────────────────────────
  推理深度控制模型的"思考力度"。推荐使用默认值:

  claude-opus:
  > ● high     深度推理, 适合 Chairman 综合 (推荐)
    ○ medium   均衡
    ○ xhigh    最深度推理 (仅部分模型支持)

  claude-sonnet:
  > ● medium   均衡推理 (推荐)
    ○ low      轻度推理, 更快
    ○ high     深度推理

  gemini-pro:
  > ● medium   均衡推理 (推荐)
    ○ low      轻度推理, 更快
    ○ high     深度推理

  [↑↓ 选择, Enter 确认]   [s] 全部使用推荐值

Step 5/6 — 选择默认主持人 (Chairman)
──────────────────────────────────────────────────────
  Chairman 负责最终综合各方观点，建议选择综合能力最强的模型。

  > ● claude-opus     (推荐 — 最强综合能力, reasoning: high)
    ○ claude-sonnet
    ○ gemini-pro

  [↑↓ 选择, Enter 确认]

Step 6/6 — 选择默认辩论模式
──────────────────────────────────────────────────────
  > ● auto     自动根据问题复杂度选择 (推荐)
    ○ quick    单模型快速回答
    ○ compare  多模型对比（不互评）
    ○ debate   完整辩论（含互评和共识评分）

  [↑↓ 选择, Enter 确认]

Step 6 (可选) — 添加自定义 OpenAI 兼容端点
──────────────────────────────────────────────────────
  Add a custom OpenAI-compatible endpoint? (e.g. ollama, vLLM, LM Studio) [y/N]

  > y
  Provider name (lowercase, a-z 0-9 -):  ollama
  Base URL (e.g. http://localhost:11434/v1):  http://localhost:11434/v1
  Model identifier (e.g. llama3.2, gpt-4o):  llama3.2
  API key (leave empty for no auth, e.g. local ollama):  ********

  → 写入凭证 ~/.council/credentials/custom-ollama.key (mode 0o600)
  → 连通性测试 custom:ollama:llama3.2 ... ✓
  Add another custom endpoint? [y/N]  n

══════════════════════════════════════════════════════
  ✓ 配置完成! 已保存到 ~/.council/

  已启用模型:
    claude-opus    (Claude Opus)      ← Chairman
    claude-sonnet  (Claude Sonnet)
    gemini-pro     (Gemini 2.5 Pro)
  默认模式: auto

  数据说明:
    所有数据仅保存在本地 (~/.council/), 不上传任何外部服务
    Session 默认保留 90 天后自动清理 (可配置)

  现在可以开始使用了:
    council "你的问题"

  更多配置:
    council setup          完整配置向导
    council models add     添加新模型/模型变体
    council models         查看模型状态
══════════════════════════════════════════════════════
```

**首次引导的设计原则**：
- 主流程 5 步，2 分钟内完成；Step 6（自定义端点）可选，默认跳过
- 自动扫描工具 + 展示可选模型列表，推荐最佳组合
- 同一工具可选多个模型变体（如 opus + sonnet 协作）
- 跳过高级配置（超时、并发、路由规则等），全部使用默认值
- 引导完成后立即可用，不强制要求进一步配置
- Step 6 用于纳入第三方 OpenAI 兼容服务（ollama / vLLM / LM Studio / OneAPI / 自建 LiteLLM 网关 / Azure OpenAI 代理等），无需在 pi-ai 中预注册即可参与辩论。setup 中途取消时，已写入但未被持久化引用的孤儿凭证文件会被清理

**失败恢复与中断处理**：

| 场景 | 处理方式 |
|------|---------|
| 用户在引导中途 `Ctrl+C` | 已完成的步骤保存为部分配置；下次运行时从中断点继续，不重头开始 |
| 扫描到 0 个可用工具 | 明确提示需要至少安装一个 CLI 工具，给出安装链接；退出后用户安装完再运行即可 |
| 验证阶段某个工具失败 | 标记该工具为不可用，跳过继续；如果全部失败则同上 |
| 引导完成后用户想重来 | `council setup --reset` 清除配置，重新触发首次引导 |
| 之前部分完成的配置已存在 | 检测到 `~/.council/` 已存在但不完整，提示 `[r] 继续上次配置 / [n] 重新开始` |

#### 4.3.2 完整配置向导 (`council setup`)

针对需要调整高级选项的用户，提供分模块的完整配置向导：

```
$ council setup

══════════════════════════════════════════════════════
  Council 配置向导
══════════════════════════════════════════════════════

  请选择要配置的模块:

  1. 模型管理         扫描/添加/移除/调整模型
  2. 辩论设置         默认模式、互评轮数、Chairman
  3. 路由规则         关键词匹配、能力路由、动态权重
  4. 输出偏好         输出格式、显示项、剪贴板
  5. 高级设置         并发控制、熔断器、安全性
  6. 全部重新配置     重走首次引导流程

  [1-6 选择, q 退出]
```

**模块 1: 模型管理 — 逐步引导示例：**

```
$ council setup → 1. 模型管理

当前已配置模型:
  ✓ claude-opus     Claude Opus          priority: 10   enabled  ← Chairman
  ✓ claude-sonnet   Claude Sonnet        priority: 20   enabled
  ✓ gemini-pro      Gemini 2.5 Pro       priority: 30   enabled

操作:
  a. 添加新模型
  s. 重新扫描本地工具
  e. 编辑已有模型
  d. 禁用/启用模型
  p. 调整优先级
  b. 返回

> a

──────────────────────────────────────────────────────
  添加新模型 — Step 1/6: 基本信息
──────────────────────────────────────────────────────

  模型 ID (英文标识, 如 codex, ollama-qwen):
  > codex

  显示名称:
  > Codex CLI

──────────────────────────────────────────────────────
  添加新模型 — Step 2/7: CLI 工具
──────────────────────────────────────────────────────

  可执行文件名或路径:
  > codex

  正在检测... ✓ 找到 /usr/local/bin/codex
  验证版本... ✓ Codex v0.1.2

──────────────────────────────────────────────────────
  添加新模型 — Step 3/7: 选择模型
──────────────────────────────────────────────────────

  该工具支持多个模型，请选择:

  > ● o4-mini      (推荐 — 均衡)
    ○ o3           (更强, 较慢)
    ○ codex-mini   (最快, 代码专用)
    ○ 自定义...     (手动输入模型名)

  [↑↓ 选择, Enter 确认]

  提示: 同一工具的其他模型可以稍后通过 council models add 继续添加。

──────────────────────────────────────────────────────
  添加新模型 — Step 4/7: 调用方式
──────────────────────────────────────────────────────

  Prompt 如何传入给这个工具?
  > ● stdin    通过管道传入 (如: echo "prompt" | tool)
    ○ arg      作为命令行参数 (如: tool "prompt")
    ○ file     写入临时文件传入

  非交互模式需要哪些额外参数?
  (多个参数用空格分隔, 直接回车跳过)
  > --quiet --approval-mode full-auto

──────────────────────────────────────────────────────
  添加新模型 — Step 5/7: 能力声明
──────────────────────────────────────────────────────

  这个模型擅长什么? (空格多选, Enter 确认)

  > [✓] code          代码生成、审查、调试
    [✓] debug         Bug 定位与修复
    [✓] refactor      代码重构与优化
    [ ] general       通用问答、分析、总结
    [ ] analysis      深度分析、拆解复杂问题
    [ ] creative      创意写作、头脑风暴
    [ ] chinese       中文理解与生成
    [ ] architecture  系统架构设计
    [ ] math          数学推理与计算

──────────────────────────────────────────────────────
  添加新模型 — Step 6/7: 资源限制
──────────────────────────────────────────────────────

  这是云端 API 还是本地模型?
  > ● 云端 (Claude, Codex, Gemini 等订阅服务)
    ○ 本地 (Ollama, llama.cpp 等本地运行)

  最大并发调用数 (默认 1):
  > 1

  单次调用超时秒数 (默认 120):
  > 120

──────────────────────────────────────────────────────
  添加新模型 — Step 7/7: 验证
──────────────────────────────────────────────────────

  发送测试 prompt: "Say OK"...
  ✓ 收到回复 (2.3s): "OK"

  以下配置将保存到 ~/.council/config/models/codex-o4mini.yaml:

  ┌──────────────────────────────────┐
  │ name: Codex o4-mini              │
  │ binary: codex                    │
  │ model: o4-mini                   │
  │ args: [--quiet, --approval-mode, │
  │        full-auto]                │
  │ input_mode: stdin                │
  │ capabilities: [code, debug,      │
  │                refactor]         │
  │ priority: 50                     │
  │ max_concurrent: 1                │
  │ timeout_seconds: 120             │
  └──────────────────────────────────┘

  确认保存? [Y/n] > Y

  ✓ 模型 codex-o4mini 已添加并启用
  提示: 可通过 council models add 继续添加该工具的其他模型 (如 o3)
```

**模块 3: 路由规则 — 逐步引导示例：**

```
$ council setup → 3. 路由规则

当前路由策略: keyword

  路由策略选择:
  > ● keyword    关键词匹配 (快速, 零成本)
    ○ llm        用 AI 做语义分类 (更准, 多 2-3s)
    ○ manual     不自动路由, 始终用默认模型组

  动态权重 (基于历史表现自动调整模型优先级):
  > ● 开启 (推荐)
    ○ 关闭

  是否自定义路由规则? (默认规则已覆盖代码/架构/创意场景)
  > ● 使用默认规则 (推荐)
    ○ 自定义规则
```

#### 4.3.3 快捷添加 (`council models add`)

`council models add` 是 `council setup → 模型管理 → 添加新模型` 的快捷入口，直接进入 Step 1/7 的添加流程（同 4.2.2 模块 1 的 "添加新模型" 部分）。

也支持参数跳过引导直接添加（高级用户）：

```bash
# 引导式（默认）
council models add

# 快捷模式 — 自动检测工具并列出可选模型
council models add --quick codex

# 直接指定工具+模型（跳过引导，使用预设配置）
council models add --quick codex --model o3

# 完整参数（跳过引导）
council models add --id codex-o4mini --binary codex --model o4-mini --args "--quiet --approval-mode full-auto" --input arg --capabilities code,debug
```

#### 4.3.4 已知工具预设库（Built-in Presets）

系统内置常见工具的预设配置，引导过程中自动匹配，减少用户输入。每个 Provider 同时支持 CLI 和 API 两种调用模式：

**CLI 模式预设（仅定义 CLI 工具的调用参数，不硬编码模型列表）：**

| 工具 | binary | 模型来源 | 模型切换参数 | 预设 input_mode |
|------|--------|---------|-------------|----------------|
| Claude Code | `claude` | pi-ai `getModels('anthropic')` 动态获取 | `--model {model}` | stdin |
| Codex CLI | `codex` | pi-ai `getModels('openai')` 动态获取 | `--model {model}` | arg |
| Gemini CLI | `gemini` | pi-ai `getModels('google')` 动态获取 | `--model {model}` | stdin |
| Ollama | `ollama` | `ollama list` 动态获取本地已拉取的模型 | `run {model}` | stdin |
| Aider | `aider` | 取决于配置的 provider | `--model {model}` | arg |

> **动态模型列表**: CLI 模式预设只定义工具的调用方式（binary、args、input_mode），**可用模型列表不硬编码在预设中**，而是通过 pi-ai 的 `getModels(provider)` 在 Setup Wizard 和 `models add` 时动态获取。这样当 Provider 发布新模型时，用户无需更新 Council 即可使用。

**API 模式预设（统一由 pi-ai 管理，模型列表通过 `getModels(provider)` 自动发现）：**

| Provider | 鉴权方式 | 典型可用模型 |
|----------|---------|------------|
| Anthropic | OAuth（Claude Pro/Max）/ `ANTHROPIC_API_KEY` | claude-opus-4, claude-sonnet-4, claude-haiku-4.5 等 |
| OpenAI | OAuth（Codex CLI）/ `OPENAI_API_KEY` | o4-mini, o3, gpt-4.1, gpt-5.x 等 |
| Google | OAuth（Gemini CLI）/ `GEMINI_API_KEY` | gemini-2.5-pro, gemini-2.5-flash 等 |
| Google Vertex | ADC / `GOOGLE_CLOUD_API_KEY` | gemini-2.5-pro 等（Vertex 端点） |
| Azure OpenAI | `AZURE_OPENAI_API_KEY` | 由企业部署决定 |
| Mistral | `MISTRAL_API_KEY` | mistral-large, codestral 等 |
| GitHub Copilot | OAuth（Device Code）/ `GH_TOKEN` | copilot-chat 等 |
| Amazon Bedrock | AWS 凭证链 | claude, llama, mistral 等（Bedrock 端点） |
| Groq | `GROQ_API_KEY` | llama, mixtral 等（Groq 加速推理） |
| xAI | `XAI_API_KEY` | grok 系列 |
| OpenRouter | `OPENROUTER_API_KEY` | 聚合多 Provider 模型 |
| Ollama / vLLM / LM Studio | 本地服务（OpenAI 兼容端点） | 用户本地部署的任意模型 |

> **模型发现**: Council 启动时调用 pi-ai 的 `getProviders()` 和 `getModels(provider)` 动态获取完整模型列表，而非硬编码。当 pi-ai 新增 Provider 或模型时，Council 自动可见。

> **核心概念**：一个 Provider 可以注册多个模型配置，且 CLI 和 API 模式可共存。例如 Anthropic 可以同时注册 `claude-opus`（CLI 模式，利用 Claude Code 的项目上下文能力）和 `anthropic-opus-api`（API 模式，更低延迟），路由时按需选择。

当扫描到已知工具时，引导流程自动查询可用模型列表，由用户选择要启用哪些：

```
检测到已知工具: claude (Claude Code)

  该工具支持以下模型，请选择要启用的 (空格多选):
  > [✓] claude-sonnet-4-20250514     (推荐 — 均衡, 速度快)
    [✓] claude-opus-4-20250514       (推荐 — 最强综合能力, 适合 Chairman)
    [ ] claude-haiku-4-5-20251001    (最快, 能力较弱)

  将为每个选中的模型生成独立配置文件。
```

### 4.4 模型配置文件规范

引导式配置最终生成标准 YAML 文件，高级用户也可直接编辑。每个模型对应 `config/models/` 下的一个 YAML 文件，文件名即模型 ID。

#### 4.4.1 YAML Schema 完整定义

**通用字段：**

| 字段 | 类型 | 必填 | 引导步骤 | 说明 |
|------|------|------|---------|------|
| name | string | ✓ | Step 1 | 显示名称，如 "Claude Opus" |
| invocation | enum | ✓ | Step 2 | `cli` \| `api` \| `auto` — 调用模式（见 4.2.1）。`auto` 优先 API，回退 CLI |
| provider | enum | — | 自动推断 | pi-ai 支持的所有 Provider ID（`anthropic` \| `openai` \| `google` \| `google-vertex` \| `azure-openai-responses` \| `mistral` \| `github-copilot` \| `bedrock` \| `groq` \| `cerebras` \| `xai` \| `openrouter` \| `ollama` \| `custom` 等）— API 模式下标识 Provider |
| model | string | — | Step 2 | 具体模型标识（如 "claude-opus-4-20250514"）。同一 provider/binary 可注册多个 model |
| timeout_seconds | int | ✓ | Step 5 | 默认 120，每次调用的超时时间 |
| capabilities | string[] | ✓ | Step 4 | 能力声明，见 4.6。同一工具的不同模型可有不同能力标签 |
| priority | int | ✓ | 自动计算 | 默认 100，数字越小优先级越高。同能力时优先选择高优先级模型 |
| max_concurrent | int | ✓ | Step 5 | 默认 1。该模型的最大并发调用数 |
| resource_weight | int | ✓ | Step 5 | 默认 1。资源权重（本地模型自动设为 3-5，云端设为 1） |
| enabled | bool | ✓ | 默认 true | 设为 false 可临时禁用而不删配置 |
| reasoning_effort | enum | — | Step 6 | `minimal` \| `low` \| `medium` \| `high` \| `xhigh` — 推理深度控制（见 4.4.2）。未设置时由模型默认行为决定 |

> **`reasoning_effort` 说明**: 该字段映射到 pi-ai 的 `ThinkingLevel`，控制模型的"思考深度"。不同 Provider 的底层实现不同（OpenAI 的 `reasoningEffort`、Anthropic 的 `thinkingEnabled` + token 预算、Google 的 `thinking` 配置），但 pi-ai 统一抽象为 5 个档位。Council 通过此字段让用户按场景灵活控制：
> - Chairman（综合者）建议 `high` 或 `xhigh` — 需要深度分析和综合
> - Review 阶段建议 `medium` — 均衡的评审深度
> - Quick 模式可用 `low` — 快速响应
> - `xhigh` 仅部分模型支持（pi-ai 的 `supportsXhigh(model)` 可检测），不支持时自动降级为 `high`

**CLI 模式专用字段**（`invocation: cli` 或 `auto` 时使用）：

| 字段 | 类型 | 必填 | 引导步骤 | 说明 |
|------|------|------|---------|------|
| binary | string | CLI 必填 | Step 2 | CLI 可执行文件名，如 "claude"、"/usr/local/bin/claude" |
| model_args | string[] | — | 自动生成 | 模型切换参数（如 `["--model", "claude-opus-4-20250514"]`），自动追加到 args |
| args | string[] | CLI 必填 | Step 3 | 非交互模式的基础命令行参数（不含模型切换参数） |
| input_mode | enum | CLI 必填 | Step 3 | `stdin` \| `arg` \| `file` — prompt 如何传入 |
| output_mode | enum | CLI 必填 | Step 3 | `stdout` \| `file` \| `json_field` — 如何提取输出 |
| output_json_field | string | — | Step 3 | 当 output_mode=json_field 时，指定提取哪个 JSON 字段 |
| env | dict | — | 高级 | 额外的环境变量，如 API key 路径 |
| health_check | object | CLI 必填 | 自动生成 | 健康检查配置（子字段见下方） |

**API 模式专用字段**（`invocation: api` 或 `auto` 时使用）：

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| api_credential_path | string | — | 凭证文件路径（默认按 provider 自动探测，见 4.2.2）。如需指定非默认路径可手动填写。自定义端点场景下指向 `~/.council/credentials/custom-<name>.key`（mode 0o600） |
| api_base_url | string | — | 自定义 API 端点。指定后绕过 pi-ai 模型注册表，按 OpenAI Completions 协议直连任意兼容服务（ollama / vLLM / LM Studio / OneAPI / Azure OpenAI 代理等） |
| api_key_env | string | — | 环境变量名（如 `ANTHROPIC_API_KEY`、`OLLAMA_API_KEY`）。读取该环境变量作为 API Key |

> **API Key 解析三级优先级**（自定义端点和已注册 Provider 共用）：① `api_key_env` 指定的环境变量 → ② `api_credential_path` 指向的凭证文件（整个文件内容 trim 后作为 key） → ③ `CredentialManager.getApiKey(provider)` 的 OAuth/默认路径回退。三者均为空时，仅当 `api_base_url` 指向本地 host（`localhost` / `127.0.0.1` / `[::1]` / `0.0.0.0`）时允许以空 key 调用（适配无鉴权的本地服务，如 ollama 默认部署）。
| streaming | bool | — | 是否使用流式输出，默认 `true` |
| temperature | float | — | 模型温度参数（0.0-2.0），未设置时使用模型默认值 |
| max_tokens | int | — | 最大输出 token 数，未设置时使用模型默认值 |

**`health_check` 子字段定义**（CLI 模式）：

| 子字段 | 类型 | 必填 | 默认值 | 说明 |
|--------|------|------|-------|------|
| command | string[] | ✓ | `["{binary}", "--version"]` | 健康检查执行的命令及参数 |
| expect_exit_code | int | ✓ | `0` | 期望的进程退出码，不匹配则判定为 unhealthy |
| cache_seconds | int | — | `300` | 检查结果缓存时长（秒），避免频繁检查 |
| timeout_seconds | int | — | `10` | 健康检查本身的超时时间（秒），防止 hang 住 |

**关键概念 — 工具 vs 模型**：

- `binary` 是 CLI 工具（如 `claude`），同一个 binary 可以注册多个配置文件
- `model` 是该工具下的具体模型变体（如 `claude-opus-4-20250514`）
- 配置文件命名规则：`{binary}-{model_short_name}.yaml`（如 `claude-opus.yaml`、`claude-sonnet.yaml`）
- 同一 binary 的多个配置共享 `args` 和 `input_mode` 等基础参数，但 `model`、`capabilities`、`priority`、`timeout_seconds` 可各自不同

**自动生成的字段**：
- `model_args`: 根据预设库中的"模型切换参数"模板和用户选择的 model 自动拼接
- `health_check`: 根据 binary 自动生成 `{binary} --version` 检查命令
- `priority`: 首次添加时根据预设库推荐（同工具下旗舰模型优先级更高）；后续可通过 `council setup` 调整或由动态权重自动优化
- `resource_weight`: 根据"云端/本地"选择自动设定（云端=1, 本地=5）

#### 4.4.2 推理深度（Reasoning Effort）配置

`reasoning_effort` 通过 pi-ai 的 `SimpleStreamOptions.reasoning` 透传给各 Provider，控制模型的"思考深度"：

| reasoning_effort | 适用场景 | 效果 |
|-----------------|---------|------|
| `minimal` | 快速分类、简单格式化 | 最低 token 消耗，几乎无思考 |
| `low` | quick 模式、简单问答 | 轻度推理，响应快 |
| `medium`（默认） | compare 模式、常规 Review | 均衡的推理深度 |
| `high` | debate 模式、Chairman 综合 | 深度推理，适合复杂分析 |
| `xhigh` | 高价值决策、数学证明 | 最深度推理，仅部分模型支持 |

**阶段级 Effort Override**: 除了模型配置中的全局 `reasoning_effort`，编排器还支持按辩论阶段动态覆盖：

```yaml
# council.yaml
general:
  stage_effort:
    broadcast: medium        # 各 Agent 回答：均衡
    review: low              # 互评：不需要太深的推理
    synthesis: high          # Chairman 综合：需要深度分析
```

当 `stage_effort` 与模型配置中的 `reasoning_effort` 同时存在时，取**较高**的那个（不会降低模型自身配置的推理深度）。

**动态模型信息**: 模型的 `contextWindow`、`maxTokens`、是否支持 reasoning、是否支持 `xhigh` 等元信息通过 pi-ai 的 `getModel()` 返回的 `Model` 对象动态获取，Council 不硬编码这些值。编排器在构建 prompt 时参考 `contextWindow` 计算是否需要压缩。

#### 4.4.3 配置示例

引导流程自动生成的 YAML 文件示例。注意同一 Provider 可以注册多个模型配置，且 CLI 和 API 模式可混用：

**claude-opus.yaml**（CLI 模式 — 首次引导选中 opus 后自动生成）

```yaml
# Auto-generated by council setup
name: Claude Opus
invocation: cli                # CLI 模式：通过 subprocess 调用
provider: anthropic
binary: claude
model: claude-opus-4-20250514
model_args: ["--model", "claude-opus-4-20250514"]
args: ["-p", "--output-format", "text"]
input_mode: stdin
output_mode: stdout
timeout_seconds: 180
health_check:
  command: ["claude", "--version"]
  expect_exit_code: 0
  cache_seconds: 300
capabilities: [general, code, analysis, chinese, architecture]
priority: 10              # 旗舰模型，最高优先级，推荐作为 Chairman
max_concurrent: 1
resource_weight: 1
reasoning_effort: high    # 旗舰模型用于综合，深度推理
enabled: true
```

**claude-sonnet.yaml**（首次引导选中 sonnet 后自动生成）

```yaml
# Auto-generated by council setup
name: Claude Sonnet
binary: claude
model: claude-sonnet-4-20250514
model_args: ["--model", "claude-sonnet-4-20250514"]
args: ["-p", "--output-format", "text"]
input_mode: stdin
output_mode: stdout
timeout_seconds: 120
health_check:
  command: ["claude", "--version"]
  expect_exit_code: 0
  cache_seconds: 300
capabilities: [general, code, analysis, chinese]
priority: 20              # 均衡模型，速度更快
max_concurrent: 2
resource_weight: 1
reasoning_effort: medium  # 均衡模型，中等推理深度
enabled: true
```

**codex-o4mini.yaml**（CLI 模式 — 通过 `council models add` 引导生成）

```yaml
# Auto-generated by council models add
name: Codex o4-mini
invocation: cli
provider: openai
binary: codex
model: o4-mini
model_args: ["--model", "o4-mini"]
args: ["--quiet", "--approval-mode", "full-auto"]
input_mode: arg
output_mode: stdout
timeout_seconds: 120
health_check:
  command: ["codex", "--version"]
  expect_exit_code: 0
  cache_seconds: 300
capabilities: [code, debug, refactor]
priority: 50
max_concurrent: 1
resource_weight: 1
enabled: true
```

**openai-o4mini.yaml**（API 模式 — CLI 未安装但发现本地 OAuth 凭证时自动生成）

```yaml
# Auto-generated by council setup (credential discovery)
name: OpenAI o4-mini
invocation: api               # API 模式：直接调用 OpenAI SDK
provider: openai
model: o4-mini
api_credential_path: ~/.codex/auth.json   # 复用 Codex CLI 的 OAuth 凭证
streaming: true
timeout_seconds: 120
capabilities: [code, debug, refactor, general]
priority: 50
max_concurrent: 3             # API 模式支持更高并发
resource_weight: 1
enabled: true
```

**anthropic-opus-api.yaml**（API 模式 — 用户有 API Key 或 OAuth 凭证时的配置示例）

```yaml
# API 模式配置示例
name: Claude Opus (API)
invocation: api
provider: anthropic
model: claude-opus-4-20250514
api_key_env: ANTHROPIC_API_KEY  # 优先使用环境变量中的 API Key
# api_credential_path: 无需填写，自动探测 Claude Code 的 OAuth 凭证
streaming: true
timeout_seconds: 180
capabilities: [general, code, analysis, chinese, architecture]
priority: 10
max_concurrent: 3
resource_weight: 1
reasoning_effort: high          # 综合者角色，深度推理
enabled: true
```

> **CLI vs API 同模型共存**: 同一个模型（如 claude-opus）可以同时注册 CLI 配置和 API 配置。设置 `invocation: auto` 时，系统优先尝试 API 模式（更低延迟），API 不可用时回退到 CLI。用户也可以为不同场景显式选择：API 模式用于常规辩论（快），CLI 模式用于需要 Codex 沙箱执行等特殊能力的场景。

**custom-ollama-llama3.yaml**（自定义 OpenAI 兼容端点示例 — 本地 ollama）

```yaml
# 通过 council setup Step 6 自动生成
name: custom:ollama:llama3.2
invocation: api
provider: custom:ollama          # 命名约定：custom:<sanitized-name>，name 满足 [a-z0-9-]+
model: llama3.2
api_base_url: http://localhost:11434/v1   # 本地 host：无鉴权也允许
# api_credential_path: 未设置（无 key 场景）；如有 key 则指向 ~/.council/credentials/custom-ollama.key
streaming: true
timeout_seconds: 120
capabilities: [general, code, analysis]
priority: 50
max_concurrent: 1
resource_weight: 1
enabled: true
```

> **自定义 Provider 命名规则**: `provider: 'custom:<name>'`，其中 `<name>` 满足 `[a-z0-9-]+`（wizard 自动 sanitize）。该命名同时作为 circuit-breaker 的 key — 同一自定义 provider 的多个模型共享熔断状态。配置文件名约定 `custom-<name>-<model>.yaml`。

**gemini-pro.yaml**（首次扫描自动生成）

```yaml
# Auto-generated by council setup
name: Gemini 2.5 Pro
binary: gemini
model: gemini-2.5-pro
model_args: ["--model", "gemini-2.5-pro"]
args: ["-p"]
input_mode: stdin
output_mode: stdout
timeout_seconds: 120
health_check:
  command: ["gemini", "--version"]
  expect_exit_code: 0
  cache_seconds: 300
capabilities: [general, creative, multilingual, analysis]
priority: 30
max_concurrent: 3
resource_weight: 1
enabled: true
```

**gemini-flash.yaml**（首次引导选中 flash 后自动生成）

```yaml
# Auto-generated by council setup
name: Gemini 2.5 Flash
binary: gemini
model: gemini-2.5-flash
model_args: ["--model", "gemini-2.5-flash"]
args: ["-p"]
input_mode: stdin
output_mode: stdout
timeout_seconds: 60
health_check:
  command: ["gemini", "--version"]
  expect_exit_code: 0
  cache_seconds: 300
capabilities: [general, creative, multilingual]
priority: 60              # 快速模型，适合 quick 模式
max_concurrent: 5
resource_weight: 1
enabled: true
```

> **组合示例**: 用户可以同时启用 `claude-opus` + `claude-sonnet` + `gemini-pro`，在 debate 模式下让 opus 担任 Chairman，sonnet 和 gemini-pro 各自以不同角色参与辩论。

### 4.5 健康检查与熔断机制

模型可用性不能仅靠"which 命令存在"判断。CLI 工具可能存在但未登录、token 过期、版本不兼容等问题。API 模式则需要验证凭证有效性。需要分层的健康检查：

#### 4.5.1 三层检查模型

**CLI 模式：**

| 层级 | 检查项 | 检查方法 | 失败处理 |
|------|--------|---------|---------|
| L1 | 二进制存在 | `which {binary}` 检查 PATH 中是否存在 | 标记为 `unavailable`，从候选列表移除 |
| L2 | 版本兼容 | 执行 `health_check.command`，检查退出码 | 标记为 `unhealthy`，降低优先级但不移除 |
| L3 | 功能验证 | 发送简单探针 prompt（如 "Say OK"），检查是否正常回复 | 标记为 `degraded`，记录错误详情 |

**API 模式：**

| 层级 | 检查项 | 检查方法 | 失败处理 |
|------|--------|---------|---------|
| L1 | 凭证文件存在 | 检查 `api_credential_path` 或默认路径是否存在且可读 | 标记为 `unavailable` |
| L2 | Token 有效性 | 检查 `expiry_date`；若过期则尝试 `refresh_token` 刷新 | 刷新失败 → `unhealthy`（凭证过期，需用户重新登录对应 CLI） |
| L3 | API 连通性 | 发送轻量级 API 调用（如 Anthropic 的 `/v1/messages` with max_tokens=1） | 标记为 `degraded` |

#### 4.5.2 检查策略

- **启动时全量检查**: 首次运行 council 命令时，对所有 enabled=true 的模型执行 L1+L2 检查
- **缓存机制**: L1/L2 检查结果缓存 `health_check.cache_seconds` 秒（默认 300s），避免每次运行都检查
- **L3 按需触发**: 仅在 L2 失败或 broadcast 阶段模型失败时触发 L3 检查，避免浪费调用额度
- **失败记忆**: 模型连续失败达到 `circuit_breaker.failure_threshold`（默认 5 次）后自动触发熔断，记录到 council.db，直到熔断恢复或用户手动重置。

#### 4.5.3 熔断机制（Circuit Breaker）

当模型连续失败达到阈值时，自动进入熔断状态：

| 状态 | 触发条件 | 行为 | 恢复条件 |
|------|---------|------|---------|
| `closed` | 正常 | 正常调用 | — |
| `open`（熔断） | 连续失败 ≥ `failure_threshold`（默认 5 次） | 自动禁用模型，路由时彻底剔除 | 熔断持续 `recovery_seconds`（默认 3600s）后进入 half-open |
| `half-open`（试探） | 熔断时间到期 | 允许 1 次试探调用 | 试探成功 → closed；试探失败 → open（重置计时器） |

**配置项**（`council.yaml`）：

```yaml
circuit_breaker:
  failure_threshold: 5        # 连续失败多少次触发熔断（可按模型覆盖）
  recovery_seconds: 3600      # 熔断持续时间（秒）
  enabled: true               # 是否启用熔断机制
```

### 4.6 能力声明与智能路由

#### 4.6.1 能力标签体系

每个模型的 `capabilities` 字段声明其擅长领域，用于智能路由：

| 能力标签 | 含义 |
|---------|------|
| general | 通用问答、分析、总结 |
| code | 代码生成、审查、调试 |
| analysis | 深度分析、拆解复杂问题 |
| creative | 创意写作、头脑风暴、非常规方案 |
| chinese | 中文理解与生成能力强 |
| multilingual | 多语言支持 |
| debug | Bug 定位与修复 |
| refactor | 代码重构与优化 |
| architecture | 系统架构设计 |
| math | 数学推理与计算 |

#### 4.6.2 路由规则

主配置文件 `council.yaml` 中定义路由规则，指定不同场景下优先使用哪些模型：

```yaml
routing:
  strategy: keyword          # keyword | llm | manual（路由策略选择）
  dynamic_weight: true       # 是否启用动态权重（基于历史表现自动调整）

  rules:
    - match:                           # 匹配条件
        keywords: ["代码", "code", "bug", "debug", "函数", "function"]
        min_capabilities: [code]       # 必须具备的能力
      prefer: [claude-opus, claude-sonnet, codex-o4mini]  # 优先模型（配置文件 ID）
      chairman: claude-opus            # 综合者
      role_set: code-review            # 使用的角色 prompt 集

    - match:
        keywords: ["架构", "architecture", "设计", "design", "系统"]
        min_capabilities: [analysis]
      prefer: [claude-opus, gemini-pro]
      chairman: claude-opus
      role_set: architecture

    - match:
        keywords: ["创意", "creative", "头脑风暴", "brainstorm"]
        min_capabilities: [creative]
      prefer: [gemini-pro, claude-sonnet]
      chairman: gemini-pro
      role_set: default

  default:                              # 无匹配时的默认配置
    prefer: [claude-opus, claude-sonnet, gemini-pro]
    chairman: claude-opus
    role_set: default
```

**路由策略说明：**

| 策略 | 说明 | 适用场景 | 降级逻辑 |
|------|------|---------|---------|
| `keyword` | 基于关键词匹配，零成本 | 默认策略 | — |
| `llm` | Chairman 模型语义分类 | 语义复杂场景 | **若分类失败/超时/Chairman不可用**：自动降级为 `keyword` 策略，不阻塞主流程 |
| `manual` | 始终使用 default 配置 | 固定模型组 | — |

#### 4.6.3 动态权重（Dynamic Weight）

启用 `routing.dynamic_weight: true` 后，模型的路由优先级不再完全依赖静态 `priority`，而是结合历史表现动态调整。

**方向约定**: 系统内部统一使用 **score 越高越优先** 的方向。配置文件中 `priority` 值越小越优先（用户习惯），加载时自动反转为内部 score：`static_score = 1 - (priority / max_priority)`。

```
effective_score(model) = static_score × (1 - α) + dynamic_score × α

其中:
- static_score: 由 priority 反转而来，值域 [0, 1]，越大越优先
  static_score = 1 - (priority / max_priority_in_pool)
- dynamic_score: 基于近 30 天 model_stats 计算，值域 [0, 1]，越大越优先
  = 0.4 × normalize(avg_peer_score)
  + 0.3 × normalize(avg_user_rating)
  + 0.2 × success_rate
  + 0.1 × normalize(1 / avg_response_time)
  其中 normalize() 将原始值映射到 [0, 1]
- α: 动态权重系数，默认 0.3（可配置 routing.dynamic_weight_alpha）
```

路由时按 `effective_score` **降序**排列，得分最高的模型优先入选。

**Shadow Mode（影子模式）**：动态权重首次启用后，默认进入 shadow mode（`routing.dynamic_weight_shadow: true`）。在 shadow mode 下，系统照常收集模型表现数据并计算 `effective_score`，但**实际路由仍然使用静态 priority**，不让动态权重参与真实决策。`council stats --routing` 会输出 shadow 模式下的"假设路由"与实际路由的差异对比，帮助用户评估动态权重是否可靠。当用户确认 shadow 数据合理后，可通过 `routing.dynamic_weight_shadow: false` 切换为真实生效模式。这避免了早期噪声数据被学成策略。

**Epsilon-Greedy 探索机制**：

纯动态权重可能导致"强者愈强"的马太效应——早期偶然高分的模型被持续优先选择，新模型或更新后能力提升的模型永远没有出头机会。为此引入探索策略：

- 在 `auto` 模式下，有 `ε` 的概率（默认 10%）忽略动态权重，随机选择一个健康的可用模型填充某个 Agent 席位
- **Chairman 豁免机制**: Chairman 席位**不参与**探索随机化，始终由 `effective_score` 最高的旗舰模型担任，以确保最终总结质量的绝对稳定性。探索仅作用于非 Chairman 的 Agent 席位。
- `ε` 值可配置：`routing.exploration_rate: 0.1`
- 探索选中的模型在该次辩论中正常参与，其表现会更新 `model_stats`，从而自动校正动态权重
- 当某模型累计参与次数 < 5 时（冷启动），强制提高其被探索选中的概率（`ε_cold = 0.3`）
- 这确保系统持续探测每个模型在不同版本下的真实水平，自动发现"进步"的模型

#### 4.6.4 路由执行流程

1. **关键词匹配**: 对用户问题做关键词提取，与 `routing.rules` 中的 `match.keywords` 比对
2. **能力筛选**: 从匹配规则的 prefer 列表中，筛选出 enabled=true、健康状态正常、非熔断的模型
3. **动态排序**: 如果启用了 dynamic_weight，按 effective_priority 重新排序
4. **角色 prompt 加载**: 根据 role_set 从 `config/roles/` 目录加载对应的角色 prompt 模板
5. **Agent 席位分配**: 将角色分配给可用模型。规则如下：
   - 优先将不同角色分配给不同模型（多样性最大化）
   - 如果可用模型数 < 角色数且 `allow_same_model_agents=true`，将剩余角色复用已有模型（优先复用 priority 最高的）
   - 如果 `allow_same_model_agents=false` 且可用模型不足，降级为 compare 或 quick 模式
6. **最少 Agent 数保证**: 如果分配后不足 `min_agents` 个席位，自动复用可用模型填充
7. **Chairman 确认**: 如果指定的 chairman 不可用，fallback 到 prefer 列表的第一个可用模型
8. **反方角色分配**: 在 debate 模式下，根据触发条件分配 Devil's Advocate（见 2.4 节）

### 4.7 角色 Prompt 模板

角色 prompt 是辩论质量的决定性因素。每个 role_set 定义一组角色，存储在 `config/roles/{role_set}.yaml` 中。

**role_set 版本化**: 角色 prompt 的微调直接影响辩论结果，因此每个 role_set 文件包含 `version` 字段，Session 中记录使用的 role_set 版本。这使得：
- 结果可追溯：知道某次辩论用的是哪个版本的角色 prompt
- 历史复用安全：`reused_from` 检测时比对 role_set 版本，版本不一致则标记为 `stale`
- 建议将 `config/roles/` 纳入 Git 管理，变更自动有迹可循

```yaml
# config/roles/default.yaml
version: "1.0.0"                 # 版本号，用于 stale 检测
roles:
  analyst:
    description: "注重严谨性和全面性的分析师"
    system_prompt: |
      你是一位注重严谨性和全面性的分析师。
      你会考虑边界情况、潜在风险和长期影响。
      如果一个方案有隐患，你一定会指出。
    assign_to: [claude-opus, claude-sonnet]  # 优先分配给哪个模型配置

  engineer:
    description: "注重实践的工程师"
    system_prompt: |
      你是一位注重实践的工程师。
      你关心方案能不能落地、性能如何、维护成本多少。
      你偏好简单直接的解决方案，反对过度设计。
    assign_to: [codex-o4mini]

  innovator:
    description: "善于跳出框架思考的创新者"
    system_prompt: |
      你是一位善于跳出框架思考的创新者。
      你会考虑非常规方案、新技术趋势和跨领域借鉴。
      你鼓励探索，但也会评估可行性。
    assign_to: [gemini-pro]
```

**角色分配规则：**

- 优先按 `assign_to` 分配角色给指定模型
- 如果 `assign_to` 指定的模型不可用，将角色分配给其他可用模型
- **多模型场景**: 优先让每个模型承担 1 个角色（最大化视角多样性）
- **单模型/少模型场景**: 允许同一模型承担多个角色（通过不同的 system prompt 产生视角差异）。同一模型的多次调用使用独立的会话上下文，确保各 Agent 回答独立
- 如果模型数 > 角色数，多余模型使用通用角色 prompt
- Devil's Advocate 是附加层，不替代原有角色

### 4.8 调用适配层（Invocation Adapter）

适配层负责抽象 CLI 模式和 API 模式的差异，让编排层统一调用 `invoke(model_id, prompt) -> response` 接口。

#### CLI 模式适配

不同 CLI 工具的输入输出方式差异很大，通过 `input_mode` / `output_mode` 适配：

| 模式 | input_mode 行为 | output_mode 行为 |
|------|----------------|-----------------|
| stdin | 通过 stdin pipe 传入 prompt | 从 stdout 读取完整输出 |
| arg | prompt 作为命令行最后一个参数传入 **⚠️ 不安全：prompt 会暴露在进程列表（`ps aux`）和 shell 历史中，不适用于包含敏感信息的问题** | (同 stdout) |
| file | 写入临时文件，通过参数传入文件路径 | 从指定输出文件读取结果 |
| json_field | (同 stdin/arg) | stdout 为 JSON，从指定字段提取文本内容 |

CLI 适配层还负责：
- **输出清洗**: 去除 ANSI 色彩码、进度条、警告信息等非内容输出
- **编码处理**: 统一转换为 UTF-8，处理中文字符编码问题

#### API 模式适配

API 模式通过 Provider SDK 直接调用，无需处理 CLI 的 I/O 差异。适配逻辑按 provider 分派：

| Provider | SDK | 调用方式 | 凭证来源 |
|----------|-----|---------|---------|
| `anthropic` | `@anthropic-ai/sdk` | `messages.create()` with streaming | OAuth token（Claude Code 凭证）或 `ANTHROPIC_API_KEY` |
| `openai` | `openai` | `responses.create()` with streaming | OAuth token（`~/.codex/auth.json`）或 `OPENAI_API_KEY` |
| `google` | `@google/genai` | `generateContent()` with streaming | OAuth token（`~/.gemini/oauth_creds.json`）或 `GEMINI_API_KEY` |
| `ollama` | HTTP REST | `POST /api/generate` with streaming | 无需凭证（本地服务） |

**API 调用前的凭证准备流程**：
1. 按优先级获取凭证：`api_key_env` 环境变量 > `api_credential_path` 指定文件 > 自动探测默认路径
2. 检查 token 是否过期（`expiry_date < now`）
3. 若过期，使用 `refresh_token` 自动刷新，写回原凭证文件
4. 刷新失败 → 标记模型为 `degraded`，尝试回退到 CLI 模式（如果 `invocation: auto`）

#### 通用后处理（CLI 和 API 共享）

- **身份标识过滤**: 自动检测并替换模型自我介绍句式（如 "I'm Claude"），防止 Review 阶段暴露身份
- **错误标准化**: 将不同来源的错误格式统一为标准的 InvocationError 结构
- **Token 用量记录**: API 模式从响应的 `usage` 字段提取；CLI 模式无法精确获取，记为 `null`

### 4.9 并发控制与资源管理

#### 4.9.1 全局并发池（Global Concurrency Pool）

单个模型的 `max_concurrent` 限制了该模型的并发数，但当系统同时运行多个本地模型（如 Ollama）时，可能导致系统资源耗尽。全局并发池通过 `resource_weight` 实现系统级资源管控：

```yaml
# council.yaml
concurrency:
  global_resource_limit: 10   # 全局资源池上限
```

**资源计算方式**: 每次调用消耗该模型的 `resource_weight` 点资源。例如：
- 调用 claude（weight=1）+ codex（weight=1）+ gemini（weight=1）= 消耗 3 点 ✓
- 调用 claude（weight=1）+ ollama-qwen（weight=5）+ ollama-llama（weight=5）= 消耗 11 点 ✗（超限，需排队）

#### 4.9.2 跨进程原子调度

单纯的文件锁（flock）只能做互斥，无法实现"全局资源池的原子扣减"。采用 **SQLite WAL 模式** 作为跨进程协调层：

**调度数据库**: `~/.council/data/council.db` 中增加 `resource_slots` 表：

| 列名 | 类型 | 说明 |
|------|------|------|
| slot_id | INTEGER PK | 自增槽位 ID |
| model_id | TEXT | 占用该槽位的模型配置 ID |
| pid | INTEGER | 占用进程的 PID |
| acquired_at | TEXT | 获取时间（ISO 8601） |
| resource_cost | INTEGER | 该槽位消耗的资源点数 |

**获取资源的原子流程**（在单个 SQLite 事务中完成）：

```sql
BEGIN IMMEDIATE;
-- 1. 清理僵尸槽位（PID 已退出的）
DELETE FROM resource_slots WHERE pid NOT IN (活跃进程列表);
-- 进程存活检测: macOS/Linux 用 kill(pid, 0), Windows 用 OpenProcess(pid)
-- 实现层封装为平台无关的 is_process_alive(pid) -> bool
-- 2. 检查模型并发限制
SELECT COUNT(*) FROM resource_slots WHERE model_id = ?;  -- < max_concurrent?
-- 3. 检查全局资源池
SELECT SUM(resource_cost) FROM resource_slots;            -- + new_cost ≤ global_limit?
-- 4. 两项检查都通过才插入
INSERT INTO resource_slots (model_id, pid, acquired_at, resource_cost) VALUES (?, ?, ?, ?);
COMMIT;
```

- SQLite 的 `BEGIN IMMEDIATE` 保证写事务互斥，天然解决多进程竞态
- 进程退出时（包括正常退出和 SIGINT）在 finally 块中释放槽位
- 每次调用前清理僵尸槽位（`kill -0 pid` 检测进程存活），防止死锁
- 等待资源时显示 `[Waiting] Model X is in use by another council instance (PID: 12345)...`，每 2s 重试

---

## 5. 主配置文件结构

`council.yaml` 是系统的全局配置文件，完整结构如下：

```yaml
# ~/.council/config/council.yaml

# 配置版本，用于未来配置迁移
schema_version: 1

# 全局设置
general:
  default_mode: auto            # 默认辩论模式
  default_chairman: claude-opus  # 默认综合者（模型配置 ID）
  min_agents: 2                 # compare/debate 模式的最少 Agent 数（quick 模式例外，固定为 1）
  max_agents: 5                 # 最大参与 Agent 数（适用于所有多 Agent 模式）
  allow_same_model_agents: true # 允许同一模型配置扮演多个 Agent（不同角色 prompt）
  review_rounds: 1              # peer review 轮数
  language: auto                # auto | zh | en
                                # auto: 检测用户问题语言并匹配输出
                                # zh/en: 强制使用指定语言输出
  compression_threshold_ratio: 0.6  # Synthesis 输入超过 Chairman context 的此比例时触发 Pre-Synthesis Compression
  devil_advocate: auto          # auto | always | never
  high_risk_keywords:           # 触发 -i 自动提醒的高风险关键词（支持热更新）
    - "安全审计"
    - "生产部署"
    - "数据迁移"
    - "权限变更"
    - "security audit"
    - "production deploy"

# 持久化设置
storage:
  data_dir: ~/.council/data
  checkpoint_dir: ~/.council/checkpoints
  log_dir: ~/.council/logs
  lock_dir: ~/.council/locks
  log_retention_days: 7
  orphan_checkpoint_hours: 24

# 路由规则 (见 4.6.2)
routing:
  strategy: keyword             # keyword | llm | manual
  dynamic_weight: true          # 启用基于历史表现的动态权重
  dynamic_weight_alpha: 0.3     # 动态权重系数（0=纯静态, 1=纯动态）
  dynamic_weight_shadow: true   # Shadow mode: 收集数据但不影响真实路由（首次启用时默认开启）
  exploration_rate: 0.1         # Epsilon-Greedy 探索率（10% 概率随机选模型，防马太效应）
  rules: [...]
  default:
    prefer: [claude-opus, claude-sonnet, gemini-pro]
    chairman: claude-opus
    role_set: default

# 并发控制
concurrency:
  global_resource_limit: 10     # 全局资源池上限

# 熔断器
circuit_breaker:
  failure_threshold: 5          # 连续失败 5 次触发熔断（与 4.4.3 一致）
  recovery_seconds: 3600        # 熔断持续时间（秒）
  enabled: true

# 输出设置
output:
  format: markdown              # markdown | json | plain
  show_individual: false        # 是否显示各模型原始回答
  show_scores: true             # 是否显示互评分数
  show_consensus: true          # 是否显示共识度
  show_dimension_heatmap: true  # 是否显示分维度分歧热力图
  show_timing: true             # 是否显示耗时
  copy_to_clipboard: false      # 是否自动复制结果到剪贴板
  tui_mode: auto                # auto | always | never（TUI 仪表盘模式）

# 存储安全（轻量级，数据全在本地）
storage_security:
  session_retention_days: 90     # Session JSON 保留天数（默认 90 天，设 0 永久保留）
  # --no-store 模式通过 CLI 参数启用，不在配置文件中设定默认值（避免意外全局禁用持久化）
```

---

## 6. 用户交互体验

### 6.1 首次使用体验（First-Run Experience）

用户安装 council 后的首次体验路径：

```
$ council "Redis vs Memcached 怎么选?"

  检测到首次使用，进入初始配置...
  (约 60 秒即可完成)

  → 自动进入 First-Run Wizard（见第 4.3.1 节）
  → 配置完成后自动执行用户的原始问题
```

**关键设计决策**：
- 首次运行不是要求用户先执行 `council setup`，而是在用户提问时自然触发引导
- 引导完成后**无缝衔接**执行用户的原始问题，不要求重新输入
- 如果用户想跳过引导，可以 `Ctrl+C` 中断，后续通过 `council setup` 手动配置

### 6.2 实时进度反馈（Streaming UX）

辩论流程长达 60-180s，用户等待焦虑感强。系统通过多层反馈机制降低焦虑：

#### 最小反馈（plain 模式）

每个阶段切换时输出状态行：

```
[1/4] Broadcasting to 3 models...
  ✓ claude (12.3s)
  ✓ gemini (8.7s)
  ⏳ codex (running 15.2s...)
  ✓ codex (18.1s)
[2/4] Peer review (round 1)...
  ✓ All reviews completed (22.4s)
[3/4] Calculating consensus...
  Consensus: 0.72 (中等)
[4/4] Synthesizing final answer...
```

#### TUI 仪表盘模式

当 `output.tui_mode` 为 `always` 或检测到终端支持时（`auto` 模式），使用全屏 TUI 仪表盘实时展示：

```
┌─────────────────────────────────────────────────────┐
│  Open Council - Debate Mode                         │
│  Question: "Redis vs Memcached 选型..."              │
├─────────────────────────────────────────────────────┤
│                                                     │
│  Phase: [██████████░░░░░░░░░░] 2/4 Review           │
│                                                     │
│  Agents:                                            │
│    [✓ Done  ] claude-opus   (analyst)     12.3s     │
│    [▶ Review] codex-o4mini  (engineer)    ████░░ 67%│
│    [✓ Done  ] gemini-pro    (innovator)   8.7s      │
│                                                     │
│  Consensus: — (pending)                             │
│  Elapsed: 43.2s                                     │
│                                                     │
├─────────────────────────────────────────────────────┤
│  [q] quit  [p] pause  [v] view responses            │
└─────────────────────────────────────────────────────┘
```

**本地模型预热（Warm-up）**: 本地模型（Ollama 等）首次调用时需要将模型权重加载到显存，会产生 10-30s 的冷启动延迟。TUI 通过以下机制优化体验：

1. **预热探针**: Route 阶段确定模型组合后，立即向本地模型发送轻量级 ping（如 Ollama 的 `/api/show`），触发模型权重预加载
2. **Warm-up 状态显示**: TUI 中显示 `[🔥 Warming] ollama-qwen (loading model...)` 状态，让用户理解延迟原因
3. **时间重叠**: 预热与其他云端模型的网络调用并行执行，将冷启动延迟隐藏在正常等待时间内

```
│  Agents:                                            │
│    [🔥 Warm ] ollama-qwen  (analyst)     loading... │
│    [▶ Broad ] claude-opus  (engineer)    ████░░ 67% │
│    [✓ Done  ] gemini-pro   (innovator)   8.7s       │
```

**技术选型建议**: Python `rich` 库（轻量级 TUI），或 Go `bubbletea` / Rust `ratatui`（如果选择编译型语言实现）。

### 6.3 Human-in-the-Loop（`--interactive` 模式）

见 Phase 2.5: Human Gate（第 2.3 节）。

**默认关闭**。启用条件：用户显式传入 `--interactive` 或 `-i` 参数。

**设计决策**: CLI 工具的常见使用场景包括脚本集成和管道操作（如 `council "question" | jq .synthesis`），因此默认必须是非交互、非阻塞的。interactive 模式作为显式提升层，适用于高价值决策场景。

**自动提醒机制**: 在非交互模式下，以下场景自动追加 `-i` 建议提示：
- 极低共识（consensus < 0.2）：`提示: 共识度极低，建议加 -i 参数启用人工干预模式`
- 高风险问题类型检测（关键词命中"安全审计"、"生产部署"、"数据迁移"、"权限变更"等）：`提示: 检测到高风险决策场景，建议加 -i 参数进行人工确认`
- 高风险关键词列表可在 `council.yaml` 的 `general.high_risk_keywords` 中自定义

### 6.4 辩论结束后交互

辩论完成后，提供可选的快捷操作：

```
══════════════════════════════════════════════
  辩论完成 ✓  耗时: 72.3s  共识度: 0.72
══════════════════════════════════════════════

  快速评分 (可选, 按数字键即可):  [1]  [2]  [3]  [4]  [5]
  ──────────────────────────────────────────
  [c] 复制结果    [v] 查看各 Agent 原始回答
  [e] 导出 Markdown  [p] 回放辩论    [enter] 退出

Council > _
```

**追问模式（Council prompt）的启用条件**：仅当 stdout 连接到 TTY（交互式终端）时才进入追问模式。当输出被管道重定向时（如 `council "question" | jq .synthesis`），辩论完成后直接输出结果并退出，不进入追问 prompt，确保脚本/管道场景不被阻塞。也可通过 `--interactive` 显式启用或 `--no-interactive` 显式禁用。

在追问模式下，用户可以：
- **直接输入追问**：基于本轮结论继续深入讨论，系统自动创建子 Session（`parent_session_id` 指向当前 Session）
- **按快捷键**：评分、复制、查看明细等
- **按 Enter 或 Ctrl+D**：退出追问模式

追问会触发一轮全新的完整辩论流程（Route → Broadcast → Synthesis），但 Broadcast 阶段的 prompt 会注入上一轮的综合结论作为背景（见 Phase 1 追问 prompt 结构）。

**追问示例**：

```
Council > 如果我们目前的读写比是 1:10 呢？

[auto] → debate  理由: 基于前置架构讨论的追问 | 预估: ~100s, 3 Agent
[1/4] Broadcasting to 3 agents (follow-up, depth: 1)...
  ...
══════════════════════════════════════════════
  追问辩论完成 ✓  耗时: 98.2s  共识度: 0.81
  (基于上轮 "Redis vs Memcached 选型..." 的追问, 深度: 1)
══════════════════════════════════════════════

Council > _
```

**多轮上下文策略**：
- 每次追问仅携带**直接父 Session** 的 synthesis，不累积整条链（防止深层追问 context 膨胀）
- 如果需要引用更早的结论，用户可以在追问中自行提及
- 追问深度无硬性限制，但 `thread_depth > 5` 时提示用户"讨论链较长，建议整理后开新话题"

### 6.5 辩论回放（Time-Travel Replay）

`council replay {session_id}` 利用持久化的 Session 数据和 Checkpoint，在 TUI 界面中以加速模式回放完整辩论过程，**零 token 消耗**。

**核心价值**：
- **决策溯源**: 向团队展示"我们为什么选择这个架构方案"，重现辩论中的关键分歧和共识形成过程
- **调试分析**: 慢放某个阶段，定位评分异常或质量下降的具体环节
- **演示展示**: 10x 加速回放，直观展示 Council 的多 Agent 协作决策逻辑

**回放界面**：

```
┌─────────────────────────────────────────────────────┐
│  ▶ Replay: 2026-03-25_a1b2c3  [10x speed]          │
│  "Redis vs Memcached 选型..."                        │
├─────────────────────────────────────────────────────┤
│                                                     │
│  ▶ Phase 1: Broadcast                               │
│    claude-opus (analyst):     ████████████ ✓ 12.3s  │
│    gemini-pro  (innovator):   ████████░░░░   8.7s   │
│                                                     │
│  Preview:                                           │
│  ┊ [analyst] Redis 在数据结构丰富度上有绝对优势...    │
│                                                     │
├─────────────────────────────────────────────────────┤
│  [space] 暂停  [←→] 跳转阶段  [1-9] 调速  [q] 退出  │
└─────────────────────────────────────────────────────┘
```

**实现原理**: 读取 Session JSON 中的各阶段时间戳和完整数据，按实际时间比例模拟进度条推进，逐步展示各 Agent 的回答摘要、互评分数和最终综合。

### 6.6 本地 Web 界面（`council serve`）

除 CLI 与 TUI 外，`council serve` 启动一个本地 Web 控制台，在浏览器中发起并观看辩论，降低非终端用户的使用门槛。

**MVP 范围（仅此三项）**：

| 能力 | 说明 |
|------|------|
| **发起辩论** | 表单填写问题 + 选择模式/参与模型/Chairman/反方角色 → 提交 |
| **实时观看** | 多专家流式发言 → 评审 → 共识 → Chairman 综合，逐阶段实时呈现 |
| **历史只读** | 列出过往 Session，点开只读详情（复用既有持久化数据） |

**明确不做**：配置向导（仍走 CLI `council setup`）、编辑/删除会话、鉴权、多用户、远程访问。

**安全边界**：

- 默认仅绑定 `127.0.0.1`（本地环回），不接受外部网络访问；无鉴权、不开 CORS，仅同源。
- 服务端在进程内装配凭证与模型适配器，**凭证绝不经 API 返回**（SEC-02）；`/api/models` 只暴露模型名称与元数据。
- 对所有请求校验 `Host` 头，对状态变更请求额外校验 `Origin`，防御 DNS-rebinding / CSRF。

**与 CLI 的关系**：Web 界面复用同一套辩论编排与持久化（长驻进程持有 SQLite WAL 连接，与 CLI 进程共享全局并发池）；配置仍在 CLI 完成，Web 只做发起 / 观看 / 回看。

---

## 7. CLI 接口设计

### 7.1 核心命令

| 命令 | 说明 |
|------|------|
| `council "question"` | 发起辩论（默认 auto 模式） |
| `council -m debate "q"` | 指定模式: `quick` \| `compare` \| `debate` |
| `council -c gemini "q"` | 指定 Chairman 模型 |
| `council --models a b "q"` | 指定参与模型 |
| `council --role-set code-review "q"` | 显式指定角色 prompt 集（绕过自动路由） |
| `council -j "q"` | JSON 格式输出 |
| `council -i "q"` | 启用 interactive 模式（Human-in-the-Loop） |
| `council --devil-advocate "q"` | 强制启用反方角色 |
| `council --resume` | 恢复上次中断的辩论或接管相同 hash 的任务 |
| `council --force` | 强制开启新辩论，忽略锁文件或查重警告 |
| `council --tag arch "q"` | 给本次辩论打标签 |
| `council --no-store "q"` | 不持久化本次辩论（敏感场景使用，结果仅输出到 stdout） |
| `council --copy "q"` | 结果自动复制到剪贴板 |
| `council rate {id} {1-5}` | 对某次辩论结果评分 |
| `council --follow {session_id} "追问"` | 基于某次辩论结果继续追问（创建子 Session） |
| `council --follow "追问"` | 追问最近一次辩论（默认 follow 最新 Session） |

### 7.2 配置命令

| 命令 | 说明 |
|------|------|
| `council setup` | 进入完整配置向导（分模块引导配置） |
| `council setup --reset` | 重置所有配置，重走首次引导流程 |

### 7.3 模型管理命令

| 命令 | 说明 |
|------|------|
| `council models` | 列出所有配置的模型及其状态（调用模式、凭证状态、熔断状态） |
| `council models check` | 执行全量健康检查 |
| `council models add` | 引导式添加新模型（7 步向导，含模型变体选择） |
| `council models add --quick {binary}` | 快捷添加：自动检测工具并列出可选模型 |
| `council models add --quick {binary} --model {model}` | 直接添加指定工具的指定模型 |
| `council models edit {id}` | 引导式编辑已有模型配置 |
| `council models enable/disable {id}` | 启用/禁用模型 |
| `council models reset {id}` | 重置某个模型的熔断状态 |
| `council models scan` | 重新扫描本地 CLI 工具，发现新安装的模型 |

### 7.4 查询与分析命令


| 命令 | 说明 |
|------|------|
| `council history` | 列出历史辩论记录 |
| `council history --search kw` | 全文搜索历史问题和结论 |
| `council recall "关键词"` | 本地知识检索：搜索历史辩论的共识结论 |
| `council show {id}` | 查看某次辩论的完整过程 |
| `council thread {id}` | 查看某次辩论的完整追问链（从根 Session 到最新追问） |
| `council stats` | 模型表现统计（平均分、响应时间、成功率） |
| `council stats --by-rating` | 按用户满意度统计模型表现 |
| `council prune --before DATE` | 清理旧数据 |
| `council export {id} -o file` | 导出某次辩论为 Markdown/JSON |
| `council replay {id}` | 在 TUI 中回放历史辩论全过程（10x 加速，零 token 消耗） |
| `council replay {id} --speed 5` | 指定回放速度倍率 |
| `council reload` | 重新加载配置文件（无需重启） |
| `council benchmark` | 运行基准测试（见第 9 节） |

### 7.5 Web 界面命令

| 命令 | 说明 |
|------|------|
| `council serve` | 启动本地 Web 控制台（默认端口 3720，仅绑定 `127.0.0.1`；见 §6.6） |
| `council serve --port {n}` | 指定绑定端口（默认 3720） |
| `council serve --no-open` | 启动后不自动打开浏览器 |

---

## 8. 前进保障与异常处理

### 8.1 设计原则：永远向前推进

辩论流水线的核心保障是**永远产出结果，不允许无声卡死**。每个阶段遵循统一的"尝试 → 降级 → 兜底"三级策略：

```
每个 Phase 的执行逻辑:
┌─────────────┐
│  正常执行     │ → 成功 → 进入下一阶段
└──────┬──────┘
       │ 失败
       ▼
┌─────────────┐
│  降级执行     │ → 跳过本阶段 or 用已有数据继续
└──────┬──────┘
       │ 仍然失败
       ▼
┌─────────────┐
│  兜底输出     │ → 输出当前可用的最好结果 + 标注降级原因
└─────────────┘
```

**核心约束**：任何单点失败（单个模型挂了、某个阶段解析出错）都不能阻断整个流水线。只有"所有模型均不可用"才允许 Session 标记为 failed。

### 8.2 分阶段前进保障

| 阶段 | 正常路径 | 降级路径 | 兜底路径 | 触发降级的条件 |
|------|---------|---------|---------|-------------|
| **Route** | 按规则选出 N 个 Agent | 可用模型不足时，同一模型扮演多角色补齐 | 仅 1 个模型可用 → 强制 quick 模式直出 | 可用模型 < prefer 列表长度 |
| **Broadcast** | 所有 Agent 并行回答 | 部分超时/失败 → 用已成功的回答继续（≥ 2 个即可） | 仅 1 个成功 → 跳过 Review/Consensus，直接输出该回答 + 标注"仅单 Agent 回答，未经交叉验证" | Agent 失败数 > 0 |
| **Pre-Synthesis Compression** | Top 保留全文 + 其余摘要 | 摘要调用失败 → 截断原文前 N 字符替代 | 全部摘要失败 → 跳过压缩，直接用原文进 Synthesis（可能触发 context 溢出保护） | 摘要调用超时或失败 |
| **Review** | N×(N-1) 份互评全部完成 | 部分评审解析失败 → 标记 PARSE_ERROR 权重 0，用有效评审继续 | 有效评审 < 2 份 → **跳过 Review + Consensus**，降级为 compare 模式直接进 Synthesis | 解析失败率 > 50% |
| **Consensus** | 计算出 consensus_score | — | 无有效评分数据 → consensus_score = null，Synthesis 阶段不展示共识分析 | 无足够有效评审 |
| **Synthesis** | Chairman 综合输出 | Chairman 失败 → Fallback 到下一个可用模型 | 所有模型均无法综合 → 直接输出 Broadcast 中互评得分最高的回答，标注"综合阶段失败，展示最佳单 Agent 回答" | Chairman + fallback 均失败 |

### 8.3 降级透明化

每次降级都必须在输出中**明确告知用户**，而不是静默降低质量：

```
══════════════════════════════════════════════
  ⚠ 辩论过程中发生降级
══════════════════════════════════════════════

  [!] Broadcast: codex-o4mini 超时 (120s)，使用剩余 2 个 Agent 继续
  [!] Review: 1/3 评审解析失败，已排除无效评审
  共识度基于 2 个有效 Agent 计算，置信度较正常 3 Agent 辩论偏低

══════════════════════════════════════════════
```

**降级标记存入 Session**：`Session.degradation_events: [{phase, reason, impact}]`，供后续 `council show` 和 `council stats` 分析降级频率和原因。

### 8.4 重试策略

不是所有失败都应该降级——某些瞬时错误（网络抖动、rate limit）值得重试：

| 错误类型 | 重试策略 | 最大重试次数 |
|---------|---------|------------|
| 网络超时 | 指数退避重试（2s, 4s, 8s） | 2 次 |
| Rate limit (429) | 等待 `Retry-After` 头指定的时间 | 1 次 |
| 进程崩溃 (exit code ≠ 0) | 不重试，直接标记失败 | 0 |
| JSON 解析失败 | 不重试（回答已拿到，只是格式问题） | 0 |

重试失败后才进入降级路径。重试次数可在 `council.yaml` 中配置：`general.max_retries: 2`。

### 8.5 其他边界情况

| 场景 | 处理策略 |
|------|---------|
| 相似问题已有历史结果 | 通过 `question_hash` 精确匹配 + `question_normalized` 近似匹配，以**候选推荐**形式展示（而非自动复用）。展示匹配到的历史结论摘要、共识度和时间，由用户决定是否采纳。**不自动短路执行**，因为 `question_normalized` 的语义近似匹配存在误判风险（如"Redis 选型"和"Redis 集群部署"可能被误判为相似）。**版本失效校验**: 模型配置或 role_set 变更后标记为 `stale`，提示"历史结论基于旧配置，建议重新辩论" |
| 磁盘空间不足 | 不足 10MB 时警告，不足 1MB 时拒绝写入并提示 `council prune` |
| 多 council 实例并发 | SQLite `resource_slots` 原子事务调度 |
| 评分偏差 | z-score 归一化消除评审者尺度差异 |
| 模型持续不可用 | 熔断机制自动禁用 1 小时 |
| Synthesis 输入超长 | 自动触发 Pre-Synthesis Compression（核心保留 + 外围摘要） |
| Review 阶段身份泄露 | 三层匿名化防护（身份过滤 + 格式归一化 + 顺序随机） |

---

## 9. 效果度量与基准测试

### 9.1 设计目标

多模型辩论的核心假设是"比单模型更可靠"。需要有系统化的方法来验证这一假设并持续优化。

### 9.2 基准测试方案

`council benchmark` 命令使用预定义的标准问题集，对比 council 多模型结果与各单模型结果：

```yaml
# ~/.council/config/benchmark.yaml
questions:
  - id: bench_001
    question: "Redis 和 Memcached 的选型对比"
    category: architecture
    expected_points:       # 预期答案应覆盖的关键点
      - "数据结构丰富度"
      - "持久化支持"
      - "集群方案"
      - "内存管理策略"

  - id: bench_002
    question: "实现一个线程安全的 LRU Cache"
    category: code
    expected_points:
      - "并发控制方案"
      - "时间复杂度分析"
      - "边界条件处理"
    known_traps:                 # 已知易错点，用于错误率评估
      - type: factual_error
        description: "误称 HashMap 是线程安全的"
      - type: critical_omission
        description: "遗漏死锁/饥饿场景分析"
      - type: unsafe_recommendation
        description: "推荐无锁方案但未说明 ABA 问题"
```

**错误标签类型定义**：

| 标签 | 含义 | 严重度 |
|------|------|-------|
| `factual_error` | 事实性错误（错误的 API 用法、错误的算法复杂度等） | 高 |
| `unsafe_recommendation` | 不安全的建议（可能导致安全漏洞、数据丢失等） | 高 |
| `critical_omission` | 关键遗漏（缺少必要的边界条件、风险分析等） | 中 |
| `misleading_claim` | 误导性表述（不完全错误但容易让人做出错误决策） | 中 |

Benchmark 报告中错误率作为独立指标输出：

```
  Error Rate:
    council (debate):  0/3 errors  ████████████ 0%
    claude (solo):     1/3 errors  ████████░░░░ 33%  [factual_error: HashMap 线程安全]
    codex (solo):      1/3 errors  ████████░░░░ 33%  [critical_omission: 死锁分析]

  Error Rate Delta (vs best single):  -33%  ✓ 达标 (code 目标: -20%)
```

**问题集来源**：
- **内置通用集**: 系统自带的 `benchmark.yaml`，覆盖 code/architecture/general 常见场景
- **团队自定义集**: 用户可创建自己的 benchmark 文件，加入团队特定的业务问题：

```bash
council benchmark                          # 运行内置问题集
council benchmark --suite my-team.yaml     # 运行自定义问题集
council benchmark --suite all              # 运行所有已注册问题集
```

**Benchmark 流程 — 四组消融实验**：

为公平评估增益来源（多答案采样 vs peer review vs Chairman 综合），benchmark 对每个问题运行四组对比，而非仅"单模型 quick vs 多模型 debate"：

| 组别 | 配置 | 测量目标 |
|------|------|---------|
| **A. best-single-quick** | 最佳单模型，标准 quick prompt | 基线：单次调用的原始能力 |
| **B. best-single-deep** | 最佳单模型，使用与 debate 相同的精细化 prompt（含结构化输出要求） | 控制变量：排除 prompt 工程带来的增益 |
| **C. compare+synthesis** | 多模型并行 + Chairman 综合（跳过 Review） | 定位增益来源：多答案采样 + 综合的贡献 |
| **D. full-debate** | 完整辩论流程（Broadcast → Review → Consensus → Synthesis） | 完整系统的实际表现 |

**release gate 的基线对比对象是 B 组（best-single-deep）**，而非 A 组，以确保增益确实来自多 Agent 协作而非更好的 prompt。

```
Benchmark Report (2026-03-25)
Suite: default (内置通用集)
═══════════════════════════════════════════════
  Question: Redis vs Memcached 选型 [architecture]

  Coverage (expected_points hit):
    A. claude (quick):           3/4  █████████░░░  75%
    B. claude (deep prompt):     3/4  █████████░░░  75%
    C. council (compare+synth):  4/4  ████████████ 100%
    D. council (full debate):    4/4  ████████████ 100%

  Ablation Analysis:
    B vs A (prompt effect):     +0%   → prompt 工程无额外增益
    C vs B (multi-sampling):    +25%  → 多模型采样+综合贡献显著
    D vs C (peer review):       +0%   → Review 阶段未带来额外覆盖

  Release Gate (D vs B):
    improvement:          +25%   ✓ 达标 (architecture 目标: +20%)

  待人工抽检: 2/8 项 (标记为 [?] 的判定)
═══════════════════════════════════════════════
```

消融分析帮助定位各阶段的真实价值，指导后续优化方向（如果 D vs C 差距不大，说明 Review 阶段的复杂度 ROI 较低）。

**与上次基线对比**（当存在历史 benchmark 记录时）：

```
  vs 上次 (2026-03-18):
    council coverage:  92% → 92% (持平)
    claude solo:       68% → 71% (+3%, 模型可能已更新)
```

### 9.3 用户满意度追踪

- 每次辩论完成后，可选提示用户评分（1-5 分）
- 通过 `council rate {session_id} {score}` 事后评分
- `council stats --by-rating` 按满意度维度分析各模型和模型组合的表现
- 长期积累数据后，可以分析：
  - 哪个模型组合在哪类问题上用户满意度最高
  - consensus_score 与 user_rating 的相关性（验证共识度是否有效）
  - 动态权重系统是否有效提升了路由质量

### 9.4 本地知识检索（Recall）

`council recall "关键词"` 命令利用 SQLite FTS5 索引搜索历史辩论的问题和综合结论，实现知识复用：

```
$ council recall "Redis 选型"

Found 3 related debates:
─────────────────────────────────────────────
1. [2026-03-20] "Redis 和 Memcached 的选型对比"
   共识度: 0.85  评分: ⭐⭐⭐⭐⭐
   结论摘要: 大多数场景推荐 Redis，除非是纯粹的短期 KV 缓存...
   → council show 2026-03-20_a1b2c3

2. [2026-03-15] "Redis Cluster 部署方案"
   共识度: 0.62  评分: ⭐⭐⭐⭐
   结论摘要: 推荐 6 节点起步，使用 hash slot 分片...
   → council show 2026-03-15_d4e5f6
─────────────────────────────────────────────
```

---

## 10. 本地存储与安全

> **设计边界**: 本产品为纯本地工具，所有数据存储在用户 home 目录下（`~/.council/`），不上传任何外部服务。加密存储和分级隐私控制作为 future scope 在需求明确后引入。当前版本通过以下机制提供基础安全保障。

- **文件权限**: 配置文件和 Session JSON 自动设为 `600`（仅所有者可读写）。权限不满足时输出警告提示
- **数据保留**: Session JSON 默认保留 90 天（`storage_security.session_retention_days`），超期自动清理。`council prune --before DATE` 可手动清理
- **`--no-store` 模式**: 当处理敏感问题（如涉及企业代码、凭证、安全审计内容）时，用户可通过 `--no-store` 参数禁止本次辩论的 Session 持久化。该模式下结果仅输出到 stdout，不写入 JSON 文件、不写入 SQLite 索引、不留 checkpoint。辩论结束后无任何本地痕迹
- **input_mode: arg 安全警告**: `arg` 模式会将 prompt 作为命令行参数传入，这意味着 prompt 内容会暴露在进程列表（`ps aux` 可见）和 shell 历史中。系统在使用 `arg` 模式调用时，自动在日志中输出一次性提醒：`⚠ input_mode=arg: prompt 可通过 ps 命令被同机其他用户看到，建议敏感场景使用 stdin/file 模式`。配置引导中 `arg` 选项旁标注此风险
- **进程隔离**: 每个模型调用通过独立的 subprocess 执行，互不影响
- **并发调度**: 通过 SQLite `resource_slots` 表原子事务调度（唯一真源），`locks/` 目录仅作进程存活标记供调试

---

## 11. 实现路线图

### Phase 0: 最小可运行原型（建议 1-2 天）

目标：**验证核心假设** —— 多模型编排的回答质量是否优于单模型

- 硬编码 2 个模型（如 claude + gemini），**优先使用 API 模式**（通过 pi-ai 统一接口调用），CLI 模式作为 fallback
- 仅实现 Broadcast + Synthesis 两阶段，无 review
- 结果直接输出到 stdout，无持久化
- 无异常处理、无中断恢复
- 手动对比 council 输出与单模型输出，收集初步反馈

### Phase 1: MVP + 引导式配置（建议 3-5 天）

- **首次运行引导**: First-Run Wizard（5 步：扫描工具+凭证 → 选择模型+调用模式 → 验证 → 选 Chairman → 选模式）
- **双模调用适配**: CLI 模式（subprocess）+ API 模式（通过 pi-ai 统一接口），`invocation: auto` 自动选择
- **鉴权统一**: 凭证发现、Token 刷新、OAuth 登录全部委托给 `@mariozechner/pi-ai`，Council 不自行实现鉴权逻辑
- **模型发现**: 通过 pi-ai 的 `getProviders()` / `getModels()` 动态发现可用模型，支持 20+ Provider
- **预设库**: CLI 模式内置 claude/codex/gemini 预设；API 模式由 pi-ai 自动管理
- **配置加载**: YAML 读取、模型注册、L1 健康检查（CLI: binary 存在检查；API: 凭证有效性检查）
- **基础编排**: Broadcast + Synthesis 两阶段（跳过 review）
- **基础持久化**: Session JSON 写入、目录初始化
- **CLI 基础命令**: `council "question"` 和 `council models`
- **基础 UX**: 阶段切换时的状态行输出

### Phase 2: 完整辩论流程（建议 3-5 天）

- **Peer Review 阶段**: 匿名化三层防护（身份过滤 + 格式归一化 + 顺序随机）、JSON 解析、评分提取、z-score 归一化
- **Consensus 评分**: 标准差计算、Kendall's W 排名一致性、共识度公式、分维度分歧分析
- **Checkpoint**: 中断恢复、SIGINT 捕获、`--resume` 命令
- **SQLite 索引**: 建表、写入、基础查询
- **反方角色**: Devil's Advocate 机制

### Phase 3: 效果验证与基准测试（建议 3-5 天）

> **优先级说明**: Benchmark 是 release gate，必须在投入高级 UX 之前验证核心假设（"多 Agent 确实比单模型好"）。如果验证失败，后续所有 UX 工作都缺乏基础。

- `council benchmark` 基准测试命令（含四组消融实验：best-single-quick / best-single-deep / compare+synthesis / full-debate）
- `council rate` 用户满意度追踪
- `council recall` 本地知识检索（候选推荐模式，非自动复用）
- `council stats` 模型表现统计
- Release gate 验证：覆盖率提升、错误率下降、统计显著性检验

### Phase 4: 智能路由与完整配置向导（建议 3-5 天）

- **`council setup` 完整向导**: 分模块配置（模型/辩论/路由/输出/高级）
- **`council models add` 引导**: 7 步添加向导（含模型选择）+ `--quick` 快捷模式
- 路由规则引擎、能力匹配、角色自动分配
- `council history`、`council export` 等管理命令
- L2+L3 健康检查、熔断机制、失败记忆
- 相似问题查重（精确 + 近似）、历史候选推荐
- **动态权重 shadow mode**: 收集数据但不影响真实路由，用户确认后切换为真实生效
- **动态权重 + Epsilon-Greedy**: shadow mode 验证后启用，基于历史表现自动调整路由

### Phase 5: 高级 UX 与优化（建议 3-5 天）

- **TUI 仪表盘**: 实时进度展示 + 本地模型 Warm-up 预热机制
- **Human-in-the-Loop**: `--interactive` 模式、冲突摘要视图、Human Gate 交互界面
- **Pre-Synthesis Compression**: "核心保留 + 外围摘要" 策略
- **辩论回放**: `council replay` 命令，TUI 中加速重现历史辩论
- **`--copy`、辩论结束后快捷操作** 等 UX 优化
- `council stats --by-rating` 满意度维度分析
- 全局资源池、SQLite 原子调度
