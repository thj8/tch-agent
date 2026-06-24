# 课时 8：Solver RPC 协议 + init 握手

> 🎯 **目标**：实现宿主 ↔ 容器的 stdin/stdout JSONL 通信，让容器内的 LLM 真的能跑。
>
> ⏰ **预计耗时**：3-4 小时（本阶段最复杂的一课）
>
> 📋 **难度**：⭐⭐⭐⭐⭐

---

## 你将学到什么

1. **JSONL 协议设计**（按行分隔的 JSON 通信）
2. **stdin/stdout 全双工通信的技巧**
3. **init 握手协议**（防止容器还没准备好就收到命令）
4. **pi-coding-agent SDK 的事件流类型**

## 前置条件

✅ 已完成 [课时 1-7](./README.md)

## 最终效果

```bash
tch-agent runtime launch --prompt SOLVER "ls /tmp"
# → 容器启动 + init 握手成功
# → LLM 开始调工具，事件流实时打到 stdout
# → 看到 [assistant] / [tool_call] / [tool_result] 等事件
# → LLM 结束后容器退出
```

---

## 第零步：概念扫盲

### 0.1 为什么需要 RPC 协议？

课时 7 我们让容器跑起来，但**宿主和容器之间不能通信**：
- 宿主写 stdin，容器没读
- 容器往 stdout 写，宿主只是 print 不理解

我们需要一套**协议**让双方能对话。这节课设计 RPC 协议。

### 0.2 为什么用 JSONL？

**JSONL = JSON Lines = 每行一个 JSON**

```
{"type":"prompt","message":"hello"}
{"type":"response","command":"init","success":true}
{"type":"tool_execution_end","toolName":"bash",...}
```

**为什么不用 TCP / WebSocket / HTTP？**

| 协议 | 复杂度 | 适用 |
|---|---|---|
| **stdin/stdout + JSONL** | 简单 | 父子进程通信 |
| TCP socket | 中等 | 网络进程通信 |
| WebSocket | 高 | 浏览器 / Web 通信 |
| HTTP REST | 高 | 客户端 / 服务器 |

我们的场景是"宿主 spawn 容器"，stdin/stdout 是天然的双向管道，**不需要额外开端口**。JSONL 让协议简单且结构化。

### 0.3 协议设计

```
┌─ Host ───────────────────────────────┐    ┌─ Container ──────────────────┐
│                                      │    │                              │
│  1. 写 stdin：SolverInitPayload      │───▶│  读第一行 → createSolverSession│
│                                      │    │                              │
│                                      │◀───│  写 stdout：init success      │
│                                      │    │                              │
│  2. 写 stdin：RpcCommand (prompt)    │───▶│  session.prompt(message)      │
│                                      │    │                              │
│                                      │◀───│  写 stdout：AgentSessionEvent │
│                                      │◀───│  写 stdout：AgentSessionEvent │
│                                      │◀───│  ...（流式）                  │
│                                      │    │                              │
│  3. 写 stdin：RpcCommand (steer)     │───▶│  session.steer(...)           │
│  ...                                 │    │  ...                          │
└──────────────────────────────────────┘    └──────────────────────────────┘
```

**消息类型**：

- **SolverInitPayload**（宿主 → 容器，第一行）：告诉容器"你是谁、要做什么"。
- **init success / failure**（容器 → 宿主）：握手结果。
- **RpcCommand**（宿主 → 容器）：prompt / steer / follow_up / abort / ...
- **AgentSessionEvent**（容器 → 宿主）：LLM 的事件流（tool_call / message_end / agent_end / ...）。
- **RpcResponse**（容器 → 宿主）：命令的同步应答。

### 0.4 init 握手的必要性

如果不握手：

```
宿主 → 容器：prompt("ls /tmp")   ← 容器还没准备好，丢失！
容器：(初始化中...)
容器：好了，等命令   ← 已经错过了
```

握手保证：**宿主确认容器就绪后才开始发命令**。

握手协议：

1. 容器启动后，**第一件事是读 stdin 第一行**（SolverInitPayload）。
2. 容器用 init 信息创建 AgentSession。
3. 容器写 stdout：`{ command: "init", success: true }`。
4. 宿主收到这个消息后才认为容器就绪，开始发后续命令。

---

