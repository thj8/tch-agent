# 课时 5：第一个 AgentSession + CLI 跑通

> 🎯 **目标**：在本地（非 Docker）跑通"LLM 调 bash 工具"，看到 AgentSession 的实时事件流。
>
> ⏰ **预计耗时**：2-3 小时
>
> 📋 **难度**：⭐⭐⭐⭐（本阶段最重要的一课）

---

## 你将学到什么

1. **pi-coding-agent SDK 的核心概念**：AgentSession / Extension / Tool
2. **resolvePromptSession** —— Prompt 如何装配成 AgentSessionOptions
3. **AgentSession 的事件流**（subscribe）
4. **怎么让 LLM 真的能调工具**

## 前置条件

✅ 已完成 [课时 1-4](./README.md)
✅ 至少配了一个真实 API Key（OpenAI / Anthropic / 智谱）

## 最终效果

```bash
tch-agent solver --prompt SOLVER "ls /tmp 然后告诉我看到了什么"
```

**预期输出**：

```
[init] loaded prompt SOLVER (tools: read, bash, write, edit, grep, ls)
[start] task: ls /tmp 然后告诉我看到了什么

[assistant] 我先看一下 /tmp 目录有什么。
[tool_call] bash({ command: "ls /tmp" })
[tool_result] file1.txt
file2.txt
...
[assistant] /tmp 目录下有：
- file1.txt
- file2.txt
...
[done] stop reason: end_turn
```

---

## 第零步：概念扫盲

### 0.1 pi-coding-agent SDK 的核心对象

```
┌─────────────────────────────────────┐
│  AgentSession                       │  ← 一次对话会话
│  ├─ prompt(message)                 │  ← 发起一轮对话
│  ├─ subscribe(handler)              │  ← 监听事件流
│  ├─ model / thinkingLevel           │  ← 用的模型
│  ├─ tools[]                         │  ← 可调工具列表
│  ├─ messages[]                      │  ← 对话历史
│  └─ sessionManager                  │  ← 落盘管理
└─────────────────────────────────────┘
```

**AgentSession 是核心**：每个 session 是一个独立的 LLM 对话。

### 0.2 AgentSession 的事件流

调 `session.prompt("...")` 后，会触发一系列事件：

| 事件 | 含义 |
|---|---|
| `message_start` | LLM 开始回复 |
| `message_update` | 流式 token（增量） |
| `message_end` | LLM 回复结束（含 stopReason） |
| `tool_execution_start` | 开始调工具 |
| `tool_execution_end` | 工具调用结束 |
| `agent_end` | 整轮 agent 结束 |

用 `session.subscribe(handler)` 监听这些事件。

### 0.3 Tool 是什么

Tool 是 LLM 可以调用的函数。SDK 自带一批：

| 工具 | 作用 |
|---|---|
| `read` | 读文件 |
| `write` | 写文件 |
| `edit` | 编辑文件（find & replace） |
| `bash` | 跑 shell 命令 |
| `grep` | 搜索文件内容 |
| `find` | 按文件名搜索 |
| `ls` | 列目录 |

LLM 在回复时会输出 tool_call，SDK 自动执行并把结果喂回去。

### 0.4 Extension 是什么

Extension 是 hook 系统，让你能在 session 事件流里插入自定义逻辑：

```typescript
const factory: ExtensionFactory = (pi) => {
    pi.on("tool_execution_end", async (event) => {
        console.log(`Tool ${event.toolName} done`)
    })
}

// 在 createAgentSession 时传入
createAgentSession({ ..., extensions: [factory] })
```

后续课时（强制续跑、observer）都用 Extension 实现。

---

## 第一步：实现 resolvePromptSession

`resolvePromptSession` 是**核心方法**：把 Prompt 文件解析成 SDK 的 `CreateAgentSessionOptions`。

### 1.1 改 packages/core/src/config/index.ts

在 ConfigManager 类里加：

