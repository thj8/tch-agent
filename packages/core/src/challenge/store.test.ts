import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
    appendChallengeAttemptLog,
    appendChallengeSubmissionLog,
    computeChallengeCompleted,
    listChallengeAttemptLogs,
    listChallengeRecords,
    listChallengeSubmissionLogs,
    readChallengeRecord,
    saveChallengeRecord,
    type ChallengeRecord,
} from "./store"

let rootDir: string

beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "tinyfat-challenge-"))
})

afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true })
})

/** 一份最小合法 ChallengeRecord，测试里展开覆盖。 */
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
        flags: [],
        ...overrides,
    }
}

describe("challenge store - 元数据 save/read/list", () => {
    test("save 后 read 能读回，带 updated_at / source", async () => {
        await saveChallengeRecord(rootDir, baseRecord("test-1"), "manual")

        const got = await readChallengeRecord(rootDir, "test-1")
        expect(got).toBeDefined()
        expect(got!.id).toBe("test-1")
        expect(got!.title).toBe("title-test-1")
        expect(got!.source).toBe("manual")
        expect(got!.updated_at).toBeTruthy()
        // 原字段保留
        expect(got!.flag_count).toBe(1)
    })

    test("save 默认 source = save", async () => {
        await saveChallengeRecord(rootDir, baseRecord("test-2"))
        expect((await readChallengeRecord(rootDir, "test-2"))!.source).toBe("save")
    })

    test("save 覆盖写：再存一次以新值为准", async () => {
        await saveChallengeRecord(rootDir, baseRecord("c1", { title: "old" }))
        await saveChallengeRecord(rootDir, baseRecord("c1", { title: "new" }))
        expect((await readChallengeRecord(rootDir, "c1"))!.title).toBe("new")
    })

    test("read 不存在的题目返回 undefined", async () => {
        expect(await readChallengeRecord(rootDir, "ghost")).toBeUndefined()
    })

    test("list 空时返回 []", async () => {
        expect(await listChallengeRecords(rootDir)).toEqual([])
    })

    test("list 返回全部题目，按解码后的 id 排序", async () => {
        await saveChallengeRecord(rootDir, baseRecord("b-1"))
        await saveChallengeRecord(rootDir, baseRecord("a-1"))
        const list = await listChallengeRecords(rootDir)
        expect(list.map((c) => c.id)).toEqual(["a-1", "b-1"])
    })

    test("save 锁用完即释放：locks 目录下不残留 challenge.lock", async () => {
        await saveChallengeRecord(rootDir, baseRecord("c1"))
        const locksDir = join(rootDir, encodeURIComponent("c1"), "locks")
        const entries = await readdir(locksDir).catch(() => [] as string[])
        expect(entries).not.toContain("challenge.lock")
    })
})

describe("challenge store - ID 编码", () => {
    test("含特殊字符的 ID 编码成单层目录，能正常读回", async () => {
        const id = "http://example.com/c?id=1"
        await saveChallengeRecord(rootDir, baseRecord(id))

        // 根目录里每个 challenge 恰好是一个扁平条目（不会因为 // 展开成多层）
        const entries = await readdir(rootDir, { withFileTypes: true })
        const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name)
        expect(dirs).toHaveLength(1)
        expect(dirs[0]).not.toContain("/")

        const got = await readChallengeRecord(rootDir, id)
        expect(got!.id).toBe(id)
    })

    test("list 能把编码后的目录名正确解码回原始 ID", async () => {
        const id = "http://example.com"
        await saveChallengeRecord(rootDir, baseRecord(id))
        const list = await listChallengeRecords(rootDir)
        expect(list.map((c) => c.id)).toEqual([id])
    })
})

describe("challenge store - 参数校验", () => {
    test("save 空 id 抛错", async () => {
        expect(saveChallengeRecord(rootDir, baseRecord("   "))).rejects.toThrow(
            "challenge.id is required",
        )
    })

    test("appendChallengeAttemptLog 空 solverId 抛错", async () => {
        await saveChallengeRecord(rootDir, baseRecord("c1"))
        expect(
            appendChallengeAttemptLog(rootDir, {
                challengeId: "c1",
                solverId: "  ",
                promptName: "SOLVER",
                task: "t",
            }),
        ).rejects.toThrow("solverId is required")
    })

    test("appendChallengeSubmissionLog 空 flag 抛错", async () => {
        await saveChallengeRecord(rootDir, baseRecord("c1"))
        expect(
            appendChallengeSubmissionLog(rootDir, {
                challengeId: "c1",
                flag: "",
                correct: true,
            }),
        ).rejects.toThrow("flag is required")
    })

    test("listChallengeAttemptLogs 空 challengeId 抛错", async () => {
        expect(listChallengeAttemptLogs(rootDir, "")).rejects.toThrow("challengeId is required")
    })
})