## 第一步：定义 RPC 类型

### 1.1 创建 packages/core/src/solver/rpc/rpc-types.ts

```bash
mkdir -p packages/core/src/solver/rpc
```

新建 `packages/core/src/solver/rpc/rpc-types.ts`：

```typescript
import type { ThinkingLevel } from "@mariozechner/pi-agent-core"

/**
 * Solver 启动载荷（宿主 → 容器，stdin 第一行）。
 *
 * 容器拿到这个后调 createSolverSession。
 */
export interface SolverInitPayload {
    /** 8 字符 solver ID */
    solverId: string
    /** 用哪个 prompt */
    promptName: string
    /** 初始 task */
    task: string
    /** challenge 模式下的题目 ID（可选） */
    challengeId?: string
}

/**
 * 宿主 → 容器的所有命令。
 *
 * 每条命令有可选 `id`，用于在 RpcResponse 里配对。
 */
export type RpcCommand =
    // Prompting
    | { id?: string; type: "prompt"; message: string; streamingBehavior?: "steer" | "followUp" }
    | { id?: string; type: "steer"; message: string }
    | { id?: string; type: "follow_up"; message: string }
    | { id?: string; type: "abort" }
    // State
    | { id?: string; type: "get_state" }
    // Model
    | { id?: string; type: "set_model"; provider: string; modelId: string }
    | { id?: string; type: "cycle_model" }
    | { id?: string; type: "get_available_models" }
    // Thinking
    | { id?: string; type: "set_thinking_level"; level: ThinkingLevel }
    | { id?: string; type: "cycle_thinking_level" }
    // Bash
    | { id?: string; type: "bash"; command: string }
    | { id?: string; type: "abort_bash" }
    // Session
    | { id?: string; type: "get_messages" }
    | { id?: string; type: "get_session_stats" }

/**
 * 容器 → 宿主的命令应答。
 */
export type RpcResponse =
    | { id?: string; type: "response"; command: string; success: true; data?: unknown }
    | { id?: string; type: "response"; command: string; success: false; error: string }
```

### 1.2 创建 JSONL 工具

新建 `packages/core/src/solver/rpc/jsonl.ts`：

```typescript
import { StringDecoder } from "node:string_decoder"
import type { Readable } from "node:stream"

/**
 * 把任意值序列化成 `JSON\n` 一行。
 */
export function serializeJsonLine(value: unknown): string {
    return `${JSON.stringify(value)}\n`
}

/**
 * 把一个 Readable 流按行切分，每读到一行就调用 onLine。
 *
 * 处理两个边界情况：
 *   1. 一个 chunk 可能含多行 / 半行（甚至半字符，因为 UTF-8 多字节字符可能被切断）
 *      用 StringDecoder 处理跨 chunk 的多字节字符。
 *   2. 最后一个 chunk 可能没有 trailing newline；在 stream end 时 flush。
 *
 * @returns 取消订阅函数
 */
export function attachJsonlLineReader(
    stream: Readable,
    onLine: (line: string) => void,
): () => void {
    const decoder = new StringDecoder("utf8")
    let buffer = ""

    const onData = (chunk: string | Buffer) => {
        buffer += typeof chunk === "string" ? chunk : decoder.write(chunk)
        while (true) {
            const idx = buffer.indexOf("\n")
            if (idx === -1) return
            const line = buffer.slice(0, idx)
            buffer = buffer.slice(idx + 1)
            onLine(line.endsWith("\r") ? line.slice(0, -1) : line)
        }
    }

    const onEnd = () => {
        buffer += decoder.end()
        if (buffer.length > 0) {
            onLine(buffer)
            buffer = ""
        }
    }

    stream.on("data", onData)
    stream.on("end", onEnd)

    return () => {
        stream.off("data", onData)
        stream.off("end", onEnd)
    }
}
```

---

## 第二步：实现容器内 RPC server

### 2.1 创建 packages/core/src/solver/rpc/rpc-server.ts

新建 `packages/core/src/solver/rpc/rpc-server.ts`：