```typescript
// 顶部加 imports
import {
    DefaultResourceLoader,
} from "@mariozechner/pi-coding-agent"
import type { CreateAgentSessionOptions, ExtensionFactory } from "@mariozechner/pi-coding-agent"
import type { Api, Model, ThinkingLevel } from "@mariozechner/pi-ai"

// 在 ConfigManager 类里追加：

/**
 * Prompt → AgentSessionOptions 的"装配函数"。
 *
 * 流程：
 *   1. 加载 prompt 文件
 *   2. 解析 model pref → Model<Api> + thinkingLevel
 *   3. 把 prompt.meta.tools 作为工具名白名单（SDK 自己实例化）
 *   4. 用 prompt.content 作为 systemPrompt（通过 DefaultResourceLoader 注入）
 *
 * @param promptName prompt 名
 * @param extensions ExtensionFactory 数组（可选）。SDK 规定 extensions 必须通过
 *                   DefaultResourceLoader 注入，不是 createAgentSession 直接传。
 *                   `session.bindExtensions({})` 时才被调用。
 * @param cwd 工作目录（影响 read/bash/ls 等工具的相对路径，默认 process.cwd()）
 * @returns 找不到/disabled 返回 undefined
 */
async resolvePromptSession(
    promptName: string,
    extensions: ExtensionFactory[] = [],
    cwd: string = process.cwd(),
): Promise<CreateAgentSessionOptions | undefined> {
    // 1. 加载 prompt
    const prompt = await this.getPrompt(promptName)
    if (!prompt) return undefined
    if (prompt.meta.disabled) return undefined

    // 2. 解析 model
    let model: Model<Api> | undefined
    let thinkingLevel: ThinkingLevel | undefined
    if (prompt.meta.model) {
        try {
            const resolved = await this.resolveModelPref(prompt.meta.model)
            model = resolved.model
            thinkingLevel = resolved.thinkingLevel
        } catch (error) {
            throw new Error(
                `prompt "${promptName}" model "${prompt.meta.model}": ${
                    error instanceof Error ? error.message : String(error)
                }`,
            )
        }
    }

    // 3. 装配 ResourceLoader（systemPrompt + extensions）
    //    SDK 规定：extensions 必须通过 ResourceLoader 注入
    const resourceLoader = new DefaultResourceLoader({
        cwd,
        agentDir: this.dir,
        systemPromptOverride: () => prompt.content,
        extensionFactories: extensions,   // ← 后续课时会用
    })
    await resourceLoader.reload()

    // 4. 组装 CreateAgentSessionOptions
    //    SDK 的 tools 字段是工具名白名单（string[]），不是 ToolDefinition[]
    //    SDK 自己根据名字实例化内置工具（read/bash/edit/write/grep/find/ls）
    const opts: CreateAgentSessionOptions = {
        cwd,
        tools: prompt.meta.tools ?? [],
        resourceLoader,
        authStorage: this.auth,
        modelRegistry: this.models,
        settingsManager: this.settings,
    }
    if (model) opts.model = model
    if (thinkingLevel) opts.thinkingLevel = thinkingLevel

    return opts
}

/**
 * 把 Model 偏好 ID 解析成真实 Model<Api> + thinkingLevel。
 *
 * @param modelPrefId 用户的 model 偏好 ID（如 "work-gpt4"）
 */
async resolveModelPref(modelPrefId: string): Promise<{ model: Model<Api>; thinkingLevel?: ThinkingLevel }> {
    // 查 model-prefs.json
    const prefs = await this.listModelPrefs()
    const pref = prefs.find((p) => p.id === modelPrefId)
    if (!pref) {
        throw new Error(`model pref not found: ${modelPrefId}`)
    }

    // 在 ModelRegistry 里找
    const all = await this.models.getAvailable()
    const model = all.find(
        (m) => m.provider === pref.provider && m.id === pref.modelId,
    )
    if (!model) {
        throw new Error(
            `model not registered: ${pref.provider}/${pref.modelId} (did you configure the provider?)`,
        )
    }

    // 解析 thinkingLevel
    let thinkingLevel: ThinkingLevel | undefined
    if (pref.thinkingLevel) {
        thinkingLevel = pref.thinkingLevel as ThinkingLevel
    }

    return { model, thinkingLevel }
}
```

### 1.2 关键设计点

#### 为什么用 `systemPromptOverride`

```typescript
new DefaultResourceLoader({
    agentDir: this.dir,
    systemPromptOverride: () => prompt.content,
})
```

DefaultResourceLoader 是 SDK 的资源加载器，默认会从 `<agentDir>/prompts/` 读 prompt。我们用 `systemPromptOverride` 直接传入 prompt 内容，避免重复加载。

#### 为什么 tools 字段是 `string[]` 而不是 `ToolDefinition[]`

SDK 的 `createAgentSession({ tools, customTools })`：
- `tools`：内置工具的**名字白名单**（`string[]`）。SDK 根据名字自己实例化工具（read/bash/edit/write/grep/find/ls）。
- `customTools`：自定义工具的**定义**（含 execute 函数），类型是 `ToolDefinition[]`。本课不用。

所以 prompt.meta.tools（已经是 `string[]`）直接传过去即可，不用做映射。

#### resolveModelPref 的边界情况

如果用户在 prompt 里写了 `model: work-gpt4` 但：
- `work-gpt4` 不在 model-prefs.json → 抛"not found"。
- `work-gpt4` 存在但 provider 没注册到 ModelRegistry → 抛"not registered"。

错误信息要清晰，方便用户排查。

### 1.3 ConfigManager.initialize 自动应用 provider-prefs

`resolveModelPref` 依赖 ModelRegistry 里有对应 provider。SDK 内置了 anthropic / openai 等，但 baseUrl 是官方的（`api.anthropic.com` / `api.openai.com`）。要让 SDK 走自定义端点（智谱 anthropic 兼容），需要在 `ConfigManager.initialize` 末尾加 `applyProviderPrefs()`：

