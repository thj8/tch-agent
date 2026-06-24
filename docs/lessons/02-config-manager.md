# 课时 2：ConfigManager 骨架 + 目录布局

> 🎯 **目标**：搭出 ConfigManager 单例 + 定义 `~/.tch-agent/` 目录布局，跑通初始化逻辑。
>
> ⏰ **预计耗时**：1-2 小时
>
> 📋 **难度**：⭐⭐

---

## 你将学到什么

1. **什么是 ConfigManager**，为什么要单例
2. **pi-coding-agent SDK 的核心组件**：AuthStorage / ModelRegistry / SettingsManager
3. **TypeScript 单例模式的几种实现**（重点掌握）
4. **跨平台路径处理**（macOS / Linux / Windows）
5. **配置文件 vs 环境变量**：什么时候用哪个

## 前置条件

✅ 已完成 [课时 1](./01-init-monorepo.md)

## 最终效果

跑 `bun run start init` 会：

1. 自动创建 `~/.tch-agent/config/` 目录及子目录（prompts/、skills/）
2. 实例化 SDK 的 AuthStorage / ModelRegistry / SettingsManager
3. 打印出所有路径供你确认

---

## 第零步：基础概念扫盲（新手必读）

### 0.1 什么是 ConfigManager？

整个项目会经常需要：

- 读 API Key（`ConfigManager.getApiKey("openai")`）
- 加载 Prompt 文件（`ConfigManager.getPrompt("SOLVER")`）
- 解析模型偏好（`ConfigManager.resolveModelPref("work-gpt4")`）

这些都是"配置"操作。如果每个模块都自己读盘，会很混乱：

```typescript
// ❌ 反面教材：到处自己读盘
class ChallengeManager {
    async getChallenge(id) {
        const data = await Bun.file(`~/.tch-agent/challenges/${id}.json`).json()
        // 但 API Key 怎么读？路径在哪？
    }
}
```

**正确做法**：所有配置相关的操作通过 ConfigManager 统一管理：

```typescript
// ✅ 推荐：通过 ConfigManager
class ChallengeManager {
    constructor(private config: ConfigManager) {}

    async submitFlag(id, flag) {
        const apiKey = this.config.getApiKey("openai")  // 统一入口
        // ...
    }
}
```

**ConfigManager 的职责**：

1. **持有所有 SDK 对象**（AuthStorage / ModelRegistry / SettingsManager）
2. **提供配置 CRUD**（API Key / Provider / Model / Prompt / Skill）
3. **解析 prompt → AgentSessionOptions**（后续课时）
4. **管理目录布局**（确保 ~/.tch-agent/ 存在）

### 0.2 为什么要单例？

整个进程只需要一份配置。如果每次都 `new ConfigManager()`，会有：

| 问题 | 后果 |
|---|---|
| **内存浪费** | 1000 个地方用就 1000 个实例 |
| **状态不一致** | A 改了 API Key，B 不知道（因为 B 的实例还是旧的） |
| **IO 浪费** | 每个实例都读一遍 auth.json，磁盘压力大 |

单例保证：**整个进程共用一个 ConfigManager 实例**。

### 0.3 TypeScript 单例的几种实现方式

#### 方式 A：全局变量（最简单，不推荐）

```typescript
// ❌ 简单但不优雅
let _instance: ConfigManager | undefined

export function getConfig() {
    if (!_instance) _instance = new ConfigManager()
    return _instance
}
```

**缺点**：无法 reset、无法异步初始化、测试时难替换。

#### 方式 B：经典 static 单例（推荐）

```typescript
// ✅ 经典做法
export class ConfigManager {
    private static instance: ConfigManager

    private constructor() { /* 私有构造 */ }

    static getInstance() {
        if (!this.instance) this.instance = new ConfigManager()
        return this.instance
    }
}

// 使用
const config = ConfigManager.getInstance()
```

**特点**：
- 构造函数私有，外部只能用 `getInstance()`
- static 字段属于类本身，全局唯一

#### 方式 C：异步单例（本项目用）

异步场景（构造里要 await mkdir / 读文件）需要用 Promise：

```typescript
export class ConfigManager {
    private static instance: Promise<ConfigManager> | undefined

    static async getInstance() {
        if (this.instance) return this.instance

        // 启动异步初始化
        this.instance = (async () => {
            const mgr = new ConfigManager()
            await mgr.initialize()  // 异步操作
            return mgr
        })()

        return this.instance
    }
}

// 使用
const config = await ConfigManager.getInstance()
```

