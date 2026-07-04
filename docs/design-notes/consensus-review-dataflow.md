# 设计笔记：共识判停 / 评审回灌 / 自评剔除 / 截断标记

| 项目 | Open Council |
|------|-------------|
| 作者 | @architect |
| 日期 | 2026-07-04 |
| 状态 | 设计定稿，待实施 |
| 文档优先级 | CONTRIBUTING > TDD > PRD |
| 约束 | ARCH-01（core 无 I/O）、ARCH-04（types 零运行时）、ARCH-05（接口交互）、TS-01~06 |

本笔记覆盖四个工作项的接口 / 数据流设计。四项之间存在耦合：**#2 回灌、#3 自评剔除共享 `ParsedReview` 与 label 解析链路**，因此其数据模型统一设计，避免二次改接口。

---

## 全局设计基线：统一"label → 全局身份"解析

当前代码在 3 处独立地把匿名 label 映射回 agent：`executeConsensus`（按 label 分组）、`executePreSynthesisCompression`（`aggregateReviewScores` 用 `labelToAgentId`）、`live/plain/tui` 渲染。#3 自评剔除会让**每个 reviewer 的 label 集不同**，全局单一 `label_map` 失效。

**基线决策**：`ParsedReview` 增加已解析的全局身份字段 `reviewed_agent_id`，**所有按回答聚合的统计一律以 `reviewed_agent_id` 为键**，不再以 `label` 为键。在全集（不剔除）场景下 label↔agentId 是双射，按 agentId 分组与按 label 分组等价，因此该基线对现有路径**行为不变**、对 #3 是自然扩展。

label→agentId 的解析由 orchestrator（可访问 stage.label_map / reviewer_label_maps）在 `parseReviewResponse` 之后立即完成，core 的纯统计函数只消费已解析好的 `reviewed_agent_id`。这符合 ARCH-05：解析归属是编排职责，统计是纯逻辑。

---

## 工作项 #1：共识判停失效

### 问题定位

`consensus.ts:49`：`consensus_score = rawAgreement × rho × delta`，其中 `delta = D/A`（单供应商再 ×0.7）。`orchestrator.ts:96` 用 `consensus_score >= 0.6` 判停。

- 单模型多角色（Phase 0 默认场景，只装一个 CLI）：D=1、A=3 → `delta = (1/3)×0.7 = 0.233`。即使评审完全一致（rawAgreement=1、rho=1），`score = 0.233 < 0.6`，**数学上永远无法判停**。
- 多供应商但未满员：3 agent 2 供应商 → delta=0.667；只有 3 供应商 3 agent（delta=1）才可能过阈。

根因：`delta` 是**可信度折减因子**（衡量"这些评审者是否独立"），却被塞进了**判停分数**（应衡量"这些评审者是否达成一致"）。两者语义正交，不应相乘后再判停。

### 设计：把 delta 从判停分数中剥离

`delta`（`model_diversity_factor`）**已经**是独立字段。真正缺失的是一个"不含 delta 的一致性分数"作为判停依据。现有 `raw_agreement` 字段（= `rawAgreement × rho`）在数值上正是所需量，但命名（"raw"）语义模糊，不宜直接承载判停语义。

**新增语义清晰的 canonical 字段 `agreement_score`，`raw_agreement` 保留为其别名以兼容持久化/渲染/export。**

```typescript
// src/types/session.ts —— ConsensusResult（增量、非破坏）
export interface ConsensusResult {
  /** 评审者之间的一致性（0-1），与供应商多样性无关。★判停依据★ = rawAgreement × rho。 */
  agreement_score: number;                 // NEW（canonical）

  /** 可信度折减后的对外共识分 = agreement_score × model_diversity_factor。用于展示/查询/DB 列。 */
  consensus_score: number;                 // 语义不变（仍含 delta 折减）

  /** 模型多样性可信度因子 δ（0-1），独立的可靠性限定符。 */
  model_diversity_factor: number;          // 不变

  dimension_scores: Record<string, { score: number; divergence: number }>;

  /** @deprecated agreement_score 的别名，读旧数据用。数值恒等于 agreement_score。 */
  raw_agreement: number;                   // 不变（= agreement_score）
}
```