```typescript
/**
 * Solver RPC server —— 跑在容器内。
 *
 * Bootstrap：
 *   1. 读 stdin 第一行 JSONL → SolverInitPayload
 *   2. createSolverSession
 *   3. 输出 `{ command: "init", success: true }` 告诉宿主"我准备好了"
 *
 * 之后进入命令循环：
 *   - stdin 每行 = RpcCommand → dispatch
 *   - AgentSession 事件 → stdout 推送
 */

import type { AgentSession, AgentSessionEvent } from "@mariozechner/pi-coding-agent"
import { createSolverSession } from "../session"
import type { SolverInitPayload, RpcCommand, RpcResponse } from "./rpc-types"
import { serializeJsonLine, attachJsonlLineReader } from "./jsonl"

// ── 输出辅助 ──────────────────────────────────────────────

/** 把任意值写到 stdout（一行 JSONL） */
function output(value: unknown): void {
    process.stdout.write(serializeJsonLine(value))
}

/** 成功响应 */
function success(id: string | undefined, command: string, data?: unknown): RpcResponse {
    if (data === undefined) return { id, type: "response", command, success: true }
    return { id, type: "response", command, success: true, data }
}

/** 失败响应 */
function error(id: string | undefined, command: string, message: string): RpcResponse {
    return { id, type: "response", command, success: false, error: message }
}

/**
 * 决定一个事件是否要转发给宿主。
 *
 * - message_update（流式 token 增量）不发：流量太大。
 * - tool_execution_update 只转发 subagent：其他工具中间进度噪音大。
 */
function shouldForwardEvent(event: AgentSessionEvent): boolean {
    if (event.type === "message_update") return false
    if (event.type === "tool_execution_update") {
        return event.toolName === "subagent"
    }
    return true
}

// ── 主入口 ────────────────────────────────────────────────

/**
 * 启动 RPC server。永不返回（直到进程退出）。
 */
export async function runSolverRpc(): Promise<never> {
    // 1. Bootstrap：读 stdin 第一行作为 SolverInitPayload
    const raw = await new Promise<string>((resolve, reject) => {
        const detach = attachJsonlLineReader(process.stdin, (line) => {
            detach()
            resolve(line)
        })
        process.stdin.on("end", () => reject(new Error("stdin closed before init")))
    })

    let init: SolverInitPayload
    try {
        init = JSON.parse(raw) as SolverInitPayload
    } catch {
        output(error(undefined, "init", `invalid JSON: ${raw.slice(0, 100)}`))
        process.exit(1)
    }
    if (!init.solverId || !init.promptName) {
        output(error(undefined, "init", "missing solverId or promptName"))
        process.exit(1)
    }

    // 2. 创建 AgentSession
    let session: AgentSession
    try {
        const result = await createSolverSession({
            solverId: init.solverId,
            promptName: init.promptName,
            task: init.task,
        })
        session = result.session
    } catch (err) {
        output(error(undefined, "init", err instanceof Error ? err.message : String(err)))
        process.exit(1)
    }

    // 3. 订阅事件流，转发到 stdout
    session.subscribe((event: AgentSessionEvent) => {
        if (!shouldForwardEvent(event)) return
        output(event)
    })

    // 4. init 成功响应
    output(success(undefined, "init"))

    // 5. 立刻发起首轮 prompt（用 task）
    session.prompt(init.task, { source: "rpc" }).catch((err) => {
        output(error(undefined, "solver", err instanceof Error ? err.message : String(err)))
        session.dispose()
        process.exit(1)
    })

    // 6. 进入命令循环
    attachJsonlLineReader(process.stdin, (line) => {
        void handleInputLine(session, line)
    })

    // stdin 关闭 = 宿主断了，优雅退出
    process.stdin.on("end", () => {
        session.dispose()
        process.exit(0)
    })

    return new Promise(() => {})  // 永不返回
}

/** 解析一行 JSON 命令并分发 */
async function handleInputLine(session: AgentSession, line: string): Promise<void> {
    let cmd: RpcCommand
    try {
        cmd = JSON.parse(line) as RpcCommand
    } catch (e: unknown) {
        output(error(undefined, "parse", `invalid JSON: ${line.slice(0, 100)}`))
        return
    }

    const response = await handleCommand(session, cmd)
    output(response)
}

/** 命令分发器 */
async function handleCommand(session: AgentSession, cmd: RpcCommand): Promise<RpcResponse> {
    const id = cmd.id

    switch (cmd.type) {
        case "prompt": {
            session.prompt(cmd.message, { source: "rpc" }).catch((e: Error) => {
                output(error(id, "prompt", e.message))
            })
            return success(id, "prompt")
        }

        case "steer": {
            await session.steer(cmd.message)
            return success(id, "steer")
        }

        case "follow_up": {
            await session.followUp(cmd.message)
            return success(id, "follow_up")
        }

        case "abort": {
            await session.abort()
            return success(id, "abort")
        }

        case "get_state": {
            return success(id, "get_state", {
                model: session.model,
                thinkingLevel: session.thinkingLevel,
                isStreaming: session.isStreaming,
                messageCount: session.messages.length,
            })
        }

        case "get_messages": {
            return success(id, "get_messages", { messages: session.messages })
        }

        case "set_model": {
            const models = await session.modelRegistry.getAvailable()
            const model = models.find(
                (m) => m.provider === cmd.provider && m.id === cmd.modelId,
            )
            if (!model) {
                return error(id, "set_model", `Model not found: ${cmd.provider}/${cmd.modelId}`)
            }
            await session.setModel(model)
            return success(id, "set_model", model)
        }

        case "set_thinking_level": {
            session.setThinkingLevel(cmd.level)
            return success(id, "set_thinking_level")
        }

        case "bash": {
            const result = await session.executeBash(cmd.command)
            return success(id, "bash", result)
        }

        default: {
            const unknown = cmd as { type: string }
            return error(id, unknown.type, `Unknown command: ${unknown.type}`)
        }
    }
}
```