```typescript
private async initialize(): Promise<void> {
    // ... 前面建目录、释放 prompt 不变

    // 把 provider-prefs 应用到 ModelRegistry（baseUrl override）
    this.applyProviderPrefs()

    // SDK 重试设置
    this.settings.setRetryEnabled(true)
    // ...
}

/**
 * 把 provider-prefs.json 应用到 ModelRegistry。每个 entry 二选一：
 *
 * **A. 有 models** → full registration
 *   注册全新 provider（name 可任意，如 "glm"），每个 model 用合理默认元数据
 *   注册成 ModelRegistry 里的实体。SDK 校验要求同时传 apiKey（从 AuthStorage
 *   按 provider 名查；request 时 AuthStorage 也是优先源，行为一致）。
 *
 * **B. 无 models** → override-only
 *   SDK 把内置 provider（如 anthropic）的所有内置 model 的 baseUrl 换成新值，
 *   复用 SDK 自带的 model 元数据。要求 name 必须是 SDK 内置 provider 名。
 */
private applyProviderPrefs(): void {
    const file = Bun.file(this.providerPrefsPath())
    file.json().then((data) => {
        if (!Array.isArray(data)) return
        const entries = data as ProviderPrefEntry[]
        for (const entry of entries) {
            const providerName = entry.name?.trim()
            const baseUrl = entry.baseUrl?.trim()
            if (!providerName || !baseUrl) continue

            const models = (entry.models ?? []).map((m) => m.trim()).filter(Boolean)

            try {
                if (models.length > 0) {
                    // A. full registration
                    const storedKey = this.getApiKeyValue(providerName)
                    const providerCfg = {
                        baseUrl,
                        ...(entry.api ? { api: entry.api as Api } : {}),
                        ...(storedKey ? { apiKey: storedKey } : {}),
                        models: models.map((id) => ({
                            id, name: id,
                            reasoning: false,
                            input: ["text", "image"],
                            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                            contextWindow: 128000,
                            maxTokens: 16384,
                        })),
                    }
                    this.models.registerProvider(providerName, providerCfg)
                } else {
                    // B. override-only
                    this.models.registerProvider(providerName, {
                        baseUrl,
                        ...(entry.api ? { api: entry.api as Api } : {}),
                    })
                }
            } catch (error) {
                console.error(`[warn] failed to register provider "${providerName}": ${
                    error instanceof Error ? error.message : String(error)
                }`)
            }
        }
    }).catch(() => {
        // 文件不存在或解析失败 → 静默
    })
}
```

关键：
- 用 `entry.name`（不是 `entry.id`）作为 SDK provider 名——id 是用户起的本地 ID（`prov_abc`），name 才是 SDK 认的 provider key
- full registration 时 `apiKey` 必须传，从 AuthStorage 按 provider 名查；所以 `config api-keys set <name>` 的 key 名要和 provider 名一致


---

## 第二步：实现 createSolverSession

`createSolverSession` 是**包装函数**：在 resolvePromptSession 基础上：
1. 准备 workspace / session 目录
2. 调 SDK 的 `createAgentSession` + `bindExtensions`

### 2.1 创建 packages/core/src/solver/session.ts

```bash
mkdir -p packages/core/src/solver
```

新建 `packages/core/src/solver/session.ts`：

```typescript
import {
    SessionManager,
    createAgentSession,
} from "@mariozechner/pi-coding-agent"
import type { AgentSession } from "@mariozechner/pi-coding-agent"
import { mkdir } from "node:fs/promises"
import { homedir } from "node:os"
import { resolve } from "node:path"
import { ConfigManager } from "../config/index"

/**
 * 一个已就绪的 Solver AgentSession + 目录路径。
 */
export interface SolverSession {
    session: AgentSession
    sessionDir: string
    workspaceDir: string
}

/**
 * 创建一个 Solver AgentSession。
 *
 * 流程：
 *   1. 准备 workspace / session 目录（默认在 ~/.tch-agent/solvers/<id>/）
 *   2. resolvePromptSession 装配 SDK 选项
 *   3. createAgentSession + bindExtensions
 *
 * 注意：本函数只创建并返回 session，**不发送 prompt**。
 * 调用方（runSolverCli）负责发送初始 task。
 *
 * @param init.solverId    8 字符 solver ID
 * @param init.promptName  用哪个 prompt
 * @param init.task        初始任务文本
 */
export async function createSolverSession(init: {
    solverId: string
    promptName: string
    task: string
}): Promise<SolverSession> {
    const config = await ConfigManager.getInstance()

    // 1. 准备目录（默认布局：~/.tch-agent/solvers/<id>/）
    const homeDir = resolve(homedir(), ".tch-agent")
    const solversDir = resolve(homeDir, "solvers")
    const workspaceDir = resolve(solversDir, init.solverId, "workspace")
    const sessionDir = resolve(solversDir, init.solverId, "session")

    await mkdir(workspaceDir, { recursive: true })
    await mkdir(sessionDir, { recursive: true })

    // 2. 装配 SDK 选项（cwd 用 workspace，让 read/bash 等工具落在 workspace 里）
    const sessionOpts = await config.resolvePromptSession(
        init.promptName,
        [],
        workspaceDir,
    )
    if (!sessionOpts) {
        throw new Error(`prompt not found or disabled: ${init.promptName}`)
    }

    // 3. 创建 AgentSession
    const { session } = await createAgentSession({
        ...sessionOpts,
        cwd: workspaceDir,
        sessionManager: SessionManager.create(workspaceDir, sessionDir),
    })
    await session.bindExtensions({})

    return { session, sessionDir, workspaceDir }
}
```