**关键点**：`this.instance` 是 Promise，多次调用 `getInstance()` 返回**同一个 Promise**，所以 initialize 只执行一次。

本项目用方式 C，因为 initialize 里有 mkdir 等异步操作。

### 0.4 SDK 三件套

我们用的 SDK（`@mariozechner/pi-coding-agent`）提供三个核心对象：

| SDK 对象 | 作用 | 类比 | 落盘文件 |
|---|---|---|---|
| **AuthStorage** | 存 API Key | 像 macOS Keychain | `auth.json` |
| **ModelRegistry** | 注册 Provider + Model | 像 App Store 应用列表 | `models.json` |
| **SettingsManager** | SDK 运行时设置 | 像 VS Code settings.json | `settings.json` |

**AuthStorage**

- 你给 OpenAI / Anthropic 等供应商的 API Key。
- SDK 调 LLM 时自动从这里取对应 Key。

**ModelRegistry**

- 登记所有可用的 Provider（OpenAI / Anthropic / 智谱等）。
- 每个 Provider 下登记多个 Model（gpt-4o / claude-sonnet / glm-4 等）。
- AgentSession 创建时从这里 resolve "work-gpt4" → 真实 Model 对象。

**SettingsManager**

- SDK 的运行时行为配置：重试、压缩、超时等。
- 比如设 `retry.enabled: true` 后，LLM 调用失败会自动重试。

### 0.5 跨平台路径处理

不同操作系统的路径分隔符不同：

- macOS / Linux：`/Users/xxx/.tch-agent/config/auth.json`
- Windows：`C:\Users\xxx\.tch-agent\config\auth.json`

**永远不要硬编码路径分隔符**，用 Node 的 `path` 模块：

```typescript
import { resolve, join } from "node:path"

// ✅ 正确：自动用当前系统的分隔符
const authFile = resolve(homeDir, ".tch-agent", "config", "auth.json")
// macOS:  /Users/xxx/.tch-agent/config/auth.json
// Windows: C:\Users\xxx\.tch-agent\config\auth.json

// ❌ 错误：硬编码 /
const authFile = `${homeDir}/.tch-agent/config/auth.json`  // Windows 上可能出问题
```

用户主目录用 `node:os` 的 `homedir()`：

```typescript
import { homedir } from "node:os"
const home = homedir()  // macOS: /Users/xxx；Windows: C:\Users\xxx
```

### 0.6 配置文件 vs 环境变量

两种存储配置的方式：

**环境变量**：
- 适合**敏感**信息（API Key）—— 不进 git
- 适合**部署时**变化的配置（端口、数据库地址）
- 缺点：类型不友好（都是字符串）、不易管理多个值

**配置文件**（JSON）：
- 适合**用户级**配置 —— 持久、可编辑
- 支持复杂结构（嵌套对象、数组）
- 缺点：可能含敏感信息，需要小心 .gitignore

本项目策略：
- **API Key** → `auth.json`（SDK 自动加密落盘）
- **运行时配置**（Provider、Model 偏好、Prompt 等）→ JSON 文件
- **可选的 env 覆盖**（高级用法，比如 CI 里）

---

## 第一步：安装依赖

```bash
bun add @mariozechner/pi-coding-agent @mariozechner/pi-ai
```

**预期输出**：

```
Saved 2 packages
```

这两个包是 pi-coding-agent SDK 的核心：

- `pi-coding-agent`：Agent session 管理、工具定义、Extensions、AuthStorage / ModelRegistry / SettingsManager
- `pi-ai`：Provider / Model / Api 类型定义

**验证**：

```bash
# 看一下装好没
bun pm ls | grep -E "pi-(coding|ai)"
```

**预期**：

```
@mariozechner/pi-coding-agent@x.x.x
@mariozechner/pi-ai@x.x.x
```

---

## 第二步：定义类型

### 2.1 创建目录

```bash
mkdir -p packages/core/src/config
```

### 2.2 创建 packages/core/src/config/types.ts

新建文件 `packages/core/src/config/types.ts`：

