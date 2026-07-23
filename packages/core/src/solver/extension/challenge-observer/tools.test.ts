import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
    createObserverSidecarTools,
    createSendReminderTool,
    observerSidecarBoardTools,
} from "./tools"

type ToolResult = { content: Array<{ type: string; text: string }>; details: unknown }
type RunTool = {
    execute: (
        id: string,
        params: unknown,
        signal: unknown,
        onUpdate: unknown,
        ctx: unknown,
    ) => Promise<ToolResult>
}

/** 取 board 工具 by name。 */
function board(name: string): RunTool {
    const t = observerSidecarBoardTools.find((x) => x.name === name)
    if (!t) throw new Error(`tool not found: ${name}`)
    return t as unknown as RunTool
}

/** 执行工具（补齐 SDK execute 的 5 个参数；测试只关心 content/details）。 */
async function run(tool: RunTool, params: unknown): Promise<ToolResult> {
    return tool.execute("tc", params, undefined, undefined, undefined)
}

let sessionDir: string
let prevEnv: string | undefined

beforeEach(async () => {
    sessionDir = await mkdtemp(join(tmpdir(), "tinyfat-observer-tools-"))
    prevEnv = process.env.TCH_SOLVER_SESSION_DIR
    process.env.TCH_SOLVER_SESSION_DIR = sessionDir
})

afterEach(async () => {
    if (prevEnv === undefined) delete process.env.TCH_SOLVER_SESSION_DIR
    else process.env.TCH_SOLVER_SESSION_DIR = prevEnv
    await rm(sessionDir, { recursive: true, force: true })
})

describe("observer sidecar tools - memory", () => {
    test("memory_list 空 → 提示语", async () => {
        const res = await run(board("memory_list"), {})
        expect(res.content[0]?.text).toBe("No memory entries.")
    })

    test("memory_add → details.entry 落盘；list 可见", async () => {
        const add = await run(board("memory_add"), {
            kind: "fact",
            content: "gpt-4o supports tools",
        })
        expect(add.content[0]?.text).toContain("added memory")
        const entry = (add.details as { entry: { id: string } }).entry
        expect(entry.id).toMatch(/^mem_/)

        const list = await run(board("memory_list"), {})
        expect(list.content[0]?.text).toContain("gpt-4o supports tools")
    })

    test("memory_update（entry_id）改 content", async () => {
        const add = await run(board("memory_add"), { kind: "note", content: "old", source: "o" })
        const id = (add.details as { entry: { id: string } }).entry.id
        const upd = await run(board("memory_update"), { entry_id: id, content: "new" })
        expect(upd.content[0]?.text).toContain("updated memory")
        const list = await run(board("memory_list"), {})
        expect(list.content[0]?.text).toContain("new")
    })

    test("memory_delete", async () => {
        const add = await run(board("memory_add"), { kind: "note", content: "tmp", source: "o" })
        const id = (add.details as { entry: { id: string } }).entry.id
        const del = await run(board("memory_delete"), { entry_id: id })
        expect(del.content[0]?.text).toContain("deleted memory")
        const list = await run(board("memory_list"), {})
        expect(list.content[0]?.text).toBe("No memory entries.")
    })
})

describe("observer sidecar tools - ideas", () => {
    test("idea_add（created）+ idea_list", async () => {
        const add = await run(board("idea_add"), { content: "test SQL injection" })
        expect(add.content[0]?.text).toContain("created idea")
        const list = await run(board("idea_list"), {})
        expect(list.content[0]?.text).toContain("test SQL injection")
    })

    test("idea_add 去重 → exists", async () => {
        await run(board("idea_add"), { content: "check /admin" })
        const dup = await run(board("idea_add"), { content: "CHECK /ADMIN" })
        expect(dup.content[0]?.text).toContain("exists idea")
    })

    test("idea_search 命中 content", async () => {
        await run(board("idea_add"), { content: "xss on /search" })
        const res = await run(board("idea_search"), { query: "xss" })
        expect(res.content[0]?.text).toContain("xss on /search")
    })

    test("idea_search 无命中 → No ideas.", async () => {
        const res = await run(board("idea_search"), { query: "nothing" })
        expect(res.content[0]?.text).toBe("No ideas.")
    })

    test("idea_update status", async () => {
        const add = await run(board("idea_add"), { content: "try ssti" })
        const id = (add.details as { item: { id: string } }).item.id
        const upd = await run(board("idea_update"), { idea_id: id, status: "testing" })
        expect(upd.content[0]?.text).toContain("status=testing")
    })
})

describe("observer sidecar tools - send_efficiency_reminder", () => {
    test("createSendReminderTool delivered=true → sent:", async () => {
        const tool = createSendReminderTool(() => true) as unknown as RunTool
        const res = await run(tool, { message: "stop repeating" })
        expect(res.content[0]?.text).toContain("sent:")
        expect((res.details as { delivered: boolean }).delivered).toBe(true)
    })

    test("createSendReminderTool delivered=false → suppressed:", async () => {
        const tool = createSendReminderTool(() => false) as unknown as RunTool
        const res = await run(tool, { message: "nudge" })
        expect(res.content[0]?.text).toContain("suppressed:")
    })

    test("createObserverSidecarTools：传回调才含 reminder", () => {
        const without = createObserverSidecarTools()
        const withCb = createObserverSidecarTools({ sendCorrectionNotice: () => true })
        expect(without.find((t) => t.name === "send_efficiency_reminder")).toBeUndefined()
        expect(withCb.find((t) => t.name === "send_efficiency_reminder")).toBeDefined()
        // board 工具数量一致
        expect(without.filter((t) => t.name.startsWith("memory_") || t.name.startsWith("idea_"))).toHaveLength(8)
    })
})