### 2.2 在 packages/core/src/solver/cli.ts 加 re-export

修改 `packages/core/src/solver/cli.ts`，在文件末尾追加：

```typescript
export { runSolverRpc } from "./rpc/rpc-server"
```

### 2.3 在 apps/cli/src/main.ts 加 rpc 子命令

在已有的 `solver` 命令后追加：

```typescript
// ── solver rpc 子命令 ──────────────────────────────────

const solverCmd = program.command("solver").description("Solver entry points")

solverCmd
    .command("rpc")
    .description("Start RPC server (reads JSONL from stdin) — runs inside container")
    .action(async () => {
        const { runSolverRpc } = await import("@my/core")
        try {
            await runSolverRpc()
        } catch (error) {
            console.error("[rpc] fatal:", error)
            process.exit(1)
        }
    })
```

> 💡 注意：原来在 program.command("solver") 那里改成 solverCmd.command("rpc") 嵌套。

---

## 第三步：修改 RuntimeManager.launch 做 init 握手

### 3.1 修改 packages/core/src/runtime/runtime.ts 的 launch 方法

把课时 7 的 `readStream` 简化版替换为带 init 握手的完整版：

```typescript
// 顶部加 import
import type { SolverInitPayload } from "../solver/rpc/rpc-types"

// 修改 launch 方法的尾部：

async launch(
    promptName: string,
    task: string,
    solverEnv: Record<string, string> = {},
): Promise<SolverInstance> {
    // ... 前面的目录准备、binds 组装、launch 命令拼装保持不变 ...

    // 拉起容器
    const proc = Bun.spawn(args, {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
    })

    this.procs.set(id, proc)
    solver.status = "running"

    // 启动 stdout 监听（返回一个在 init 成功时 resolve 的 Promise）
    const initReady = this.readStream(id, proc)

    // 写 SolverInitPayload 到容器 stdin
    const initPayload: SolverInitPayload = {
        solverId: id,
        promptName,
        task,
        ...(solver.challengeId ? { challengeId: solver.challengeId } : {}),
    }
    proc.stdin.write(JSON.stringify(initPayload) + "\n")

    // 等 init success（最多 30 秒）
    await Promise.race([
        initReady,
        new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("solver init timeout (30s)")), 30_000),
        ),
    ])

    return solver
}

/**
 * 读容器的 stdout，做两件事：
 *   1. 等第一条 init 响应（initReady Promise）
 *   2. 后续每行作为事件转发给 event handler
 */
private readStream(
    solverId: string,
    proc: Subprocess<"pipe", "pipe", "pipe">,
): Promise<void> {
    const decoder = new TextDecoder()

    let resolveInit!: () => void
    let rejectInit!: (err: Error) => void
    const initReady = new Promise<void>((res, rej) => {
        resolveInit = res
        rejectInit = rej
    })

    let initResolved = false

    ;(async () => {
        const reader = proc.stdout.getReader()
        let buffer = ""
        try {
            while (true) {
                const { done, value } = await reader.read()
                if (done) break
                buffer += decoder.decode(value, { stream: true })

                while (true) {
                    const idx = buffer.indexOf("\n")
                    if (idx === -1) break
                    const line = buffer.slice(0, idx).trim()
                    buffer = buffer.slice(idx + 1)
                    if (!line) continue

                    // 解析 JSON
                    let event: unknown
                    try {
                        event = JSON.parse(line)
                    } catch {
                        console.warn(`[${solverId}] non-JSON stdout: ${line}`)
                        continue
                    }

                    // 第一条响应必须是 init
                    if (!initResolved) {
                        const response = event as { type?: string; command?: string; success?: boolean; error?: string }
                        if (response.type === "response" && response.command === "init") {
                            initResolved = true
                            if (response.success) {
                                resolveInit()
                            } else {
                                rejectInit(new Error(response.error || "init failed"))
                            }
                            continue
                        }
                        // 不是 init 响应就当普通事件
                    }

                    // 转发给事件 handler
                    this.emit(solverId, event as Parameters<RuntimeManager["emit"]>[1])
                }
            }
        } catch (error) {
            if (!initResolved) rejectInit(error as Error)
        }

        // 流结束 = 容器退出
        const exitCode = await proc.exited
        const solver = this.solvers.get(solverId)
        if (solver && solver.status !== "stopped") {
            solver.status = exitCode === 0 ? "stopped" : "error"
            if (exitCode !== 0) {
                solver.error = `Container exited with code ${exitCode}`
            }
        }
        this.procs.delete(solverId)
    })()

    // 也监听 stderr
    if (proc.stderr) {
        const errReader = proc.stderr.getReader()
        ;(async () => {
            while (true) {
                const { done, value } = await errReader.read()
                if (done) break
                const text = decoder.decode(value)
                console.error(`[${solverId}][stderr] ${text.trim()}`)
            }
        })()
    }

    return initReady
}

/**
 * 给指定 solver 容器发 RPC 命令。
 */
sendCommand(solverId: string, command: unknown): void {
    const proc = this.procs.get(solverId)
    if (!proc) throw new Error(`No process for solver ${solverId}`)
    proc.stdin.write(JSON.stringify(command) + "\n")
}
```

