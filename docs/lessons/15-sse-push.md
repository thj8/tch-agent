# 课时 15：SSE 实时推送

> 🎯 **目标**：让 web UI 能实时看到 solver 行为 + challenge 进度，通过 SSE（Server-Sent Events）推送。
>
> ⏰ **预计耗时**：2-3 小时
>
> 📋 **难度**：⭐⭐⭐⭐

---

## 你将学到什么

1. **SSE 协议**（Server-Sent Events）vs WebSocket
2. **Bun.serve 实现 SSE**（ReadableStream + keepalive）
3. **多订阅者广播模式**
4. **前端 EventSource API**

## 前置条件

✅ 已完成 [课时 1-14](./README.md)

## 最终效果

浏览器打开 solver 详情页，实时看到 LLM 思考、工具调用、结果。

```
[10:00:01] [assistant] 我先看看 /tmp 目录...
[10:00:02] [tool_call] bash({ command: "ls /tmp" })
[10:00:02] [tool_result] file1.txt ...
[10:00:03] [assistant] 看到 file1.txt ...
```

---

## 第零步：概念扫盲

### 0.1 SSE vs WebSocket

| 协议 | 方向 | 复杂度 | 适用 |
|---|---|---|---|
| **轮询** | 客户端定时拉 | 简单 | 低实时性场景 |
| **SSE** | 服务端单推 | 简单 | 单向推送（日志、事件流） |
| **WebSocket** | 双向 | 复杂 | 聊天、协同编辑 |

我们的场景是"宿主 → 浏览器"单向推送，SSE 最合适。

### 0.2 SSE 协议

SSE 基于 HTTP，响应头：

```
Content-Type: text/event-stream
Cache-Control: no-cache
Connection: keep-alive
```

响应体是按事件分割的文本：

```
: connected

event: status
data: {"solvers": 2}

: keepalive

event: solver_event
data: {"type":"tool_call",...}

```

- 每个事件：`event: <name>\n` + `data: <json>\n` + 空行
- `:` 开头是注释（用于 keepalive）
- 客户端用 `EventSource` API 监听

### 0.3 多订阅者广播

多个浏览器同时看一个 solver，宿主怎么把事件发给所有订阅者？

```
订阅者 A → controller1 ─┐
订阅者 B → controller2 ─┼─← emit(event) 扇出
订阅者 C → controller3 ─┘
```

每次事件来：循环所有 controller，调 `controller.enqueue(frame)`。

---

## 第一步：实现 RuntimeManager 的事件总线

### 1.1 修改 packages/core/src/runtime/runtime.ts

```typescript
// 类顶部加：
private eventHandlers: SolverEventHandler[] = []

/**
 * 注册事件处理器。
 */
onEvent(handler: SolverEventHandler): void {
    this.eventHandlers.push(handler)
}

/**
 * 触发事件：扇出给所有 handler。
 */
private emit(solverId: string, event: AgentSessionEvent): void {
    for (const handler of this.eventHandlers) {
        try {
            handler(solverId, event)
        } catch (error) {
            console.error("[runtime] event handler error:", error)
        }
    }
}
```

### 1.2 修改 readStream 让它转发事件

```typescript
// 在 readStream 里，原本 console.log(line) 改成 emit
if (line) {
    try {
        const event = JSON.parse(line)
        this.emit(solverId, event)
    } catch {
        // 非 JSON，忽略
    }
}
```

---

## 第二步：实现 server.ts 的 SSE 基础设施

修改 `packages/ui-web/src/server.ts`：