```typescript
/**
 * config 层的跨模块共享类型。
 *
 * 本项目所有"宿主级"配置（runtime / challenge / planner 三块）
 * 都存在 ~/.tch-agent/config/host-settings.json。
 *
 * "宿主级" vs "用户偏好"：
 *   - 宿主级：跑这个进程的环境级配置（镜像名、网络、平台 API 地址等）。
 *   - 用户偏好：用户的 API Key、Provider 实例、模型别名等（在 auth.json / models.json）。
 */

/** add* 操作的统一返回：新分配的 ID + 可选的拒绝原因（比如重复） */
export interface AddResult {
    id: string
    rejected?: string
}

/**
 * Runtime 容器配置（覆盖默认镜像 / binds / env / network）。
 * 后续课时会用这个配置拉起 Docker 容器。
 */
export interface HostRuntimeSettings {
    /** Docker 镜像名（默认 tch-agent:latest） */
    image?: string
    /** 全局 env（所有 solver 容器都会注入） */
    env?: Record<string, string>
    /** Solver 专属 env（只注入到 solver 容器；必填，没有就传 {}） */
    solverEnv: Record<string, string>
    /** 额外的 volume binds（host:container 格式） */
    binds?: string[]
    /** 并发 solver 上限（默认 7） */
    maxSolvers?: number
    /** Docker 网络模式（默认 host） */
    networkMode?: "bridge" | "host"
}

/**
 * HostSettings：宿主级配置三块聚合。
 * 后续课时会加 challenge / planner 字段。
 */
export interface HostSettings {
    /** Runtime / Docker 相关 */
    runtime: HostRuntimeSettings
    /** 允许其他字段（challenge / planner 课时会扩展） */
    [key: string]: unknown
}
```

**关键设计点**：

- 用 `interface` 而不是 `type` —— 支持声明合并。
- `[key: string]: unknown` 允许后续扩展（challenge / planner）而不破坏类型。
- 字段都是可选（`?`）—— 没配置时用默认值。

---

## 第三步：实现 ConfigManager

### 3.1 创建 packages/core/src/config/index.ts

新建文件 `packages/core/src/config/index.ts`：

