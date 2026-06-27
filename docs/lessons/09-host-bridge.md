# 课时 9：Host Bridge —— solver 反查宿主

> 🎯 **目标**：让容器内 solver 能反向调用宿主方法（如查询配置、提交数据），实现宿主 ↔ 容器的双向通信。
>
> ⏰ **预计耗时**：2-3 小时
>
> 📋 **难度**：⭐⭐⭐⭐

---

## 你将学到什么

1. **嵌套 RPC 的设计**（在已有 RPC 上叠加 bridge）
2. **Promise 配对**（请求-响应异步映射）
3. **超时机制**（防止单个 bridge 请求卡死整个 solver）
4. **错误传播**（让容器看到清晰的失败原因）

## 前置条件

✅ 已完成 [课时 1-8](./README.md)

## 最终效果

容器内的 solver LLM 能调用 `ping_host` 工具，宿主收到请求处理后把结果推回容器：

```
[container] → {"type":"host_bridge_request","request_id":"abc-123","action":"ping","params":{}}
[host]      处理...
[host]      → {"type":"host_bridge_response","request_id":"abc-123","success":true,"data":{"pong":true}}
[container] 收到，继续工作
```

---

## 第零步：概念扫盲

### 0.1 为什么需要 host bridge？

课时 8 我们实现了"宿主 → 容器"的 RPC。但还有一类需求是反过来的：

**容器内的 solver 需要宿主帮忙**：

- "查一下当前 challenge 状态"—— challenge 数据在宿主。
- "提交一个 flag"—— 需要调平台 API（容器没网关 token）。
- "查 API Key"—— auth.json 在宿主。
- "广播消息给其他 solver"—— 需要宿主协调。

这些都是"容器调用宿主方法"。我们设计 host bridge 协议。

### 0.2 嵌套 RPC 的难点

已有的 RPC 通道：

```
宿主 stdin → 容器 stdin
容器 stdout → 宿主 stdout
```

要叠加一层 host bridge：

```
宿主 → 容器：RpcCommand (prompt / steer / ...)
容器 → 宿主：AgentSessionEvent / RpcResponse / HostBridgeRequest
宿主 → 容器：HostBridgeResponse (作为新的 RpcCommand type)
```

**关键**：host bridge 请求是"容器 → 宿主"，但响应是"宿主 → 容器"，**走的还是同一条 stdin/stdout 通道**。

### 0.3 request_id 配对

容器内同时可能有多个 host bridge 请求在等：

```
请求 A（query challenge state）  ← 等 response
请求 B（submit flag）            ← 等 response
请求 C（list memory）            ← 等 response
```

宿主处理完 B 后推响应回去，容器需要知道这个响应对应 B 而不是 A 或 C。

**方案**：每个请求带唯一 `request_id`（UUID），响应也带相同的 `request_id`。容器用 `Map<request_id, Promise>` 配对。

---

## 第一步：定义 host bridge 类型

### 1.1 创建 packages/core/src/challenge 目录和类型文件

```bash
mkdir -p packages/core/src/challenge
```

新建 `packages/core/src/challenge/env.ts`（环境变量名常量，后续课时使用）：

```typescript
/**
 * env.ts：challenge 模式下注入 Solver 容器的环境变量名常量。
 *
 * Manager 启动 challenge solver 时把这些变量塞进容器 env；
 * Solver 容器内的 extension / host-bridge-client 通过它们知道
 * "自己在做哪道题、平台 API 在哪、鉴权 token 是什么"。
 */

/** 当前 challenge 的 ID（最常用，决定 solver 是不是 challenge 模式）。 */
export const CHALLENGE_ENV_CHALLENGE_ID = "TCH_CHALLENGE_ID"
/** challenge 数据目录（容器内挂载点）。 */
export const CHALLENGE_ENV_DIR = "TCH_CHALLENGE_DIR"
/** 赛题平台 API base URL。 */
export const CHALLENGE_ENV_API_BASE_URL = "TCH_CHALLENGE_API_BASE_URL"
/** 赛题平台 agent token（鉴权用）。 */
export const CHALLENGE_ENV_AGENT_TOKEN = "TCH_CHALLENGE_AGENT_TOKEN"
```

新建 `packages/core/src/challenge/host-bridge-types.ts`：

