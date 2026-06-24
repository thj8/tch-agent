# 课时 4：Prompt 文件格式 + 加载器

> 🎯 **目标**：定义 Prompt 文件格式（YAML + MD），实现 load/save/list/remove，跑出"创建 prompt → 查看 → 删除"完整闭环。
>
> ⏰ **预计耗时**：2-3 小时
>
> 📋 **难度**：⭐⭐⭐

---

## 你将学到什么

1. **Prompt 文件的设计哲学**：为什么 YAML frontmatter + Markdown
2. **pi-coding-agent SDK 的 prompt 加载机制**
3. **YAML 解析与序列化**
4. **如何让 Prompt 引用 Model 偏好**（解耦设计）

## 前置条件

✅ 已完成 [课时 1-3](./README.md)

## 最终效果

```bash
# 列出
tch-agent config prompts list

# 写一个新 prompt（交互式）
tch-agent config prompts create SOLVER

# 查看内容
tch-agent config prompts show SOLVER

# 删除
tch-agent config prompts remove SOLVER
```

prompt 文件存放在 `~/.tch-agent/config/prompts/SOLVER.md`，格式：

```markdown
---
description: General-purpose solver
model: work-gpt4
tools:
  - read
  - bash
---

You are a helpful assistant that solves CTF challenges.
...
```

---

## 第零步：概念扫盲

### 0.1 什么是 Prompt 文件？

在 LLM agent 里，**Prompt 文件**定义了一个 agent 的"角色"：

- **system prompt**：告诉 LLM 它是谁、要做什么、不要做什么。
- **model**：用哪个 LLM（claude / gpt / glm）。
- **tools**：能用哪些工具（read / bash / edit / ...）。
- **skills**：启用哪些 skill 包。
- **subagents**：能派哪些子 agent。

这些都是**配置**，但和普通 JSON 配置不同——system prompt 是**长文本**，需要 Markdown 编辑。

### 0.2 为什么用 YAML frontmatter？

**方案 A：纯 JSON**

```json
{
  "description": "...",
  "model": "work-gpt4",
  "systemPrompt": "You are..."
}
```

缺点：长文本里的换行、引号要转义，难写。

**方案 B：纯 Markdown**

```markdown
You are...
```

缺点：没有结构化字段，无法配置 model / tools 等。

**方案 C：YAML frontmatter + Markdown（本项目用）**

```markdown
---
description: ...
model: work-gpt4
tools: [read, bash]
---

You are...
```

**好处**：
- 结构化字段用 YAML（紧凑、可读）。
- 长文本用 Markdown（无需转义、支持编辑器高亮）。
- 是 [Jekyll](https://jekyllrb.com/docs/front-matter/) / [Hugo](https://gohugo.io/content-management/front-matter/) 等静态站点的通用格式，编辑器有插件支持。

### 0.3 SDK 怎么加载 Prompt？

pi-coding-agent SDK 提供了工具：

```typescript
import { parseFrontmatter, stripFrontmatter } from "@mariozechner/pi-coding-agent"

const raw = `---
title: Hello
---
# Body`

const { frontmatter } = parseFrontmatter<Record<string, unknown>>(raw)
// frontmatter = { title: "Hello" }

const body = stripFrontmatter(raw)
// body = "# Body"
```

`parseFrontmatter` 自动识别 `---...---` 块并解析 YAML。

---

## 第一步：定义 Prompt 类型

### 1.1 创建 packages/core/src/config/prompts/index.ts

```bash
mkdir -p packages/core/src/config/prompts
```

新建文件 `packages/core/src/config/prompts/index.ts`：

```typescript
import { resolve, basename } from "node:path"
import { readdir, mkdir, unlink } from "node:fs/promises"
import { existsSync } from "node:fs"
import { createSyntheticSourceInfo, parseFrontmatter, stripFrontmatter } from "@mariozechner/pi-coding-agent"
import type { PromptTemplate } from "@mariozechner/pi-coding-agent"

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
    let results: PromptFile[] = []

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
        // SDK 的 PromptTemplate 把 sourceInfo 设成必填。
        // 这些 prompt 来自 ~/.tch-agent/config/prompts/，scope 是 user。
        sourceInfo: createSyntheticSourceInfo(`/prompts/${prompt.name}.md`, {
            source: prompt.name,
            scope: "user",
            origin: "top-level",
        }),
    }
}
```

### 1.2 关键设计点

#### `parseFrontmatter` / `stripFrontmatter`

SDK 提供的工具：

- `parseFrontmatter(raw)` → `{ frontmatter, body }`，自动识别 `---...---` 块。
- `stripFrontmatter(raw)` → 去掉 frontmatter 块的 body。

我们直接用，不用自己写 YAML 解析。

#### `normalizePromptMeta` 的小技巧

如果 prompt 启用了 skills 但没加 read 工具，自动加。为什么？

skills 是 markdown 文件，skill 启用时模型需要能 read 它。如果不加 read，skill 文件读不出来，等于白配。

#### 数组字段的 YAML 序列化

```yaml
# 数组用块格式
tools:
  - read
  - bash
  - edit