```typescript
import { resolve } from "node:path"
import { homedir } from "node:os"
import { mkdir } from "node:fs/promises"
import { AuthStorage, ModelRegistry, SettingsManager } from "@mariozechner/pi-coding-agent"

/**
 * 用户主目录下的配置根目录：~/.tch-agent/
 *
 * 所有用户配置都放在这里（与项目代码分离）：
 *   ~/.tch-agent/
 *     └── config/
 *       ├── auth.json              ← AuthStorage 落盘
 *       ├── models.json            ← ModelRegistry 落盘
 *       ├── settings.json          ← SettingsManager 落盘
 *       ├── host-settings.json     ← 项目自定义全局配置
 *       ├── prompts/               ← Prompt 文件（课时 4）
 *       ├── skills/                ← Skill 目录（课时 8）
 *       ├── provider-prefs.json    ← Provider 偏好（课时 3）
 *       └── model-prefs.json       ← Model 偏好（课时 3）
 */
export const TCH_AGENT_HOME_DIR = resolve(homedir(), ".tch-agent")

/**
 * 配置目录：~/.tch-agent/config/
 */
export const DEFAULT_CONFIG_DIR = resolve(TCH_AGENT_HOME_DIR, "config")

/**
 * ConfigManager：所有配置的"中央入口"。
 *
 * 单例模式 —— 整个进程共用一个实例（getInstance）。
 *
 * 职责：
 *   1. 持有 SDK 三件套（auth / models / settings）
 *   2. 提供配置 CRUD（后续课时追加）
 *   3. 解析 prompt → AgentSessionOptions（课时 5）
 *   4. 管理目录布局（确保 ~/.tch-agent/ 存在）
 */
export class ConfigManager {
    /** 配置根目录（绝对路径） */
    readonly dir: string
    /** API Key 存储 */
    readonly auth: AuthStorage
    /** Provider + Model 注册表 */
    readonly models: ModelRegistry
    /** SDK 运行时设置 */
    readonly settings: SettingsManager

    /**
     * 单例缓存（Promise 形式：让并发调用合并到同一个初始化过程）。
     */
    private static instance: Promise<ConfigManager> | undefined
    /**
     * 单例对应的 configDir，用于检测"用户改了目录"的场景。
     */
    private static instanceDir: string | undefined

    /**
     * 构造函数私有 —— 外部只能通过 getInstance() 获取。
     *
     * @param dir 配置目录绝对路径
     */
    private constructor(dir: string) {
        this.dir = dir
        // AuthStorage 落盘到 <dir>/auth.json
        this.auth = AuthStorage.create(resolve(dir, "auth.json"))
        // ModelRegistry 落盘到 <dir>/models.json
        this.models = ModelRegistry.create(this.auth, resolve(dir, "models.json"))
        // SettingsManager：第一个参数是 cwd（工作目录），第二个是 agentDir（配置目录）
        // 传 process.cwd() 作为 cwd，配置目录用 dir
        this.settings = SettingsManager.create(process.cwd(), dir)
    }

    /**
     * 获取单例。
     *
     * 第一次调用会创建实例 + initialize()。
     * 同一个 dir 重复调用返回同一个 Promise。
     *
     * 失败时会清掉单例，让下次调用可以重试。
     *
     * @param configDir 可选的自定义配置目录，默认 ~/.tch-agent/config/
     */
    static async getInstance(configDir: string = DEFAULT_CONFIG_DIR): Promise<ConfigManager> {
        const dir = resolve(configDir)
        // 已有实例且目录没变 → 直接返回
        if (this.instance && this.instanceDir === dir) return this.instance

        // 创建实例（异步，因为 initialize 里有 mkdir 等异步操作）
        const created = (async () => {
            const mgr = new ConfigManager(dir)
            await mgr.initialize()
            return mgr
        })()

        this.instanceDir = dir
        // 失败时清掉单例，让下次调用可以重试
        this.instance = created.catch((error) => {
            if (this.instance === created) {
                this.instance = undefined
                this.instanceDir = undefined
            }
            throw error
        })
        return this.instance
    }

    /**
     * 清除单例缓存（仅测试用：让 getInstance 接受新 dir）。
     *
     * 生产代码永远不需要调它。测试里用临时目录时，每次测试前 reset 一下，
     * 避免上一个测试的实例（指向已被清理的目录）泄漏到下一个测试。
     */
    static resetInstance(): void {
        this.instance = undefined
        this.instanceDir = undefined
    }

    /**
     * 初始化：确保必要目录存在 + 设置 SDK 默认行为。
     * 由 getInstance 首次调用时自动执行。
     */
    private async initialize(): Promise<void> {
        const configDir = this.dir
        // 确保三个目录存在（递归创建）
        const dirs = [
            configDir,
            resolve(configDir, "prompts"),  // 课时 4 用
            resolve(configDir, "skills"),   // 课时 8 用
        ]
        for (const d of dirs) {
            await mkdir(d, { recursive: true })
        }

        // SDK 默认设置：开启自动重试（LLM 调用经常遇到 rate limit）
        this.settings.setRetryEnabled(true)
        this.settings.applyOverrides({
            retry: {
                enabled: true,
                maxRetries: 20,
                baseDelayMs: 1000,
            },
        })
    }
}
```

### 3.2 关键设计点解释

#### 私有构造 + static getInstance

```typescript
private constructor(dir: string) { ... }

static async getInstance(configDir = DEFAULT_CONFIG_DIR) { ... }
```

**为什么要私有构造？**

如果不私有，外部就能 `new ConfigManager()` 创建多个实例，单例就没意义了。

私有后，外部只能通过 `getInstance()` 拿实例，类自己控制实例数量。

#### Promise 单例（异步初始化）

```typescript
private static instance: Promise<ConfigManager> | undefined

static async getInstance() {
    if (this.instance) return this.instance

    const created = (async () => {
        const mgr = new ConfigManager(dir)
        await mgr.initialize()  // 异步
        return mgr
    })()

    this.instance = created
    return this.instance
}
```

**为什么不直接 `static instance: ConfigManager`？**

因为 initialize 是异步的（要 await mkdir）。如果用同步缓存，第一次调用还没 await 完时，第二次调用会以为没实例又创建一次。

**Promise 的妙用**：

`this.instance` 是 Promise，第二次调用 `getInstance()` 直接返回**同一个 Promise**。Promise resolve 后，所有 await 它的代码都拿到同一个 ConfigManager 实例。

#### 失败时清缓存

