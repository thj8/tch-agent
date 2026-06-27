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
import { resolveHostBridgeResponse } from "../../challenge/host-bridge-client"
import type { RpcCommand, RpcResponse, SolverInitPayload } from "./rpc-types"
import { attachJsonlLineReader, serializeJsonLine } from "./jsonl"

// ── 输出辅助 ──────────────────────────────────────────────

function output(value: unknown): void {
    process.stdout.write(serializeJsonLine(value))
}

function success(id: string | undefined, command: string, data?: unknown): RpcResponse {
    if (data === undefined) return { id, type: "response", command, success: true }
    return { id, type: "response", command, success: true, data }
}

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
 *
 * 三个阶段：
 *   1. Bootstrap：读 stdin 第一行 → SolverInitPayload → 建 AgentSession
 *   2. 握手：输出 init success，告诉宿主"我准备好了"（宿主 launch() 就等这一行）
 *   3. 常驻：订阅事件流 → 触发首轮 prompt → 进入命令循环
 */
export async function runSolverRpc(): Promise<never> {
    // ── 阶段 1：Bootstrap —— 只消费 stdin 第一行作为 init 载荷 ──
    // 抓到第一行就立刻 detach：只读一行，把剩下的 stdin 留给下面的命令循环 reader。
    // 若宿主还没发 init 就关了 stdin（异常断连），reject 退出。
    const raw = await new Promise<string>((resolve, reject) => {
        const detach = attachJsonlLineReader(process.stdin, (line) => {
            detach()
            resolve(line)
        })
        process.stdin.on("end", () => reject(new Error("stdin closed before init")))
    })

    // 解析 + 校验 init 载荷。任一步失败都回 init error 并 exit：
    // 握手机制下宿主拿不到 success 会在 30s 后超时，这里主动报错更快暴露问题。
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

    // 建 AgentSession。cwd 落在容器 workspace；prompt / 工具白名单 / model
    // 都由 resolvePromptSession 在 createSolverSession 内装配好。
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

    // ── 阶段 2：订阅事件流 ──
    // 顺序关键：必须在「发 init success」和「触发首轮 prompt」之前注册，
    // 否则首轮 prompt 产生的事件会漏发。事件经 shouldForwardEvent 滤掉高频噪音
    // （message_update 等）后，逐行 JSONL 推给宿主。
    session.subscribe((event: AgentSessionEvent) => {
        if (!shouldForwardEvent(event)) return
        output(event)
    })

    // 握手信号：宿主 launch() 内部 await initReady，收到这行（{command:"init",success:true}）
    // 才认为容器就绪、才开始发后续命令。
    output(success(undefined, "init"))

    // ── 阶段 3：触发首轮 prompt（用 init.task）──
    // 故意 fire-and-forget、不 await：await 会阻塞下面命令循环 reader 的注册，
    // 导致宿主中途发来的 steer/abort 等命令收不到。LLM 的事件靠上面的 subscriber
    // 异步流出；prompt 自身抛错走 .catch → dispose → exit。
    session.prompt(init.task, { source: "rpc" }).catch((err) => {
        output(error(undefined, "solver", err instanceof Error ? err.message : String(err)))
        session.dispose()
        process.exit(1)
    })

    // 命令循环：从 stdin 第二行起，每行一个 RpcCommand，分发后回 RpcResponse。
    // （阶段 1 的 reader 早已 detach，这里新挂一个 reader 接管后续所有行。）
    attachJsonlLineReader(process.stdin, (line) => {
        void handleInputLine(session, line)
    })

    // stdin 关闭 = 宿主断连（Ctrl+C / stopSolver）→ dispose 后优雅退出。
    process.stdin.on("end", () => {
        session.dispose()
        process.exit(0)
    })

    // 永不 resolve：让进程常驻。真正退出全靠上面的 stdin end，或各处 error 分支的 process.exit。
    return new Promise(() => {})
}

async function handleInputLine(session: AgentSession, line: string): Promise<void> {
    let cmd: RpcCommand
    try {
        cmd = JSON.parse(line) as RpcCommand
    } catch {
        output(error(undefined, "parse", `invalid JSON: ${line.slice(0, 100)}`))
        return
    }

    const response = await handleCommand(session, cmd)
    output(response)
}

/**
 * 命令分发器：把一条 RpcCommand 翻译成对 AgentSession 的调用，返回同步应答 RpcResponse。
 *
 * 两类命令的应答语义不同：
 *   - 同步命令（get_state / set_model / bash …）：执行完才回，data 里带结果。
 *   - 异步命令（prompt）：fire-and-forget，立刻回 success 只表示"已受理"，
 *     LLM 的事件靠 runSolverRpc 里的 subscriber 异步流出，不在这里等。
 */
async function handleCommand(session: AgentSession, cmd: RpcCommand): Promise<RpcResponse> {
    const id = cmd.id

    switch (cmd.type) {
        case "prompt": {
            // fire-and-forget：不 await。立即回 success = "已受理"，真正的回复走事件流。
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

        case "host_bridge_response": {
            // 宿主把之前 host_bridge_request 的结果推回来：resolve 掉容器内挂起的 Promise
            // （见 challenge/host-bridge-client），唤醒等待这次 bridge 调用的代码。
            resolveHostBridgeResponse(cmd.request_id, cmd.success, cmd.data, cmd.error)
            return success(id, "host_bridge_response")
        }

        case "set_model": {
            const model = session.modelRegistry.find(cmd.provider, cmd.modelId)
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