### 2.2 关键设计点

#### 为什么不在这里发 prompt？

`createSolverSession` 只负责"装配 + 创建"，**不发 prompt**。原因：

1. **关注点分离**：创建和执行是两件事。
2. **测试友好**：测试时可能想创建后改配置再发 prompt。
3. **未来扩展**：阶段 2 的 RPC 模式下，容器内要先创建 session 再等宿主发命令。

#### SessionManager 的作用

```typescript
SessionManager.create(workspaceDir, sessionDir)
```

让 SDK 把对话历史落到 `sessionDir`（JSONL 格式）。这样：
- 进程重启后能恢复对话（虽然本课时不用）
- 后续课时（observer）能读这些 JSONL 做行为分析

#### `await session.bindExtensions({})` 到底干了什么

SDK 文档里写"创建 session 后必须 bindExtensions"，但传一个空对象到底意义何在？

**签名**（SDK 的 `AgentSession.bindExtensions`）：

```typescript
bindExtensions(bindings: ExtensionBindings): Promise<void>

interface ExtensionBindings {
    uiContext?: ExtensionUIContext                       // UI 回调（渲染、菜单等）
    commandContextActions?: ExtensionCommandContextActions  // 自定义 /命令 的行为
    shutdownHandler?: ShutdownHandler                    // 关闭回调
    onError?: ExtensionErrorListener                     // 错误回调
}
```

**内部行为**（SDK 源码 `agent-session.js`）：

1. 把传入的 4 个回调存到 session 内部字段（传 `{}` 时全部跳过）
2. 如果 `extensionRunner` 已存在：
   - 把当前已存的回调同步给 runner
   - 触发 `session_start` 事件给所有扩展
   - 让扩展声明 skills / prompts / themes，并入 ResourceLoader，重建系统提示

**为什么传 `{}` 也能跑**：扩展本身是在 `resolvePromptSession` 第 3 步通过 `DefaultResourceLoader.extensionFactories` 注入的，但 SDK 规定——扩展的 `session_start` 钩子和资源发现**只有在 `bindExtensions` 被调用时才会触发**。传 `{}` 等于："我没有 UI / shutdown / 命令回调，但仍然要走完扩展启动流程。"

> 💡 **SDK 自己的示例也这么写**：`examples/sdk/13-session-runtime.ts` 就是 `await session.bindExtensions({})`——headless 场景的标准用法。

将来要做交互式 UI 或自定义 `/命令`，再往里塞 `uiContext` / `commandContextActions`。后续课时（observer / 强制续跑）会用到。

---

## 第三步：实现 CLI 入口

### 3.1 创建 packages/core/src/solver/cli.ts

```typescript
import type { AgentSessionEvent } from "@mariozechner/pi-coding-agent"
import { createSolverSession } from "./session"

export interface RunSolverOptions {
    promptName: string
    task: string
}

/**
 * Solver CLI 入口：在本地跑一个 solver。
 *
 * 1. 创建 AgentSession
 * 2. 订阅事件流（打到 stdout）
 * 3. 发起首轮 prompt
 */
export async function runSolverCli(options: RunSolverOptions): Promise<void> {
    const solverId = crypto.randomUUID().slice(0, 8)

    console.log(`[init] solverId=${solverId}`)
    console.log(`[init] prompt=${options.promptName}`)

    const { session } = await createSolverSession({
        solverId,
        promptName: options.promptName,
        task: options.task,
    })

    // 订阅事件流
    session.subscribe((event: AgentSessionEvent) => {
        printEvent(event)
    })

    console.log(`[start] task: ${options.task}\n`)

    // 发起首轮 prompt
    await session.prompt(options.task, {
        source: "interactive",
    })

    console.log(`\n[done] session ended`)
    session.dispose()
}

/**
 * 把 AgentSessionEvent 转成可读的 console 输出。
 *
 * 重点事件：
 *   - message_end (assistant)  → 打印 LLM 回复
 *   - tool_execution_start     → 打印工具调用
 *   - tool_execution_end       → 打印工具结果（前 500 字符）
 *   - agent_end                → 打印结束原因
 */
function printEvent(event: AgentSessionEvent): void {
    switch (event.type) {
        case "message_end": {
            if (event.message?.role === "assistant") {
                const text = extractText(event.message.content)
                if (text) console.log(`[assistant] ${text}`)
            }
            break
        }
        case "tool_execution_start": {
            console.log(`[tool_call] ${event.toolName}(${summarizeArgs(event.args)})`)
            break
        }
        case "tool_execution_end": {
            const preview = summarizeResult(event.result)
            const isError = event.isError ? " (error)" : ""
            console.log(`[tool_result${isError}] ${preview}`)
            break
        }
        case "agent_end": {
            // agent_end 没有 stopReason 字段，从 messages 数组里取最后一条 assistant 消息
            const reason = extractStopReason(event.messages)
            console.log(`[agent_end] stopReason=${reason}`)
            break
        }
        // 忽略其他事件（message_update 流式 token 等）
    }
}

/** 从 messages 数组里找最后一条 AssistantMessage 的 stopReason */
function extractStopReason(messages: unknown): string {
    if (!Array.isArray(messages)) return "unknown"
    for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i] as { role?: string; stopReason?: string }
        if (m?.role === "assistant" && typeof m.stopReason === "string") {
            return m.stopReason
        }
    }
    return "unknown"
}

/** 从 message.content 数组里提取所有 text 块 */
function extractText(content: unknown): string {
    if (typeof content === "string") return content
    if (!Array.isArray(content)) return ""
    return content
        .filter((p): p is { type: "text"; text: string } =>
            !!p && typeof p === "object" && (p as { type?: unknown }).type === "text",
        )
        .map((p) => p.text)
        .join("")
}

/** 把工具参数摘要成一行 */
function summarizeArgs(args: unknown): string {
    try {
        const json = JSON.stringify(args)
        return (json ?? "").slice(0, 120)
    } catch {
        return String(args)
    }
}

/** 把工具结果摘要成短文本 */
function summarizeResult(result: unknown): string {
    if (typeof result === "string") return result.slice(0, 500)
    if (result && typeof result === "object" && "content" in result) {
        const content = (result as { content?: unknown }).content
        if (Array.isArray(content)) {
            const text = content
                .map((c) => {
                    if (typeof c === "object" && c && (c as { type?: string }).type === "text") {
                        return (c as { text?: string }).text ?? ""
                    }
                    return ""
                })
                .join("\n")
            return text.slice(0, 500)
        }
    }
    try {
        return JSON.stringify(result).slice(0, 500)
    } catch {
        return String(result)
    }
}
```

