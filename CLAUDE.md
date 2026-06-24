# my-tch-agent

CTF / 渗透测试多 Agent 协作平台。

## 快速参考

- **运行时**：Bun（不是 Node.js）
- **类型检查**：`bun run typecheck`
- **测试**：`bun test`
- **启动**：`bun run start`

## 项目结构

```
apps/cli/src/main.ts                commander CLI（命令注册都在这里）
packages/core/src/
  index.ts                          对外 barrel 导出
  config/
    index.ts                        ConfigManager 单例 + Provider/Model 偏好 CRUD + resolvePromptSession
    types.ts                        AddResult
    providers/types.ts              ProviderPrefEntry / ModelConfigEntry
    prompts/index.ts                Prompt 文件加载（YAML frontmatter + MD）
    config-manager.test.ts          bun:test 单元测试
  solver/
    session.ts                      createSolverSession（装配 AgentSession）
    cli.ts                          runSolverCli（事件流 → stdout）
```

monorepo：`apps/*` 可执行，`packages/*` 被 `@my/*` 引用。

## 配置层（ConfigManager）

- **单例**：`ConfigManager.getInstance(dir)` 缓存；测试用 `ConfigManager.resetInstance()`
- **存储**：默认 `~/.tch-agent/config/`（已 gitignore）；测试用 `mkdtemp`
- **自管 JSON**：`provider-prefs.json` / `model-prefs.json`，缺失或解析失败 → `[]`
- **原子写**：tmp + rename，统一走 `writeJsonAtomic(path, data)`
- **CRUD**：`listXxx` / `addXxx`（返回 `AddResult`，id 冲突 `{ rejected }`）/ `updateXxx` / `removeXxx`
- **ID**：`generateId(prefix)` → `<prefix>_<6位hex>`，如 `prov_a3f9b2`
- **Prompt**：YAML frontmatter + MD；`savePrompt` 自动给 skills 补 `read` 工具
- **resolvePromptSession**：Prompt → `CreateAgentSessionOptions`（含 model 解析 + tools 白名单 + DefaultResourceLoader）

## 代码风格

- 文件 / 目录：kebab-case
- 类型导入 `import type`，值导入 `import`
- `export function` 声明，不用 `export default`
- TS `strict: true`，不用 `any`（SDK 边界除外）
- 接口 / 类型 PascalCase，常量 UPPER_SNAKE_CASE
- `===` 不用 `==`

### Bun 偏好

- `bun <file>` / `bun test` / `Bun.file()` / `Bun.write()`
- 系统调用（rename / mkdir 等）仍走 `node:fs/promises`

## 测试约定

- 文件名 `<被测文件>.test.ts`，同目录
- 隔离：`beforeEach` mkdtemp + resetInstance，`afterEach` rm -rf
- 业务语义分组：`describe("ConfigManager - Provider 偏好", ...)`
- 真实文件系统（tmp 目录），不 mock
- **每个新功能都要写单元测试**

## CLI 约定（apps/cli）

- 命令注册全在 `apps/cli/src/main.ts`
- action 第一行：`const config = await ConfigManager.getInstance()`
- 失败：`console.error(\`✗ <原因>\`)` + `process.exit(1)`
- 成功：`console.log(\`✓ <动作>: <id>\`)`
- 必填 `.requiredOption`，长选项 kebab-case（`--base-url`、`--provider-id`）
- 末尾 `program.parseAsync(process.argv)`

## 文档同步

- 改代码后同步 `docs/lessons/` 对应课时、`README.md`、本文件
- 文档偏离代码时改文档，**不能偏离主线设计**

## 安全

- API Key / token 一律走 `~/.tch-agent/config/auth.json`（gitignore），**不写进代码 / 测试 / commit message**
