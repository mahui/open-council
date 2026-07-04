# Open Council — 开发规范

本文档是项目的强制性开发规范。所有代码提交（人工或 Agent）必须遵守。

---

## 1. 架构约束

### 1.1 分层纪律

```
commands/  →  core/  →  (无外部依赖)
    ↓          ↑
   ui/     providers/  →  外部系统 (subprocess, HTTP API, 文件系统)
    ↓          ↑
         storage/  →  SQLite, JSON 文件
         config/   →  YAML 文件
```

**强制规则**：

| 规则 ID | 规则 | 违反后果 |
|---------|------|---------|
| ARCH-01 | `src/core/` 禁止导入 `node:fs`、`node:child_process`、`node:http`、`better-sqlite3` 及任何 I/O 模块 | 必须通过接口注入 |
| ARCH-02 | `src/core/` 禁止导入 `src/providers/`、`src/storage/`、`src/ui/`、`src/commands/` | 单向依赖，core 是最底层 |
| ARCH-03 | `src/commands/` 是薄层，单个命令文件不超过 150 行；业务逻辑必须委托给 `core/` | 防止 command 膨胀 |
| ARCH-04 | `src/types/` 是纯类型定义，不包含任何运行时代码（函数、类、常量） | 保持零副作用 |
| ARCH-05 | 所有模块间交互通过 `src/types/` 中定义的接口进行，不直接依赖具体实现类 | 依赖倒置 |

> **ARCH-04 显式豁免**：`src/types/errors.ts` 的 Error 子类是既定豁免。错误类型是跨层契约，Error 子类必须携带运行时构造函数才能被 `throw`/`instanceof`，无法退化为纯类型。同理，由 zod schema 推导类型时 schema 本身的运行时定义也属允许的例外。除此之外 `src/types/` 保持零运行时代码。

### 1.2 关键接口契约

以下接口是模块间的硬契约，修改需经 `@architect` 审查：

- `InvocationAdapter` — providers ↔ core 的唯一桥梁
- `Renderer` — ui ↔ core 的唯一桥梁
- `SessionStore` — storage ↔ core 的唯一桥梁
- `CheckpointManager` — storage ↔ core 的唯一桥梁
- `ConfigLoader` — config ↔ commands 的唯一桥梁

修改这些接口的签名属于 **breaking change**，必须同步更新所有实现方和调用方。

### 1.3 Phase 纪律

当前开发阶段的功能边界严格遵循 PRD 第 11 节路线图。**禁止提前实现后续 Phase 的功能**：

- Phase 0 不引入配置系统、持久化、TUI、健康检查
- Phase 1 不引入 Review/Consensus、熔断器、动态权重
- Phase 2 不引入 Benchmark、TUI 仪表盘、回放

在代码中为后续功能预留接口是允许的，但不实现具体逻辑。

---

## 2. TypeScript 编码规范

### 2.1 类型安全

| 规则 ID | 规则 |
|---------|------|
| TS-01 | `tsconfig.json` 必须启用 `strict: true`（含 strictNullChecks、noImplicitAny） |
| TS-02 | 禁止使用 `as any`、`@ts-ignore`、`@ts-expect-error`。如确有必要，必须附注释说明原因并标注 TODO |
| TS-03 | 所有对外接口使用 `interface` 定义（非 `type`），便于声明合并和 IDE 提示 |
| TS-04 | 配置对象的类型必须从 zod schema 推导：`type X = z.infer<typeof XSchema>`，禁止手写重复类型 |
| TS-05 | 枚举值使用 `string literal union`（如 `'cli' \| 'api' \| 'auto'`），不使用 `enum` 关键字 |
| TS-06 | 函数返回类型必须显式标注（不依赖类型推导），除非是单行箭头函数 |

### 2.2 异步与错误处理

| 规则 ID | 规则 |
|---------|------|
| ASYNC-01 | 所有 async 函数的调用方必须 `await` 或显式处理返回的 Promise。禁止 fire-and-forget |
| ASYNC-02 | `better-sqlite3` 调用必须使用同步 API（这是刻意选择，保证事务原子性） |
| ASYNC-03 | 自定义错误类必须继承 `CouncilError`，包含 `code: string` 字段 |
| ASYNC-04 | 错误处理不允许空 catch：`catch {}` 或 `catch (e) {}` 必须至少记录日志或重新抛出 |
| ASYNC-05 | Provider 调用失败时，不静默降级——必须通过 `Renderer.onDegradation()` 通知用户 |

### 2.3 命名约定