### 判停语义

| 用途 | 用什么分数 | 比什么阈值 |
|------|-----------|-----------|
| **cross-examine 判停**（orchestrator.ts:96） | `agreement_score` | `AGREEMENT_STOP_THRESHOLD = 0.6` |
| 对外展示 / DB / 相似辩论复用 | `consensus_score`（含 delta） | 各调用点现有阈值不变 |

`consensus_score` 语义保持不变（仍含 delta），因为 PRD §228 明确要求"单模型多角色的 consensus_score 被 model_diversity_factor 自动折减"——这是对外**展示**的可信度叙事，不能推翻。判停用 `agreement_score`，展示用 `consensus_score`，两条语义分离后即解决 bug 且不违反 PRD。

阈值 0.6 迁移到 `agreement_score` 上仍合理：`rawAgreement = 0.5(1−σ/4.5) + 0.5W`，高度一致时 ~0.8–1.0，显著分歧时 ~0.3–0.5，0.6 是"中等一致"的合理切点。

### 函数签名变更清单

- `consensus.ts::calculateConsensus`：return 对象增加 `agreement_score: rawAgreement * rho`（`raw_agreement` 保持同值）。**非破坏**。
- `orchestrator.ts` 常量 `CONSENSUS_THRESHOLD` → 重命名 `AGREEMENT_STOP_THRESHOLD`（值 0.6）；`runDebateLoop` 第 96 行判定改为 `consensus.agreement_score >= AGREEMENT_STOP_THRESHOLD`。第 99–102 行降级提示文案改为展示 `agreement_score`。

### 数据流（文字版）

```
review invocations → parseReviewResponse → 解析 reviewed_agent_id
  → calculateConsensus → { agreement_score, consensus_score(=agr×δ), δ, ... }
      ├─(判停)→ orchestrator 比较 agreement_score ≥ 0.6 → 停/续 cross-examine
      └─(展示)→ renderer.onConsensus 用 consensus_score 画条、δ 触发低多样性警告
```

### 迁移 / 兼容

- **Session JSON**：`consensus` 对象新增 `agreement_score`。旧文件缺该字段，读取方按 `agreement_score ?? raw_agreement ?? 0` 回退。
- **DB**：`sessions.consensus_score` 列语义不变，**不新增列**（判停分是 JSON 内瞬态量，无需索引）——守 Phase 纪律。
- **渲染**：`plain/live/tui/Dashboard` 均只读 `consensus_score` + `model_diversity_factor`，语义未变 → **零改动**。可选：调试视图加显 `agreement_score`（非必需）。
- **export.ts**：读 `raw_agreement`（别名仍在）→ 不破。

### 取舍

- 选 **新增 canonical 字段 + 保留别名**：判停语义在类型层面自解释，未来维护者不会误用；纯增量、无破坏、无 DB 迁移。
- 放弃 **"只改 orchestrator 第 96 行用 raw_agreement、不动类型"**（最小改动）：改动更小但把判停语义压在名为 "raw" 的字段上，语义晦涩，易被后续误改。作为 fallback 方案备选。
- 放弃 **让 consensus_score 不含 delta**：会与 PRD §228 的展示叙事冲突，且波及全部渲染/export/DB 语义，破坏面大。

### 与 TDD 冲突点

- TDD §4.4 `ConsensusResult` 无 `agreement_score` → **建议 TDD 修订**：补该字段及"判停用 agreement_score、展示用 consensus_score"说明。
- TDD §4.4 `calculateConsensus` 只 `filter(r.status === 'valid')`，实现同时纳入 `'partial'`（consensus.ts:15）。此为既有偏离，**建议 TDD 修订**为 `valid || partial`（PRD §347 只要求排除 PARSE_ERROR，partial 有有效 overall 分，纳入合理）。

