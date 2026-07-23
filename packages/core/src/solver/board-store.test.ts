import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
    addSolverBoardIdea,
    appendSolverBoardMemory,
    deleteSolverBoardMemory,
    listSolverBoardIdeas,
    listSolverBoardMemory,
    searchSolverBoardIdeas,
    solverBoardRootDir,
    updateSolverBoardIdea,
    updateSolverBoardMemory,
} from "./board-store"

let sessionDir: string
let prevEnv: string | undefined

beforeEach(async () => {
    sessionDir = await mkdtemp(join(tmpdir(), "tinyfat-board-"))
    prevEnv = process.env.TCH_SOLVER_SESSION_DIR
    process.env.TCH_SOLVER_SESSION_DIR = sessionDir
})

afterEach(async () => {
    if (prevEnv === undefined) delete process.env.TCH_SOLVER_SESSION_DIR
    else process.env.TCH_SOLVER_SESSION_DIR = prevEnv
    await rm(sessionDir, { recursive: true, force: true })
})

describe("board-store - 路径 + sessionDir 解析", () => {
    test("solverBoardRootDir → <sessionDir>/.observer", () => {
        expect(solverBoardRootDir(sessionDir)).toBe(join(sessionDir, ".observer"))
    })

    test("无 sessionDir 且无 env → 抛错", async () => {
        delete process.env.TCH_SOLVER_SESSION_DIR
        await expect(listSolverBoardMemory()).rejects.toThrow(/TCH_SOLVER_SESSION_DIR/)
    })

    test("env 兜底：不传 sessionDir 也能跑（空列表）", async () => {
        expect(await listSolverBoardMemory()).toEqual([])
    })
})

describe("board-store - memory CRUD", () => {
    test("append + list（显式传 sessionDir）", async () => {
        const entry = await appendSolverBoardMemory(
            { kind: "fact", content: "x", source: "observer" },
            sessionDir,
        )
        expect(entry.id).toMatch(/^mem_/)
        const list = await listSolverBoardMemory(sessionDir)
        expect(list).toHaveLength(1)
        expect(list[0]?.content).toBe("x")
    })

    test("update（前缀）+ delete", async () => {
        const e = await appendSolverBoardMemory(
            { kind: "fact", content: "old", source: "s" },
            sessionDir,
        )
        const updated = await updateSolverBoardMemory(e.id.slice(0, 6), { content: "new" }, sessionDir)
        expect(updated.content).toBe("new")
        await deleteSolverBoardMemory(e.id, sessionDir)
        expect(await listSolverBoardMemory(sessionDir)).toHaveLength(0)
    })
})

describe("board-store - ideas CRUD + 去重 + 搜索", () => {
    test("add + list + 去重", async () => {
        const r1 = await addSolverBoardIdea({ content: "try xss" }, sessionDir)
        const r2 = await addSolverBoardIdea({ content: "  Try XSS " }, sessionDir)
        expect(r1.created).toBe(true)
        expect(r2.created).toBe(false)
        expect(r2.item.id).toBe(r1.item.id)
        expect(await listSolverBoardIdeas(sessionDir)).toHaveLength(1)
    })

    test("update（前缀）status + result", async () => {
        const r = await addSolverBoardIdea({ content: "check /admin" }, sessionDir)
        const updated = await updateSolverBoardIdea(
            r.item.id.slice(0, 6),
            { status: "verified", result: "admin found" },
            sessionDir,
        )
        expect(updated.status).toBe("verified")
        expect(updated.result).toBe("admin found")
    })

    test("search：按 content/result 子串", async () => {
        await addSolverBoardIdea({ content: "SQL injection on login" }, sessionDir)
        await addSolverBoardIdea({ content: "other", result: "sqlmap found dbs" }, sessionDir)
        const hits = await searchSolverBoardIdeas("sql", sessionDir)
        expect(hits).toHaveLength(2)
    })
})