### 3.2 关键设计点

#### initReady Promise

```typescript
let resolveInit!: () => void
let rejectInit!: (err: Error) => void
const initReady = new Promise<void>((res, rej) => {
    resolveInit = res
    rejectInit = rej
})
```

这是经典的 "external promise" 模式：把 resolve/reject 函数提取到外面，让 readStream 内部能控制 Promise 的状态。

#### 30 秒超时

```typescript
await Promise.race([
    initReady,
    new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("solver init timeout (30s)")), 30_000),
    ),
])
```

防止容器卡死时宿主永远等下去。

#### emit 转发

```typescript
this.emit(solverId, event as ...)
```

把解析出来的 AgentSessionEvent 转发给所有 event handler（本课时还没人订阅，但留好接口给后续课时用）。

---

## 第四步：验证

### 4.1 本地端到端测试（不走 Docker）

先在本地跑 RPC server，验证协议本身正确：

```bash
# 终端 1：启动 RPC server
echo '{"solverId":"test1","promptName":"SOLVER","task":"say hi"}' | bun run apps/cli/src/main.ts solver rpc
```

**预期输出**：

```json
{"id":null,"type":"response","command":"init","success":true}
{"type":"message_start",...}
{"type":"tool_execution_start",...}
{"type":"tool_execution_end",...}
{"type":"message_end",...}
{"type":"agent_end",...}
```

（具体事件取决于 LLM 怎么响应。）

### 4.2 Docker 端到端测试

重新 build solver binary：

```bash
bun run build:solver
```

跑 launch：

```bash
bun run apps/cli/src/main.ts runtime launch --prompt SOLVER "ls /tmp 然后总结"
```

**预期**：