---

## 工作项 #2：评审信息回灌

### 目标

`ParsedReview.strengths/weaknesses` 已解析但从未使用；`devil_advocate_notes`（PRD §543、prompt-builder.ts:141 要求 DA 输出）**从未被解析、也无字段**。需把三者按回答聚合后回灌到 `buildCrossExaminePrompt`（让 agent 看到"别人对我的批评"）与 `buildSynthesisPrompt`（让 Chairman 参考互评权重）。

### 数据结构

```typescript
// src/core/score-parser.ts —— ParsedReview 增量
export interface ParsedReview {
  label: string;
  scores: ReviewScore;
  strengths: string;
  weaknesses: string;
  ranking: number;
  status: 'valid' | 'partial' | 'parse_error';
  reviewer_agent_id?: string;
  /** DA 评审者列出的关键风险（PRD §543）。非 DA 评审为空串。 */
  devil_advocate_notes?: string;        // NEW
  /** 被评回答的全局身份，由 orchestrator 经 label_map 解析后回填（见全局基线）。 */
  reviewed_agent_id?: string;           // NEW（#2/#3 共用）
}
```

```typescript
// src/core/review-aggregator.ts（新建，纯逻辑，ARCH-01）
/** 针对单个回答，聚合所有评审者对它的评价。 */
export interface AnswerReviewSummary {
  reviewed_agent_id: string;
  role: string;                    // 已解析角色名（cross-examine/synthesis 非匿名，可用）
  avg_overall: number;
  strengths: string[];             // 汇总各评审者的优点（去空）
  weaknesses: string[];            // 汇总各评审者的不足
  devil_advocate_notes: string[];  // 汇总 DA 风险点
  reviewer_count: number;          // 有效评审席位数
}

export function buildReviewSummaries(
  reviews: readonly ParsedReview[],
  agentIdToRole: ReadonlyMap<string, string>,
): Map<string, AnswerReviewSummary>;   // key = reviewed_agent_id
```

### 匿名 → 角色的还原时机与匿名性

关键区分两种匿名性：
- **评审评分的作者匿名**（消除位置/身份偏见）——必须保护。
- **被评回答的作者身份**——在 cross-examine / synthesis 阶段**本就已公开**（`buildCrossExaminePrompt` 现在就带 `otherResponses[].role`，Chairman 也按 role 看回答）。

因此回灌批评时：把"对某回答的批评"归到**被批评的回答（按 role）**上，而**不透露是哪位评审者说的**（聚合呈现，去具名）。这既不破坏评分作者匿名，又能让被批评者看到内容。

**还原时机**：在 orchestrator 的 `executeCrossExamine` / `executeSynthesis` 构造 prompt 前，用**最新 review stage 的 label_map（或 #3 的 reviewer_label_maps）** 把每条 review 的 label 解析成 `reviewed_agent_id` → 再经 `session.agents` 得到 role → 调 `buildReviewSummaries`。core 纯函数只收已解析结果。

### 呈现策略（cross-examine "别人对你的批评"）

- **对本人回答**：完整呈现聚合后的 weaknesses + devil_advocate_notes，措辞为"同行评审对你回答的评价"，不点名评审者。让 agent 有据可辩/可改。
- **对他人回答**：仅附一行 `avg_overall` + 首要 weakness，避免过度引导（防止评审噪声主导二次辩论）。

### 函数签名变更清单

