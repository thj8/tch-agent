import { afterEach, describe, expect, test } from "bun:test"
import {
    ChallengeApiClient,
    type ChallengeApiMockState,
} from "./api-client"

const originalFetch = globalThis.fetch
afterEach(() => {
    // 恢复可能被某条用例换掉的 fetch
    globalThis.fetch = originalFetch
})

/** 一个全量 mock state：每个方法都记下被调的参数 + 可控返回。 */
function makeMockState(overrides: Partial<ChallengeApiMockState> = {}): ChallengeApiMockState & {
    calls: { method: string; args: unknown[] }[]
} {
    const calls: { method: string; args: unknown[] }[] = []
    return {
        calls,
        listChallenges: overrides.listChallenges ?? (async () => {
            calls.push({ method: "listChallenges", args: [] })
            return {
                current_level: 1,
                total_challenges: 1,
                solved_challenges: 0,
                challenges: [
                    {
                        title: "T",
                        code: "c1",
                        difficulty: "easy",
                        description: "",
                        level: 1,
                        total_score: 100,
                        total_got_score: 0,
                        flag_count: 1,
                        flag_got_count: 0,
                        hint_viewed: false,
                        instance_status: "stopped",
                        entrypoint: null,
                    },
                ],
            }
        }),
        startChallenge: overrides.startChallenge ?? (async (code) => {
            calls.push({ method: "startChallenge", args: [code] })
            return ["127.0.0.1:8080"]
        }),
        stopChallenge: overrides.stopChallenge ?? (async (code) => {
            calls.push({ method: "stopChallenge", args: [code] })
            return null
        }),
        submitFlag: overrides.submitFlag ?? (async (code, flag) => {
            calls.push({ method: "submitFlag", args: [code, flag] })
            return {
                correct: flag === "flag{yes}",
                message: "",
                flag_count: 1,
                flag_got_count: flag === "flag{yes}" ? 1 : 0,
            }
        }),
        getHint: overrides.getHint ?? (async (code) => {
            calls.push({ method: "getHint", args: [code] })
            return { code, hint_content: "look here" }
        }),
    }
}

describe("ChallengeApiClient - baseUrl 规范化", () => {
    test("缺 /api 自动补上", () => {
        expect(ChallengeApiClient.create("https://x.example.com", "t").baseUrl).toBe(
            "https://x.example.com/api",
        )
    })

    test("去掉尾部 / 再补 /api", () => {
        expect(ChallengeApiClient.create("https://x.example.com/", "t").baseUrl).toBe(
            "https://x.example.com/api",
        )
    })

    test("已经有 /api 不重复", () => {
        expect(ChallengeApiClient.create("https://x.example.com/api", "t").baseUrl).toBe(
            "https://x.example.com/api",
        )
    })

    test("/api/ 的尾部斜杠被去掉", () => {
        expect(ChallengeApiClient.create("https://x.example.com/api/", "t").baseUrl).toBe(
            "https://x.example.com/api",
        )
    })

    test("空 baseUrl 抛错", () => {
        expect(() => ChallengeApiClient.create("   ", "t")).toThrow("baseUrl is required")
    })

    test("空 agentToken 抛错", () => {
        expect(() => ChallengeApiClient.create("https://x", "")).toThrow("agentToken is required")
    })
})