```typescript
/**
 * Host bridge 协议类型。
 *
 * Solver 容器通过 stdout 发起 host_bridge_request，
 * 宿主处理后通过 stdin 推回 host_bridge_response。
 */

/** 容器能向宿主请求的动作集合（本课时简化，只有 ping；后续课时会扩展） */
export type HostBridgeAction =
    | "ping"                                  // 测试连通性
    | "get_env"                               // 读环境变量
    | "get_api_key"                           // 读 API Key（不返回原值，只返回是否存在）

/**
 * Solver 发给 host 的请求事件。
 * 通过 stdout JSONL 传输。
 */
export interface HostBridgeRequestEvent {
    type: "host_bridge_request"
    /** UUID，用于配对响应 */
    request_id: string
    /** 动作名 */
    action: HostBridgeAction
    /** 任意参数 */
    params: unknown
}
```

### 1.2 在 rpc-types.ts 加 host_bridge_response 命令

修改 `packages/core/src/solver/rpc/rpc-types.ts`，在 RpcCommand 联合类型里追加：

```typescript
// 在已有命令后追加：
| { id?: string; type: "host_bridge_response"; request_id: string; success: boolean; data?: unknown; error?: string }
```

这条命令是宿主 → 容器，把 host bridge 请求的结果推回去。

---

## 第二步：实现容器侧 client

### 2.1 创建 packages/core/src/challenge/host-bridge-client.ts

新建 `packages/core/src/challenge/host-bridge-client.ts`：

```typescript
import type { HostBridgeAction, HostBridgeRequestEvent } from "./host-bridge-types"

/**
 * Pending 请求记录。
 */
interface PendingRequest {
    resolve: (value: unknown) => void
    reject: (error: Error) => void
    timer: ReturnType<typeof setTimeout>
}

/** 所有未完成的 host bridge 请求，按 request_id 索引 */
const pendingRequests = new Map<string, PendingRequest>()

/** 默认超时：30 秒 */
const DEFAULT_TIMEOUT_MS = 30_000

function toErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}

function serializeJsonLine(value: unknown): string {
    return `${JSON.stringify(value)}\n`
}

/**
 * 向宿主发起一次 bridge 请求并等待响应。
 *
 * 流程：
 *   1. 生成 request_id，写 stdout（host_bridge_request 事件）
 *   2. 在 pendingRequests 注册 Promise
 *   3. 宿主处理后通过 stdin 推 host_bridge_response
 *   4. resolveHostBridgeResponse 用 request_id 配对，resolve Promise
 *
 * @param action 动作名
 * @param params 任意参数
 * @returns 宿主处理结果（类型由调用方断言）
 *
 * @throws 超时 / 宿主返回 error / stdout 写入失败
 */
export async function requestHostBridge<T>(
    action: HostBridgeAction,
    params: unknown,
): Promise<T> {
    const requestId = crypto.randomUUID()
    const event: HostBridgeRequestEvent = {
        type: "host_bridge_request",
        request_id: requestId,
        action,
        params,
    }

    return new Promise<T>((resolve, reject) => {
        // 30 秒超时保护
        const timer = setTimeout(() => {
            pendingRequests.delete(requestId)
            reject(new Error(`host bridge timeout: ${action}`))
        }, DEFAULT_TIMEOUT_MS)

        pendingRequests.set(requestId, {
            resolve: (value) => resolve(value as T),
            reject,
            timer,
        })

        try {
            // 写 stdout 让宿主看到请求
            process.stdout.write(serializeJsonLine(event))
        } catch (error) {
            clearTimeout(timer)
            pendingRequests.delete(requestId)
            reject(new Error(`host bridge write failed: ${toErrorMessage(error)}`))
        }
    })
}

/**
 * 配对宿主返回的响应。
 * 被 RPC server 在收到 host_bridge_response 命令时调用。
 *
 * 找不到 pending（超时已清理 / 重复响应）静默忽略。
 */
export function resolveHostBridgeResponse(
    requestId: string,
    success: boolean,
    data?: unknown,
    error?: string,
): void {
    const pending = pendingRequests.get(requestId)
    if (!pending) return

    pendingRequests.delete(requestId)
    clearTimeout(pending.timer)

    if (!success) {
        pending.reject(new Error(error?.trim() || "host bridge request failed"))
        return
    }
    pending.resolve(data)
}
```