| 类别 | 约定 | 示例 |
|------|------|------|
| 文件名 | kebab-case | `cli-adapter.ts`, `prompt-builder.ts` |
| 类名 | PascalCase | `CliAdapter`, `CredentialManager` |
| 接口名 | PascalCase，不加 `I` 前缀 | `InvocationAdapter`（非 `IInvocationAdapter`） |
| 函数/方法 | camelCase | `calculateConsensus()`, `getValidCredential()` |
| 常量 | UPPER_SNAKE_CASE | `CREDENTIAL_PATHS`, `TOKEN_ENDPOINTS` |
| 类型参数 | 单大写字母或描述性名称 | `T`, `TResult` |
| 私有成员 | 不加下划线前缀，使用 `private` 关键字 | `private cache` |
| 布尔变量 | is/has/should/can 前缀 | `isExpired`, `hasValidCredential` |

### 2.4 导入规范

```typescript
// 1. Node.js 内置模块（node: 协议）
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// 2. 第三方依赖
import Database from 'better-sqlite3';
import { z } from 'zod';

// 3. 项目内部模块（相对路径）
import type { ModelConfig } from '../types/config.js';
import { PATHS } from '../config/paths.js';
```

- 导入顺序：Node 内置 → 第三方 → 项目内部，各组之间空一行
- 类型导入使用 `import type`
- 项目内部导入使用 `.js` 扩展名（ESM 兼容）

---

## 3. 安全规范

| 规则 ID | 规则 | 检查方式 |
|---------|------|---------|
| SEC-01 | SQLite 查询 100% 使用 prepared statement。禁止字符串拼接或模板字符串构造 SQL | `@reviewer` 审查 |
| SEC-02 | 凭证字段（access_token, refresh_token, api_key）禁止出现在日志中。pino 配置必须 redact 这些字段 | 日志审查 |
| SEC-03 | 所有文件写入（session JSON、checkpoint、凭证）必须设置 `mode: 0o600` | grep `writeFileSync` 检查 |
| SEC-04 | 用户输入拼接文件路径时必须校验：禁止 `..`、绝对路径注入。使用 `path.resolve()` 后验证仍在预期目录内 | `@reviewer` 审查 |
| SEC-05 | `input_mode: arg` 模式调用时，日志输出一次性安全提醒 | 代码审查 |
| SEC-06 | 环境变量中的 API Key 优先级高于文件凭证。通过 `api_key_env` 配置，不硬编码变量名 | 配置校验 |
| SEC-07 | `--no-store` 模式下，Session 数据不写入任何本地文件（JSON、SQLite、checkpoint） | 集成测试覆盖 |

---

## 4. 测试规范

### 4.1 覆盖要求

| 模块 | 最低行覆盖率 | 必须覆盖的场景 |
|------|------------|--------------|
| `src/core/` | 90% | 所有公开方法 + 边界情况（空输入、单 Agent、全失败、PARSE_ERROR） |
| `src/providers/` | 80% | invoke 成功/失败/超时、凭证发现/刷新/过期、健康检查各状态 |
| `src/storage/` | 85% | CRUD 操作、事务原子性、僵尸清理、FTS5 查询 |
| `src/config/` | 80% | 合法配置、非法配置（zod 校验失败）、缺失字段默认值 |

### 4.2 测试编写原则

| 规则 ID | 规则 |
|---------|------|
| TEST-01 | 测试命名必须描述预期行为：`it('3 个不同模型高度一致 → score > 0.8')` 而非 `it('test consensus')` |
| TEST-02 | 每个测试独立运行，不依赖其他测试的执行顺序或副作用 |
| TEST-03 | 不 mock `src/core/` 的内部方法——测试输入输出契约，不测试实现细节 |
| TEST-04 | SQLite 测试使用 `:memory:` 或 `tmpdir`，测试结束后清理 |
| TEST-05 | 涉及外部服务的测试（真实 API 调用）标记为 `@slow`，不在 CI 默认运行 |
| TEST-06 | 新增代码必须同时提交对应测试。PR 中无测试的新功能代码不予合并 |

### 4.3 测试目录对应关系

```
src/core/orchestrator.ts      →  test/core/orchestrator.test.ts
src/providers/cli-adapter.ts  →  test/providers/cli-adapter.test.ts
src/storage/database.ts       →  test/storage/database.test.ts
```

文件名一一对应，使用 `.test.ts` 后缀。

---

## 5. Git 规范

### 5.1 分支策略

| 分支 | 用途 | 保护规则 |
|------|------|---------|
| `main` | 稳定版本，每个 Phase 完成后合并 | 禁止直接推送 |
| `dev` | 开发主线 | 日常开发提交到此 |
| `feature/*` | 功能分支 | 从 dev 分出，完成后 PR 回 dev |
| `fix/*` | Bug 修复 | 从 dev 分出 |

