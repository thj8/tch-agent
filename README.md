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
    index.ts           ConfigManager（单例）
    types.ts           AddResult
    providers/types.ts ProviderPrefEntry / ModelConfigEntry
    config-manager.test.ts
```

## 配置目录

默认在 `~/.tch-agent/`，包含：

| 文件 | 用途 |
|---|---|
| `config/auth.json` | API Keys（SDK AuthStorage） |
| `config/models.json` | 模型注册表（SDK ModelRegistry） |
| `config/provider-prefs.json` | Provider 偏好（自管 CRUD） |
| `config/model-prefs.json` | Model 偏好（自管 CRUD） |
| `config/prompts/` | Prompt 模板目录 |
| `config/skills/` | Skill 目录 |

## CLI 命令

```bash
tch-agent init                                        # 初始化配置目录
tch-agent paths                                       # 打印路径常量

tch-agent config api-keys set <provider> <key>        # 设置 API Key
tch-agent config api-keys remove <provider>
tch-agent config api-keys list

tch-agent config providers add -n <name> [-i id] [-a api] [-b baseUrl]
tch-agent config providers list
tch-agent config providers remove <id>

tch-agent config model-prefs add -p <provider> --provider-id <id> -m <modelId> [-i id] [-t thinking]
tch-agent config model-prefs list
tch-agent config model-prefs remove <id>
```

## 测试

`bun test` 自动扫描所有 `*.test.ts`。每个测试用 `mkdtemp` 建临时目录隔离，`ConfigManager.resetInstance()` 清单例缓存，**不会触碰 `~/.tch-agent/`**。

```bash
bun test                                              # 跑全部
bun test packages/core/src/config/config-manager.test.ts
bun test --watch
```