```

而不是行内 `[read, bash, edit]`，因为前者更易读、更易 diff。

---

## 第二步：在 ConfigManager 加 prompt 方法

### 2.1 改 packages/core/src/config/index.ts

在 ConfigManager 类里追加：

```typescript
// 顶部加 import
import * as prompts from "./prompts/index"

// 在 ConfigManager 类里追加：

/** 加载一个 prompt */
async getPrompt(name: string) {
    return prompts.loadPrompt(this.dir, name)
}

/** 列出所有 prompt */
async listPrompts() {
    return prompts.listPrompts(this.dir)
}

/** 列出普通 agent prompt（非 subagent） */
async listAgentPrompts() {
    return prompts.listAgentPrompts(this.dir)
}

/** 列出 subagent prompt */
async listSubagentPrompts() {
    return prompts.listSubagentPrompts(this.dir)
}

/** 保存一个 prompt */
async savePrompt(prompt: prompts.PromptFile) {
    await prompts.savePrompt(this.dir, prompt)
}

/** 删除一个 prompt */
async removePrompt(name: string) {
    await prompts.removePrompt(this.dir, name)
}
```

### 2.2 更新 packages/core/src/index.ts

```typescript
// 追加
export * from "./config/prompts/index"
```

---

## 第三步：内置 Prompt（创建默认 SOLVER）

让用户首次跑 `init` 时自动创建一个示例 prompt，方便测试。

### 3.1 内置 SOLVER 的内容（参考）

下面是 SOLVER prompt 的完整内容。本课时我们直接把它内嵌成 string 写在 `ConfigManager.releaseBuiltinPrompts` 里（见 3.2），不需要单独存一个 `.md` 文件。

> 💡 生产代码可以改用 Bun embed 文件：在 `packages/core/src/config/prompts/builtin/SOLVER.md` 存真实文件，然后 `import promptUrl from "./builtin/SOLVER.md" with { type: "file" }` + `Bun.file(promptUrl).text()` 读取。本课时为简化省略了这一步。

```markdown
---
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
- Use `read` tool to inspect files before assuming their content.
- Use `bash` to run commands when you need to explore or test.
- If something fails, debug it instead of giving up.
```

### 3.2 在 ConfigManager.initialize 里释放内置 prompt

修改 `packages/core/src/config/index.ts` 的 `initialize` 方法：

```typescript
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

    // 释放内置 prompt（如果用户没改过的话）
    await this.releaseBuiltinPrompts()

    // SDK 重试设置
    this.settings.setRetryEnabled(true)
    this.settings.applyOverrides({
        retry: { enabled: true, maxRetries: 20, baseDelayMs: 1000, maxDelayMs: 60_000 },
    })
}

/**
 * 把内置 prompt 释放到用户目录（不覆盖已存在的文件）。
 */