```typescript
import { DaemonManager } from "@my/core"
import type { AgentSessionEvent } from "@mariozechner/pi-coding-agent"
import index from "./index.html"

export interface WebServerOptions {
    hostname?: string
    port?: number
}

const SSE_KEEPALIVE_MS = 5000

export async function startWeb(options: WebServerOptions = {}): Promise<void> {
    const { hostname = "127.0.0.1", port = 3000 } = options
    const daemon = await DaemonManager.getInstance()
    const { config, runtime } = daemon

    await runtime.init((msg) => console.log(`[runtime] ${msg}`))

    // ── SSE 订阅注册表 ────────────────────────────────────
    // 三类订阅频道
    const runtimeSubscribers = new Set<ReadableStreamDefaultController<Uint8Array>>()
    const solverSubscribers = new Map<string, Set<ReadableStreamDefaultController<Uint8Array>>>()

    // ── SSE 工具函数 ──────────────────────────────────────

    const encoder = new TextEncoder()

    function encodeSse(event: string, data: unknown): Uint8Array {
        return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    }

    function closeController(controller: ReadableStreamDefaultController<Uint8Array>): void {
        try {
            controller.close()
        } catch {
            // 已经关了
        }
    }

    function safeEnqueue(
        controller: ReadableStreamDefaultController<Uint8Array>,
        frame: Uint8Array,
        onFailure?: () => void,
    ): boolean {
        try {
            controller.enqueue(frame)
            return true
        } catch {
            onFailure?.()
            closeController(controller)
            return false
        }
    }

    /**
     * 创建一条 SSE 连接。
     */
    function openSse(
        req: Request,
        onStart: (controller: ReadableStreamDefaultController<Uint8Array>) => void,
        onClose: (controller: ReadableStreamDefaultController<Uint8Array>) => void,
    ): Response {
        const stream = new ReadableStream<Uint8Array>({
            start(controller) {
                onStart(controller)

                // 立即发送 connected 信号
                safeEnqueue(
                    controller,
                    encoder.encode(": connected\n\n"),
                    () => onClose(controller),
                )

                // 5 秒 keepalive
                const timer = setInterval(() => {
                    safeEnqueue(
                        controller,
                        encoder.encode(": keepalive\n\n"),
                        () => {
                            clearInterval(timer)
                            onClose(controller)
                        },
                    )
                }, SSE_KEEPALIVE_MS)

                // 客户端断开
                req.signal.addEventListener(
                    "abort",
                    () => {
                        clearInterval(timer)
                        onClose(controller)
                        closeController(controller)
                    },
                    { once: true },
                )
            },
        })

        return new Response(stream, {
            headers: {
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache",
                Connection: "keep-alive",
            },
        })
    }

    /**
     * 广播 runtime 状态。
     */
    async function broadcastRuntimeSnapshot(): Promise<void> {
        if (runtimeSubscribers.size === 0) return
        const frame = encodeSse("status", {
            docker: await runtime.ping(),
            solvers: runtime.list().length,
        })
        for (const controller of [...runtimeSubscribers]) {
            safeEnqueue(controller, frame, () => {
                runtimeSubscribers.delete(controller)
            })
        }
    }

    /**
     * 广播单 solver 事件。
     */
    function broadcastSolverEvent(solverId: string, event: AgentSessionEvent): void {
        const subscribers = solverSubscribers.get(solverId)
        if (!subscribers || subscribers.size === 0) return
        const frame = encodeSse("agent_event", event)
        for (const controller of [...subscribers]) {
            safeEnqueue(controller, frame, () => {
                subscribers.delete(controller)
                if (subscribers.size === 0) solverSubscribers.delete(solverId)
            })
        }
    }

    // ── 订阅 RuntimeManager 事件 ──────────────────────────

    runtime.onEvent((solverId, event) => {
        broadcastSolverEvent(solverId, event)
        // agent_end 时刷新 runtime 快照
        if (event.type === "agent_end") {
            void broadcastRuntimeSnapshot()
        }
    })

    // ── Bun.serve 路由 ────────────────────────────────────

    const server = Bun.serve({
        hostname,
        port,
        idleTimeout: 30,
        routes: {
            "/": index,

            // 课时 10 的已有路由（api-keys, providers 等）在此保留

            // ── 新增：SSE 路由 ──

            "/api/runtime/stream": {
                GET: (req) =>
                    openSse(
                        req,
                        (controller) => {
                            runtimeSubscribers.add(controller)
                            // 立即推一次初始状态
                            void (async () => {
                                const frame = encodeSse("status", {
                                    docker: await runtime.ping(),
                                    solvers: runtime.list().length,
                                })
                                safeEnqueue(controller, frame, () => runtimeSubscribers.delete(controller))
                                const solversFrame = encodeSse("solvers", runtime.list())
                                safeEnqueue(controller, solversFrame, () => runtimeSubscribers.delete(controller))
                            })()
                        },
                        (controller) => runtimeSubscribers.delete(controller),
                    ),
            },

            "/api/runtime/solvers/:id/stream": {
                GET: (req, params) =>
                    openSse(
                        req,
                        (controller) => {
                            const solverId = params.id
                            const subscribers =
                                solverSubscribers.get(solverId) ?? new Set()
                            subscribers.add(controller)
                            solverSubscribers.set(solverId, subscribers)
                        },
                        (controller) => {
                            // 从所有频道的 set 里清理
                            for (const [id, subscribers] of solverSubscribers) {
                                subscribers.delete(controller)
                                if (subscribers.size === 0) solverSubscribers.delete(id)
                            }
                        },
                    ),
            },
        },
        fetch(req) {
            return new Response("Not Found", { status: 404 })
        },
        development: { hmr: true, console: true },
    })

    console.log(`\n🌐 Web UI running at http://${hostname}:${port}\n`)
}
```

---

## 第三步：前端 EventSource

修改 `packages/ui-web/src/app.tsx`，加 Solver 详情页：

```typescript
// 在 SolversPage 后面加：

