import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent"
import { loadRecentObserverRounds } from "./observer-store"
import { attachObserverLoop } from "./observer-loop"
import type { ObserverReviewPayload } from "./types"

type Handler = (event: unknown, ctx?: unknown) => Promise<void> | void

/** 伪造 ExtensionAPI：只实现 on，按事件名捕获 handler。 */
function createFakePi(): { handlers: Record<string, Handler>; api: ExtensionAPI } {
    const handlers: Record<string, Handler> = {}
    const api = {
        on(event: string, handler: Handler) {
            handlers[event] = handler
        },
    } as unknown as ExtensionAPI
    return { handlers, api }
}

async function waitFor(cond: () => boolean, timeoutMs = 1000): Promise<void> {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
        if (cond()) return
        await Bun.sleep(5)
    }
    throw new Error("waitFor timeout")
}

let sessionDir: string
let prevEnv: string | undefined
let toolCallCounter = 0

beforeEach(async () => {
    sessionDir = await mkdtemp(join(tmpdir(), "tinyfat-observer-loop-"))
    prevEnv = process.env.TCH_SOLVER_SESSION_DIR
    process.env.TCH_SOLVER_SESSION_DIR = sessionDir
    toolCallCounter = 0
})

afterEach(async () => {
    if (prevEnv === undefined) delete process.env.TCH_SOLVER_SESSION_DIR
    else process.env.TCH_SOLVER_SESSION_DIR = prevEnv
    await rm(sessionDir, { recursive: true, force: true })
})

/** 跑一轮：可选一个工具调用 + assistant 收尾。 */
async function fireRound(
    h: Record<string, Handler>,
    opts: { tool?: string; args?: unknown; result?: unknown; isError?: boolean; text?: string } = {},
): Promise<void> {
    if (opts.tool) {
        const callId = `tc_${++toolCallCounter}`
        await h["tool_execution_start"]!({ toolCallId: callId, toolName: opts.tool, args: opts.args ?? {} })
        await h["tool_execution_end"]!({
            toolCallId: callId,
            toolName: opts.tool,
            result: opts.result ?? "",
            isError: opts.isError ?? false,
        })
    }
    await h["message_end"]!({
        message: { role: "assistant", content: [{ type: "text", text: opts.text ?? "step" }] },
    })
}

describe("observer-loop - 触发节奏", () => {
    test("每 6 轮一次周期 review（reason=periodic）", async () => {
        const received: ObserverReviewPayload[] = []
        const { handlers, api } = createFakePi()
        attachObserverLoop(api, {
            runReview: async (_id, payload) => {
                received.push(payload)
                return { applied: true }
            },
        })

        for (let i = 0; i < 6; i++) {
            await fireRound(handlers, { tool: "bash", args: { cmd: "ls" }, result: "out" })
        }

        await waitFor(() => received.length >= 1)
        expect(received).toHaveLength(1)
        expect(received[0]?.reason).toBe("periodic")
        // 轮次已落盘
        expect((await loadRecentObserverRounds(10))).toHaveLength(6)
    })

    test("5 轮内不触发 review", async () => {
        const received: ObserverReviewPayload[] = []
        const { handlers, api } = createFakePi()
        attachObserverLoop(api, {
            runReview: async (_id, payload) => {
                received.push(payload)
                return { applied: true }
            },
        })

        for (let i = 0; i < 5; i++) {
            await fireRound(handlers, { tool: "bash", text: `r${i}` })
        }
        await Bun.sleep(40)
        expect(received).toHaveLength(0)
    })

    test("challenge_get_hint 成功 → 强制 review（reason=hint）", async () => {
        const received: ObserverReviewPayload[] = []
        const { handlers, api } = createFakePi()
        attachObserverLoop(api, {
            runReview: async (_id, payload) => {
                received.push(payload)
                return { applied: true }
            },
        })

        await fireRound(handlers, {
            tool: "challenge_get_hint",
            result: { content: [{ type: "text", text: "look at /admin" }] },
            isError: false,
        })

        await waitFor(() => received.length >= 1)
        expect(received[0]?.reason).toBe("hint")
    })

    test("agent_end → 末轮 review（reason=agent_end）", async () => {
        const received: ObserverReviewPayload[] = []
        const { handlers, api } = createFakePi()
        attachObserverLoop(api, {
            runReview: async (_id, payload) => {
                received.push(payload)
                return { applied: true }
            },
        })

        await fireRound(handlers, { tool: "bash", text: "last step" })
        await handlers["agent_end"]!({})

        await waitFor(() => received.length >= 1)
        expect(received[0]?.reason).toBe("agent_end")
    })
})

describe("observer-loop - 工具日志配对", () => {
    test("tool_execution_start 暂存 args，end 配对进 tool_logs", async () => {
        const received: ObserverReviewPayload[] = []
        const { handlers, api } = createFakePi()
        attachObserverLoop(api, {
            runReview: async (_id, payload) => {
                received.push(payload)
                return { applied: true }
            },
        })

        // 一轮带 bash 工具 → 第 6 轮触发时窗口含此工具日志
        for (let i = 0; i < 6; i++) {
            await fireRound(handlers, { tool: "bash", args: { cmd: `echo ${i}` }, result: `o${i}` })
        }
        await waitFor(() => received.length >= 1)

        const rounds = received[0]?.rounds ?? []
        const firstRound = rounds[0]
        expect(firstRound?.tool_logs[0]?.tool_name).toBe("bash")
        expect(firstRound?.tool_logs[0]?.args_summary).toContain("echo 0")
        expect(firstRound?.tool_logs[0]?.result_summary).toBe("o0")
        expect(firstRound?.tool_logs[0]?.is_error).toBe(false)
    })
})
