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
    builtinToolMap,
    type ToolDefinition,
} from "@mariozechner/pi-coding-agent"
import type { CreateAgentSessionOptions } from "@mariozechner/pi-coding-agent"
import type { ExtensionFactory } from "@mariozechner/pi-coding-agent"
import type { Model, Api } from "@mariozechner/pi-ai"
import type { ThinkingLevel } from "@mariozechner/pi-agent-core"

// 在 ConfigManager 类里追加：

/**
 * Prompt → AgentSessionOptions 的"装配函数"。
 *
 * 流程：
 *   1. 加载 prompt 文件
 *   2. 解析 model pref → Model<Api> + thinkingLevel
 *   3. 把 prompt.meta.tools 转成 SDK ToolDefinition[]
 *   4. 用 prompt.content 作为 systemPrompt
 *   5. 把外部传入的 extensionFactories 装进 ResourceLoader（SDK 规定）
 *
 * @param promptName prompt 名
 * @param extensions ExtensionFactory 数组（可选）。SDK 规定 extensions 必须通过
 *                   DefaultResourceLoader 注入，不是 createAgentSession 直接传。
 *                   `session.bindExtensions({})` 时才被调用。
 * @returns 找不到/disabled 返回 undefined
 */
async resolvePromptSession(
    promptName: string,
    extensions: ExtensionFactory[] = [],
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

    // 3. 解析 tools
    const toolNames = prompt.meta.tools ?? []
    const tools: ToolDefinition[] = []
    for (const name of toolNames) {
        const tool = builtinToolMap[name]
        if (tool) tools.push(tool)
    }

    // 4. 装配 ResourceLoader（含 systemPrompt + extensions）
    //    SDK 规定：extensions 必须通过 ResourceLoader 注入，不能直接传给 createAgentSession
    const resourceLoader = new DefaultResourceLoader({
        agentDir: this.dir,
        systemPromptOverride: () => prompt.content,
        extensionFactories: extensions,   // ← 后续课时会用
    })
    await resourceLoader.reload()

    // 5. 组装 CreateAgentSessionOptions
    const opts: CreateAgentSessionOptions = {
        tools,
        customTools: [],
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

#### 为什么 tools 字段是 `ToolDefinition[]` 而不是工具实例

SDK 的 `createAgentSession({ tools, customTools })`：
- `tools`：内置工具的**定义**（用于 schema 校验）。
- `customTools`：自定义工具的**实例**（含 execute 函数）。

我们这里只用内置工具，所以 `customTools: []`。

#### resolveModelPref 的边界情况

如果用户在 prompt 里写了 `model: work-gpt4` 但：
- `work-gpt4` 不在 model-prefs.json → 抛"not found"。
- `work-gpt4` 存在但 provider 没注册到 ModelRegistry → 抛"not registered"。

错误信息要清晰，方便用户排查。

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
import { createAgentSession, SessionManager } from "@mariozechner/pi-coding-agent"
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

    // 2. 装配 SDK 选项
    const sessionOpts = await config.resolvePromptSession(init.promptName)
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
            const reason = "stopReason" in event ? event.stopReason : "unknown"
            console.log(`[agent_end] stopReason=${reason}`)
            break
        }
        // 忽略其他事件（message_update 流式 token 等）
    }
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

program
    .command("solver list")
    .description("List available prompts (non-subagent)")
    .action(async () => {
        const { ConfigManager } = await import("@my/core")
        const config = await ConfigManager.getInstance()
        const prompts = await config.listAgentPrompts()
        if (prompts.length === 0) {
            console.log("(no prompts)")
            return
        }
        console.log("Available prompts:")
        for (const p of prompts) {
            const desc = p.meta.description ? ` - ${p.meta.description}` : ""
            console.log(`  ${p.name}${desc}`)
        }
    })
```

---

## 第四步：配置一个真实可用的环境

### 4.1 加 API Key

```bash
# 替换成你的真实 key
bun run apps/cli/src/main.ts config api-keys set openai sk-...
```

### 4.2 注册内置 OpenAI Provider（如果 SDK 没默认注册）

> 💡 SDK 通常默认注册 OpenAI / Anthropic，但需要确认。

### 4.3 加 Model 偏好

```bash
bun run apps/cli/src/main.ts config model-prefs add \
  --id default-gpt \
  --provider openai \
  --model-id gpt-4o-mini
```

### 4.4 让 SOLVER prompt 用这个 model

编辑 `~/.tch-agent/config/prompts/SOLVER.md`：

```markdown
---
description: General-purpose solver for any task
model: default-gpt
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

加一行 `model: default-gpt`。

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

[assistant] 我来用 ls 命令看看 /tmp 目录。
[tool_call] bash({"command":"ls /tmp"})
[tool_result] file1.txt
file2.txt
.cache
[assistant] /tmp 目录下有：
- file1.txt（文件）
- file2.txt（文件）
- .cache（隐藏目录）
[agent_end] stopReason=end_turn

[done] session ended
```

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

cat ~/.tch-agent/solvers/<id>/session/*.jsonl | head -5
# 看到对话历史（每行一个 JSON 事件）
```

### 5.4 类型检查

```bash
bun run typecheck
```

---

## 第六步：故障排查

### 问题 1：`model not registered: openai/gpt-4o-mini`

**原因**：SDK 的 ModelRegistry 还没注册 OpenAI provider。

**解决**：检查 SDK 是否需要手动注册。可以在 ConfigManager.initialize 加：

```typescript
// 注册内置 OpenAI provider
this.models.registerProvider("openai", {
    baseUrl: "https://api.openai.com/v1",
    apiKey: "openai",
    api: "openai-completions",
    models: [
        { id: "gpt-4o-mini", name: "GPT-4o mini", contextWindow: 128000, maxTokens: 16384 },
        // ...
    ],
})
```

### 问题 2：`AuthStorage has no key for "openai"`

**原因**：忘了 `config api-keys set openai sk-...`。

**解决**：跑那条命令。

### 问题 3：跑起来但 LLM 没调工具

**原因**：可能是 model 不支持 tool calling，或 prompt 没明确说"用工具"。

**解决**：
- 换支持 tool 的 model（gpt-4o-mini / claude-sonnet / glm-4 都支持）。
- 在 prompt 里强化："You MUST use tools to interact with the environment."

### 问题 4：tool_call 显示了但没 tool_result

**原因**：可能是 `builtinToolMap` 找不到对应工具。

**解决**：在 resolvePromptSession 里 print 一下：

```typescript
for (const name of toolNames) {
    const tool = builtinToolMap[name]
    if (!tool) console.warn(`Tool not found: ${name}`)
}
```

### 问题 5：`DefaultResourceLoader is not exported`

**原因**：SDK 版本不同，导出方式可能不同。

**解决**：

```bash
# 看 SDK 实际导出
grep -r "export" node_modules/@mariozechner/pi-coding-agent/dist/*.d.ts | grep -E "(DefaultResourceLoader|builtinToolMap|SessionManager)"
```

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
