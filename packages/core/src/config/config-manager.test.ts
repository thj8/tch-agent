import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ConfigManager } from "./index"

let dir: string
let cfg: ConfigManager

beforeEach(async () => {
  ConfigManager.resetInstance()
  dir = await mkdtemp(join(tmpdir(), "tch-test-"))
  cfg = await ConfigManager.getInstance(dir)
})

afterEach(async () => {
  ConfigManager.resetInstance()
  await rm(dir, { recursive: true, force: true })
})

describe("ConfigManager - Provider 偏好", () => {
  test("add 后 list 能读回", async () => {
    const r = await cfg.addProviderPref({ name: "OpenAI", api: "openai-completions" })
    expect(r.rejected).toBeUndefined()
    expect(r.id).toMatch(/^prov_[a-z0-9]{6}$/)

    const list = await cfg.listProviderPrefs()
    expect(list).toHaveLength(1)
    expect(list[0].name).toBe("OpenAI")
    expect(list[0].api).toBe("openai-completions")
  })

  test("空字符串字段被规范成 undefined", async () => {
    await cfg.addProviderPref({ name: "X", api: "  ", baseUrl: "" })
    const list = await cfg.listProviderPrefs()
    expect(list[0].api).toBeUndefined()
    expect(list[0].baseUrl).toBeUndefined()
  })

  test("显式 id 生效，重复 id 被 rejected", async () => {
    const a = await cfg.addProviderPref({ id: "dup", name: "A" })
    expect(a.rejected).toBeUndefined()

    const b = await cfg.addProviderPref({ id: "dup", name: "B" })
    expect(b.rejected).toContain("already exists")
    expect(await cfg.listProviderPrefs()).toHaveLength(1)
  })

  test("update 按 id 合并，不改 id", async () => {
    await cfg.addProviderPref({ id: "p1", name: "Old", api: "openai-completions" })
    const updated = await cfg.updateProviderPref("p1", { name: "New", baseUrl: "https://x" })
    expect(updated?.name).toBe("New")
    expect(updated?.api).toBe("openai-completions")
    expect(updated?.baseUrl).toBe("https://x")
    expect(updated?.id).toBe("p1")
  })

  test("update 不存在 id 返回 undefined", async () => {
    expect(await cfg.updateProviderPref("ghost", { name: "X" })).toBeUndefined()
  })

  test("remove 成功返回 true，再删返回 false", async () => {
    await cfg.addProviderPref({ id: "p1", name: "A" })
    expect(await cfg.removeProviderPref("p1")).toBe(true)
    expect(await cfg.listProviderPrefs()).toHaveLength(0)
    expect(await cfg.removeProviderPref("p1")).toBe(false)
  })

  test("listProviderPrefs 文件不存在或损坏时返回空数组", async () => {
    ConfigManager.resetInstance()
    const empty = await ConfigManager.getInstance(join(dir, "no-such"))
    expect(await empty.listProviderPrefs()).toEqual([])
  })
})

describe("ConfigManager - Model 偏好", () => {
  test("add 自动生成 model_ 前缀 id", async () => {
    const r = await cfg.addModelPref({
      provider: "openai",
      providerId: "p1",
      modelId: "gpt-4o",
    })
    expect(r.rejected).toBeUndefined()
    expect(r.id).toMatch(/^model_[a-z0-9]{6}$/)

    const list = await cfg.listModelPrefs()
    expect(list[0].modelId).toBe("gpt-4o")
    expect(list[0].thinkingLevel).toBeUndefined()
  })

  test("thinkingLevel 空串规范成 undefined", async () => {
    await cfg.addModelPref({
      provider: "openai",
      providerId: "p1",
      modelId: "gpt-4o",
      thinkingLevel: "  ",
    })
    expect((await cfg.listModelPrefs())[0].thinkingLevel).toBeUndefined()
  })

  test("重复 model id 被 rejected", async () => {
    await cfg.addModelPref({ id: "m1", provider: "a", providerId: "p", modelId: "x" })
    const r = await cfg.addModelPref({ id: "m1", provider: "b", providerId: "p", modelId: "y" })
    expect(r.rejected).toContain("already exists")
  })

  test("remove 按 id 删除，不存在返回 false", async () => {
    await cfg.addModelPref({ id: "m1", provider: "a", providerId: "p", modelId: "x" })
    expect(await cfg.removeModelPref("m1")).toBe(true)
    expect(await cfg.removeModelPref("m1")).toBe(false)
  })

  test("update 按 id 合并", async () => {
    await cfg.addModelPref({ id: "m1", provider: "a", providerId: "p", modelId: "x" })
    const u = await cfg.updateModelPref("m1", { thinkingLevel: "high" })
    expect(u?.thinkingLevel).toBe("high")
    expect(u?.modelId).toBe("x")
  })
})

