import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
    addChallengeIdea,
    appendChallengeMemory,
    deleteChallengeIdea,
    deleteChallengeMemory,
    listChallengeIdeas,
    listChallengeMemory,
    searchChallengeIdeas,
    updateChallengeIdea,
    updateChallengeMemory,
} from "./memory"

let rootDir: string

beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "tinyfat-memory-"))
})

afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true })
})

describe("memory - CRUD", () => {
    test("append + list", async () => {
        const entry = await appendChallengeMemory(rootDir, {
            challengeId: "c1",
            kind: "fact",
            content: "gpt-4o supports tools",
            source: "manual",
        })
        expect(entry.id).toMatch(/^mem_/)
        expect(entry.refs).toEqual([])

        const list = await listChallengeMemory(rootDir, "c1")
        expect(list).toHaveLength(1)
        expect(list[0]?.content).toBe("gpt-4o supports tools")
    })

    test("refs 去重 + trim（空串过滤）", async () => {
        const entry = await appendChallengeMemory(rootDir, {
            challengeId: "c1",
            kind: "evidence",
            content: "x",
            source: "s",
            refs: ["a", " a ", "b", ""],
        })
        expect(entry.refs).toEqual(["a", "b"])
    })

    test("多条 memory 按文件名（ts 前缀）排序", async () => {
        await appendChallengeMemory(rootDir, {
            challengeId: "c1",
            kind: "fact",
            content: "first",
            source: "s",
        })
        await Bun.sleep(5)
        await appendChallengeMemory(rootDir, {
            challengeId: "c1",
            kind: "fact",
            content: "second",
            source: "s",
        })
        const list = await listChallengeMemory(rootDir, "c1")
        expect(list).toHaveLength(2)
        expect(list[0]?.content).toBe("first")
        expect(list[1]?.content).toBe("second")
    })

    test("update（前缀匹配）改 content / kind", async () => {
        const e = await appendChallengeMemory(rootDir, {
            challengeId: "c1",
            kind: "fact",
            content: "old",
            source: "s",
        })
        const updated = await updateChallengeMemory(rootDir, "c1", e.id.slice(0, 6), {
            content: "new",
            kind: "evidence",
        })
        expect(updated.content).toBe("new")
        expect(updated.kind).toBe("evidence")
        const list = await listChallengeMemory(rootDir, "c1")
        expect(list).toHaveLength(1)
        expect(list[0]?.content).toBe("new")
    })

    test("update 不存在 → 抛错", async () => {
        await expect(
            updateChallengeMemory(rootDir, "c1", "mem_nope", { content: "x" }),
        ).rejects.toThrow(/not found/)
    })

    test("delete（前缀匹配）", async () => {
        const e = await appendChallengeMemory(rootDir, {
            challengeId: "c1",
            kind: "fact",
            content: "x",
            source: "s",
        })
        await deleteChallengeMemory(rootDir, "c1", e.id)
        expect(await listChallengeMemory(rootDir, "c1")).toHaveLength(0)
    })

    test("list 不存在的 challenge → []", async () => {
        expect(await listChallengeMemory(rootDir, "nope")).toEqual([])
    })
})

describe("ideas - CRUD + 去重 + 双写", () => {
    test("add + list（默认 pending）", async () => {
        const r = await addChallengeIdea(rootDir, "c1", { content: "test SQL injection" })
        expect(r.created).toBe(true)
        expect(r.item.status).toBe("pending")
        expect(r.item.normalized).toBe("test sql injection")

        const list = await listChallengeIdeas(rootDir, "c1")
        expect(list).toHaveLength(1)
        expect(list[0]?.content).toBe("test SQL injection")
    })

    test("去重：大小写/空格不同 → created:false，同一 item", async () => {
        const first = await addChallengeIdea(rootDir, "c1", { content: "Test SQL Injection" })
        const second = await addChallengeIdea(rootDir, "c1", { content: "  test sql injection  " })
        expect(first.created).toBe(true)
        expect(second.created).toBe(false)
        expect(second.item.id).toBe(first.item.id)
        expect(await listChallengeIdeas(rootDir, "c1")).toHaveLength(1)
    })

    test("update（前缀）status + result", async () => {
        const r = await addChallengeIdea(rootDir, "c1", { content: "check /admin" })
        const updated = await updateChallengeIdea(rootDir, "c1", r.item.id.slice(0, 6), {
            status: "testing",
            result: "found admin panel",
        })
        expect(updated.status).toBe("testing")
        expect(updated.result).toBe("found admin panel")
    })

    test("update 不存在 → 抛错", async () => {
        await expect(
            updateChallengeIdea(rootDir, "c1", "idea_nope", { status: "failed" }),
        ).rejects.toThrow(/not found/)
    })

    test("前缀歧义 → 抛错（手工写两条共享前缀的 idea）", async () => {
        const ideasDir = join(rootDir, "c1", "ideas")
        await mkdir(join(ideasDir, "by-id"), { recursive: true })
        const item = (suffix: string) => ({
            id: `idea_aaa${suffix}`,
            content: `c${suffix}`,
            normalized: `c${suffix}`,
            status: "pending" as const,
            result: "",
            created_at: "t",
            updated_at: "t",
        })
        const index = { challengeId: "c1", updated_at: "t", items: [item("1"), item("2")] }
        await Bun.write(join(ideasDir, "index.json"), JSON.stringify(index))
        await Bun.write(join(ideasDir, "by-id", "idea_aaa1.json"), JSON.stringify(item("1")))
        await Bun.write(join(ideasDir, "by-id", "idea_aaa2.json"), JSON.stringify(item("2")))

        await expect(
            updateChallengeIdea(rootDir, "c1", "idea_aaa", { status: "failed" }),
        ).rejects.toThrow(/ambiguous/)
    })

    test("delete（前缀）", async () => {
        const r = await addChallengeIdea(rootDir, "c1", { content: "try xss" })
        await deleteChallengeIdea(rootDir, "c1", r.item.id)
        expect(await listChallengeIdeas(rootDir, "c1")).toHaveLength(0)
    })

    test("search：按 content / result 子串（大小写无关）", async () => {
        await addChallengeIdea(rootDir, "c1", { content: "SQL injection on login" })
        await addChallengeIdea(rootDir, "c1", { content: "other", result: "sqlmap found dbs" })
        const hits = await searchChallengeIdeas(rootDir, "c1", "sql")
        expect(hits).toHaveLength(2)
    })

    test("双写：index.json + by-id/<id>.json 都存在", async () => {
        const r = await addChallengeIdea(rootDir, "c1", { content: "double write check" })
        const byIdFiles = (await readdir(join(rootDir, "c1", "ideas", "by-id"))).filter(
            (f) => f.endsWith(".json"),
        )
        expect(byIdFiles).toContain(`${r.item.id}.json`)
        // index 里也能读到
        expect((await listChallengeIdeas(rootDir, "c1")).some((i) => i.id === r.item.id)).toBe(true)
    })
})