### 5.2 Commit Message 格式

```
<type>(<scope>): <description>

[optional body]
```

**type 必须是以下之一**:

| type | 用途 |
|------|------|
| `feat` | 新功能 |
| `fix` | Bug 修复 |
| `refactor` | 重构（不改变外部行为） |
| `test` | 添加或修改测试 |
| `docs` | 文档变更 |
| `chore` | 构建、依赖、配置变更 |

**scope 必须是以下之一**: `core`, `providers`, `storage`, `config`, `cli`, `ui`, `types`, `benchmark`

**示例**:
```
feat(providers): implement OpenAI credential discovery from ~/.codex/auth.json
fix(core): correct Kendall's W calculation for tied ranks
test(storage): add concurrency tests for resource_slots deadlock scenarios
refactor(providers): extract token refresh logic into shared base class
```

### 5.3 PR 规范

- PR 标题遵循 commit message 格式
- PR 描述包含：变更摘要、影响的模块、测试计划
- 新功能 PR 必须包含测试
- 触及接口契约（ARCH-05 中列出的接口）的 PR 必须 `@architect` 审查

---

## 6. 依赖管理

| 规则 ID | 规则 |
|---------|------|
| DEP-01 | 新增依赖前检查是否可以用 Node.js 内置模块替代。例如：用原生 `fetch` 而非 `axios` |
| DEP-02 | 新增依赖必须说明理由并记录在 PR 描述中 |
| DEP-03 | 依赖版本使用 `^`（允许 minor 更新），`better-sqlite3` 等原生模块锁定 minor 版本 |
| DEP-04 | 禁止引入 TDD 第 1.3 节明确排除的依赖（axios, knex, drizzle, blessed, chalk, ora） |
| DEP-05 | `devDependencies` 和 `dependencies` 严格区分。测试框架、构建工具放 dev |

---

## 7. 配置文件规范

### 7.1 YAML 配置

- 使用 `yaml` 库（eemeli/yaml）解析，保留注释
- 所有配置文件必须有对应的 zod schema
- 加载时通过 `schema.parse()` 校验，失败时输出 user-friendly 错误信息（标注哪个字段、期望什么类型）
- 配置文件中的路径支持 `~` 展开

### 7.2 默认值策略

- 所有可选配置字段必须在 zod schema 中定义 `.default()` 值
- 默认值在 schema 层设置，不在业务代码中散落
- `council.yaml` 不存在时系统能以全默认值启动（首次引导后生成）

---

## 8. 日志规范

```typescript
import pino from 'pino';

export const logger = pino({
  level: process.env.COUNCIL_LOG_LEVEL ?? 'info',
  redact: {
    paths: ['access_token', 'refresh_token', 'api_key', '*.access_token', '*.refresh_token'],
    censor: '[REDACTED]',
  },
  transport: process.env.NODE_ENV === 'development'
    ? { target: 'pino-pretty' }
    : undefined,
});
```

| 级别 | 用途 | 示例 |
|------|------|------|
| `error` | 不可恢复的错误 | 所有模型均不可用、数据库损坏 |
| `warn` | 可恢复的异常 | 单个模型超时（已降级）、凭证即将过期 |
| `info` | 关键业务事件 | Session 创建/完成、模式判定、凭证刷新成功 |
| `debug` | 开发调试 | 完整 prompt、API 响应元数据、checkpoint 写入 |

- 日志写入 `~/.council/logs/council-{date}.log`，按天轮转，保留 7 天
- 进度信息写 stderr（供用户看），结构化日志写文件（供调试）
- **禁止在 stdout 输出日志**——stdout 专门留给辩论结果（pipe 友好）

---

## 9. 文档规范

| 类别 | 要求 |
|------|------|
| 公开接口 | 必须有 JSDoc 注释，包含 `@param`、`@returns`、`@throws` |
| 复杂算法 | 必须有行内注释说明思路（如 Kendall's W、z-score 归一化） |
| TODO | 格式 `// TODO(phase-N): description`，标注属于哪个 Phase |
| HACK | 格式 `// HACK: reason`，必须说明为什么这样做以及什么条件下可以移除 |
| 普通代码 | 自解释的代码不需要注释。**不要为了注释而注释** |

---

## 规则索引

快速查找规则：

- **ARCH-01 ~ 05**: 架构分层约束
- **TS-01 ~ 06**: TypeScript 类型安全
- **ASYNC-01 ~ 05**: 异步与错误处理
- **SEC-01 ~ 07**: 安全规范
- **TEST-01 ~ 06**: 测试规范
- **DEP-01 ~ 05**: 依赖管理
