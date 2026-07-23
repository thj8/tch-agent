import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
    enqueueObserverReview,
    loadLatestObserverRoundNumber,
    loadObserverState,
    loadRecentObserverRounds,
    persistObserverRound,
    takeNextObserverReview,
    updateObserverState,
} from "./observer-store"
import type { ObserverReviewPayload, ObserverRoundPayload } from "./types"

let sessionDir: string
let prevEnv: string | undefined

beforeEach(async () => {
    sessionDir = await mkdtemp(join(tmpdir(), "tinyfat-observer-store-"))
    prevEnv = process.env.TCH_SOLVER_SESSION_DIR
    process.env.TCH_SOLVER_SESSION_DIR = sessionDir
})

afterEach(async () => {
    if (prevEnv === undefined) delete process.env.TCH_SOLVER_SESSION_DIR
    else process.env.TCH_SOLVER_SESSION_DIR = prevEnv
    await rm(sessionDir, { recursive: true, force: true })
})

function round(n: number, over: Partial<ObserverRoundPayload> = {}): ObserverRoundPayload {
    return { round: n, assistant_summary: `round ${n}`, tool_logs: [], ...over }
}

describe("observer-store - state", () => {
    test("loadObserverState 默认值", async () => {
        const state = await loadObserverState()
        expect(state.round).toBe(0)
        expect(state.current_round_tool_logs).toEqual([])
        expect(state.tool_args_by_call_id).toEqual({})
    })

    test("updateObserverState 读 → 改 → 写", async () => {
        const result = await updateObserverState((state) => ({
            nextState: { ...state, round: 42 },
            result: state.round,
        }))
        expect(result).toBe(0) // 改之前的值
        expect((await loadObserverState()).round).toBe(42)
    })
})

describe("observer-store - review queue (FIFO)", () => {
    test("enqueue + take 按 ts 顺序", async () => {
        await enqueueObserverReview({ reason: "periodic", rounds: [], session_context: "a" })
        await Bun.sleep(2)
        await enqueueObserverReview({ reason: "hint", rounds: [], session_context: "b" })
        await Bun.sleep(2)
        await enqueueObserverReview({ reason: "agent_end", rounds: [], session_context: "c" })

        const first = await takeNextObserverReview()
        const second = await takeNextObserverReview()
        const third = await takeNextObserverReview()
        expect(first?.session_context).toBe("a")
        expect(second?.session_context).toBe("b")
        expect(third?.session_context).toBe("c")
    })

    test("空队列 take → undefined", async () => {
        expect(await takeNextObserverReview()).toBeUndefined()
    })

    test("payload 结构保持", async () => {
        const payload: ObserverReviewPayload = {
            reason: "periodic",
            rounds: [round(1)],
            session_context: "ctx",
        }
        await enqueueObserverReview(payload)
        const got = await takeNextObserverReview()
        expect(got?.reason).toBe("periodic")
        expect(got?.rounds).toHaveLength(1)
        expect(got?.rounds[0]?.round).toBe(1)
    })
})

describe("observer-store - rounds archive", () => {
    test("persist + loadRecent（limit）按轮号升序", async () => {
        await persistObserverRound(round(1))
        await persistObserverRound(round(2))
        await persistObserverRound(round(3))

        const recent = await loadRecentObserverRounds(2)
        expect(recent.map((r) => r.round)).toEqual([2, 3])
    })

    test("loadRecent(0) → []", async () => {
        await persistObserverRound(round(1))
        expect(await loadRecentObserverRounds(0)).toEqual([])
    })

    test("loadLatestObserverRoundNumber", async () => {
        expect(await loadLatestObserverRoundNumber()).toBe(0)
        await persistObserverRound(round(5))
        await persistObserverRound(round(7))
        expect(await loadLatestObserverRoundNumber()).toBe(7)
    })
})
