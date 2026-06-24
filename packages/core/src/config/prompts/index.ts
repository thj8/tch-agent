import { createSyntheticSourceInfo, parseFrontmatter, stripFrontmatter } from "@mariozechner/pi-coding-agent"
import type { PromptTemplate } from "@mariozechner/pi-coding-agent"
import { existsSync } from "node:fs"
import { mkdir, readdir, unlink } from "node:fs/promises"
import { basename, resolve } from "node:path"

/**
 * Prompt 文件的 frontmatter 字段。
 *
 * 这是用户在 prompt 文件顶部 YAML 块里可以配置的所有字段。
 */
export interface PromptMeta {
    /** 人类可读的描述 */
    description?: string
    /** 引用的 Model 偏好 ID（如 "work-gpt4"） */
    model?: string
    /** Observer 专用 Model 偏好（不填则用 model 字段） */
    observerModel?: string
    /** 是否启用 Observer sidecar（阶段 4 用） */
    observerEnabled?: boolean
    /** 是否禁用（禁用的 prompt 不能被启动） */
    disabled?: boolean
    /** 启用的 MCP server 名列表（白名单，空表示全部禁用） */
    mcps?: string[]
    /** 启用的工具名列表（白名单） */
    tools?: string[]
    /** 启用的 skill 名列表 */
    skills?: string[]
    /** 允许调用的 subagent prompt 名 */
    subagents?: string[]
    /** 是否为 subagent 专用 prompt */
    isSubagent?: boolean
    /** 允许其他自定义字段 */
    [key: string]: unknown
}

/**
 * 加载后的 Prompt 完整对象。
 */
export interface PromptFile {
    /** Prompt 名（= 文件名，不含 .md） */
    name: string
    /** YAML frontmatter */
    meta: PromptMeta
    /** Markdown body（= system prompt 内容） */
    content: string
    /** 是否为内置 prompt */
    builtin?: boolean
    /** 是否已被用户删除（仅用于"已删内置 prompt"的恢复 UX） */
    deleted?: boolean
}

// ── 路径计算 ──────────────────────────────────────────

/** prompts 目录：<configDir>/prompts */
function promptsDir(configDir: string): string {
    return resolve(configDir, "prompts")
}

/** 单个 prompt 文件路径：<prompts>/<name>.md */
function promptPath(configDir: string, name: string): string {
    return resolve(promptsDir(configDir), `${name}.md`)
}

// ── 工具函数 ──────────────────────────────────────────

/** 把 model 字段规范化（trim + 空串转 undefined） */
function normalizePromptMetaModelId(value: unknown): string | undefined {
    if (typeof value === "string") {
        const text = value.trim()
        return text || undefined
    }
    if (typeof value === "number" || typeof value === "bigint") {
        return String(value)
    }
    return undefined
}

/** 把任意值格式化为 YAML 标量（字符串用 JSON 风格的双引号） */
function formatYamlScalar(value: unknown): string {
    if (typeof value === "string") return JSON.stringify(value)
    if (typeof value === "number" || typeof value === "bigint") return String(value)
    return JSON.stringify(String(value))
}

/**
 * 规范化 PromptMeta：
 *   - model / observerModel 空串转 undefined
 *   - 如果有 skills 但没 read 工具，自动加 read（让 skill 能读文件）
 */
function normalizePromptMeta(meta: PromptMeta): PromptMeta {
    const tools = meta.tools ?? []
    const skills = meta.skills ?? []
    const nextTools = skills.length > 0 && !tools.includes("read") ? ["read", ...tools] : tools
    const model = normalizePromptMetaModelId(meta.model)
    const observerModel = normalizePromptMetaModelId(meta.observerModel)

    return {
        ...meta,
        ...(model ? { model } : { model: undefined }),
        ...(observerModel ? { observerModel } : { observerModel: undefined }),
        ...(nextTools.length > 0 ? { tools: nextTools } : { tools: undefined }),
    }
}