```typescript
// prompt-builder.ts —— 均为可选参数，未传时行为与现状一致（软兼容）
buildCrossExaminePrompt(
  question: string,
  role: string,
  ownResponse: string,
  otherResponses: Array<{ role: string; response: string; reviewSummary?: AnswerReviewSummary }>, // CHANGED
  divergencePoints: string[],
  roundNumber: number,
  ownReviewSummary?: AnswerReviewSummary,   // NEW（本人回答收到的批评）
): string

buildSynthesisPrompt(
  question: string,
  responses: Array<{ role: string; modelName: string; response: string; reviewSummary?: AnswerReviewSummary }>, // CHANGED
): string
```

- `score-parser.ts::tryJsonParse`：解析 `devil_advocate_notes`（JSON 中读 `r['devil_advocate_notes']`，缺省空串）；`tryRegexParse` / fallback 置空串。
- `orchestrator.ts::executeCrossExamine`（~L358-374）与 `executeSynthesis`（~L414-457）：构造 `reviewSummary` / `ownReviewSummary` 传入；新增私有 helper 复用解析链路。

### 数据流（文字版）

```
review invocations ─ parse ─→ ParsedReview[]{strengths,weaknesses,DA_notes,label}
     │  orchestrator: label ─(label_map)→ reviewed_agent_id ─(agents)→ role
     ▼
buildReviewSummaries → Map<agentId, AnswerReviewSummary>
     ├─→ executeCrossExamine: ownReviewSummary(本人) + otherResponses[].reviewSummary
     │        → buildCrossExaminePrompt → agent 修订回答
     └─→ executeSynthesis: responses[].reviewSummary
              → buildSynthesisPrompt → Chairman 加权综合
```

### 迁移 / 兼容

- prompt-builder 新参数全为可选，旧调用点/测试不传即退化为现状。**非破坏**。
- `ParsedReview` 两个新字段可选，`Invocation.result` 不变；review 的解析结果不单独持久化到 JSON（现状即如此，从 `response_raw` 重解析），故**无 JSON schema 变更**。

### 与 TDD/PRD 冲突点

- TDD §3.4.3 把 `devil_advocate_notes` / `parsed_scores` 列为 **Invocation** 字段；实现中它们是 `ParsedReview`（从 `response_raw` 重解析、不落库到 Invocation）。**建议 TDD 修订**：注明 review 解析结果为运行期派生结构（`ParsedReview`），Invocation 仅存 `response_raw`。
- PRD §334-336 review JSON 的 `overall` 在 `scores` 同级外层，而 prompt-builder.ts:99 把 `overall` 放进 `scores` 内。既有实现偏离，**建议 doc 同步**（本项不改行为，仅标注）。

---

## 工作项 #3：自评剔除

### 目标

`executeReview`（orchestrator.ts:472-568）当前每个 reviewer 评审**含自己回答的全集**。需剔除自评。

### 方案对比与选定

| 方案 | 说明 | 结论 |
|------|------|------|
| A. per-reviewer 子集 | 每个 reviewer 拿到**不含自己回答**的匿名子集 | ✅ **选定** |
| B. 全集 + 跳过指示 | 全集给出、prompt 指示"跳过你自己那条" | ❌ 否决 |

**否决 B 的硬理由**：匿名化的目的就是让模型无法识别哪条是自己的（`Anonymizer` 去身份 + shuffle）。既然模型无法识别自己，"跳过自己"这条指令**在匿名前提下不可执行**；要执行就得告诉它"C 是你写的"，直接破坏匿名。B 与匿名化自相矛盾。

**选定 A**：为每个 reviewer 单独取"除自己外的有效回答"，用独立 `Anonymizer` 实例 shuffle + 打标签（A、B、C…）。每个 reviewer 的 label 集是**局部**的。

### label 分配与持久化

per-reviewer 局部 label 意味着 label "A" 对不同 reviewer 指向不同回答，单一 `stage.label_map` 不再够用。

```typescript
// src/types/session.ts —— Stage 增量
export interface Stage {
  // ... 现有字段 ...
  /** 全集匿名映射：label → agent_id。全集 review 阶段用；#3 下保留兼容。 */
  label_map?: Record<string, string>;
  /** per-reviewer 匿名映射：reviewerAgentId → (label → 被评 agent_id)。#3 自评剔除用。 */
  reviewer_label_maps?: Record<string, Record<string, string>>;   // NEW
}
```