```typescript
this.instance = created.catch((error) => {
    if (this.instance === created) {
        this.instance = undefined
        this.instanceDir = undefined
    }
    throw error
})
```

**为什么？** 如果 initialize 失败（比如权限不足），缓存会卡住一个 rejected Promise，后续调用永远拿到 rejected Promise。清掉缓存让下次调用可以重试。

### 3.3 更新 packages/core/src/index.ts

替换 `packages/core/src/index.ts` 的内容：

```typescript
/**
 * @my/core 包的对外入口（barrel file）。
 *
 * 重新导出核心模块，让其他包（@my/cli、@my/ui-web）能通过
 * `import { ConfigManager } from "@my/core"` 直接引用。
 */

export const PACKAGE_NAME = "@my/core"

// ↓↓↓ 新增这些 export ↓↓↓
export { ConfigManager, TCH_AGENT_HOME_DIR, DEFAULT_CONFIG_DIR } from "./config/index"
export type { HostSettings, HostRuntimeSettings } from "./config/types"

// 保留课时 1 的工具函数（如果用到的话）
export function add(a: number, b: number): number {
    return a + b
}
```

**什么是 barrel file？**

`index.ts` 只做 export 不写实现，叫 "barrel file"（桶文件）。好处：

- 其他包只需要 `import { A, B, C } from "@my/core"`，不用知道 A 在 `config/index.ts`、B 在 `runtime/index.ts`。
- 模块结构变化时，只改 barrel file，外部不用改。

---

## 第四步：加 CLI 命令

### 4.1 安装 commander

```bash
bun add commander
```

[Commander](https://github.com/tj/commander.js) 是 Node.js 最流行的 CLI 框架，用于定义子命令、参数、选项。

### 4.2 改造 apps/cli/src/main.ts

替换 `apps/cli/src/main.ts` 的内容：

```typescript
#!/usr/bin/env bun
import { Command } from "commander"
import { ConfigManager, TCH_AGENT_HOME_DIR, DEFAULT_CONFIG_DIR } from "@my/core"
import { stat } from "node:fs/promises"

/**
 * 全局错误处理：任何未捕获的异常都打到 stderr + 退出码 1。
 */
function formatError(error: unknown): string {
    return error instanceof Error ? error.stack || error.message : String(error)
}

process.on("unhandledRejection", (reason) => {
    console.error("[fatal] unhandledRejection", formatError(reason))
    process.exit(1)
})

process.on("uncaughtException", (error) => {
    console.error("[fatal] uncaughtException", formatError(error))
    process.exit(1)
})

/**
 * 检查路径是否存在（目录或文件）。
 */
async function pathExists(path: string): Promise<boolean> {
    try {
        await stat(path)
        return true
    } catch {
        return false
    }
}

async function main() {
    const program = new Command()
        .name("tch-agent")
        .description("CTF / pentest multi-agent platform")
        .version("0.0.1")

    /**
     * 子命令：tch-agent init
     * 初始化 ConfigManager，确认目录被创建。
     */
    program
        .command("init")
        .description("Initialize config directories and show paths")
        .action(async () => {
            console.log("Initialize tch-agent...\n")

            // 这一行触发 ConfigManager 单例创建 + initialize()
            const config = await ConfigManager.getInstance()

            console.log("✓ Config directories created:")
            console.log(` TCH_AGENT_HOME: ${TCH_AGENT_HOME_DIR}`)
            console.log(` CONFIG_DIR: ${DEFAULT_CONFIG_DIR}`)
            console.log(` AUTH_FILE: ${config.dir}/auth.json`)
            console.log(` MODELS_FILE: ${config.dir}/models.json`)
            console.log(` PROMPTS_DIR: ${config.dir}/prompts`)
            console.log(` SKILLS_DIR: ${config.dir}/skills\n")

            console.log("✓ SDK objects initialized:")
            console.log(` AuthStorage: ${config.auth.constructor.name}`)
            console.log(` ModelRegistry: ${config.models.constructor.name}`)
            console.log(` SettingsManager: ${config.settings.constructor.name}\n`)

            // 验证目录真的存在
            const checks = await Promise.all([
                pathExists(config.dir),
                pathExists(`${config.dir}/prompts`),
                pathExists(`${config.dir}/skills`),
            ])
            if (checks.every(Boolean)) {
                console.log("✓ All directories verified")
            } else {
                console.error("✗ Some directories missing! Check permissions.")
                process.exit(1)
            }
        })

    /**
     * 子命令：tch-agent paths
     * 打印所有路径，不创建任何东西（用于调试）。
     */
    program
        .command("paths")
        .description("Print all configured paths without creating anything")
        .action(async () => {
            console.log(`TCH_AGENT_HOME_DIR = ${TCH_AGENT_HOME_DIR}`)
            console.log(`DEFAULT_CONFIG_DIR = ${DEFAULT_CONFIG_DIR}`)
        })

    await program.parseAsync(process.argv)
}