```
[runtime] launching solver abc12345...
[runtime] cmd: docker run -i ...

[abc12345][stderr] Challenge observer extension initialized  (如果配了 observer)
[abc12345] {"type":"message_start",...}
[abc12345] {"type":"tool_execution_start","toolName":"bash",...}
[abc12345] {"type":"tool_execution_end","toolName":"bash",...}
[abc12345] {"type":"message_end",...}
[abc12345] {"type":"agent_end",...}

[abc12345] container exited with code 0
```

### 4.3 检查对话历史落盘

```bash
ls ~/.tch-agent/solvers/<id>/session/
# 一个或多个 .jsonl 文件
```

### 4.4 类型检查

```bash
bun run typecheck
```

---

## 第五步：故障排查

### 问题 1：init 超时（30s）

**原因**：容器内 `runSolverRpc` 没正确响应 init。

**调试**：

```bash
# 手动测试容器
echo '{"solverId":"test","promptName":"SOLVER","task":"hi"}' | \
docker run -i --rm \
  -v ~/.tch-agent:/root/.tch-agent \
  -v ~/.tch-agent/runtime/self/tch-agent-linux-x64:/opt/tch-agent/tch-agent:ro \
  -v ~/.tch-agent/runtime/self/package.json:/opt/tch-agent/package.json:ro \
  tch-agent:latest \
  /opt/tch-agent/tch-agent solver rpc
```

应该看到 JSON 输出。如果没看到，问题在容器内。

### 问题 2：stdin 没数据传到容器

**原因**：Bun.spawn 时没设 `stdin: "pipe"`。

**解决**：检查 `Bun.spawn(args, { stdin: "pipe", ... })`。

### 问题 3：JSON 解析失败

**原因**：可能是容器内 Bun 启动时有 banner / warning 写到 stdout。

**解决**：用 `process.stdout.write` 而不是 `console.log`（后者会加换行）；保证启动时 stdout 完全干净。

### 问题 4：容器内找不到 binary

**原因**：挂载路径不对。

**调试**：

```bash
docker run -it --rm \
  -v ~/.tch-agent/runtime/self/tch-agent-linux-x64:/opt/tch-agent/tch-agent:ro \
  tch-agent:latest \
  bash

# 在容器里
$ ls -la /opt/tch-agent/
$ /opt/tch-agent/tch-agent --help
```

### 问题 5：SDK 报 `prompt not found`

**原因**：容器内看不到 `~/.tch-agent/config/prompts/SOLVER.md`。

**解决**：检查 `-v ~/.tch-agent:/root/.tch-agent` 挂载是否正确。

### 问题 6：API Key 找不到

**原因**：容器内看不到 `~/.tch-agent/config/auth.json`，或 auth.json 里没存 OpenAI 的 key。

**解决**：

```bash
# 在宿主上
bun run apps/cli/src/main.ts config api-keys list
# 如果没 openai，加上：
bun run apps/cli/src/main.ts config api-keys set openai sk-...
```

---

## 本课小结

✅ **你已完成**：

- 定义 JSONL RPC 协议（SolverInitPayload / RpcCommand / RpcResponse）
- 实现 attachJsonlLineReader（流式 JSONL 解析）
- 实现容器内 runSolverRpc（Bootstrap + 命令循环）
- 实现 init 握手（30s 超时保护）
- 端到端跑通"宿主 → 容器 → LLM 调工具 → 事件流回宿主"

📦 **新增文件**：

```
packages/core/src/solver/rpc/
├── rpc-types.ts       ← 协议类型
├── jsonl.ts           ← JSONL 解析工具
└── rpc-server.ts      ← runSolverRpc 主循环
```

🔑 **关键概念**：

- **JSONL 协议**：每行一个 JSON，适合父子进程通信。
- **init 握手**：保证容器准备好后才发命令。
- **external promise**：把 resolve/reject 提取出来，跨函数控制 Promise。
- **事件流过滤**：丢弃 message_update 等噪音事件，只转发重要事件。

---

## 下一课预告

[课时 9：Host Bridge —— solver 反查宿主](./09-host-bridge.md)（待生成）—— 我们会：

- 让容器内 solver 能向宿主发起请求（查 challenge 状态、提交 flag）
- 实现嵌套 RPC（host_bridge_request / response）
- 实现 ping action 验证通路

继续课时 9 →