### consensus 按 label 聚合的修正

见全局基线：orchestrator 解析每条 review 时，用**该 reviewer 自己的 label 映射**解析 `reviewed_agent_id`，写入 `ParsedReview.reviewed_agent_id`。`consensus.ts` 的 `groupScoresByAnswer` / `groupScoresByDimension` / `kendallsW` 全部**改按 `reviewed_agent_id` 分组**（不再按 `label`）。全集路径下等价，自评剔除路径下正确。

### Kendall's W 的统计困难与取舍

自评剔除后形成**不完全区组设计**：每个回答 i 恰好缺失 1 位评审者的排名（即作者本人）。标准 W 公式 `W = 12S / (k²(n³−n))` 假设每位 rater 对**同一组 n 个 item** 完整排名，此处不成立。

**取舍（选定：均值秩填补）**

对缺失项按该 rater 的**平均秩 (n+1)/2** 填补，再套用现有 `kendallsW`。理由：
- 本设计是**平衡**的不完全区组——每个 item 恰好被填补 1 次（缺其作者），填补对所有 item **对称**，不改变相对一致性结构，只均匀轻微压低 W 幅度。
- 幅度压低方向是**保守**的（宁可低估一致性、多辩一轮，也不虚高共识而误停）——符合判停应偏保守的原则。
- 改动极小（`kendallsW` 里对缺失 label 填 `(n+1)/2` 而非 0）。

**备选（未选）：成对秩相关平均**——对每对 rater 在其"共同评过的 item"上算 Spearman ρ（映射到 (ρ+1)/2）再平均。统计上对不完全设计最干净，但代码量更大、且小 N 下共同子集可能过小。列为后续精化路径。

**否决"缺失项填 0 秩"**：会把作者回答的 rankSum 系统性拉高/拉低（取决于方向），非对称，偏置 W。

### N=2 边界

自评剔除后每个 reviewer 只剩 1 条可评 → 每个回答仅 1 个评分、每个 rater 只排 1 项：σ per-answer 无法计算（<2 样本→0）、W 无法排名。共识退化。

**决策**：**自评剔除仅在 N ≥ 3 时生效**；N=2 时回退全集 review（保留自评）。`executeReview` 依据有效回答数分支。此边界须写入实现与测试。

### compression 的 aggregateReviewScores 修正

`executePreSynthesisCompression`（L654-665）当前用单一 `labelToAgentId` 把 review 聚合到 agentId。per-reviewer 映射下失效。

**做法**：orchestrator 在解析 review 时已回填 `reviewed_agent_id`（全局基线）；`aggregateReviewScores` 改为**优先读 `review.reviewed_agent_id`**，`labelToAgentId` 降为可选 fallback（兼容旧数据/全集路径）。

```typescript
// compression.ts —— 签名调整（向后兼容）
export function aggregateReviewScores(
  reviews: readonly ParsedReview[],
  labelToAgentId?: ReadonlyMap<string, string>,   // 由必填改为可选 fallback
): Map<string, number>;
// 内部：const agentId = review.reviewed_agent_id ?? labelToAgentId?.get(review.label);
```

### 函数签名变更清单

- `orchestrator.ts::executeReview`：per-reviewer 匿名子集（N≥3 剔除自评，N=2 全集）；填 `stage.reviewer_label_maps`；解析后回填 `reviewed_agent_id`。
- `orchestrator.ts::executeConsensus`：改用 `reviewer_label_maps` 解析 `reviewed_agent_id`；`expectedLabels` 计算改为 per-reviewer。
- `orchestrator.ts::executePreSynthesisCompression`：同上解析 `reviewed_agent_id` 后调 `aggregateReviewScores`。
- `consensus.ts`：`groupScoresByAnswer` / `groupScoresByDimension` / `kendallsW` 分组键 label→`reviewed_agent_id`；`kendallsW` 加均值秩填补缺失项。
- `compression.ts::aggregateReviewScores`：`labelToAgentId` 改可选、优先用 `reviewed_agent_id`。

