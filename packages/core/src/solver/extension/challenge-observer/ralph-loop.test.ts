import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent"
import { CHALLENGE_ENV_CHALLENGE_ID } from "../../../challenge/env"
import {
  attachChallengeContinuation,
  getAgentEndError,
  getChallengeDelayMs,
  isChallengeMode,
} from "./ralph-loop"

type Handler = (event: unknown, ctx?: unknown) => Promise<void> | void
type SentEntry = { message: unknown; options: unknown }

/** 伪造 ExtensionAPI：捕获 on 注册的 handler，并记录 sendMessage 调用。 */
function createFakePi(): {
  handlers: Record<string, Handler>
  api: ExtensionAPI
  sent: SentEntry[]
} {
  const handlers: Record<string, Handler> = {}
  const sent: SentEntry[] = []
  const api = {
    on(event: string, handler: Handler) {
      handlers[event] = handler
    },
    sendMessage(message: unknown, options?: unknown) {
      sent.push({ message, options })
    },
  } as unknown as ExtensionAPI
  return { handlers, api, sent }
}

/** 续跑消息在 setImmediate 里注入；这里轮询等它落袋。 */
async function waitForSent(sent: SentEntry[], n: number, timeoutMs = 500): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (sent.length >= n) return
    await Bun.sleep(2)
  }
}

describe("ralph-loop - getChallengeDelayMs", () => {
  test("指数退避 + 封顶", () => {
    expect(getChallengeDelayMs(1)).toBe(1000)
    expect(getChallengeDelayMs(2)).toBe(2000)
    expect(getChallengeDelayMs(3)).toBe(4000)
    expect(getChallengeDelayMs(4)).toBe(8000)
    expect(getChallengeDelayMs(5)).toBe(10000)
    expect(getChallengeDelayMs(100)).toBe(10000) // 封顶
  })
})

describe("ralph-loop - isChallengeMode", () => {
  let prev: string | undefined
  beforeEach(() => {
    prev = process.env[CHALLENGE_ENV_CHALLENGE_ID]
  })
  afterEach(() => {
    if (prev === undefined) delete process.env[CHALLENGE_ENV_CHALLENGE_ID]
    else process.env[CHALLENGE_ENV_CHALLENGE_ID] = prev
  })

  test("未设置 → false", () => {
    delete process.env[CHALLENGE_ENV_CHALLENGE_ID]
    expect(isChallengeMode()).toBe(false)
  })

  test("非空值 → true", () => {
    process.env[CHALLENGE_ENV_CHALLENGE_ID] = "ctf-1"
    expect(isChallengeMode()).toBe(true)
  })

  test("纯空白 → false", () => {
    process.env[CHALLENGE_ENV_CHALLENGE_ID] = "   "
    expect(isChallengeMode()).toBe(false)
  })
})

describe("ralph-loop - getAgentEndError", () => {
  test("error assistant → 返回 errorMessage", () => {
    const msgs = [{ role: "assistant", stopReason: "error", errorMessage: "rate limited" }]
    expect(getAgentEndError(msgs)).toBe("rate limited")
  })

  test("error assistant 无 errorMessage → 兜底文案", () => {
    const msgs = [{ role: "assistant", stopReason: "error" }]
    expect(getAgentEndError(msgs)).toContain("unknown error")
  })

  test("正常结束（stop）→ undefined", () => {
    const msgs = [{ role: "assistant", stopReason: "stop", content: [] }]
    expect(getAgentEndError(msgs)).toBeUndefined()
  })

  test("末条非 assistant → 向前找最近的 assistant", () => {
    const msgs = [
      { role: "assistant", stopReason: "error", errorMessage: "boom" },
      { role: "toolResult" },
    ]
    expect(getAgentEndError(msgs)).toBe("boom")
  })

  test("无 assistant → undefined", () => {
    const msgs = [{ role: "user" }, { role: "toolResult" }]
    expect(getAgentEndError(msgs)).toBeUndefined()
  })
})

describe("ralph-loop - attachChallengeContinuation", () => {
  test("challenge 已完成 → 不注入续跑消息", async () => {
    const { handlers, api, sent } = createFakePi()
    attachChallengeContinuation(api, { isChallengeCompleted: async () => true })
    await handlers["agent_end"]!({ messages: [{ role: "assistant", stopReason: "stop" }] })
    await Bun.sleep(20)
    expect(sent).toHaveLength(0)
  })

  test("正常结束且未完成 → 注入 challenge-continuation（triggerTurn + display:false）", async () => {
    const { handlers, api, sent } = createFakePi()
    attachChallengeContinuation(api, { isChallengeCompleted: async () => false })
    await handlers["agent_end"]!({ messages: [{ role: "assistant", stopReason: "stop" }] })
    await waitForSent(sent, 1)

    expect(sent).toHaveLength(1)
    expect(sent[0]?.message).toMatchObject({
      customType: "challenge-continuation",
      display: false,
    })
    expect(sent[0]?.options).toEqual({ triggerTurn: true })
  })

  test("error 结束 → 退避后注入续跑", async () => {
    const { handlers, api, sent } = createFakePi()
    const sleeps: number[] = []
    attachChallengeContinuation(api, {
      isChallengeCompleted: async () => false,
      sleep: async (ms) => {
        sleeps.push(ms)
      },
    })
    await handlers["agent_end"]!({
      messages: [{ role: "assistant", stopReason: "error", errorMessage: "boom" }],
    })
    await waitForSent(sent, 1)

    expect(sleeps).toEqual([1000]) // 第 1 次错误退避 1000ms
    expect(sent).toHaveLength(1)
  })

  test("连续 error 第 11 次超过上限 → 放弃，不再注入", async () => {
    const { handlers, api, sent } = createFakePi()
    attachChallengeContinuation(api, {
      isChallengeCompleted: async () => false,
      sleep: async () => {
        // 立即返回
      },
    })

    // 前 10 次 error：每次退避后注入
    for (let i = 0; i < 10; i += 1) {
      await handlers["agent_end"]!({ messages: [{ role: "assistant", stopReason: "error" }] })
      await waitForSent(sent, i + 1, 200)
    }
    expect(sent).toHaveLength(10)

    // 第 11 次：consecutiveErrors=11 > 10 → 放弃
    await handlers["agent_end"]!({ messages: [{ role: "assistant", stopReason: "error" }] })
    await Bun.sleep(20)
    expect(sent).toHaveLength(10) // 仍为 10，没新增
  })

  test("正常结束清零错误计数（之后 error 重新从 1 退避）", async () => {
    const { handlers, api, sent } = createFakePi()
    const sleeps: number[] = []
    attachChallengeContinuation(api, {
      isChallengeCompleted: async () => false,
      sleep: async (ms) => {
        sleeps.push(ms)
      },
    })

    // 2 次 error：退避 1000、2000
    await handlers["agent_end"]!({ messages: [{ role: "assistant", stopReason: "error" }] })
    await waitForSent(sent, 1, 200)
    await handlers["agent_end"]!({ messages: [{ role: "assistant", stopReason: "error" }] })
    await waitForSent(sent, 2, 200)

    // 1 次正常结束 → 清零 + 注入（无 sleep）
    await handlers["agent_end"]!({ messages: [{ role: "assistant", stopReason: "stop" }] })
    await waitForSent(sent, 3, 200)

    // 再 error → consecutiveErrors 回到 1，退避 1000
    await handlers["agent_end"]!({ messages: [{ role: "assistant", stopReason: "error" }] })
    await waitForSent(sent, 4, 200)

    expect(sleeps).toEqual([1000, 2000, 1000])
  })
})
