import { AuthStorage, ModelRegistry, SettingsManager } from "@mariozechner/pi-coding-agent"
import { mkdir, rename } from "node:fs/promises"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import * as prompts from "./prompts/index"
import type { ModelConfigEntry, ProviderPrefEntry } from "./providers/types"
import type { AddResult } from "./types"

// 用户主目录下的配置根目录：~/.tch-agent/
export const TCH_AGENT_HOME_DIR = resolve(homedir(), ".tch-agent")

// 配置目录：~/.tch-agent/config/
export const DEFAULT_CONFIG_DIR = resolve(TCH_AGENT_HOME_DIR, "config")


export class ConfigManager {
  readonly dir: string
  readonly auth: AuthStorage
  readonly models: ModelRegistry
  readonly settings: SettingsManager

  private static instanceDir: string | undefined
  private static instance: Promise<ConfigManager> | undefined

  // 构造函数私有，外部只能通过getInstance()获取
  private constructor(dir: string) {
    this.dir = dir
    this.auth = AuthStorage.create(resolve(dir, "auth.json"))
    this.models = ModelRegistry.create(this.auth, resolve(dir, "models.json"))
    this.settings = SettingsManager.create(process.cwd(), dir)
  }

  static async getInstance(configDir: string = DEFAULT_CONFIG_DIR): Promise<ConfigManager> {
    const dir = resolve(configDir)

    if (this.instance && this.instanceDir === dir)
      return this.instance

    const created = (async () => {
      const mgr = new ConfigManager(dir)
      await mgr.initialize()
      return mgr
    })()

    this.instanceDir = dir
    this.instance = created.catch((error) => {
      if (this.instance === created) {
        this.instance = undefined
        this.instanceDir = undefined
      }
      throw error
    })

    return this.instance
  }

  /** 清除单例缓存（仅测试用：让 getInstance 接受新 dir） */
  static resetInstance(): void {
    this.instance = undefined
    this.instanceDir = undefined
  }

  // 初始化:确保必要目录存在+设置SDK默认行为
  //
  private async initialize(): Promise<void> {
    const configDir = this.dir
    const dirs = [
      configDir,
      resolve(configDir, "prompts"),
      resolve(configDir, "skills"),
    ]

    for (const d of dirs) {
      await mkdir(d, { recursive: true })
    }

    // 释放内置 prompt（不覆盖已存在的文件）
    await this.releaseBuiltinPrompts()

    // SDK 默认设置：开启自动重试（LLM 调用经常遇到 rate limit）
    this.settings.setRetryEnabled(true)
    this.settings.applyOverrides({
      retry: {
        enabled: true,
        maxRetries: 20,
        baseDelayMs: 1000,
      }
    })
  }

  /**
   * 把内置 prompt 释放到用户目录（不覆盖已存在的文件）。
   */
  private async releaseBuiltinPrompts(): Promise<void> {
    const builtinPrompts: Record<string, string> = {
      SOLVER: `---
description: General-purpose solver for any task
tools:
  - read
  - bash
  - write
  - edit
  - grep
  - ls
---

You are a helpful agent that solves tasks step by step.

# Workflow

1. Read the task description carefully.
2. Explore the environment to understand what's available.
3. Make a plan before acting.
4. Use tools to make progress, one step at a time.
5. Verify each step's result before moving on.
6. Summarize the final result when done.

# Rules

- Be concise. Don't repeat what you just did.
- Use \`read\` tool to inspect files before assuming their content.
- Use \`bash\` to run commands when you need to explore or test.
- If something fails, debug it instead of giving up.
`,
    }

    for (const [name, content] of Object.entries(builtinPrompts)) {
      const path = resolve(this.dir, "prompts", `${name}.md`)
      const file = Bun.file(path)
      if (await file.exists()) continue   // 不覆盖
      await Bun.write(path, content)
    }
  }

  // ── API Keys ────────────────────────────────────────────

  /** 设置指定 provider 的 API Key */
  setApiKey(provider: string, key: string): void {
    this.auth.set(provider, { type: "api_key", key })
  }

  /** 删除指定 provider 的 API Key */
  removeApiKey(provider: string): void {
    this.auth.remove(provider)
  }
  /** 取指定 provider 的 API Key（原始值） */
  getApiKey(provider: string): { type: "api_key"; key: string } | undefined {
    return this.auth.get(provider) as { type: "api_key"; key: string } | undefined
  }
  /** 取 API Key 的字符串值（便捷封装） */
  getApiKeyValue(provider: string): string | undefined {
    return this.getApiKey(provider)?.key
  }

  /** 是否已配置指定 provider 的 API Key */
  hasApiKey(provider: string): boolean {
    return this.auth.has(provider)
  }

  /** 列出所有已配置的 provider 名 */
  listApiKeys(): string[] {
    return this.auth.list()
  }

  // ── Provider 偏好 ──────────────────────────────────────────
  /** provider-prefs.json 的路径*/
  private providerPrefsPath(): string {
    return join(this.dir, "provider-prefs.json")
  }

  /** 读所有 Provider 偏好 */
  async listProviderPrefs(): Promise<ProviderPrefEntry[]> {
    const file = Bun.file(this.providerPrefsPath())
    if (!await file.exists()) return []
    try {
      const data = await file.json()
      return Array.isArray(data) ? (data as ProviderPrefEntry[]) : []
    } catch {
      return []
    }
  }