### 2.2 关键设计点

#### pendingRequests Map

```typescript
const pendingRequests = new Map<string, PendingRequest>()
```

全局变量，记录所有"正在等待"的请求。request_id 是 key。

为什么不放进某个类？因为这个模块在容器内是单例，全局 Map 就够了。

#### 超时保护

```typescript
const timer = setTimeout(() => {
    pendingRequests.delete(requestId)
    reject(new Error(`host bridge timeout: ${action}`))
}, DEFAULT_TIMEOUT_MS)
```

如果宿主 30 秒内没响应，主动 reject 并清理。

#### 类型擦除

```typescript
export async function requestHostBridge<T>(action, params): Promise<T>
```

调用方指定 T：

```typescript
const result = await requestHostBridge<{ pong: boolean }>("ping", {})
// result.pong 类型是 boolean
```

这是"类型由调用方断言"模式，让函数签名保持简洁。

---

## 第三步：RPC server 加 host_bridge_response 分发

### 3.1 修改 packages/core/src/solver/rpc/rpc-server.ts

在 `handleCommand` 的 switch 里加：

```typescript
// 在 get_messages case 后追加：

case "host_bridge_response": {
    // 宿主把 bridge 请求结果推回 solver
    resolveHostBridgeResponse(cmd.request_id, cmd.success, cmd.data, cmd.error)
    return success(id, "host_bridge_response")
}
```

并在文件顶部加 import：

```typescript
import { resolveHostBridgeResponse } from "../../challenge/host-bridge-client"
```

---

## 第四步：实现宿主侧 handler

宿主收到 host_bridge_request 事件后，需要：
1. 识别这是 bridge 请求（不是普通事件）。
2. 调用对应 handler 处理。
3. 把结果通过 `sendCommand` 推回去。

### 4.1 创建 packages/core/src/challenge/host-bridge-handler.ts

新建 `packages/core/src/challenge/host-bridge-handler.ts`：

```typescript
import type { HostBridgeAction, HostBridgeRequestEvent } from "./host-bridge-types"

/**
 * Host bridge handler 的执行上下文。
 * 宿主把所有"容器可能需要"的能力打包成这个对象传给 handler。
 */
export interface HostBridgeHandleContext {
    /** 发起请求的 solver ID */
    solverId: string
    /** 请求的动作 */
    action: HostBridgeAction
    /** 请求参数 */
    params: unknown
    /** 读容器 env（容器环境变量） */
    getSolverEnvValue?: (key: string) => string | undefined
    /** 读宿主 API Key（不返回原值，只返回是否存在） */
    hasApiKey?: (provider: string) => boolean
}

/** handler 返回结果 */
export interface HostBridgeHandleResult {
    /** true = 已处理；false = 不认识这个 action */
    handled: boolean
    /** 返回数据 */
    data?: unknown
}

/**
 * Handler 接口。
 * 多个 handler 可以串起来（按注册顺序匹配）。
 */
export interface HostBridgeHandler {
    handle(ctx: HostBridgeHandleContext): Promise<HostBridgeHandleResult>
}

/**
 * 内置 handler：处理 ping / get_env / get_api_key。
 */
export function createBuiltinHostBridgeHandler(
    options: {
        getSolverEnvValue?: (solverId: string, key: string) => string | undefined
        hasApiKey?: (provider: string) => boolean
    } = {},
): HostBridgeHandler {
    return {
        async handle(ctx: HostBridgeHandleContext): Promise<HostBridgeHandleResult> {
            switch (ctx.action) {
                case "ping": {
                    return { handled: true, data: { pong: true, time: Date.now() } }
                }

                case "get_env": {
                    const params = (ctx.params ?? {}) as { key?: string }
                    const key = params.key
                    if (!key) return { handled: true, data: { value: undefined } }
                    // 优先用 ctx 里的（每次请求都带最新 solver env），fallback 到 options
                    const value = ctx.getSolverEnvValue?.(key)
                        ?? options.getSolverEnvValue?.(ctx.solverId, key)
                    return { handled: true, data: { value } }
                }

                case "get_api_key": {
                    const params = (ctx.params ?? {}) as { provider?: string }
                    const provider = params.provider
                    if (!provider) return { handled: true, data: { exists: false } }
                    return { handled: true, data: { exists: options.hasApiKey?.(provider) ?? false } }
                }

                default:
                    return { handled: false }
            }
        },
    }
}
```

