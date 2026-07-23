import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ConfigManager } from "../config/index"
import {
    ChallengeManager,
    buildSolverTask,
    enumSchema,
    formatPlannerSnapshot,
} from "./manager"
import type { RuntimeManager } from "../runtime/runtime"
import type { SolverInstance } from "../runtime/types"
import type { ChallengeInfoRecord, ChallengeRecord } from "./store"

let configDir: string
let rootDir: string
let config: ConfigManager
let mgr: ChallengeManager

beforeEach(async () => {
    ConfigManager.resetInstance()
    configDir = await mkdtemp(join(tmpdir(), "tinyfat-cfg-"))
    rootDir = await mkdtemp(join(tmpdir(), "tinyfat-challenge-"))
    config = await ConfigManager.getInstance(configDir)
    // 开 mock 模式
    await config.setHostSettings({ challenge: { mockEnabled: true } })
    mgr = new ChallengeManager(config, rootDir)
})

afterEach(async () => {
    ConfigManager.resetInstance()
    await rm(configDir, { recursive: true, force: true })
    await rm(rootDir, { recursive: true, force: true })
})

function baseRecord(id: string, overrides: Partial<ChallengeRecord> = {}): ChallengeRecord {
    return {
        id,
        title: `title-${id}`,
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
        flags: [`flag{${id}}`],
        ...overrides,
    }
}

describe("ChallengeManager - mock 模式：基础读写", () => {
    test("createChallenge 后 getChallenge 能读回", async () => {
        await mgr.createChallenge(baseRecord("c1"))
        const got = await mgr.getChallenge("c1")
        expect(got?.title).toBe("title-c1")
        expect(got?.source).toBe("manual")
    })

    test("listChallenges 同步：remote 反映本地数量，flags 经 sync 保留", async () => {
        await mgr.createChallenge(baseRecord("c1", { flags: ["flag{c1}"] }))
        const { remote, local } = await mgr.listChallenges()
        expect(remote.total_challenges).toBe(1)
        expect(remote.solved_challenges).toBe(0)
        expect(local).toHaveLength(1)
        // sync 后 flags 仍在（mock submit 依赖它）
        expect((await mgr.getChallenge("c1"))?.flags).toEqual(["flag{c1}"])
    })
})

describe("ChallengeManager - mock 模式：start/stop", () => {
    test("startChallenge 把状态置 running 并返回 entrypoint", async () => {
        await mgr.createChallenge(baseRecord("c1"))
        const result = await mgr.startChallenge("c1")
        expect(Array.isArray(result.remote)).toBe(true)
        expect(result.challenge?.instance_status).toBe("running")
    })

    test("已完成题目再 start 返回 already_completed，不改状态", async () => {
        await mgr.createChallenge(baseRecord("c1", { flag_count: 1, flag_got_count: 1 }))
        const result = await mgr.startChallenge("c1")
        expect(result.remote).toEqual({ already_completed: true })
        // finishChallenge 会被 submit 触发，但这里没 submit；start 不应把已完成题改成 running
        expect(result.challenge?.instance_status).not.toBe("running")
    })
})

describe("ChallengeManager - mock 模式：submitFlag", () => {
    test("错误 flag：不增加进度，不算完成", async () => {
        await mgr.createChallenge(baseRecord("c1"))
        const wrong = await mgr.submitFlag("c1", "flag{wrong}")
        expect(wrong.remote.correct).toBe(false)
        expect(wrong.remote.flag_got_count).toBe(0)
        expect(wrong.is_completed).toBe(false)
    })

    test("正确 flag：进度 +1，完成 → 触发 finish（实例被停）", async () => {
        await mgr.createChallenge(baseRecord("c1", { flag_count: 1 }))
        const right = await mgr.submitFlag("c1", "flag{c1}")
        expect(right.remote.correct).toBe(true)
        expect(right.remote.flag_got_count).toBe(1)
        expect(right.is_completed).toBe(true)
        // finishChallenge 自动停了实例
        expect(right.challenge?.instance_status).toBe("stopped")
    })

    test("多 flag：提交两个不同 flag 才完成", async () => {
        await mgr.createChallenge(
            baseRecord("c2", { flag_count: 2, flags: ["flag{a}", "flag{b}"] }),
        )
        const first = await mgr.submitFlag("c2", "flag{a}")
        expect(first.is_completed).toBe(false)
        expect(first.remote.flag_got_count).toBe(1)

        const second = await mgr.submitFlag("c2", "flag{b}")
        expect(second.is_completed).toBe(true)
        expect(second.remote.flag_got_count).toBe(2)
    })
})