  /**
 * 加一条 Provider 偏好。
 * @returns 新分配的 ID（如果用户没传 id，自动生成）
 */
  async addProviderPref(entry: Partial<ProviderPrefEntry> & { name: string }): Promise<AddResult> {
    const list = await this.listProviderPrefs()

    const id = entry.id?.trim() || this.generateId("prov")
    if (list.some((item) => item.id === id)) {
      return { id, rejected: `provider pref id "${id}" already exists` }
    }

    const newEntry: ProviderPrefEntry = {
      id,
      name: entry.name,
      api: entry.api?.trim() || undefined,
      baseUrl: entry.baseUrl?.trim() || undefined,
      apiKey: entry.apiKey?.trim() || undefined,
    }

    await this.writeProviderPrefs([...list, newEntry])

    return { id }
  }

  /** 写 provider-prefs.json（原子写） */
  private async writeProviderPrefs(list: ProviderPrefEntry[]): Promise<void> {
    await this.writeJsonAtomic(this.providerPrefsPath(), list)
  }

  /** 按 id 更新 Provider 偏好 */
  async updateProviderPref(id: string, patch: Partial<ProviderPrefEntry>): Promise<ProviderPrefEntry | undefined> {
    const list = await this.listProviderPrefs()
    const idx = list.findIndex((item) => item.id === id)
    if (idx < 0) {
      return undefined
    }

    const updated: ProviderPrefEntry = { ...list[idx], ...patch, id: list[idx].id }
    list[idx] = updated
    await this.writeProviderPrefs(list)

    return updated
  }

  /** 按 id 删除 Provider 偏好 */
  async removeProviderPref(id: string): Promise<boolean> {
    const list = await this.listProviderPrefs()
    const next = list.filter((item) => item.id !== id)
    if (next.length === list.length) return false
    await this.writeProviderPrefs(next)
    return true
  }

  // ── Model 偏好 ──────────────────────────────────────────
  /** model-prefs.json 的路径 */
  private modelPrefsPath(): string {
    return join(this.dir, "model-prefs.json")
  }

  /** 读所有 Model 偏好 */
  async listModelPrefs(): Promise<ModelConfigEntry[]> {
    const file = Bun.file(this.modelPrefsPath())
    if (!await file.exists()) return []
    try {
      const data = await file.json()
      return Array.isArray(data) ? (data as ModelConfigEntry[]) : []
    } catch {
      return []
    }
  }

  /**
   * 加一条 Model 偏好。
   * @returns 新分配的 ID（如果用户没传 id，自动生成）
   */
  async addModelPref(
    entry: Partial<ModelConfigEntry> & { provider: string; providerId: string; modelId: string },
  ): Promise<AddResult> {
    const list = await this.listModelPrefs()

    const id = entry.id?.trim() || this.generateId("model")
    if (list.some((item) => item.id === id)) {
      return { id, rejected: `model pref id "${id}" already exists` }
    }

    const newEntry: ModelConfigEntry = {
      ...entry,
      id,
      provider: entry.provider.trim(),
      providerId: entry.providerId.trim(),
      modelId: entry.modelId.trim(),
      thinkingLevel: entry.thinkingLevel?.trim() || undefined,
    }

    await this.writeModelPrefs([...list, newEntry])

    return { id }
  }

  /** 写 model-prefs.json（原子写） */
  private async writeModelPrefs(list: ModelConfigEntry[]): Promise<void> {
    await this.writeJsonAtomic(this.modelPrefsPath(), list)
  }

  /** 按 id 更新 Model 偏好 */
  async updateModelPref(id: string, patch: Partial<ModelConfigEntry>): Promise<ModelConfigEntry | undefined> {
    const list = await this.listModelPrefs()
    const idx = list.findIndex((item) => item.id === id)
    if (idx < 0) {
      return undefined
    }

    const updated: ModelConfigEntry = { ...list[idx], ...patch, id: list[idx].id }
    list[idx] = updated
    await this.writeModelPrefs(list)

    return updated
  }

  /** 按 id 删除 Model 偏好 */
  async removeModelPref(id: string): Promise<boolean> {
    const list = await this.listModelPrefs()
    const next = list.filter((item) => item.id !== id)
    if (next.length === list.length) return false
    await this.writeModelPrefs(next)
    return true
  }

  // ── Prompts ──────────────────────────────────────────────

  /** 加载一个 prompt（找不到返回 undefined） */
  async getPrompt(name: string): Promise<prompts.PromptFile | undefined> {
    return prompts.loadPrompt(this.dir, name)
  }

  /** 列出所有 prompt（按名字排序） */
  async listPrompts(): Promise<prompts.PromptFile[]> {
    return prompts.listPrompts(this.dir)
  }

  /** 列出普通 agent prompt（非 subagent） */
  async listAgentPrompts(): Promise<prompts.PromptFile[]> {
    return prompts.listAgentPrompts(this.dir)
  }

  /** 列出 subagent prompt */
  async listSubagentPrompts(): Promise<prompts.PromptFile[]> {
    return prompts.listSubagentPrompts(this.dir)
  }

  /** 保存一个 prompt（覆盖写） */
  async savePrompt(prompt: prompts.PromptFile): Promise<void> {
    await prompts.savePrompt(this.dir, prompt)
  }

  /** 删除一个 prompt（不存在时静默） */
  async removePrompt(name: string): Promise<void> {
    await prompts.removePrompt(this.dir, name)
  }

  // ── 工具方法 ────────────────────────────────────────────

  /**
   * 原子写 JSON：先写 tmp 文件再 rename，避免半写状态。
   */
  private async writeJsonAtomic(path: string, data: unknown): Promise<void> {
    const tmp = `${path}-${process.pid}-${Date.now()}`
    await Bun.write(tmp, JSON.stringify(data, null, 2))
    await rename(tmp, path)
  }

  /**
   * 生成不重复的短 ID。
   * 格式：<prefix>_<6 字符随机串>，如 "prov_a3f9b2"
   */
  private generateId(prefix: string): string {
    const random = crypto.randomUUID().replaceAll("-", "").slice(0, 6)
    return `${prefix}_${random}`
  }
}
