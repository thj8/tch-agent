# tinyfat

CTF / 渗透测试多 Agent 协作平台。

## 运行时

[Bun](https://bun.com) ≥ 1.3。

```bash
bun install            # 装依赖
bun run start          # 启动 CLI
bun run typecheck      # 类型检查
bun test               # 单元测试
```

## 安装

### 开发期：全局软链（推荐）

改代码立即生效，不用重新编译：

```bash
bun link            # 在项目根目录注册
tinyfat --help    # 全局可用
```

`tinyfat` 软链到 `~/.bun/bin/tinyfat`，Bun 已自动加入 `PATH`。卸载：`bun unlink`。

### 分发：编译成单文件 binary

```bash
bun run build       # 产出 bin/tinyfat（约 77MB，内嵌 Bun runtime）
```

可扔到任何 macOS / Linux 机器，**不需要装 Bun**：

```bash
sudo mv bin/tinyfat /usr/local/bin/
tinyfat --help
```

> ⚠️ `bin/` 下必须同时有 `package.json`（`build` script 自动复制）—— SDK `@mariozechner/pi-coding-agent` 在运行时定位 TUI 资源需要读它。如果只拷 `tinyfat` 一个文件，启动会 `ENOENT: package.json`。

跨平台编译用 `--target`：

```bash
bun build --compile --target=bun-linux-x64 ./apps/cli/src/main.ts --outfile bin/tinyfat-linux
bun build --compile --target=bun-darwin-arm64 ./apps/cli/src/main.ts --outfile bin/tinyfat-macos-arm
```

## 项目结构

```
apps/cli/              CLI 入口（commander）
  src/main.ts          入口：装配 program + 挂命令组 + parseAsync（约 40 行）
  src/utils.ts         formatError / pathExists
  src/event-summary.ts AgentSession 事件 → 一行摘要
  src/commands/        命令组（misc / config / solver / runtime / challenge，各导出 registerXxxCommands）
packages/core/         核心库（@my/core）
  src/index.ts         对外导出（含 DaemonManager 装配根）
  src/config/          配置层
    index.ts           ConfigManager（单例 + resolvePromptSession + applyProviderPrefs）
    types.ts           AddResult
    providers/types.ts ProviderPrefEntry（含 models） / ModelConfigEntry
    prompts/index.ts   Prompt 文件加载（YAML frontmatter + MD）
    config-manager.test.ts
  src/solver/          AgentSession 装配
    session.ts         createSolverSession
    cli.ts             runSolverCli（事件流 → stdout）
  src/runtime/         Docker runtime
    runtime.ts         RuntimeManager（构建镜像 / 拉起容器 / RPC）
  src/solver/rpc/      Solver ↔ Host RPC 协议（init 握手 + host bridge）
  src/challenge/       Challenge 数据存储层 + challenge 模式 env / host-bridge
    store.ts           元数据 + attempts/submissions 日志（原子写 + mkdir 文件锁）
packages/ui-web/       Web UI（@my/ui-web）
  src/server.ts        Bun.serve + REST API + Tailwind sidecar
  src/index.html       前端入口
  src/app.tsx          sidebar + hash 路由
  src/components/      共享 UI（Modal / PageHeader / Button / ...）
  src/pages/           api-keys / providers / model-prefs / solvers
```

## 配置目录

默认在 `~/.tinyfat/`（已 gitignore，**API Key 不会进 git**），包含：

| 文件 | 用途 |
|---|---|
| `config/auth.json` | API Keys（SDK AuthStorage，provider 名 → key） |
| `config/models.json` | 模型注册表（SDK ModelRegistry） |
| `config/provider-prefs.json` | Provider 偏好（含 baseUrl / api / models 列表） |
| `config/model-prefs.json` | Model 偏好（用户起的名 → provider + modelId） |
| `config/prompts/` | Prompt 模板目录（YAML frontmatter + MD） |
| `config/skills/` | Skill 目录 |
| `solvers/<id>/` | 每次 solver 跑的 workspace + session JSONL |

## CLI 命令

```bash
tinyfat init                                        # 初始化配置目录
tinyfat paths                                       # 打印路径常量

# API Keys（写到 auth.json，按 provider 名存）
tinyfat config api-keys set <provider> <key>
tinyfat config api-keys remove <provider>
tinyfat config api-keys list

# Provider 偏好（baseUrl + 可选自定义 model 列表）
tinyfat config providers add -n <name> [-i id] [-a api] [-b baseUrl] [-m <model>]...
tinyfat config providers list
tinyfat config providers remove <id>

# Model 偏好（用户友好 ID → provider + modelId）
tinyfat config model-prefs add -p <provider> -m <modelId> [-i id] [-t thinking]
tinyfat config model-prefs list
tinyfat config model-prefs remove <id>

# Prompt 模板
tinyfat config prompts list
tinyfat config prompts show <name>
tinyfat config prompts create <name> [-d desc] [-m model]
tinyfat config prompts remove <name>

# Solver：本地跑 LLM agent 调工具
tinyfat solver run -p <prompt> "<task>"

# Runtime：管理 Docker 镜像 / 容器
tinyfat runtime ping                       # 探活 Docker daemon
tinyfat runtime build-image                # 构建/更新 solver 镜像
tinyfat runtime has-image                  # 镜像是否存在
tinyfat runtime launch -p <prompt> "<task>"  # 拉起容器跑 solver
tinyfat runtime list                       # 当前活跃 solver

# Web UI：浏览器管理配置 + 看 solver
tinyfat web                                # 默认 http://127.0.0.1:3000
tinyfat web --port 3001 --host 0.0.0.0
```

## 快速跑通（以智谱 GLM 为例）

```bash
# 1. 装依赖 + 初始化
bun install
tinyfat init

# 2. 设 API Key（key 名要和下一步 provider 名一致）
tinyfat config api-keys set glm <your-token>

# 3. 注册 glm provider（full registration + 自定义 model 列表）
tinyfat config providers add \
  --id glm --name glm \
  --api anthropic-messages \
  --base-url https://open.bigmodel.cn/api/anthropic \
  --model glm-5 --model glm-5.2

# 4. 加 model 偏好
tinyfat config model-prefs add --id main-glm --provider glm --model-id glm-5

# 5. 编辑 ~/.tinyfat/config/prompts/SOLVER.md 加 model: main-glm

# 6. 跑
tinyfat solver -p SOLVER "用 ls 看 /tmp 目录有什么，然后总结"
```

跑完看 `~/.tinyfat/solvers/<id>/session/*.jsonl` 第二行，`model_change` 应是 `"provider":"glm","modelId":"glm-5"`（不是 anthropic/claude-*）。

> 🔒 **Key 安全**：token 只走 `~/.tinyfat/config/auth.json`，仓库外 + `.tinyfat/` 全局 gitignore。**永远不要**把 key 写进代码、测试、commit、文档示例。

## Web UI

```bash
tinyfat web
# → 🌐 Web UI running at http://127.0.0.1:3000
```

深色 Dashboard，四个页面：

- **Solvers**：当前活跃容器列表 + Docker 状态（每 2s 轮询）
- **API Keys**：增/删 API Key
- **Providers**：增/改/删 Provider 偏好（含 baseUrl / api / 自定义 model 列表）
- **Model Prefs**：增/改/删 Model 偏好（id → provider + modelId + thinkingLevel）

URL 支持 hash 深链（`/#providers`、`/#model-prefs`、...）。

> Bun 1.3.14 自带的 Tailwind v4 集成有 bug（[issue #19021](https://github.com/oven-sh/bun/issues/19021)），`@my/ui-web` 用 `@tailwindcss/cli` sidecar 模式绕过，详见 [课时 10](./docs/lessons/10-web-ui.md)。

## 测试

`bun test` 自动扫描所有 `*.test.ts`。每个测试用 `mkdtemp` 建临时目录隔离，`ConfigManager.resetInstance()` 清单例缓存，**不会触碰 `~/.tinyfat/`**。

```bash
bun test                                              # 跑全部
bun test packages/core/src/config/config-manager.test.ts
bun test --watch
```

## 教程

20 课时循序渐进的搭建指南在 [`docs/lessons/`](./docs/lessons/README.md)，当前完成到第 10 课（Web UI + 完整 CRUD）。