describe("ChallengeManager - mock 模式：hint / 完成 / 日志", () => {
    test("getHint 标记 viewed 并返回 content", async () => {
        await mgr.createChallenge(
            baseRecord("c1", { hint_content: "look at /etc/passwd", hint_viewed: false }),
        )
        const result = await mgr.getHint("c1")
        expect(result.remote.hint_content).toBe("look at /etc/passwd")
        expect(result.challenge?.hint_viewed).toBe(true)
    })

    test("isChallengeCompleted 语义", async () => {
        await mgr.createChallenge(baseRecord("c1", { flag_count: 2, flag_got_count: 1 }))
        expect(await mgr.isChallengeCompleted("c1")).toBe(false)
        await mgr.createChallenge(
            baseRecord("c1", { flag_count: 2, flag_got_count: 2 }),
        )
        expect(await mgr.isChallengeCompleted("c1")).toBe(true)
    })

    test("appendAttemptLog / listAttemptLogs 往返", async () => {
        await mgr.createChallenge(baseRecord("c1"))
        await mgr.appendAttemptLog({
            challengeId: "c1",
            solverId: "s1",
            promptName: "SOLVER",
            task: "solve it",
        })
        const list = await mgr.listAttemptLogs("c1")
        expect(list).toHaveLength(1)
        expect(list[0].task).toBe("solve it")
    })
})

describe("ChallengeManager - 真实模式", () => {
    test("未配置 apiBaseUrl/agentToken 抛错", async () => {
        // 单独造一个没开 mock 的 config（host-settings 为默认空骨架）
        ConfigManager.resetInstance()
        const realConfigDir = await mkdtemp(join(tmpdir(), "tinyfat-cfg-real-"))
        try {
            const realConfig = await ConfigManager.getInstance(realConfigDir)
            const realMgr = new ChallengeManager(realConfig, rootDir)
            expect(realMgr.listChallenges()).rejects.toThrow(/not configured/)
        } finally {
            ConfigManager.resetInstance()
            await rm(realConfigDir, { recursive: true, force: true })
        }
    })
})

// ── lesson 14：Planner 调度 ──────────────────────────

function infoRecord(id: string, overrides: Partial<ChallengeRecord> = {}): ChallengeInfoRecord {
    return baseRecord(id, overrides) as unknown as ChallengeInfoRecord
}

/** 最小 fake runtime：只实现 launchSolver 依赖的 launch/list/stopSolver，记录 launch 调用。 */
function makeFakeRuntime() {
    const launchCalls: Array<{
        promptName: string
        task: string
        env: Record<string, string>
    }> = []
    return {
        launchCalls,
        async launch(
            promptName: string,
            task: string,
            env: Record<string, string>,
        ): Promise<SolverInstance> {
            launchCalls.push({ promptName, task, env })
            return {
                id: "solversol1",
                containerId: "tch-solver-solversol1",
                name: "tch-solver-solversol1",
                promptName,
                task,
                challengeId: env.TCH_CHALLENGE_ID,
                status: "running",
                createdAt: 0,
            }
        },
        list(): SolverInstance[] {
            return []
        },
        async stopSolver(_solverId: string): Promise<void> {},
    }
}

describe("Planner 纯函数：buildSolverTask", () => {
    test("基础字段 + 目标行", () => {
        const task = buildSolverTask(infoRecord("c1"))
        expect(task).toContain("# Challenge: title-c1")
        expect(task).toContain("- id: c1")
        expect(task).toContain("- difficulty: easy")
        expect(task).toContain("- flags: 0/1")
        expect(task).toContain("submit all flags using challenge_submit_flag")
    })

    test("entrypoint / hint / handoff 按需出现", () => {
        const task = buildSolverTask(
            infoRecord("c1", { entrypoint: ["1.2.3.4:80"], hint_content: "look here" }),
            "try sqlmap",
        )
        expect(task).toContain("- entrypoint: 1.2.3.4:80")
        expect(task).toContain("## Hint\nlook here")
        expect(task).toContain("## Strategy\ntry sqlmap")
    })

    test("无 entrypoint/hint/handoff 时不出现对应行", () => {
        const task = buildSolverTask(infoRecord("c1"))
        expect(task).not.toContain("entrypoint")
        expect(task).not.toContain("## Hint")
        expect(task).not.toContain("## Strategy")
    })
})