main()
```

> 💡 **为什么 `main()` 不 `.catch()`？**
>
> 顶部已经注册了 `process.on("unhandledRejection", ...)` 和 `process.on("uncaughtException", ...)`，任何从 `main()` 漏出去的错误都会被这两个 handler 兜住，打印 `[fatal]` + 完整 stack 后退出。再写一层 `.catch()` 是冗余的。
>
> 同样，`parseAsync(process.argv)` 显式传 argv 是为了让 commander 在测试里能被任意参数驱动（比如 `parseAsync(["init"])`），生产里和默认行为一致。

> 💡 **`#!/usr/bin/env bun` shebang**
>
> 第一行的 [shebang](https://zh.wikipedia.org/wiki/Shebang) 告诉系统"这个文件用 bun 执行"。装了 `bin` 链接（`chmod +x apps/cli/src/main.ts && ln -s .../main.ts /usr/local/bin/tch-agent`）之后，就能直接 `tch-agent init` 而不用每次写 `bun run apps/cli/src/main.ts init`。课时 1 的 `apps/cli/package.json` 里 `"bin": "src/main.ts"` 就是配合 shebang 用的。

### 4.3 代码解读

#### Commander 的用法

```typescript
const program = new Command()
    .name("tch-agent")           // CLI 名字
    .description("...")          // 描述（--help 时显示）
    .version("0.0.1")            // 版本（--version 时显示）

program
    .command("init")             // 定义子命令
    .description("...")          // 子命令描述
    .action(async () => {        // 执行函数
        // ...
    })

await program.parseAsync(process.argv)  // 解析 argv + 执行
```

**用法**：

```bash
bun run apps/cli/src/main.ts init          # 跑 init 子命令
bun run apps/cli/src/main.ts paths         # 跑 paths 子命令
bun run apps/cli/src/main.ts --help        # 看所有子命令
bun run apps/cli/src/main.ts init --help   # 看 init 子命令的选项
```

#### 全局错误处理

```typescript
process.on("unhandledRejection", (reason) => {
    console.error("[fatal] unhandledRejection", formatError(reason))
    process.exit(1)
})

process.on("uncaughtException", (error) => {
    console.error("[fatal] uncaughtException", formatError(error))
    process.exit(1)
})
```

这两个事件 handler 是 **Node/Bun 进程的最后一道防线**。如果某个 async 函数抛错没人 catch，或者 sync 代码抛错，都会触发。

为什么需要？没的话，错误会被静默吞掉，进程可能挂起不退出。这也是为什么 `main()` 调用不需要再 `.catch()`——漏出去的 rejection 会被 `unhandledRejection` 兜住。

#### pathExists 工具函数

```typescript
async function pathExists(path: string): Promise<boolean> {
    try {
        await stat(path)
        return true
    } catch {
        return false
    }
}
```

`stat` 在文件/目录不存在时抛错，我们 catch 后返回 false。

---

## 第五步：验证

### 5.1 先看一下当前 `~/.tch-agent/` 是否存在

```bash
ls -la ~/.tch-agent 2>/dev/null || echo "(目录不存在)"
```

**预期**：`(目录不存在)`（如果你从来没跑过 tch-agent）

### 5.2 跑 init

```bash
bun run apps/cli/src/main.ts init
```

**预期输出**：

```
Initialize tch-agent...

✓ Config directories created:
 TCH_AGENT_HOME: /Users/<你的用户名>/.tch-agent
 CONFIG_DIR: /Users/<你的用户名>/.tch-agent/config
 AUTH_FILE: /Users/<你的用户名>/.tch-agent/config/auth.json
 MODELS_FILE: /Users/<你的用户名>/.tch-agent/config/models.json
 PROMPTS_DIR: /Users/<你的用户名>/.tch-agent/config/prompts
 SKILLS_DIR: /Users/<你的用户名>/.tch-agent/config/skills

✓ SDK objects initialized:
 AuthStorage: AuthStorage
 ModelRegistry: ModelRegistry
 SettingsManager: SettingsManager

✓ All directories verified
```

### 5.3 确认目录真的被创建了

```bash
ls -la ~/.tch-agent/
```

**预期输出**：

```
drwxr-xr-x   3 yourname  staff   96 ... .
drwxr-xr-x  ... yourname  staff  ... ..
drwxr-xr-x   5 yourname  staff  160 ... config
```

```bash
ls -la ~/.tch-agent/config/
```

**预期输出**：

```
drwxr-xr-x   5 yourname  staff  160 ... .
drwxr-xr-x   3 yourname  staff    96 ... ..
drwxr-xr-x   2 yourname  staff    64 ... prompts
drwxr-xr-x   2 yourname  staff    64 ... skills
```

> 💡 **注意**：`auth.json` 和 `models.json` 此时**还没出现**。它们是 SDK 在第一次写入时才会创建。后面课时会触发。

### 5.4 跑 paths

```bash
bun run apps/cli/src/main.ts paths
```

**预期输出**：

```
TCH_AGENT_HOME_DIR = /Users/<你的用户名>/.tch-agent
DEFAULT_CONFIG_DIR = /Users/<你的用户名>/.tch-agent/config
```

### 5.5 再跑一次 init（验证单例）

```bash
bun run apps/cli/src/main.ts init
```

应该和第一次输出一样。**关键**：单例机制保证 ConfigManager 只初始化一次。

### 5.6 跑类型检查

```bash
bun run typecheck
```

**预期**：无任何输出，说明类型检查通过。

### 5.7 试一下 --help

```bash
bun run apps/cli/src/main.ts --help
```

**预期输出**：

```
Usage: tch-agent [options] [command]

CTF / pentest multi-agent platform

Options:
  -V, --version              output the version number
  -h, --help                 display help for command

Commands:
  init [options]             Initialize config directories and show paths
  paths [options]            Print all configured paths without creating anything
  help [command]             display help for command
```

---

## 第六步：提交到 Git

```bash
git add .
git commit -m "feat: ConfigManager skeleton with SDK integration"
```

---

## 故障排查（FAQ）

### 问题 1：`Cannot find module '@mariozechner/pi-coding-agent'`

**原因**：依赖没装好。

**解决**：

```bash
# 看看装好没
bun pm ls | grep pi-coding-agent

# 没有，重装
bun add @mariozechner/pi-coding-agent @mariozechner/pi-ai
```

### 问题 2：`AuthStorage.create is not a function`

**原因**：SDK 版本可能不匹配，或导入路径错了。

**解决**：

```bash
# 看版本
bun pm ls | grep -E "pi-(coding|ai)"

# 重装最新版
bun remove @mariozechner/pi-coding-agent @mariozechner/pi-ai
bun add @mariozechner/pi-coding-agent @mariozechner/pi-ai
```

### 问题 3：`EACCES: permission denied, mkdir '/Users/xxx/.tch-agent'`

**原因**：用户目录权限问题（少见，一般是用了奇怪的 sudo）。

**解决**：

```bash
# 检查主目录权限
ls -la ~ | head -3

# 如果有问题，修复（不会影响其他文件）
sudo chown -R $(whoami) ~/.tch-agent
```

### 问题 4：单例没生效，每次调用都创建新实例

**原因**：可能多次调用 `ConfigManager.getInstance()` 但传了不同的 `configDir`。

**调试**：

```typescript
// 加一行打印
const config1 = await ConfigManager.getInstance()
const config2 = await ConfigManager.getInstance()
console.log(config1 === config2)  // 应该 true
```

如果输出 false，说明传了不同的 configDir。

### 问题 5：跑 typecheck 时报 `'AuthStorage' only refers to a type, but is being used as a value here.`

**原因**：可能用了 `import type` 而不是 `import`。

**解决**：确保用的是值导入：

```typescript
// ✅ 正确（值导入）
import { AuthStorage } from "@mariozechner/pi-coding-agent"

// ❌ 错误（类型导入，编译时会被丢弃）
import type { AuthStorage } from "@mariozechner/pi-coding-agent"
```

### 问题 6：`commander` 装好了但报 `Cannot find module 'commander'`

**原因**：workspaces 子包之间依赖隔离，根的 commander 不能直接用。

**解决**：在 `apps/cli` 里也声明：

```bash
cd apps/cli
bun add commander
cd ../..
```

或者直接在根目录 `bun add commander` 就够了（Bun workspaces 默认会提升到根）。

### 问题 7：`mkdir: /Users/xxx/.tch-agent: Operation not permitted`

**原因**：macOS 的 App Sandbox 或 Full Disk Access 拦截了。

**解决**：

系统偏好设置 → 安全性与隐私 → 隐私 → 完全磁盘访问权限 → 添加你的终端 / VS Code。

### 问题 8：跑 init 看到 SDK 对象名是 `Object` 而不是 `AuthStorage`

**原因**：`constructor.name` 在 minified 代码里可能被改。

**解决**：不影响功能，可以忽略。如果想看真实类名，可以改用：

```typescript
console.log(`AuthStorage: ${config.auth.constructor.toString().split(" ")[1] || "Object"}`)
```

### 问题 9：`SettingsManager.create(undefined, dir)` 报 `Argument of type 'undefined' is not assignable to parameter of type 'string'`

**原因**：SDK 类型签名是 `create(cwd?: string, agentDir?: string)`，但某些 TS 版本下传 `undefined` 给可选参数会被严格检查拒绝。

**解决**：传真实路径替代 `undefined`：

```typescript
// 之前（会报错）：
this.settings = SettingsManager.create(undefined, dir)

// 改成：
this.settings = SettingsManager.create(process.cwd(), dir)
```

`process.cwd()` 是当前工作目录，作为 cwd 参数。SDK 内部只在某些场景才用它，对我们的功能不影响。

### 问题 10：SDK 其他 create 方法也有类似问题（`AuthStorage.create` / `ModelRegistry.create`）

如果 SDK 版本较新，所有 `create` 方法的类型签名可能都严格了。

**统一修法**：检查真实 SDK 类型签名：

```bash
# 看 .d.ts 文件
find node_modules -name "*.d.ts" -path "*pi-coding-agent*" | head -3
# 然后查对应方法的签名
```

报错时按签名传真实值（路径字符串）替代 `undefined`。

---

## 本课小结

✅ **你已完成**：

- 实现 ConfigManager 异步单例
- 集成 pi-coding-agent SDK 的 AuthStorage / ModelRegistry / SettingsManager
- 加 `tch-agent init` / `paths` CLI 命令
- 看到目录被自动创建

📦 **新增/修改文件**：

```
packages/core/src/config/
├── index.ts        ← ConfigManager 类
└── types.ts        ← HostSettings 类型

packages/core/src/index.ts          ← 加 export
apps/cli/src/main.ts                ← 加 init / paths 命令
```

🔑 **关键概念回顾**：

- **ConfigManager**：所有配置的中央入口，避免散乱的文件读取。
- **异步单例模式**：用 Promise 缓存让并发调用合并到同一个初始化。
- **SDK 三件套**：AuthStorage（API Key）+ ModelRegistry（模型注册）+ SettingsManager（运行时设置）。
- **Commander CLI**：定义子命令的标准方式。
- **resetInstance**：测试专用方法，让单例可以被重置，避免测试间状态泄漏。

---

## 思考题（可选）

1. 如果你要支持多个用户用同一台机器（比如共享服务器），单例会出什么问题？怎么解决？
2. `private static instance` 改成实例字段会怎样？试一下。
3. 如果想加 `tch-agent doctor` 自检命令，你会检查哪些项？（提示：Bun 版本、目录权限、SDK 对象就绪、必填配置是否填写）

---

## 下一课预告

[课时 3：API Key / Provider / Model 偏好 CRUD](./03-config-crud.md) —— 我们会：

- 实现 API Key 的增删查（`setApiKey` / `removeApiKey` / `listApiKeys`）
- 实现 Provider 偏好（自建 OpenAI 兼容网关等）
- 实现 Model 偏好（给某个真实模型起短别名，prompt 通过它引用）
- 加 `tch-agent config api-keys list` 等 CLI 子命令
- 看到配置真的写到 `auth.json` / `provider-prefs.json` 里

继续课时 3 →
