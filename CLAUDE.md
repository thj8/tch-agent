# tinyfat

CTF / 渗透测试多 Agent 协作平台。

## 快速参考

- **运行时**：Bun（不是 Node.js）
- **类型检查**：`bun run typecheck`
- **测试**：`bun test`
- **启动**：`bun run start`

## 项目结构

```
apps/cli/src/
  main.ts                          入口：装配 program + 挂命令组 + parseAsync + 全局错误处理（约 40 行）
  utils.ts                         formatError / pathExists
  event-summary.ts                 summarizeEvent 一族（AgentSession 事件 → 一行摘要）
  commands/                        命令组，每个文件导出 registerXxxCommands(program)
    misc.ts                        init / paths / web（顶层命令）
    config.ts                      config（api-keys / providers / model-prefs / prompts）
    solver.ts                      solver（run / rpc）
    runtime.ts                     runtime（ping / build-image / has-image / launch / list）
    challenge.ts                   challenge（create / list / show / sync / append-attempt / list-attempts）
    settings.ts                    settings（show / set —— host-settings 的 runtime / challenge）
packages/core/src/
  index.ts                          对外 barrel 导出（含 DaemonManager 装配根：config + challenge + runtime）
  config/
    index.ts                        ConfigManager 单例 + Provider/Model 偏好 CRUD + host-settings + resolvePromptSession（注册 host bridge / challenge 工具）
    types.ts                        AddResult / HostSettings / HostRuntimeSettings / HostChallengeSettings
    providers/types.ts              ProviderPrefEntry / ModelConfigEntry
    prompts/index.ts                Prompt 文件加载（YAML frontmatter + MD）
    tools/                          LLM 工具（defineTool），经 host bridge 转宿主执行
      host-bridge-tools.ts          ping / get_env / get_api_key
      challenge-tools.ts            challenge_get_state / submit_flag / get_hint
    config-manager.test.ts          bun:test 单元测试
  solver/
    session.ts                      createSolverSession（装配 AgentSession）
    cli.ts                          runSolverCli（事件流 → stdout）
    rpc/                            Solver ↔ Host RPC 协议（init 握手 + host bridge）
  challenge/
    env.ts                          challenge 模式注入容器的环境变量名常量
    host-bridge-*.ts                Solver ↔ Host bridge（client / handler / types / challenge-handler）
    store.ts                        Challenge 数据存储层（元数据 + attempts/submissions 日志，原子写 + mkdir 文件锁）
    store.test.ts                   bun:test 单元测试
    api-client.ts                   平台 REST 客户端（信封 / Agent-Token / 3 RPS 限流 / 2.5s 超时 / mock 模式）
    api-client.test.ts              bun:test 单元测试
    manager.ts                      ChallengeManager 控制平面（API + store + 业务逻辑 + mock 平台行为）
    manager.test.ts                 bun:test 单元测试
  runtime/runtime.ts                RuntimeManager（Docker 镜像 + 容器生命周期，收 host bridge handler 链）
packages/ui-web/src/
  server.ts                         Bun.serve + REST API + Tailwind sidecar
  app.tsx                           sidebar + hash 路由
  components/ui.tsx                 共享 UI（Modal / PageHeader / Button / Field）
  pages/                            api-keys / providers / model-prefs / solvers
  lib/types.ts                      前端共享类型 + 常量（PROVIDER_APIS / THINKING_LEVELS）
```

monorepo：`apps/*` 可执行，`packages/*` 被 `@my/*` 引用。

## 配置层（ConfigManager）

- **单例**：`ConfigManager.getInstance(dir)` 缓存；测试用 `ConfigManager.resetInstance()`
- **存储**：默认 `~/.tinyfat/config/`（已 gitignore）；测试用 `mkdtemp`
- **自管 JSON**：`provider-prefs.json` / `model-prefs.json`，缺失或解析失败 → `[]`
- **原子写**：tmp + rename，统一走 `writeJsonAtomic(path, data)`
- **CRUD**：`listXxx` / `addXxx`（返回 `AddResult`，id 冲突 `{ rejected }`）/ `updateXxx` / `removeXxx`
- **ID**：`generateId(prefix)` → `<prefix>_<6位hex>`，如 `prov_a3f9b2`
- **Prompt**：YAML frontmatter + MD；`savePrompt` 自动给 skills 补 `read` 工具
- **resolvePromptSession**：Prompt → `CreateAgentSessionOptions`（含 model 解析 + tools 白名单 + DefaultResourceLoader）
- **Host settings**：`getHostSettings` / `setHostSettings`（浅合并 `runtime` + `challenge` 两节，走 `writeJsonAtomic`，存 `host-settings.json`）；`isChallengeMockMode()` 读 `challenge.mockEnabled`