function SolverDetailPage({ solverId }: { solverId: string }) {
    const [events, setEvents] = useState<Array<{ timestamp: number; event: unknown }>>([])
    const [connected, setConnected] = useState(false)

    useEffect(() => {
        const es = new EventSource(`/api/runtime/solvers/${solverId}/stream`)

        es.addEventListener("open", () => setConnected(true))
        es.addEventListener("error", () => setConnected(false))
        es.addEventListener("agent_event", (e: MessageEvent) => {
            const event = JSON.parse(e.data)
            setEvents((prev) => [...prev, { timestamp: Date.now(), event }])
        })

        return () => es.close()
    }, [solverId])

    return (
        <div>
            <h2 className="text-2xl font-bold mb-2">Solver {solverId}</h2>
            <div className="mb-4">
                Status:{" "}
                {connected ? (
                    <span className="text-green-600">● connected</span>
                ) : (
                    <span className="text-red-600">● disconnected</span>
                )}
            </div>

            <div className="bg-black text-green-400 p-4 rounded font-mono text-sm overflow-auto max-h-[600px]">
                {events.length === 0 ? (
                    <div className="text-slate-500">waiting for events...</div>
                ) : (
                    events.map((e, i) => (
                        <div key={i}>
                            <span className="text-slate-500">
                                [{new Date(e.timestamp).toLocaleTimeString()}]
                            </span>{" "}
                            {summarizeEvent(e.event)}
                        </div>
                    ))
                )}
            </div>
        </div>
    )
}

function summarizeEvent(event: unknown): string {
    const e = event as { type?: string; [k: string]: unknown }
    if (!e?.type) return JSON.stringify(event)

    switch (e.type) {
        case "message_end": {
            const msg = e.message as { role?: string; content?: unknown }
            if (msg?.role === "assistant") {
                const text = extractTextFromContent(msg.content)
                return `[assistant] ${text.slice(0, 200)}`
            }
            return `[${msg?.role}]`
        }
        case "tool_execution_start": {
            return `[tool_call] ${e.toolName}(${summarizeArgs(e.args)})`
        }
        case "tool_execution_end": {
            return `[tool_result] ${e.toolName}${e.isError ? " (error)" : ""}`
        }
        case "agent_end": {
            return `[agent_end] stopReason=${e.stopReason ?? "unknown"}`
        }
        default:
            return `[${e.type}]`
    }
}

function extractTextFromContent(content: unknown): string {
    if (typeof content === "string") return content
    if (!Array.isArray(content)) return ""
    return content
        .filter(
            (p): p is { type: "text"; text: string } =>
                !!p && typeof p === "object" && (p as { type?: string }).type === "text",
        )
        .map((p) => p.text)
        .join("")
}

