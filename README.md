# Local AI Council

**本地多模型辩论编排系统** — 让多个 AI 模型围绕同一问题辩论、互评、达成共识，产出比单模型更可靠的答案。

```
$ council "Redis vs Memcached，电商场景日均 5000 万 PV 该怎么选？"

[auto] → debate  理由: 检测到架构决策关键词 | 预估: ~120s, 3 Agent
[1/4] Broadcasting to 3 agents...
  ✓ claude-opus   (analyst)    12.3s [API]
  ✓ openai-o4mini (engineer)    9.1s [API]
  ✓ gemini-pro    (innovator)   8.7s [API]
[2/4] Peer review...
  ✓ All reviews completed (22.4s)
[3/4] Calculating consensus...
  共识度: 0.82 ████████████████░░░░ (高)
[4/4] Synthesizing final answer...

### 结论摘要
大多数场景推荐 Redis。Memcached 仅在纯 KV 短期缓存且需要极致内存效率时考虑...

### 核心论据
1. [analyst] Redis 数据结构丰富度在电商场景有决定性优势...
2. [engineer] 持久化能力意味着缓存预热成本显著降低...
3. [innovator] 考虑 Redis Stack 的搜索和 JSON 模块可减少组件数...

### 风险与局限
- 热点 key 需单独处理（如 local cache + Redis 两级缓存）
- Redis Cluster 在跨机房场景需评估网络分区策略

### 置信度
高 — 三位专家高度一致，分歧仅在缓存策略细节
```

## 它解决什么问题

单个 AI 模型回答问题时可能存在幻觉、偏见或深度不足。Council 通过编排多个模型辩论来缓解这些问题：

- **多视角覆盖**: 不同角色（分析师、工程师、创新者）从不同维度审视问题
- **交叉验证**: 互评阶段模型间互相检查，过滤低质量回答
- **量化置信度**: `consensus_score` 告诉你模型间的一致程度，低共识时不强行输出结论
- **可追溯**: 每次辩论的完整过程（原始回答、互评、评分）持久化到本地，随时回溯

**适用场景**: 架构决策、代码审查、安全审计、技术选型 — 值得多花一分钟确认的高价值问题。

## 核心特性

- **零额外成本**: 复用已有订阅额度（Claude Max、OpenAI Pro、Google AI），不需要单独的 API Key
- **双模调用**: CLI 模式（subprocess 调用已安装工具）+ API 模式（直接读取本地 OAuth 凭证调用 SDK）
- **本地凭证自动发现**: 自动检测 `~/.codex/auth.json`、`~/.gemini/oauth_creds.json` 等已有凭证，零额外登录
- **纯本地**: 所有数据存储在 `~/.council/`，不上传任何外部服务
- **管道友好**: `council "question" | jq .synthesis` — stdout 只输出结果，进度信息走 stderr

## 安装

```bash
npm install -g @anthropic-ai/council
```

前提条件：
- Node.js ≥ 20
- 至少安装并登录一个 AI CLI 工具（claude-code、codex-cli、gemini-cli），或拥有对应的 API Key

## 快速开始

```bash
# 首次运行自动进入配置向导（扫描本地工具和凭证，约 2 分钟）
council "你的问题"

# 指定辩论模式
council -m debate "Redis vs Memcached 怎么选？"
council -m compare "这段代码有什么潜在问题？"
council -m quick "Python list 和 tuple 的区别"

# 指定 Chairman（负责最终综合的模型）
council -c gemini-pro "技术选型建议"

# JSON 输出（管道友好）
council -j "问题" | jq .synthesis

# 交互式人工干预（审阅互评后可剔除低质量回答）
council -i "生产环境数据库迁移方案"

# 不持久化（敏感场景）
council --no-store "审查这段包含凭证的代码"

# 追问（基于上一轮结论继续）
council --follow "如果读写比变成 1:10 呢？"
```

## 辩论模式

| 模式 | Agent 数 | 流程 | 耗时 | 适用场景 |
|------|---------|------|------|---------|
| `quick` | 1 | 直接回答 | 10-30s | 简单问题 |
| `compare` | 2-3 | 并行回答 → 综合 | 30-60s | 多角度对比 |
| `debate` | 2-5 | 并行回答 → 互评 → 共识 → 综合 | 60-180s | 高价值决策 |
| `auto` | 自动 | 根据问题复杂度选择 | 视情况 | 默认模式 |

## 模型管理

```bash
# 查看已配置的模型及状态
council models

# 添加新模型（引导式）
council models add

# 快捷添加
council models add --quick codex --model o3

# 健康检查
council models check

# 重新扫描本地工具
council models scan
```

## 历史与分析

```bash
# 查看历史辩论
council history

# 搜索历史结论
council recall "Redis 选型"

# 查看辩论详情
council show 2026-03-25_a1b2c3

# 模型表现统计
council stats

# 为某次辩论评分
council rate 2026-03-25_a1b2c3 5

# 导出为 Markdown
council export 2026-03-25_a1b2c3 -o report.md

# 运行基准测试（验证多模型 vs 单模型效果）
council benchmark
```

## 配置

```bash
# 完整配置向导
council setup

# 配置文件位置
~/.council/config/council.yaml          # 主配置
~/.council/config/models/*.yaml         # 模型配置（每个模型一个文件）
~/.council/config/roles/*.yaml          # 角色 prompt 模板
```

模型配置示例（API 模式，复用 Codex CLI 凭证）：

```yaml
name: OpenAI o4-mini
invocation: api
provider: openai
model: o4-mini
api_credential_path: ~/.codex/auth.json
capabilities: [code, debug, refactor, general]
priority: 50
max_concurrent: 3
```

## 技术栈

TypeScript · Node.js ≥ 20 · better-sqlite3 · @anthropic-ai/sdk · openai · @google/genai · commander · ink · zod

## 项目文档

| 文档 | 说明 |
|------|------|
| [PRD](docs/PRD.md) | 产品需求文档 v6.3 |
| [TDD](docs/TDD.md) | 技术设计文档 v1.0 |
| [CONTRIBUTING](CONTRIBUTING.md) | 开发规范（架构约束、编码规范、安全、测试、Git） |

## 开发路线图

- [x] Phase 0 — 最小可运行原型（Broadcast + Synthesis）
- [ ] Phase 1 — MVP + 引导式配置 + 双模调用
- [ ] Phase 2 — 完整辩论流程（Review + Consensus + Checkpoint）
- [ ] Phase 3 — 效果验证（Benchmark 四组消融实验）
- [ ] Phase 4 — 智能路由 + 完整配置向导 + 动态权重
- [ ] Phase 5 — TUI 仪表盘 + 辩论回放 + 高级 UX

## License

MIT