### 数据流（文字版）

```
executeReview:
  for each reviewer R (N≥3):
     subset = validInvocations \ {R 自己}
     anon_R = Anonymizer().anonymize(subset)         # 局部标签 A,B,...
     reviewer_label_maps[R.id] = deanonymize(anon_R) # label→被评 agentId
     invoke(R, buildReviewPrompt(anon_R))            # DA 用 DA 变体
  ↓
executeConsensus / preSynthesisCompression:
  parseReviewResponse(raw, R 的 expectedLabels)
     → 每条 review: label ─(reviewer_label_maps[R])→ reviewed_agent_id
  ↓
consensus 按 reviewed_agent_id 分组；kendallsW 缺失项填 (n+1)/2
aggregateReviewScores 按 reviewed_agent_id 汇总
```

### 迁移 / 兼容

- `Stage.reviewer_label_maps` 可选新增；旧 session JSON 无此字段，重放/压缩回退到 `label_map` 或顺序映射（现有 fallback 已在 L648-651）。
- `ParsedReview.reviewed_agent_id` 可选；未回填时统计函数回退按 label 分组（保留旧行为分支）。
- **非破坏**，但 consensus 数值在自评剔除生效后会变化（这是预期的行为修正，测试基线需更新）。

### 与 TDD 冲突点

- TDD §3.4.2 Stage 无 `reviewer_label_maps` → **建议 TDD 修订**补该字段及 per-reviewer 匿名说明。
- TDD §4.4 `kendallsW` 按完全设计描述 → **建议 TDD 修订**：注明自评剔除下采用均值秩填补的平衡不完全设计处理，并说明 N=2 回退全集。
- PRD §178 "输出 N×(N−1) 份评审"——自评剔除后正好是 N×(N−1)（每人评 N−1 份），实现与 PRD **一致**（当前全集是 N×N，反而偏离 PRD）。本项使实现向 PRD 收敛，无冲突。

---

## 工作项 #4：截断标记

### 目标

`InvocationResult` 增加 `truncated` 字段，明确 orchestrator 对截断回答的处理语义，及 Session JSON 影响。

### 类型定义

```typescript
// src/types/provider.ts —— InvocationResult 增量
export interface InvocationResult {
  // ... 现有字段 ...
  /** 回答因达到 max_tokens/长度上限被截断（内容仍部分可用，区别于 timed_out）。 */
  truncated?: boolean;   // NEW（可选，缺省 undefined ≡ false）
}
```

`truncated` 与 `timed_out` **语义正交**：timed_out = 调用未在时限内完成（可能无内容）；truncated = 有实质内容但被长度上限切断。由 provider 适配层根据 finish_reason（API：`length`/`max_tokens`；CLI：输出被截信号）置位。

### 处理语义（选定：进入辩论但标注）

| 选项 | 结论 |
|------|------|
| **进入辩论 + 标注** | ✅ 选定 |
| 剔除 | ❌ 截断回答仍含大量有效内容，丢弃损失信号 |
| 重试 | ❌ 翻倍成本且可能再次截断；重试属更后 Phase，违反 Phase 纪律 |

**选定"进入辩论但标注"**：
1. 截断回答照常参与 review / consensus / synthesis（它是一个有效回答，`response_raw` 非空即视为有效——现有 `!timed_out && response_raw` 过滤逻辑天然接纳它）。
2. orchestrator 在 broadcast/cross-examine 收到 `result.truncated` 时发一条 `renderer.onDegradation`（可见性），**不阻断、不剔除、不重试**。
3. 可选：synthesis prompt 对被截断回答附注 "[note: 此回答因长度上限被截断，可能不完整]"，供 Chairman 判断。（最小实现可省，留 TODO。）