describe("ChallengeApiClient - mock 模式", () => {
    test("isMock() 区分两种构造", () => {
        expect(ChallengeApiClient.createMock(makeMockState()).isMock()).toBe(true)
        expect(ChallengeApiClient.create("https://x", "t").isMock()).toBe(false)
    })

    test("listChallenges 走 mockState 并返回其数据", async () => {
        const mock = makeMockState()
        const client = ChallengeApiClient.createMock(mock)
        const data = await client.listChallenges()
        expect(data.total_challenges).toBe(1)
        expect(data.challenges[0].code).toBe("c1")
        expect(mock.calls.map((c) => c.method)).toEqual(["listChallenges"])
    })

    test("submitFlag 透传 code/flag，按 flag 判定 correct", async () => {
        const client = ChallengeApiClient.createMock(makeMockState())
        const wrong = await client.submitFlag("c1", "nope")
        const right = await client.submitFlag("c1", "flag{yes}")
        expect(wrong.correct).toBe(false)
        expect(right.correct).toBe(true)
        expect(right.flag_got_count).toBe(1)
    })

    test("getHint 返回 hint_content", async () => {
        const client = ChallengeApiClient.createMock(makeMockState())
        const hint = await client.getHint("c1")
        expect(hint.hint_content).toBe("look here")
        expect(hint.code).toBe("c1")
    })

    test("startChallenge / stopChallenge 走 mock", async () => {
        const client = ChallengeApiClient.createMock(makeMockState())
        expect(await client.startChallenge("c1")).toEqual(["127.0.0.1:8080"])
        expect(await client.stopChallenge("c1")).toBeNull()
    })

    test("mock 模式也做空值校验（submitFlag 空 flag 抛错，且不调 mock）", async () => {
        const mock = makeMockState()
        const client = ChallengeApiClient.createMock(mock)
        expect(client.submitFlag("c1", "  ")).rejects.toThrow("flag is required")
        expect(client.startChallenge("")).rejects.toThrow("code is required")
        // 抛错发生在调 mockState 之前
        expect(mock.calls).toHaveLength(0)
    })
})

describe("ChallengeApiClient - 真实模式信封解析（fake fetch）", () => {
    test("code === 0 返回 data", async () => {
        globalThis.fetch = (async () =>
            new Response(
                JSON.stringify({
                    code: 0,
                    message: "ok",
                    data: { current_level: 2, total_challenges: 5, solved_challenges: 1, challenges: [] },
                }),
                { status: 200, headers: { "content-type": "application/json" } },
            )) as unknown as typeof fetch
        const client = ChallengeApiClient.create("https://x.example.com", "tok")
        const data = await client.listChallenges()
        expect(data.total_challenges).toBe(5)
        expect(client.baseUrl).toBe("https://x.example.com/api")
    })

    test("code !== 0 抛错带平台 message", async () => {
        globalThis.fetch = (async () =>
            new Response(
                JSON.stringify({ code: 1, message: "rate limited", data: null }),
                { status: 200, headers: { "content-type": "application/json" } },
            )) as unknown as typeof fetch
        const client = ChallengeApiClient.create("https://x.example.com", "tok")
        expect(client.listChallenges()).rejects.toThrow(/failed: rate limited/)
    })

    test("HTTP 非 2xx 抛错带状态码", async () => {
        globalThis.fetch = (async () =>
            new Response("nope", { status: 500, headers: { "content-type": "text/plain" } })) as unknown as typeof fetch
        const client = ChallengeApiClient.create("https://x.example.com", "tok")
        expect(client.listChallenges()).rejects.toThrow(/HTTP 500/)
    })
})

describe("ChallengeApiClient - 限流串行化", () => {
    test("并发请求按发起顺序串行，且被间隔分开", async () => {
        const order: number[] = []
        let n = 0
        const mock = makeMockState({
            listChallenges: async () => {
                order.push(n++)
                return { current_level: 0, total_challenges: 0, solved_challenges: 0, challenges: [] }
            },
        })
        const client = ChallengeApiClient.createMock(mock)

        const start = Date.now()
        // 三个"并发"请求
        await Promise.all([
            client.listChallenges(),
            client.listChallenges(),
            client.listChallenges(),
        ])
        const elapsed = Date.now() - start

        // 顺序被保留
        expect(order).toEqual([0, 1, 2])
        // 3 个请求、间隔 ~333ms → 总耗时至少 ~600ms（若并发则 ~0ms）
        expect(elapsed).toBeGreaterThanOrEqual(600)
    })
})