---

## 第五步：RuntimeManager 接入 host bridge

### 5.1 修改 packages/core/src/runtime/runtime.ts

在构造函数注入 handler，在 readStream 识别 bridge 请求。

```typescript
// 顶部加 import
import type { HostBridgeHandler, HostBridgeHandleContext } from "../challenge/host-bridge-handler"
import type { HostBridgeRequestEvent } from "../challenge/host-bridge-types"
import { createBuiltinHostBridgeHandler } from "../challenge/host-bridge-handler"

// RuntimeManager 构造函数加 handlers 参数：
export class RuntimeManager {
    private docker: Dockerode
    private config: ContainerConfig
    private hostConfig: ConfigManager
    private eventHandlers: SolverEventHandler[] = []
    private procs = new Map<string, Subprocess<"pipe", "pipe", "pipe">>()
    private solvers = new Map<string, SolverInstance>()
    private hostBridgeHandlers: HostBridgeHandler[]
    private solverEnvs = new Map<string, Record<string, string>>()

    constructor(config: ConfigManager, hostBridgeHandlers: HostBridgeHandler[] = []) {
        this.docker = new Dockerode()
        this.hostConfig = config
        this.config = { image: "tinyfat:latest", binds: [] }

        // 自动加内置 handler
        this.hostBridgeHandlers = [
            createBuiltinHostBridgeHandler({
                getSolverEnvValue: (solverId, key) => this.solverEnvs.get(solverId)?.[key],
                hasApiKey: (provider) => this.hostConfig.hasApiKey(provider),
            }),
            ...hostBridgeHandlers,
        ]
    }

    // launch 方法里记得保存 solverEnvs：
    async launch(...): Promise<SolverInstance> {
        // ... 已有的代码 ...
        this.solvers.set(id, solver)
        this.solverEnvs.set(id, solverEnv)  // ← 加这行
        // ...
    }

    // readStream 里识别 bridge 请求并处理
    private readStream(...): Promise<void> {
        // ... 已有代码 ...

        // 在 JSON.parse 成功之后，转发之前加一段：
        // 先检查是不是 host_bridge_request
        const maybeBridgeReq = event as { type?: string }
        if (maybeBridgeReq.type === "host_bridge_request") {
            // 异步处理，不阻塞事件流
            void this.handleHostBridgeRequest(solverId, event as HostBridgeRequestEvent)
            continue  // 不转发给 event handler
        }

        // 转发给事件 handler
        this.emit(solverId, event as Parameters<RuntimeManager["emit"]>[1])
    }

    /**
     * 处理一个 host bridge 请求。
     */
    private async handleHostBridgeRequest(
        solverId: string,
        request: HostBridgeRequestEvent,
    ): Promise<void> {
        const ctx: HostBridgeHandleContext = {
            solverId,
            action: request.action,
            params: request.params,
            // 关键：把 env 读取函数传进去（让 handler 能查 TCH_CHALLENGE_ID 等）
            getSolverEnvValue: (key) => this.solverEnvs.get(solverId)?.[key],
            hasApiKey: (provider) => this.hostConfig.hasApiKey(provider),
        }

        let result: HostBridgeHandleResult = { handled: false }
        for (const handler of this.hostBridgeHandlers) {
            try {
                result = await handler.handle(ctx)
                if (result.handled) break
            } catch (error) {
                // 这一个 handler 失败，试下一个
                console.error(`[host-bridge] handler error for ${request.action}:`, error)
            }
        }

        // 推回响应
        this.sendCommand(solverId, {
            type: "host_bridge_response",
            request_id: request.request_id,
            success: result.handled,
            ...(result.handled && result.data !== undefined ? { data: result.data } : {}),
            ...(!result.handled ? { error: `unhandled action: ${request.action}` } : {}),
        })
    }
}
```

### 5.2 关键设计点

#### handler 链

```typescript
for (const handler of this.hostBridgeHandlers) {
    result = await handler.handle(ctx)
    if (result.handled) break
}
```

多个 handler 按注册顺序试，第一个返回 `handled: true` 的胜出。这让以后可以加自定义 handler（如 challenge 相关的）而不动核心代码。