### 3.2 在 packages/core/src/index.ts 加 export

```typescript
export { runSolverCli } from "./solver/cli"
export { createSolverSession } from "./solver/session"
export type { SolverSession } from "./solver/session"
```

### 3.3 在 apps/cli/src/main.ts 加 solver 命令

在 `main()` 里追加（在 `config` 命令组之后）：

```typescript
// ── solver 命令 ─────────────────────────────────────────

program
    .command("solver")
    .description("Run a solver locally (non-Docker) with the given prompt and task")
    .requiredOption("-p, --prompt <name>", "Prompt name")
    .argument("<task>", "Task description")
    .action(async (task: string, opts: { prompt: string }) => {
        const { runSolverCli } = await import("@my/core")
        try {
            await runSolverCli({
                promptName: opts.prompt,
                task,
            })
        } catch (error) {
            console.error(
                "[fatal]",
                error instanceof Error ? error.message : String(error),
            )
            process.exit(1)
        }
    })
```

> 💡 **不要写 `program.command("solver list")`**：commander 会把它当成名为 `solver` 的命令注册，和上面那条冲突。要列出可用 prompt 用 `tch-agent config prompts list`（lesson 4 已有）。

### 3.4 关键设计点

#### `await session.prompt(task, { source: "interactive" })` 做了什么

前面 `createSolverSession` 只是装配好 session，到这一行才**真正把任务发给 LLM 并驱动一整轮 agent 循环**。

**签名**（SDK 的 `AgentSession.prompt`）：

```typescript
prompt(text: string, options?: PromptOptions): Promise<void>

interface PromptOptions {
    expandPromptTemplates?: boolean             // 默认 true，展开文件式 prompt 模板
    images?: ImageContent[]                     // 附图
    streamingBehavior?: "steer" | "followUp"    // 流式时必填
    source?: InputSource                        // 默认 "interactive"
}

type InputSource = "interactive" | "rpc" | "extension"
```

**这一行做了 4 件事**（按 SDK 文档）：

1. 若文本是扩展命令（`pi.registerCommand` 注册的），立刻执行，不入 LLM
2. 默认展开 `/skill:xxx` 和文件式 prompt 模板
3. 校验 model / API key，发请求
4. **阻塞 Promise 直到整轮 agent 完成**——包括所有 LLM 调用 + 工具执行 + 最后的 `stopReason`

期间 session 持续发事件，前面 `session.subscribe(handler)` 那条订阅把事件流写进 stdout。`prompt` resolve 之后才会执行 `[done]` 和 `dispose`。

**`source: "interactive"` 是什么**：是给扩展的标签——触发 `input` 事件时附在 `InputEvent.source` 上，让监听的扩展能区分输入来自哪里：

| 值 | 含义 |
|---|---|
| `"interactive"` | 用户在交互终端里敲的（默认） |
| `"rpc"` | 通过 RPC 通道（外部程序调用）来的 |
| `"extension"` | 另一个扩展内部生成的 |

Solver 跑在 headless CLI 里，没人真的在敲终端，严格说更接近 `rpc` 语义。但 SDK 默认就是 `interactive`，这里显式写出来可读性更好；后续课时（课时 8 RPC 握手）会把这里改成 `"rpc"`。