function summarizeArgs(args: unknown): string {
    try {
        return JSON.stringify(args).slice(0, 100)
    } catch {
        return String(args).slice(0, 100)
    }
}
```

加路由跳转（修改 App 的 page 类型）：

```typescript
type Page = "api-keys" | "solvers" | { type: "solver-detail"; id: string }

// 在 SolversPage 的 table 里加点击：
<tr
    key={s.id}
    className="border-b cursor-pointer hover:bg-slate-100"
    onClick={() => setPage({ type: "solver-detail", id: s.id })}
>

// Main 区域加：
{typeof page === "object" && page.type === "solver-detail" && (
    <SolverDetailPage solverId={page.id} />
)}
```

---

## 第四步：验证

### 4.1 启动 web + 跑 solver

终端 1：

```bash
bun run apps/cli/src/main.ts web
```

终端 2（起 solver）：

```bash
bun run apps/cli/src/main.ts runtime launch --prompt SOLVER "ls /tmp"
```

### 4.2 浏览器看实时事件

1. 打开 `http://127.0.0.1:3000`
2. 切到 Solvers 页
3. 点击刚启动的 solver
4. 看到 "● connected"
5. 实时收到事件：
   - `[assistant] ...`
   - `[tool_call] bash(...)`
   - `[tool_result] bash`
   - `[agent_end] stopReason=end_turn`

### 4.3 测试 keepalive

保持连接 30 秒以上，不应该断开（每 5 秒一个 keepalive 注释）。

### 4.4 测试多订阅者

开两个浏览器 tab 同时看一个 solver，两边都收到事件。

### 4.5 类型检查

```bash
bun run typecheck
```

---

## 第五步：故障排查

### 问题 1：浏览器收不到事件

**原因**：可能 SSE 路由没匹配，或 event handler 没注册。

**调试**：

```javascript
// 浏览器 console
const es = new EventSource("/api/runtime/solvers/abc12345/stream")
es.addEventListener("open", () => console.log("connected"))
es.addEventListener("agent_event", (e) => console.log("event:", e.data))
es.addEventListener("error", (e) => console.log("error:", e))
```

### 问题 2：30 秒后断开

**原因**：Bun.serve 的 idleTimeout 默认 30 秒。

**解决**：设置 `idleTimeout: 30`（保留），但 SSE 流式响应不应触发 idle。如果还断，检查 keepalive 是否生效。

### 问题 3：消息顺序错乱

**原因**：多个事件同时 enqueue，可能乱序。

**解决**：每次 emit 时按顺序 enqueue（已经是这样了）；如果还乱，加个事件序号。

### 问题 4：内存泄漏（subscriber 没清理）

**原因**：客户端断开后，subscriber 还在 Set 里。

**解决**：确保 `req.signal.addEventListener("abort", ...)` 正确清理。

---

## 本课小结

✅ **你已完成**：

- 实现 SSE 基础设施（openSse + keepalive + abort）
- 实现多订阅者广播
- 让 RuntimeManager 事件流接入 web
- 前端用 EventSource 实时渲染

📦 **新增文件**：

```
packages/ui-web/src/server.ts       ← SSE 路由 + 广播
packages/ui-web/src/app.tsx         ← SolverDetailPage
```

🔑 **关键概念**：

- **SSE**：单向推送，比 WebSocket 简单。
- **ReadableStream + enqueue**：Bun 实现 SSE 的核心。
- **keepalive**：每 5 秒发 `:` 注释行，防代理超时。
- **EventSource**：浏览器原生 API，监听 SSE 流。

---

## 阶段 3 完结 🎉

阶段 3（课时 11-15）全部完成。你已经能：

1. 存 challenge 数据（带原子写和文件锁）
2. 对接赛题平台 API（带限流和 mock 模式）
3. 让 Planner LLM 自动调度 solver
4. 浏览器实时看 solver 行为

**阶段 4 预告**（课时 16-20）：实现 Observer sidecar + 强制续跑 + 协作广播——让 solver 智能化。

---

## 下一课预告

[课时 16：ideas + memory 存储](./16-memory-store.md)（待生成）—— 实现"策略板"的文件存储。

继续课时 16 →
