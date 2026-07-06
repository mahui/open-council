# Design Notes（设计笔记）

本目录记录 Open Council 的**跨模块设计决策、数据流与 trade-off 的定稿笔记**。每篇聚焦一个主题，用于回答"这个设计为什么是现在这个样子"——TDD 描述系统"是什么"，design-notes 记录"为什么这么定"。

## 篇目索引

| 笔记 | 主题 | 日期 | 状态 |
|------|------|------|------|
| [consensus-review-dataflow.md](./consensus-review-dataflow.md) | 共识判停 / 评审回灌 / 自评剔除 / 截断标记的接口与数据流设计 | 2026-07-04 | 设计定稿 |
| [information-architecture-review.md](./information-architecture-review.md) | 全项目信息架构审阅：模块边界、类型归属、配置/文档/命名/导出面 | 2026-07-05 | 审阅定稿 |
| [web-gui-design.md](./web-gui-design.md) | 本地 Web GUI（`council serve`）：HTTP/SSE 架构、WebRenderer、线协议、REST 契约、模块分层与工作项拆分 | 2026-07-05 | 设计定稿 |
| [web-gui-config.md](./web-gui-config.md) | Web GUI 配置能力：可编辑字段面、配置 REST 契约与脱敏 DTO、凭证入线边界裁定、RuntimeConfig 热重载、纯函数下沉、乐观锁 | 2026-07-05 | 设计定稿 |
| [standard-api-convergence.md](./standard-api-convergence.md) | 收敛到标准 API 双协议（anthropic/openai）：拆除 CLI/OAuth/订阅通道、弃用 pi-ai 换官方 SDK、新 protocol schema、配置迁移、实施波次 | 2026-07-06 | 设计定稿（待实施） |

## 约定

- **命名**：`kebab-case` 主题名，一篇一主题（如 `consensus-review-dataflow.md`）。
- **入库时机**：设计**定稿后**才入库。草稿/讨论过程不进本目录，避免与 TDD 争夺真相源。
- **与 TDD 的关系**：design-notes 记录决策与推导；一旦设计落地，系统的"当前状态"以 TDD 为权威。**若笔记与 TDD 冲突，以对 TDD 的修订收尾**——即更新 TDD，而非让两处长期并存。
- **演进**：按日期演进，新增笔记时在上表登记一行。