#### 异步不阻塞

```typescript
// 在 readStream 里：
void this.handleHostBridgeRequest(solverId, event)
continue  // 继续读下一行，不等处理完
```

bridge 请求处理可能慢（如查数据库），不能阻塞 stdout 读取。

---

## 第六步：注册 host bridge 工具（让 LLM 能调用）

让容器内的 LLM 能通过工具调 host bridge。

### 6.1 创建 packages/core/src/config/tools/host-bridge-tools.ts

```bash
mkdir -p packages/core/src/config/tools
```

新建 `packages/core/src/config/tools/host-bridge-tools.ts`：

```typescript
import { defineTool } from "@mariozechner/pi-coding-agent"
import { Type } from "typebox"
import { requestHostBridge } from "../../challenge/host-bridge-client"

/** Ping 工具：测试 host bridge 连通性 */
export const pingHostTool = defineTool({
    name: "ping_host",
    label: "Ping Host",
    description: "Test connectivity to the host process",
    parameters: Type.Object({}),
    async execute() {
        const result = await requestHostBridge<{ pong: boolean; time: number }>("ping", {})
        return {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
            details: undefined,
        }
    },
})

/** 读 env 工具 */
export const getEnvTool = defineTool({
    name: "get_env",
    label: "Get Environment Variable",
    description: "Read an environment variable from the host",
    parameters: Type.Object({
        key: Type.String({ description: "Environment variable name" }),
    }),
    async execute(_toolCallId, params) {
        const result = await requestHostBridge<{ value?: string }>("get_env", { key: params.key })
        return {
            content: [
                { type: "text", text: `${params.key}=${result.value ?? "(unset)"}` },
            ],
            details: undefined,
        }
    },
})

/** 检查 API Key 是否配置 */
export const hasApiKeyTool = defineTool({
    name: "has_api_key",
    label: "Check API Key",
    description: "Check if an API key is configured for a provider",
    parameters: Type.Object({
        provider: Type.String({ description: "Provider name (e.g., openai)" }),
    }),
    async execute(_toolCallId, params) {
        const result = await requestHostBridge<{ exists: boolean }>("get_api_key", {
            provider: params.provider,
        })
        return {
            content: [
                { type: "text", text: `${params.provider}: ${result.exists ? "configured" : "not configured"}` },
            ],
            details: undefined,
        }
    },
})

/** 所有 host bridge 工具 */
export const hostBridgeTools = [pingHostTool, getEnvTool, hasApiKeyTool]
```

> **⚠️ 注意事项**
>
> 1. **typebox 不是 @sinclair/typebox**：pi-coding-agent 内部用的是 `typebox` 包（不带命名空间），SDK 自带的 d.ts 也从 `typebox` 导入。直接 `import { Type } from "typebox"`。
>
> 2. **typebox 需要在根 package.json 显式声明**：虽然它是 pi-coding-agent 的传递依赖，但 TS 不会从 `.bun/node_modules/` 自动提升。在根 `package.json` 的 `dependencies` 里加 `"typebox": "^1.3.0"`，然后 `bun install`。
>
> 3. **execute 返回值必须有 `details` 字段**：`AgentToolResult<T>` 的类型定义里 `details: T` 是必填的（不是可选），T 默认 `unknown`。最简单的方式是直接 `details: undefined`，TS 也接受。漏掉会报：
>
>    ```text
>    error TS2322: Type '... ' is not assignable to type 'Promise<AgentToolResult<unknown>>'.
>      Property 'details' is missing in type '...'
>    ```
>
> 4. **import 路径要数清楚 `../`**：从 `packages/core/src/config/tools/host-bridge-tools.ts` 到 `packages/core/src/challenge/host-bridge-client.ts`：
>    - `tools/` → `config/`（一个 `..`）
>    - `config/` → `src/`（两个 `..`）
>    - `src/` + `challenge/host-bridge-client` = `../../challenge/host-bridge-client`

### 6.2 在 ConfigManager 注册这些工具

修改 `packages/core/src/config/index.ts` 的 `resolvePromptSession`：