## Challenge 控制平面（packages/core/src/challenge）

- **三层**：`api-client.ts`（平台 REST + mock）→ `manager.ts`（控制平面：协调 API + store + 业务）→ `store.ts`（本地落盘）
- **mock 模式**：`challenge.mockEnabled === true` 时，`ChallengeManager.getApi()` 用 `createMock` 在本地 store 上模拟整个平台（list / start / stop / submit / hint），离线可跑
- **真 API 模式**：需配 `challenge.apiBaseUrl` + `challenge.agentToken`，缺则抛 `Challenge API not configured`
- **完成收尾**：`submitFlag` 检测到完成 → 自动 `finishChallenge`（停实例 + 停该题活跃 solver）；返回值在收尾后重读，保证 `instance_status` 最新（不报 stale running）
- **Host bridge**：`createChallengeHostBridgeHandler` 暴露 `challenge_get_state / submit_flag / get_hint / is_completed` 给容器内 solver；前提是容器注入了 `TCH_CHALLENGE_ID`（常量在 `env.ts`）
- **装配**：`DaemonManager` 把 handler 注入 `RuntimeManager` 并 `challenge.attachRuntime(runtime)`；CLI 的 `challenge sync` 是纯数据操作，直接用 `ConfigManager + ChallengeManager`，**不走 DaemonManager**（避免触发 `runtime.init()` build 镜像，保证 mock 模式离线可跑）

## Web UI（packages/ui-web）

- **装配根**：`DaemonManager.getInstance()` 统一持有 `config` + `challenge` + `runtime`，单例
- **入口**：`startWeb({ hostname, port })`，被 `tinyfat web` 调用
- **路由**：`Bun.serve routes` 声明式，按 method 分发；REST API 全在 `/api/config/*` 和 `/api/runtime/*`
- **Tailwind sidecar**：Bun 1.3.14 自带 Tailwind v4 集成有 bug（[issue #19021](https://github.com/oven-sh/bun/issues/19021)），手动 spawn `@tailwindcss/cli` 构建到 `dist/tailwind.css`，再用 `/tailwind.css` 路由 serve
- **运行时 CSS 注入**：HTML 不能写 `<link href="/tailwind.css">`（会被打包器构建期解析），在 `main.tsx` 里 `document.createElement("link")` 注入
- **前端结构**：`app.tsx`（sidebar + hash 路由）+ `components/ui.tsx`（共享组件）+ `pages/*`（每页一个文件）+ `lib/types.ts`（类型 + 常量）
- **CRUD 模式**：列表 table + Add Modal + Edit Modal + Delete 确认框；表单状态用单个 `FormState` 对象，提交时按需 POST/PUT

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

- 命令按组拆在 `apps/cli/src/commands/*.ts`，每个文件导出 `registerXxxCommands(program)`；`main.ts` 只装配（见 docs/lessons/21-cli-refactor.md）
- action 第一行：`const config = await ConfigManager.getInstance()`
- 失败：`console.error(\`✗ <原因>\`)` + `process.exit(1)`
- 成功：`console.log(\`✓ <动作>: <id>\`)`
- 必填 `.requiredOption`，长选项 kebab-case（`--base-url`、`--provider-id`）
- 末尾 `program.parseAsync(process.argv)`

## 文档同步

- 改代码后同步 `docs/lessons/` 对应课时、`README.md`、本文件
- 文档偏离代码时改文档，**不能偏离主线设计**

## 安全

- API Key / token 一律走 `~/.tinyfat/config/auth.json`（gitignore），**不写进代码 / 测试 / commit message**