describe("challenge store - attempt 日志", () => {
    test("append 生成 attempt_ 前缀 id，list 能读回", async () => {
        await saveChallengeRecord(rootDir, baseRecord("c1"))
        const rec = await appendChallengeAttemptLog(rootDir, {
            challengeId: "c1",
            solverId: "solver-a",
            promptName: "SOLVER",
            task: "solve it",
        })
        expect(rec.id).toMatch(/^attempt_[a-f0-9]{8}$/)
        expect(rec.challenge_id).toBe("c1")
        expect(rec.solver_id).toBe("solver-a")

        const list = await listChallengeAttemptLogs(rootDir, "c1")
        expect(list).toHaveLength(1)
        expect(list[0].task).toBe("solve it")
    })

    test("append 多条，list 全部返回", async () => {
        await saveChallengeRecord(rootDir, baseRecord("c1"))
        await appendChallengeAttemptLog(rootDir, {
            challengeId: "c1",
            solverId: "a",
            promptName: "SOLVER",
            task: "t1",
        })
        await appendChallengeAttemptLog(rootDir, {
            challengeId: "c1",
            solverId: "b",
            promptName: "SOLVER",
            task: "t2",
        })
        const list = await listChallengeAttemptLogs(rootDir, "c1")
        expect(list).toHaveLength(2)
        expect(list.map((a) => a.task).sort()).toEqual(["t1", "t2"])
    })

    test("listAttempts 题目无日志时返回 []", async () => {
        await saveChallengeRecord(rootDir, baseRecord("c1"))
        expect(await listChallengeAttemptLogs(rootDir, "c1")).toEqual([])
    })
})

describe("challenge store - submission 日志", () => {
    test("append 正确/错误都记录，list 能读回", async () => {
        await saveChallengeRecord(rootDir, baseRecord("c1"))
        const ok = await appendChallengeSubmissionLog(rootDir, {
            challengeId: "c1",
            solverId: "s1",
            flag: "flag{a}",
            correct: true,
            message: "nice",
        })
        const bad = await appendChallengeSubmissionLog(rootDir, {
            challengeId: "c1",
            flag: "flag{wrong}",
            correct: false,
        })
        expect(ok.id).toMatch(/^submission_[a-f0-9]{8}$/)
        expect(ok.correct).toBe(true)
        expect(bad.correct).toBe(false)
        // solver_id 可选
        expect(bad.solver_id).toBeUndefined()

        const list = await listChallengeSubmissionLogs(rootDir, "c1")
        expect(list).toHaveLength(2)
        expect(list.some((s) => s.correct)).toBe(true)
        expect(list.some((s) => !s.correct)).toBe(true)
    })
})

describe("challenge store - computeChallengeCompleted", () => {
    test("undefined → false", () => {
        expect(computeChallengeCompleted(undefined)).toBe(false)
    })

    test("flag_count = 0 → false（不能凭空完成）", () => {
        const fake = { flag_count: 0, flag_got_count: 0 } as never
        expect(computeChallengeCompleted(fake)).toBe(false)
    })

    test("flag_got < flag_count → false", () => {
        const fake = { flag_count: 3, flag_got_count: 2 } as never
        expect(computeChallengeCompleted(fake)).toBe(false)
    })

    test("flag_got >= flag_count > 0 → true", () => {
        const fake = { flag_count: 3, flag_got_count: 3 } as never
        expect(computeChallengeCompleted(fake)).toBe(true)
    })

    test("save 后读回的 record 喂给 compute 行为一致", async () => {
        await saveChallengeRecord(rootDir, baseRecord("c1", { flag_count: 2, flag_got_count: 1 }))
        const unfinished = await readChallengeRecord(rootDir, "c1")
        expect(computeChallengeCompleted(unfinished)).toBe(false)

        await saveChallengeRecord(rootDir, baseRecord("c1", { flag_count: 2, flag_got_count: 2 }))
        const finished = await readChallengeRecord(rootDir, "c1")
        expect(computeChallengeCompleted(finished)).toBe(true)
    })
})

describe("challenge store - stale lock 检测", () => {
    test("残留的过期锁（>60s）会被强制清理，save 正常完成", async () => {
        await saveChallengeRecord(rootDir, baseRecord("c1"))

        // 手动造一个 2 分钟前的 stale 锁目录
        const lockDir = join(rootDir, encodeURIComponent("c1"), "locks", "challenge.lock")
        await mkdir(lockDir, { recursive: true })
        const staleIso = new Date(Date.now() - 120_000).toISOString()
        await writeFile(
            join(lockDir, "lock-meta.json"),
            JSON.stringify({ created_at: staleIso, pid: 99999 }),
        )

        // 这次 save 应该检测到 stale、清理、抢到锁、写入
        await saveChallengeRecord(rootDir, baseRecord("c1", { title: "after-stale" }))

        expect((await readChallengeRecord(rootDir, "c1"))!.title).toBe("after-stale")
        // 锁再次释放
        const locksEntries = await readdir(join(rootDir, encodeURIComponent("c1"), "locks")).catch(
            () => [] as string[],
        )
        expect(locksEntries).not.toContain("challenge.lock")
    })
})