### 数据流与持久化

`Invocation.result` 已整体持久化到 Session JSON，`truncated` 随 `result` 自动落盘，**无需新增 `Invocation` 顶层字段**。渲染层如需展示截断角标，读 `invocation.result.truncated`。

### 函数签名变更清单

- `provider.ts::InvocationResult`：加可选 `truncated`。
- 各 provider 适配器（`src/providers/`，非本 core 审查范围，交 @provider-dev）：invoke 返回时按 finish_reason 置 `truncated`。
- `orchestrator.ts::executeBroadcast` / `executeCrossExamine`：`result.truncated` 时 `onDegradation`；`toInvocation` 无需改（result 原样带入）。
- 可选 `buildSynthesisPrompt`：入参项加 `truncated?: boolean` 以生成附注（与 #2 的 responses 结构改造合并进行）。

### 迁移 / 兼容

- `InvocationResult.truncated` 可选，旧 JSON 缺省 `undefined ≡ false`。**非破坏、无 DB 迁移**（result 存于 session JSON blob，无独立列）。

### 与 TDD 冲突点

- TDD §3.4.3 Invocation 字段表无 `truncated`（仅有 `timed_out`）→ **建议 TDD 修订**：补 `truncated | bool | 回答因长度上限被截断（区别于 timed_out）`。

---

## 汇总：改动影响面与破坏性

| 工作项 | 类型改动 | 破坏性 | 需迁移 | 波及 src 目录 |
|--------|---------|--------|--------|--------------|
| #1 判停 | `ConsensusResult += agreement_score` | 非破坏（增量+别名） | 读时 fallback | core, (types) |
| #2 回灌 | `ParsedReview += devil_advocate_notes, reviewed_agent_id`；prompt-builder 加可选参 | 非破坏（可选参） | 无 | core |
| #3 自评剔除 | `Stage += reviewer_label_maps`；consensus 分组键改 agentId | 非破坏（行为变，数值变） | 读时 fallback | core, (types) |
| #4 截断 | `InvocationResult += truncated` | 非破坏 | 无 | types, providers, core |

**接口契约（`InvocationAdapter`/`Renderer`/`SessionStore`/`ConfigLoader`）签名均不变**——仅其载荷类型（`InvocationResult`/`ConsensusResult`）做增量扩展。`Renderer.onConsensus` 参数类型 `ConsensusResult` 增字段属向后兼容扩展，无需改实现方。

## 需提交给 doc-keeper 的 TDD 修订建议（汇总）

1. §4.4 `ConsensusResult` 增 `agreement_score`；`calculateConsensus` filter 改 `valid || partial`；说明判停用 agreement_score、展示用 consensus_score。
2. §4.4 `kendallsW` 注明自评剔除下的均值秩填补 + N=2 回退。
3. §3.4.2 Stage 增 `reviewer_label_maps`。
4. §3.4.3 Invocation 增 `truncated`；注明 review 解析结果（`ParsedReview`）为运行期派生、非落库 Invocation 字段。
5. review JSON schema 中 `overall` 位置（scores 内 vs 外）与实现对齐。

## 实施顺序建议（供 @pm 排期）

1. **先做全局基线**（`ParsedReview.reviewed_agent_id` + orchestrator 解析回填）——#2/#3 共同依赖，单独成一个前置工作项。
2. #1 与 #4 互相独立，可并行。
3. #2 依赖基线；#3 依赖基线 + 修改 consensus 分组（#1 若同时改 consensus.ts return，需串行或约定同一 dev 处理 consensus.ts 以免冲突）。
4. **建议 #1 与 #3 由同一 @core-dev 串行处理 `consensus.ts`**（两者都改该文件，避免并行写冲突）。