> 💡 **`await` 会一直阻塞**：包括所有工具调用。期间事件回调在并发地往 stdout 打日志——这就是为什么上面 `subscribe` 必须先于 `prompt` 调用，否则会漏掉开局事件。

---

## 第四步：配置一个真实可用的环境

本项目跑智谱 GLM（走 anthropic 兼容端点 `https://open.bigmodel.cn/api/anthropic`）。我们要让 SDK 用**真实的 glm model 名**（glm-5 / glm-5.2），而不是发 `claude-*` 让网关兜底映射——后者实际跑的 model 不可预测。

`applyProviderPrefs` 支持两种注册模式：

| 模式 | 触发条件 | 行为 |
|---|---|---|
| **A. full registration** | provider-prefs entry 带 `models` 字段 | 注册全新 provider（name 可任意），每个 model 用合理默认元数据注册成 ModelRegistry 实体 |
| **B. override-only** | provider-prefs entry 不带 `models` | name 必须是 SDK 内置 provider（anthropic/openai/...），替换 baseUrl 复用 SDK 自带 model 列表 |

GLM 用模式 A——provider 名 `glm`，自定义 model 列表 `[glm-5, glm-5.2]`。

> 🔒 **API Key 安全**：所有 key 写到 `~/.tch-agent/config/auth.json`（已 gitignore）。**永远不要**把 key 写进代码、测试、commit message、文档示例。

### 4.1 加 API Key

```bash
# 替换成你的真实 token（智谱 anthropic 兼容端点）
# 注意：key 名要和下一步 provider 名一致（都是 glm）
bun run apps/cli/src/main.ts config api-keys set glm <your-token>
```

写入 `~/.tch-agent/config/auth.json`。applyProviderPrefs 注册时会按 provider 名查 AuthStorage 把 key 传给 SDK（SDK 校验 full registration 必须带 apiKey）。

### 4.2 加 Provider 偏好（full registration + 自定义 model 列表）

```bash
bun run apps/cli/src/main.ts config providers add \
  --id glm \
  --name glm \
  --api anthropic-messages \
  --base-url https://open.bigmodel.cn/api/anthropic \
  --model glm-5 \
  --model glm-5.2
```

`--model` 可重复，每个会成为 ModelRegistry 里 `glm` provider 下的真实 Model 实体。ConfigManager.initialize 时 `applyProviderPrefs` 会调：

```ts
this.models.registerProvider("glm", {
    baseUrl: "https://open.bigmodel.cn/api/anthropic",
    api: "anthropic-messages",
    apiKey: <从 auth.json 读>,      // SDK 校验要求
    models: [
        { id: "glm-5",   name: "glm-5",   reasoning: false, input: ["text","image"],
          cost: { ...0 }, contextWindow: 128000, maxTokens: 16384 },
        { id: "glm-5.2", name: "glm-5.2", ... },
    ],
})
```

默认元数据（contextWindow / maxTokens / cost）是合理猜测，够用；要精确值以后扩展 `--model` 选项支持 per-model 参数即可。

### 4.3 加 Model 偏好

```bash
bun run apps/cli/src/main.ts config model-prefs add \
  --id main-glm \
  --provider glm \
  --model-id glm-5
```

`--provider` 必须匹配上一步的 provider 名（`glm`）；`--model-id` 必须是 provider 的 models 列表里的（`glm-5` 或 `glm-5.2`）。

### 4.4 让 SOLVER prompt 用这个 model

编辑 `~/.tch-agent/config/prompts/SOLVER.md`，加一行 `model: main-glm`：

```markdown
---
description: General-purpose solver for any task
model: main-glm
tools:
  - read
  - bash
  - write
  - edit
  - grep
  - ls
---

You are a helpful agent...
```

---

## 第四点五步：四个配置属性之间的关系

刚配完四层东西——`api-keys` / `providers` / `model-prefs` / `SOLVER.md`——它们是怎么串起来的？为什么分这么多层？

### 实际存储长什么样

```
~/.tch-agent/config/
├── auth.json            ← SDK 凭证库（按 provider 名存 key）
├── provider-prefs.json  ← provider 注册说明（baseUrl / api / 自定义 model 列表）
├── model-prefs.json     ← 用户起的别名 → (provider, modelId)
└── prompts/SOLVER.md    ← 引用别名
```

按第四步配完后：

**auth.json**
```json
{ "glm": { "type": "api_key", "key": "<your-token>" } }
```

**provider-prefs.json**
```json
[{
  "id": "glm",
  "name": "glm",                                    ← SDK 认的 provider key
  "api": "anthropic-messages",
  "baseUrl": "https://open.bigmodel.cn/api/anthropic",
  "models": ["glm-5", "glm-5.2"]                    ← 真实 model 名
}]
```

**model-prefs.json**
```json
[{
  "id": "main-glm",     ← 用户起的别名
  "provider": "glm",    ← 指向上面的 name
  "modelId": "glm-5"    ← 指向上面 models 里的某一项
}]
```