describe("ConfigManager - API Keys", () => {
  test("set/get/has/remove 联动", () => {
    expect(cfg.hasApiKey("openai")).toBe(false)
    cfg.setApiKey("openai", "sk-abc")
    expect(cfg.hasApiKey("openai")).toBe(true)
    expect(cfg.getApiKeyValue("openai")).toBe("sk-abc")
    expect(cfg.listApiKeys()).toContain("openai")

    cfg.removeApiKey("openai")
    expect(cfg.hasApiKey("openai")).toBe(false)
    expect(cfg.getApiKeyValue("openai")).toBeUndefined()
  })
})

describe("ConfigManager - Prompts", () => {
  test("initialize 自动释放内置 SOLVER prompt", async () => {
    const list = await cfg.listPrompts()
    expect(list.map((p) => p.name)).toContain("SOLVER")
  })

  test("savePrompt 后 getPrompt 能读回", async () => {
    await cfg.savePrompt({
      name: "REVIEWER",
      meta: { description: "x", model: "work-gpt4" },
      content: "body",
    })
    const p = await cfg.getPrompt("REVIEWER")
    expect(p?.content).toBe("body")
    expect(p?.meta.description).toBe("x")
    expect(p?.meta.model).toBe("work-gpt4")
  })

  test("getPrompt 不存在返回 undefined", async () => {
    expect(await cfg.getPrompt("ghost")).toBeUndefined()
  })

  test("listPrompts 同时包含内置和用户新建的，并按名字排序", async () => {
    await cfg.savePrompt({ name: "AAA", meta: {}, content: "" })
    const names = (await cfg.listPrompts()).map((p) => p.name)
    expect(names).toContain("SOLVER")
    expect(names).toContain("AAA")
    // AAA 字母序在 SOLVER 前
    expect(names.indexOf("AAA")).toBeLessThan(names.indexOf("SOLVER"))
  })

  test("removePrompt 后 getPrompt 返回 undefined", async () => {
    await cfg.savePrompt({ name: "TEMP", meta: {}, content: "" })
    await cfg.removePrompt("TEMP")
    expect(await cfg.getPrompt("TEMP")).toBeUndefined()
  })

  test("listAgentPrompts / listSubagentPrompts 按 isSubagent 分流", async () => {
    await cfg.savePrompt({ name: "MAIN", meta: {}, content: "" })
    await cfg.savePrompt({ name: "SUB", meta: { isSubagent: true }, content: "" })

    const agents = (await cfg.listAgentPrompts()).map((p) => p.name)
    const subs = (await cfg.listSubagentPrompts()).map((p) => p.name)

    expect(agents).toContain("MAIN")
    expect(agents).not.toContain("SUB")
    expect(subs).toEqual(["SUB"])
  })
})

describe("ConfigManager - 单例", () => {
  test("同 dir 复用实例，不同 dir 拿到新实例", async () => {
    const a1 = await ConfigManager.getInstance(dir)
    const a2 = await ConfigManager.getInstance(dir)
    expect(a1).toBe(a2)

    const dir2 = await mkdtemp(join(tmpdir(), "tch-test-"))
    try {
      const b = await ConfigManager.getInstance(dir2)
      expect(b).not.toBe(a1)
      expect(b.dir).toBe(dir2)
    } finally {
      await rm(dir2, { recursive: true, force: true })
    }
  })
})