private async releaseBuiltinPrompts(): Promise<void> {
    const builtinPrompts: Record<string, string> = {
        // 这里用 raw string 内嵌，避免 import .md 的复杂性
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
```

> 💡 **简化设计**：本课时把 prompt 内嵌成 string。生产代码可以用 Bun embed 文件（`import promptUrl from "./builtin/SOLVER.md" with { type: "file" }`）。

---

## 第四步：CLI 子命令

在 `apps/cli/src/main.ts` 的 `configCmd` 后追加：

```typescript
// ── config / prompts ───────────────────────────────────

const promptsCmd = configCmd.command("prompts").description("Manage prompts")

promptsCmd
    .command("list")
    .description("List all prompts")
    .action(async () => {
        const config = await ConfigManager.getInstance()
        const list = await config.listPrompts()

        if (list.length === 0) {
            console.log("(no prompts)")
            return
        }

        console.log("NAME\t\tDESCRIPTION")
        console.log("----\t\t-----------")
        for (const p of list) {
            const desc = (p.meta.description ?? "").slice(0, 40)
            console.log(`${p.name}\t\t${desc}`)
        }
    })

promptsCmd
    .command("show <name>")
    .description("Show a prompt's content")
    .action(async (name: string) => {
        const config = await ConfigManager.getInstance()
        const prompt = await config.getPrompt(name)
        if (!prompt) {
            console.error(`✗ Prompt not found: ${name}`)
            process.exit(1)
        }
        console.log(`=== ${prompt.name} ===`)
        console.log(`description: ${prompt.meta.description ?? "-"}`)
        console.log(`model: ${prompt.meta.model ?? "-"}`)
        console.log(`tools: ${(prompt.meta.tools ?? []).join(", ") || "-"}`)
        console.log()
        console.log(prompt.content)
    })

promptsCmd
    .command("remove <name>")
    .description("Remove a prompt")
    .action(async (name: string) => {
        const config = await ConfigManager.getInstance()
        await config.removePrompt(name)
        console.log(`✓ Removed prompt: ${name}`)
    })

promptsCmd
    .command("create <name>")
    .description("Create a new prompt interactively")
    .option("-d, --description <desc>", "Description", "")
    .option("-m, --model <modelId>", "Model preference ID")
    .action(async (name: string, opts) => {
        const config = await ConfigManager.getInstance()
        const existing = await config.getPrompt(name)
        if (existing) {
            console.error(`✗ Prompt already exists: ${name}`)
            process.exit(1)
        }

        await config.savePrompt({
            name,
            meta: {
                description: opts.description || `${name} prompt`,
                ...(opts.model ? { model: opts.model } : {}),
                tools: ["read", "bash"],
            },
            content: `You are a ${name} agent.\n\nDo your job well.`,
        })
        console.log(`✓ Created prompt: ${name}`)
        console.log(`  Edit at: ~/.tch-agent/config/prompts/${name}.md`)
    })
```

---

## 第五步：验证

### 5.1 重新跑 init 释放内置 prompt

```bash
# 如果之前没建过，先清空（可选）
rm -rf ~/.tch-agent

# 重新 init
bun run apps/cli/src/main.ts init
```

### 5.2 列出 prompt

```bash
bun run apps/cli/src/main.ts config prompts list
```

**预期**：

```
NAME            DESCRIPTION
----            -----------
SOLVER          General-purpose solver for any task
```

### 5.3 查看 SOLVER prompt

```bash
bun run apps/cli/src/main.ts config prompts show SOLVER
```

**预期**：

```
=== SOLVER ===
description: General-purpose solver for any task
model: -
tools: read, bash, write, edit, grep, ls

You are a helpful agent that solves tasks step by step.
...
```

### 5.4 创建一个新 prompt

```bash
bun run apps/cli/src/main.ts config prompts create reviewer \
  --description "Code reviewer agent" \
  --model work-gpt4
```

**预期**：

```
✓ Created prompt: reviewer
  Edit at: ~/.tch-agent/config/prompts/reviewer.md
```

### 5.5 编辑 prompt 文件

```bash
cat ~/.tch-agent/config/prompts/reviewer.md
```

**预期**：

```markdown
---
description: "Code reviewer agent"
model: "work-gpt4"
tools:
  - "read"
  - "bash"
---

You are a reviewer agent.

Do your job well.
```

> 💡 字符串字段都带双引号是因为 `formatYamlScalar` 用 `JSON.stringify` 序列化（保险，免得特殊字符破坏 YAML）。带不带引号对 YAML 解析完全等价。

用编辑器打开改一改，再 `show` 看看是否能读到新内容。

### 5.6 删除 prompt

```bash
bun run apps/cli/src/main.ts config prompts remove reviewer
bun run apps/cli/src/main.ts config prompts list
```

**预期**：reviewer 不见了，只剩 SOLVER。

### 5.7 类型检查

```bash
bun run typecheck
```

无输出。

---

## 第六步：故障排查

### 问题 1：parseFrontmatter 报错

**原因**：YAML 块格式错误。

**解决**：检查 frontmatter 缩进。YAML 数组项要严格对齐：

```yaml
# ✅ 正确
tools:
  - read
  - bash

# ❌ 错误（缩进不一致）
tools:
- read
   - bash
```

### 问题 2：修改了 .md 文件但 show 看到的还是旧的

**原因**：可能是 YAML 解析失败，回退到默认。

**解决**：在 `loadPrompt` 加 try-catch 看错误：

```typescript
try {
    const { frontmatter } = parseFrontmatter(raw)
    // ...
} catch (error) {
    console.error("YAML parse failed:", error)
}
```

### 问题 3：tools 字段被覆盖

**原因**：`normalizePromptMeta` 自动加了 read，可能覆盖用户配置。

**解决**：检查 normalizePromptMeta 逻辑，确保是 prepend 而不是 replace。

---

## 本课小结

✅ **你已完成**：

- 定义 Prompt 文件格式（YAML frontmatter + Markdown）
- 实现 load / save / list / remove CRUD
- 在 ConfigManager 加便捷方法
- 加 prompts CLI 子命令
- 内置 SOLVER prompt 自动释放

📦 **新增文件**：

```
packages/core/src/config/prompts/index.ts
packages/core/src/config/prompts/builtin/SOLVER.md
```

🔑 **关键概念**：

- **YAML frontmatter**：让 Markdown 文件带结构化元数据。
- **SDK 工具函数**：parseFrontmatter / stripFrontmatter 处理 frontmatter。
- **内置 prompt 释放**：首次启动时把默认 prompt 复制到用户目录，方便开箱即用。

---

## 下一课预告

[课时 5：第一个 AgentSession + CLI 跑通](./05-first-agent-session.md)（待生成）—— 我们会：

- 实现 resolvePromptSession（Prompt → AgentSessionOptions）
- 实现 createSolverSession（装配 + 启动）
- 加 `tch-agent solver --prompt SOLVER <task>` CLI
- 在本地跑通"LLM 调 bash 工具"

继续课时 5 →