**SOLVER.md**
```yaml
model: main-glm   ← 指向上面的别名
```

### 运行时的链式查找

跑 `solver -p SOLVER "..."` 时，`resolvePromptSession` 这样穿起来：

```
SOLVER.md 的 "model: main-glm"
        │
        ▼ resolvePromptSession 读 frontmatter
        │
  找 model-prefs.json 里 id="main-glm"
        │  → 得到 { provider: "glm", modelId: "glm-5" }
        ▼ resolveModelPref
        │
  在 ModelRegistry 里查 provider="glm" + id="glm-5"
        │  → 得到 SDK 的 Model<Api> 实体（含 baseUrl/api 元数据）
        ▼
  createAgentSession({ model, authStorage, ... })
        │
  SDK 发请求时按 model.provider 去 AuthStorage 取 key
        │  → auth.json["glm"].key
        ▼
  POST https://open.bigmodel.cn/api/anthropic/v1/messages
       Authorization: Bearer <token>
       body: { model: "glm-5", ... }
```

> 💡 **ModelRegistry 不是从文件查的**——是 `ConfigManager.initialize` 启动时调 `applyProviderPrefs`，把 provider-prefs + auth.json 合起来调 SDK 的 `registerProvider` 提前注册到内存。所以运行时 ModelRegistry 已经有 glm/glm-5 这个实体了。

### 四个"必须一致"

任何一处名字对不上都会断链：

| 错配 | 表现 |
|---|---|
| `auth.json` 的 key 名 ≠ provider-prefs 的 `name` | `applyProviderPrefs` 注册时报 `"apiKey" is required when defining models` |
| provider-prefs 的 `name` ≠ model-prefs 的 `--provider` | `resolveModelPref` 报 `model not registered: <provider>/<modelId>` |
| model-prefs 的 `--model-id` 不在 provider-prefs 的 `models[]` 里 | 同上（ModelRegistry 找不到这个 modelId） |
| SOLVER.md 的 `model:` ≠ model-prefs 的 `id` | `resolvePromptSession` 报 `model pref not found: <name>` |

### 为什么分四层、不直接 SOLVER.md 里写 `model: glm/glm-5`

每层都有独立变化的理由：

| 层 | 变什么 | 不影响谁 |
|---|---|---|
| **auth.json** | 换 token / 轮转 | 不动其他文件——SDK 拿新 key 继续跑 |
| **provider-prefs** | 换网关 / 加新 model | SOLVER.md 不用改；多个 model-pref 共享一个 provider |
| **model-prefs** | 同一个别名换底层 model（glm-5 → glm-5.2） | SOLVER.md 不用改 |
| **SOLVER.md `model:`** | 这个 prompt 用哪个别名 | 其他 prompt 不受影响 |

**举例**：你想让 SOLVER 从 glm-5 升级到 glm-5.2，只改一行：

```bash
bun run apps/cli/src/main.ts config model-prefs remove main-glm
bun run apps/cli/src/main.ts config model-prefs add --id main-glm --provider glm --model-id glm-5.2
```

SOLVER.md 一个字都不用动——因为 prompt 只认别名 `main-glm`。

这就是分层的好处：**每一层只关心下一层的接口，不耦合实现细节**。

---

## 第五步：验证

### 5.1 跑第一个任务

```bash
bun run apps/cli/src/main.ts solver --prompt SOLVER "ls /tmp 然后总结你看到了什么"
```

**预期输出**（具体内容取决于 LLM）：

```
[init] solverId=abc12345
[init] prompt=SOLVER
[start] task: ls /tmp 然后总结你看到了什么

[tool_call] bash({"command":"ls -la /tmp"})
[tool_result] lrwxr-xr-x  ...  /tmp -> private/tmp
[tool_call] bash({"command":"ls -la /private/tmp"})
[tool_result] total 64
...
[assistant] /tmp 目录主要包含 ...（一句话总结）
[agent_end] stopReason=stop

[done] session ended
```

> 💡 **stopReason 是 `stop` 不是 `end_turn`**：智谱 anthropic-compat 端点返回的 stop reason 是 `stop`（不是 Anthropic 标准的 `end_turn`）。SDK 透传，代码不要 hardcode 假设。

### 5.2 试复杂任务

```bash
bun run apps/cli/src/main.ts solver --prompt SOLVER \
  "在 /tmp 下创建一个 hello.txt 文件，内容是 'hello world'，然后读出来给我看"
```

应该能看到 LLM 调 write 工具 → 调 read 工具 → 总结结果。

### 5.3 看对话历史落盘

```bash
ls ~/.tch-agent/solvers/
# 看到一个 8 字符 ID 目录

ls ~/.tch-agent/solvers/<id>/session/
# 看到一个或多个 .jsonl 文件

head -2 ~/.tch-agent/solvers/<id>/session/*.jsonl
# 第二行 model_change 应该是 provider+modelId 都是你配的（如 glm/glm-5），
# 不是 anthropic/claude-sonnet-4-5（那是 override-only + 兜底映射的征兆）
```

