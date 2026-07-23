import { describe, expect, test } from "bun:test"
import type { IdeaRecord, MemoryEntry } from "../../../challenge/memory"
import { formatIdeaTable, formatMemoryTable } from "./board-format"

function mem(over: Partial<MemoryEntry> = {}): MemoryEntry {
    return {
        id: "mem_abc1",
        challengeId: "board",
        kind: "fact",
        content: "gpt-4o supports tool calling",
        refs: [],
        source: "observer",
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
        ...over,
    }
}

function idea(over: Partial<IdeaRecord> = {}): IdeaRecord {
    return {
        id: "idea_def2",
        content: "test SQL injection on /login",
        normalized: "test sql injection on /login",
        status: "pending",
        result: "",
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
        ...over,
    }
}

describe("board-format - formatMemoryTable", () => {
    test("空列表 → 提示语", () => {
        expect(formatMemoryTable([])).toBe("No memory entries.")
    })

    test("有条目 → 含表头 + 各字段列", () => {
        const out = formatMemoryTable([mem({ id: "mem_abc1", kind: "evidence" })])
        expect(out).toContain("ID")
        expect(out).toContain("Kind")
        expect(out).toContain("Content")
        expect(out).toContain("mem_abc1")
        expect(out).toContain("evidence")
        expect(out).toContain("gpt-4o supports tool calling")
        // 分隔行
        expect(out).toContain("---")
    })

    test("refs 为空显示 -；有值逗号连", () => {
        const out = formatMemoryTable([
            mem({ id: "m1", refs: ["a", "b"] }),
            mem({ id: "m2", refs: [] }),
        ])
        expect(out).toContain("a, b")
        // 空 refs 那一行有 " - "
        expect(out).toContain(" - ")
    })

    test("超长 content 被裁剪并加 ...", () => {
        const long = "x".repeat(500)
        const out = formatMemoryTable([mem({ content: long })], { contentMaxChars: 10 })
        expect(out).toContain("xxxxxxxxxx...")
        expect(out).not.toContain(long)
    })

    test("| 被转义（换行先被 clipText 折成空格）", () => {
        const out = formatMemoryTable([mem({ content: "a|b\nc" })])
        // 管道符转义；换行已被 clipText 折成空格
        expect(out).toContain("a\\|b c")
        expect(out).not.toContain("a|b")
    })
})

describe("board-format - formatIdeaTable", () => {
    test("空列表 → 提示语", () => {
        expect(formatIdeaTable([])).toBe("No ideas.")
    })

    test("有条目 → 含表头 + status + content；result 空显示 -", () => {
        const out = formatIdeaTable([idea({ status: "verified", result: "" })])
        expect(out).toContain("Status")
        expect(out).toContain("verified")
        expect(out).toContain("test SQL injection on /login")
        expect(out).toContain(" - ")
    })

    test("result 有值被裁剪", () => {
        const long = "r".repeat(300)
        const out = formatIdeaTable([idea({ result: long })], { resultMaxChars: 5 })
        expect(out).toContain("rrrrr...")
    })
})
