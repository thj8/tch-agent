# my-tch-agent

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
tch-agent --help    # 全局可用
```

`tch-agent` 软链到 `~/.bun/bin/tch-agent`，Bun 已自动加入 `PATH`。卸载：`bun unlink`。

### 分发：编译成单文件 binary

```bash
bun run build       # 产出 bin/tch-agent（约 77MB，内嵌 Bun runtime）
```

可扔到任何 macOS / Linux 机器，**不需要装 Bun**：

```bash
sudo mv bin/tch-agent /usr/local/bin/
tch-agent --help
```

> ⚠️ `bin/` 下必须同时有 `package.json`（`build` script 自动复制）—— SDK `@mariozechner/pi-coding-agent` 在运行时定位 TUI 资源需要读它。如果只拷 `tch-agent` 一个文件，启动会 `ENOENT: package.json`。

跨平台编译用 `--target`：

```bash
bun build --compile --target=bun-linux-x64 ./apps/cli/src/main.ts --outfile bin/tch-agent-linux
bun build --compile --target=bun-darwin-arm64 ./apps/cli/src/main.ts --outfile bin/tch-agent-macos-arm
```

## 项目结构

```
apps/cli/              CLI 入口（commander）
  src/main.ts
packages/core/         核心库（@my/core）
  src/index.ts         对外导出
  src/config/          配置层
    index.ts           ConfigManager（单例 + resolvePromptSession + applyProviderPrefs）
    types.ts           AddResult
    providers/types.ts ProviderPrefEntry（含 models） / ModelConfigEntry
    prompts/index.ts   Prompt 文件加载（YAML frontmatter + MD）
    config-manager.test.ts
  src/solver/          AgentSession 装配
    session.ts         createSolverSession
    cli.ts             runSolverCli（事件流 → stdout）
```

## 配置目录

默认在 `~/.tch-agent/`（已 gitignore，**API Key 不会进 git**），包含：

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
tch-agent init                                        # 初始化配置目录
tch-agent paths                                       # 打印路径常量

# API Keys（写到 auth.json，按 provider 名存）
tch-agent config api-keys set <provider> <key>
tch-agent config api-keys remove <provider>
tch-agent config api-keys list

# Provider 偏好（baseUrl + 可选自定义 model 列表）
tch-agent config providers add -n <name> [-i id] [-a api] [-b baseUrl] [-m <model>]...
tch-agent config providers list
tch-agent config providers remove <id>

# Model 偏好（用户友好 ID → provider + modelId）
tch-agent config model-prefs add -p <provider> -m <modelId> [-i id] [-t thinking]
tch-agent config model-prefs list
tch-agent config model-prefs remove <id>

# Prompt 模板
tch-agent config prompts list
tch-agent config prompts show <name>
tch-agent config prompts create <name> [-d desc] [-m model]
tch-agent config prompts remove <name>

# Solver：本地跑 LLM agent 调工具
tch-agent solver -p <prompt> "<task>"
```

## 快速跑通（以智谱 GLM 为例）

```bash
# 1. 装依赖 + 初始化
bun install
tch-agent init

# 2. 设 API Key（key 名要和下一步 provider 名一致）
tch-agent config api-keys set glm <your-token>

# 3. 注册 glm provider（full registration + 自定义 model 列表）
tch-agent config providers add \
  --id glm --name glm \
  --api anthropic-messages \
  --base-url https://open.bigmodel.cn/api/anthropic \
  --model glm-5 --model glm-5.2

# 4. 加 model 偏好
tch-agent config model-prefs add --id main-glm --provider glm --model-id glm-5

# 5. 编辑 ~/.tch-agent/config/prompts/SOLVER.md 加 model: main-glm

# 6. 跑
tch-agent solver -p SOLVER "用 ls 看 /tmp 目录有什么，然后总结"
```

跑完看 `~/.tch-agent/solvers/<id>/session/*.jsonl` 第二行，`model_change` 应是 `"provider":"glm","modelId":"glm-5"`（不是 anthropic/claude-*）。

> 🔒 **Key 安全**：token 只走 `~/.tch-agent/config/auth.json`，仓库外 + `.tch-agent/` 全局 gitignore。**永远不要**把 key 写进代码、测试、commit、文档示例。

## 测试

`bun test` 自动扫描所有 `*.test.ts`。每个测试用 `mkdtemp` 建临时目录隔离，`ConfigManager.resetInstance()` 清单例缓存，**不会触碰 `~/.tch-agent/`**。

```bash
bun test                                              # 跑全部
bun test packages/core/src/config/config-manager.test.ts
bun test --watch
```

## 教程

20 课时循序渐进的搭建指南在 [`docs/lessons/`](./docs/lessons/README.md)，当前完成到第 5 课（本地跑通 LLM agent 调工具）。