```typescript
// 顶部加 import
import { hostBridgeTools } from "./tools/host-bridge-tools"

// 在 resolvePromptSession 里，把 hostBridgeTools 加到 customTools：
const opts: CreateAgentSessionOptions = {
    tools,
    customTools: [...hostBridgeTools],  // ← 加这行
    resourceLoader,
    authStorage: this.auth,
    modelRegistry: this.models,
    settingsManager: this.settings,
}
```

### 6.3 让 SOLVER prompt 启用这些工具

编辑 `~/.tinyfat/config/prompts/SOLVER.md`，在 tools 里加这三个：

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
  - ping_host
  - get_env
  - has_api_key
---

You are a helpful agent...
```

---

## 第七步：验证

### 7.1 直接测 client（本地不走 Docker）

写个临时测试脚本：

```bash
cat > /tmp/test-bridge.ts << 'EOF'
import { requestHostBridge } from "@my/core"

// 这是容器内才能用的；本地测的话会卡 30 秒超时
const result = await requestHostBridge("ping", {})
console.log(result)
EOF
bun run /tmp/test-bridge.ts
```

**预期**：30 秒后报超时（因为本地没有宿主在监听）。

### 7.2 Docker 端到端测试

确保：
- API Key 配好
- Model pref 配好
- SOLVER prompt 启用了 ping_host 工具
- 重新 build binary：`bun run build:solver`

跑：

```bash
bun run apps/cli/src/main.ts runtime launch --prompt SOLVER "ping the host and tell me the time"
```

**预期**：

```
[abc12345] {"type":"message_start",...}
[abc12345] {"type":"tool_execution_start","toolName":"ping_host",...}
[abc12345] {"type":"tool_execution_end","toolName":"ping_host",...}
[abc12345] {"type":"message_end",...}
[abc12345] {"type":"agent_end",...}
```

LLM 看到的工具结果应该包含 `{ "pong": true, "time": 1234567890 }`。

### 7.3 类型检查

```bash
bun run typecheck
```

---

## 第八步：故障排查

### 问题 1：LLM 调了 ping_host 但卡住

**原因**：可能是 host bridge 响应没推回去。

**调试**：在 `handleHostBridgeRequest` 加日志：

```typescript
console.log(`[host-bridge] received ${request.action} (${request.request_id})`)
// ... 处理 ...
console.log(`[host-bridge] responding ${request.request_id}: ${JSON.stringify(result)}`)
```

### 问题 2：超时（30s）

**原因**：handler 没注册或没识别 action。

**解决**：检查 `hostBridgeHandlers` 是否包含了 createBuiltinHostBridgeHandler 的产物。

### 问题 3：`'host_bridge_response' is not assignable to RpcCommand`

**原因**：rpc-types.ts 里没加 host_bridge_response 命令。

**解决**：按第一步的说明加进去。

### 问题 4：data 字段丢失

**原因**：`result.data === undefined` 时没传 data，但客户端期望有值。

**解决**：handler 返回时强制带 data：

```typescript
return { handled: true, data: { /* ... */ } }
```

---

## 本课小结

✅ **你已完成**：

- 定义 host bridge 协议（HostBridgeRequest / Response）
- 实现容器侧 client（requestHostBridge + 超时 + Promise 配对）
- 实现宿主侧 handler（builtin + 链式）
- 加 host bridge 工具让 LLM 能调用
- 跑通端到端"容器 → 宿主 → 容器"

📦 **新增文件**：

```
packages/core/src/challenge/
├── host-bridge-types.ts          ← 协议类型
├── host-bridge-client.ts         ← 容器侧 client
└── host-bridge-handler.ts        ← 宿主侧 handler

packages/core/src/config/tools/host-bridge-tools.ts   ← LLM 工具
```

🔑 **关键概念**：

- **嵌套 RPC**：在已有 stdin/stdout 通道上叠加 bridge 协议。
- **request_id 配对**：让多个并发请求的响应正确匹配。
- **超时保护**：避免单个请求卡死整个 solver。
- **handler 链**：多个 handler 按顺序试，第一个认领的胜出。

---

## 下一课预告

[课时 10：Web UI 雏形（Bun.serve + REST API）](./10-web-ui.md)（待生成）—— 我们会：

- 实现 DaemonManager 装配根
- 用 Bun.serve 搭出 Web 服务
- 加 REST API 路由（配置 CRUD + solver 列表）
- 写最简 React 前端

继续课时 10 →