// ── 主要 CRUD ─────────────────────────────────────────

/**
 * 加载一个 prompt。
 * @returns 找不到返回 undefined
 */
export async function loadPrompt(configDir: string, name: string): Promise<PromptFile | undefined> {
    const file = Bun.file(promptPath(configDir, name))
    if (!(await file.exists())) return undefined

    const raw = await file.text()
    const { frontmatter } = parseFrontmatter<Record<string, unknown>>(raw)
    const meta = normalizePromptMeta((frontmatter ?? {}) as PromptMeta)
    const content = stripFrontmatter(raw).trim()
    return { name, meta, content }
}

/**
 * 保存一个 prompt（覆盖写）。
 * 自动把 meta 序列化为 YAML frontmatter。
 */
export async function savePrompt(configDir: string, prompt: PromptFile): Promise<void> {
    const dir = promptsDir(configDir)
    await mkdir(dir, { recursive: true })

    const meta = normalizePromptMeta(prompt.meta)

    // 序列化 YAML frontmatter
    const yamlLines: string[] = []
    for (const [k, v] of Object.entries(meta)) {
        if (v === undefined) continue

        // 数组字段用 YAML 块格式
        if (k === "mcps" || k === "tools" || k === "skills" || k === "subagents") {
            const arr = v as string[]
            if (arr.length > 0) {
                yamlLines.push(`${k}:`)
                for (const item of arr) {
                    yamlLines.push(`  - ${formatYamlScalar(item)}`)
                }
            } else if (k === "mcps") {
                yamlLines.push("mcps: []")
            }
        } else if (typeof v === "boolean") {
            yamlLines.push(`${k}: ${v ? "true" : "false"}`)
        } else {
            yamlLines.push(`${k}: ${formatYamlScalar(v)}`)
        }
    }

    // 拼成最终文件内容
    const output = `---\n${yamlLines.join("\n")}\n---\n\n${prompt.content}\n`
    await Bun.write(promptPath(configDir, prompt.name), output)
}

/**
 * 删除一个 prompt。
 */
export async function removePrompt(configDir: string, name: string): Promise<void> {
    const path = promptPath(configDir, name)
    if (existsSync(path)) {
        await unlink(path)
    }
}

/**
 * 列出所有 prompt（按名字排序）。
 */
export async function listPrompts(configDir: string): Promise<PromptFile[]> {
    const dir = promptsDir(configDir)
    const results: PromptFile[] = []

    try {
        const entries = await readdir(dir)
        const mdFiles = entries.filter((f) => f.endsWith(".md"))

        for (const file of mdFiles) {
            const name = basename(file, ".md")
            const prompt = await loadPrompt(configDir, name)
            if (prompt) results.push(prompt)
        }
    } catch {
        // 目录不存在返回空
    }

    return results.sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * 列出非 subagent 类型的 prompt（普通 agent prompt）。
 */
export async function listAgentPrompts(configDir: string): Promise<PromptFile[]> {
    const prompts = await listPrompts(configDir)
    return prompts.filter((prompt) => prompt.meta.isSubagent !== true)
}

/**
 * 列出 subagent 类型的 prompt。
 */
export async function listSubagentPrompts(configDir: string): Promise<PromptFile[]> {
    const prompts = await listPrompts(configDir)
    return prompts.filter((prompt) => prompt.meta.isSubagent === true)
}

/**
 * 转换为 SDK 的 PromptTemplate 格式（给 createAgentSession 用）。
 */
export function toPromptTemplate(prompt: PromptFile): PromptTemplate {
    return {
        name: prompt.name,
        description: prompt.meta.description ?? prompt.name,
        content: prompt.content,
        filePath: `/prompts/${prompt.name}.md`,
        sourceInfo: createSyntheticSourceInfo(`/prompts/${prompt.name}.md`, {
            source: prompt.name,
            scope: "user",
            origin: "top-level",
        }),
    }
}
