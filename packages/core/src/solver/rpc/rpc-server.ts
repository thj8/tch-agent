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
 */
export async function runSolverRpc(): Promise<never> {
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

    session.subscribe((event: AgentSessionEvent) => {
        if (!shouldForwardEvent(event)) return
        output(event)
    })

    output(success(undefined, "init"))

    session.prompt(init.task, { source: "rpc" }).catch((err) => {
        output(error(undefined, "solver", err instanceof Error ? err.message : String(err)))
        session.dispose()
        process.exit(1)
    })

    attachJsonlLineReader(process.stdin, (line) => {
        void handleInputLine(session, line)
    })

    process.stdin.on("end", () => {
        session.dispose()
        process.exit(0)
    })

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