describe("Planner 纯函数：formatPlannerSnapshot", () => {
    test("各 section + 计数", () => {
        const text = formatPlannerSnapshot({
            source: "manual",
            timestamp: "2026-01-01T00:00:00.000Z",
            challenges: [infoRecord("c1"), infoRecord("c2")],
            activeSolvers: [
                {
                    id: "s1",
                    containerId: "c",
                    name: "n",
                    promptName: "SOLVER",
                    task: "t",
                    status: "running",
                    createdAt: 0,
                    challengeId: "c1",
                },
            ],
            availablePrompts: ["SOLVER", "CHALLENGE_PLANNER"],
        })
        expect(text).toContain("Source: manual")
        expect(text).toContain("## Active Solvers (1)")
        expect(text).toContain("- s1 (running")
        expect(text).toContain("## Available Prompts")
        expect(text).toContain("- CHALLENGE_PLANNER")
        expect(text).toContain("## Unsolved Challenges (2)")
        expect(text).toContain("- c1 (easy")
    })
})

describe("Planner 纯函数：enumSchema", () => {
    test("非空 → Literal Union（含每个值）", () => {
        const schema = enumSchema(["a", "b"], "fallback")
        const json = JSON.stringify(schema)
        expect(json).toContain('"a"')
        expect(json).toContain('"b"')
    })

    test("空 → 自由 String（带 fallback 描述）", () => {
        const schema = enumSchema([], "fallback desc")
        expect(JSON.stringify(schema)).toContain("fallback desc")
    })
})

describe("ChallengeManager - launchSolver 编排（mock runtime）", () => {
    test("未 attach runtime → 抛错", async () => {
        await mgr.createChallenge(baseRecord("c1"))
        await expect(mgr.launchSolver("c1", "SOLVER")).rejects.toThrow(/runtime not attached/)
    })

    test("prompt 不存在 → 抛错", async () => {
        await mgr.createChallenge(baseRecord("c1"))
        const fake = makeFakeRuntime()
        mgr.attachRuntime(fake as unknown as RuntimeManager)
        await expect(mgr.launchSolver("c1", "NOPE")).rejects.toThrow(/prompt not found/)
    })

    test("已完成题 → 抛错", async () => {
        await mgr.createChallenge(baseRecord("c1", { flag_count: 1, flag_got_count: 1 }))
        await config.savePrompt({ name: "SOLVER", meta: {}, content: "" })
        const fake = makeFakeRuntime()
        mgr.attachRuntime(fake as unknown as RuntimeManager)
        await expect(mgr.launchSolver("c1", "SOLVER")).rejects.toThrow(/already completed/)
    })

    test("正常：start 占位 + launch 注入 challengeId + 记 attempt log", async () => {
        await mgr.createChallenge(baseRecord("c1"))
        await config.savePrompt({ name: "SOLVER", meta: {}, content: "be a solver" })
        const fake = makeFakeRuntime()
        mgr.attachRuntime(fake as unknown as RuntimeManager)

        const solver = await mgr.launchSolver("c1", "SOLVER", { plannerHandoff: "try x" })
        expect(solver.id).toBe("solversol1")
        expect(fake.launchCalls).toHaveLength(1)
        expect(fake.launchCalls[0].env.TCH_CHALLENGE_ID).toBe("c1")
        expect(fake.launchCalls[0].promptName).toBe("SOLVER")
        expect(fake.launchCalls[0].task).toContain("try x")

        // attempt log 记录了这次启动
        const attempts = await mgr.listAttemptLogs("c1")
        expect(attempts).toHaveLength(1)
        expect(attempts[0].solver_id).toBe("solversol1")
    })
})
