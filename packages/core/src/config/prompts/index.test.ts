import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { PromptFile } from "./index"
import {
    listAgentPrompts,
    listPrompts,
    listSubagentPrompts,
    loadPrompt,
    removePrompt,
    savePrompt,
    toPromptTemplate,
} from "./index"

let dir: string

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "tch-prompts-test-"))
})

afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
})

describe("prompts - save & load", () => {
    test("savePrompt 写文件后 loadPrompt 能读回全部字段", async () => {
        const prompt: PromptFile = {
            name: "SOLVER",
            meta: {
                description: "General solver",
                model: "work-gpt4",
                tools: ["read", "bash"],
                skills: ["web-search"],
                disabled: false,
            },
            content: "You are a solver.",
        }
        await savePrompt(dir, prompt)

        const loaded = await loadPrompt(dir, "SOLVER")
        expect(loaded).toBeDefined()
        expect(loaded!.name).toBe("SOLVER")
        expect(loaded!.meta.description).toBe("General solver")
        expect(loaded!.meta.model).toBe("work-gpt4")
        expect(loaded!.meta.tools).toEqual(["read", "bash"])
        expect(loaded!.meta.skills).toEqual(["web-search"])
        expect(loaded!.meta.disabled).toBe(false)
        expect(loaded!.content).toBe("You are a solver.")
    })

    test("loadPrompt 文件不存在返回 undefined", async () => {
        expect(await loadPrompt(dir, "nope")).toBeUndefined()
    })

    test("loadPrompt 能解析手写的 frontmatter 文件", async () => {
        // 不走 savePrompt，直接写一份裸 markdown，验证 parseFrontmatter 兼容用户手写格式
        await mkdir(join(dir, "prompts"), { recursive: true })
        await writeFile(
            join(dir, "prompts", "HANDWRITTEN.md"),
            `---
description: Hand-written prompt
model: work-gpt4
tools:
  - read
  - bash
---

You are a hand-written agent.
`,
        )

        const loaded = await loadPrompt(dir, "HANDWRITTEN")
        expect(loaded).toBeDefined()
        expect(loaded!.meta.description).toBe("Hand-written prompt")
        expect(loaded!.meta.model).toBe("work-gpt4")
        expect(loaded!.meta.tools).toEqual(["read", "bash"])
        expect(loaded!.content).toBe("You are a hand-written agent.")
    })

    test("savePrompt 把 model 空串规范成 undefined", async () => {
        await savePrompt(dir, {
            name: "P",
            meta: { description: "x", model: "   ", observerModel: "" },
            content: "body",
        })
        const loaded = await loadPrompt(dir, "P")
        expect(loaded!.meta.model).toBeUndefined()
        expect(loaded!.meta.observerModel).toBeUndefined()
    })

    test("savePrompt 有 skills 时自动补 read 工具", async () => {
        await savePrompt(dir, {
            name: "P",
            meta: { skills: ["web-search"] },
            content: "body",
        })
        const loaded = await loadPrompt(dir, "P")
        expect(loaded!.meta.tools).toContain("read")
    })

    test("savePrompt 已有 read 时不重复添加", async () => {
        await savePrompt(dir, {
            name: "P",
            meta: { tools: ["read", "bash"], skills: ["x"] },
            content: "body",
        })
        const loaded = await loadPrompt(dir, "P")
        expect(loaded!.meta.tools!.filter((t) => t === "read")).toHaveLength(1)
        // 原有的 bash 也保留
        expect(loaded!.meta.tools).toContain("bash")
    })

    test("savePrompt mcps 空数组显式写出 mcps: []，其他数组字段直接省略", async () => {
        await savePrompt(dir, {
            name: "P",
            meta: { mcps: [], tools: [], skills: [] },
            content: "body",
        })
        const raw = await Bun.file(join(dir, "prompts", "P.md")).text()
        // mcps: [] 必须显式存在（语义：禁用全部 MCP）
        expect(raw).toContain("mcps: []")
        // 其他空数组不写出
        expect(raw).not.toMatch(/^tools:/m)
        expect(raw).not.toMatch(/^skills:/m)
    })

    test("savePrompt boolean 字段用 YAML 原生 true/false", async () => {
        await savePrompt(dir, {
            name: "P",
            meta: { disabled: true, observerEnabled: false },
            content: "body",
        })
        const raw = await Bun.file(join(dir, "prompts", "P.md")).text()
        expect(raw).toMatch(/disabled: true/)
        expect(raw).toMatch(/observerEnabled: false/)
    })
})

describe("prompts - list", () => {
    test("listPrompts 按名字排序", async () => {
        await savePrompt(dir, { name: "ZEBRA", meta: {}, content: "z" })
        await savePrompt(dir, { name: "ALPHA", meta: {}, content: "a" })
        const list = await listPrompts(dir)
        expect(list.map((p) => p.name)).toEqual(["ALPHA", "ZEBRA"])
    })

    test("listPrompts 目录不存在返回空数组", async () => {
        expect(await listPrompts(join(dir, "no-such-dir"))).toEqual([])
    })

    test("listPrompts 只读 .md 文件，跳过其他", async () => {
        await mkdir(join(dir, "prompts"), { recursive: true })
        await writeFile(join(dir, "prompts", "README.txt"), "noise")
        await writeFile(join(dir, "prompts", ".DS_Store"), "noise")
        await writeFile(join(dir, "prompts", "P.md"), "---\n---\nbody")
        const list = await listPrompts(dir)
        expect(list).toHaveLength(1)
        expect(list[0].name).toBe("P")
    })
})

describe("prompts - remove", () => {
    test("removePrompt 删除已存在的文件", async () => {
        await savePrompt(dir, { name: "P", meta: {}, content: "x" })
        await removePrompt(dir, "P")
        expect(await loadPrompt(dir, "P")).toBeUndefined()
    })

    test("removePrompt 不存在时不抛错", async () => {
        // 不抛即通过
        await removePrompt(dir, "ghost")
    })
})

describe("prompts - subagent 分流", () => {
    test("listAgentPrompts / listSubagentPrompts 按 isSubagent 拆分", async () => {
        await savePrompt(dir, { name: "MAIN", meta: {}, content: "x" })
        await savePrompt(dir, { name: "SUB", meta: { isSubagent: true }, content: "x" })

        const agents = await listAgentPrompts(dir)
        const subs = await listSubagentPrompts(dir)

        expect(agents.map((p) => p.name)).toEqual(["MAIN"])
        expect(subs.map((p) => p.name)).toEqual(["SUB"])
    })
})

describe("prompts - toPromptTemplate", () => {
    test("转成 SDK PromptTemplate 格式（含 sourceInfo）", () => {
        const tpl = toPromptTemplate({
            name: "SOLVER",
            meta: { description: "Solver" },
            content: "body",
        })
        expect(tpl.name).toBe("SOLVER")
        expect(tpl.description).toBe("Solver")
        expect(tpl.content).toBe("body")
        expect(tpl.filePath).toBe("/prompts/SOLVER.md")
        expect(tpl.sourceInfo).toBeDefined()
        expect(tpl.sourceInfo.scope).toBe("user")
    })

    test("description 缺失时用 name 兜底", () => {
        const tpl = toPromptTemplate({ name: "X", meta: {}, content: "" })
        expect(tpl.description).toBe("X")
    })
})