### 5.4 类型检查

```bash
bun run typecheck
```

---

## 第六步：故障排查

### 问题 1：`model not registered: glm/glm-5`

**原因**：三种可能：
- provider-prefs 里没有 `name: "glm"` 的 entry
- entry 的 `name` 和 model-prefs 的 `--provider` 不一致
- ConfigManager 是单例，改了 provider-prefs 后没新起进程

**解决**：核对三处名字一致，然后**新起一个进程**（重新跑命令）：

```bash
bun run apps/cli/src/main.ts config providers list
# 确认有 glm 条目，且 MODELS 列含 glm-5

bun run apps/cli/src/main.ts config model-prefs list
# 确认 main-glm 的 PROVIDER 是 glm、MODEL_ID 是 glm-5
```

### 问题 2：`[warn] failed to register provider "glm": "apiKey" or "oauth" is required when defining models`

**原因**：full registration 模式 SDK 要求带 `apiKey`。`applyProviderPrefs` 按 provider 名查 AuthStorage——你设的 api-key 名必须和 provider 名一致。

**解决**：把 key 设到对应 provider 名下：

```bash
bun run apps/cli/src/main.ts config api-keys set glm <your-token>
```

然后再跑命令（新进程）。auth.json 里的 key 名要和 provider-prefs.json 里的 `name` 字段完全一致。

### 问题 3：跑起来但 `model_change` 里 modelId 是 `claude-*` 不是 `glm-*`

**原因**：还在走 override-only + bigmodel 兜底映射。你之前可能用 lesson 旧版本配过 anthropic provider pref。

**解决**：删掉旧的 anthropic provider pref，按第四步重新配 glm：

```bash
bun run apps/cli/src/main.ts config providers remove anthropic
```

然后 `cat ~/.tch-agent/solvers/<id>/session/*.jsonl | head -2`，第二行 `model_change` 应该是 `"provider":"glm","modelId":"glm-5"`。

### 问题 4：跑起来但 LLM 没调工具

**原因**：要么 model 不支持 tool calling，要么 prompt.meta.tools 漏了。

**解决**：
- 确认 `prompt show SOLVER` 输出的 `tools:` 行包含 `bash`
- glm-5 / glm-5.2 都支持 tool calling
- 在 prompt 里强化："You MUST use tools to interact with the environment."

### 问题 5：`cannot add command 'solver' as already have command 'solver'`

**原因**：commander 把 `.command("solver list")` 当成名为 `solver` 的命令注册了，和 `.command("solver")` 冲突。

**解决**：删掉 `solver list` 子命令（lesson 4 的 `config prompts list` 已经能列 prompt）。

### 问题 5：`Property 'sourceInfo' is missing in type ... PromptTemplate`

**原因**：SDK 升级后 `PromptTemplate` 接口把 `sourceInfo` 设成必填。

**解决**：在 `toPromptTemplate` 里用 SDK 的 `createSyntheticSourceInfo` 填上（lesson 4 已修复，详见 [04-prompt-loader.md](./04-prompt-loader.md)）。

### 问题 6：跑完后 session.dispose() 报错

**原因**：可能在事件回调里抛错。

**解决**：包一层 try-catch：

```typescript
session.subscribe((event) => {
    try {
        printEvent(event)
    } catch (error) {
        console.error("[event-handler-error]", error)
    }
})
```

---

## 本课小结

✅ **你已完成**：

- 实现 resolvePromptSession（Prompt → AgentSessionOptions）
- 实现 createSolverSession（装配 + bindExtensions）
- 实现 runSolverCli（事件流输出）
- 跑通"LLM 调 bash 工具"
- 看到对话历史落盘到 JSONL

📦 **新增文件**：

```
packages/core/src/solver/session.ts     ← createSolverSession
packages/core/src/solver/cli.ts         ← runSolverCli
```

🔑 **关键概念**：

- **AgentSession**：SDK 的核心对象，一个独立对话会话。
- **事件流 subscribe**：实时拿到 LLM 的思考、工具调用、结果。
- **resolvePromptSession**：把用户配置（prompt + model pref + tools）翻译成 SDK 选项。
- **JSONL 落盘**：对话历史按行存为 JSON，便于后续分析。

---

## 阶段 1 完结 🎉

恭喜！阶段 1（课时 1-5）全部完成。你已经能：

1. 用 Bun 搭出 monorepo
2. 配置 SDK 三件套
3. 写 Prompt 文件
4. 在本地跑一个能调工具的 LLM agent

**阶段 2 预告**（课时 6-10）：把这个 agent 跑进 Docker 容器，加上 stdin/stdout RPC 通信，搭出 Web UI 雏形。

---

## 下一课预告

[课时 6：Docker 镜像 + Dockerfile](./06-docker-image.md)（待生成）—— 我们会：

- 写 Dockerfile 做出 solver 镜像
- 实现 ensureImage（自动构建 + 增量构建）
- 实现 resolveSolverInjection（决定容器内用什么 binary）
- 验证镜像能跑

继续课时 6 →
