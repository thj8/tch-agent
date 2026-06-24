# 课时 17：Observer sidecar 工具集

> 🎯 **目标**：实现 Observer sidecar 用的工具集（memory_* / idea_* / send_reminder），让 Observer LLM 能维护策略板。
>
> ⏰ **预计耗时**：2-3 小时
>
> 📋 **难度**：⭐⭐⭐

---

## 你将学到什么

1. **Observer sidecar 的角色**（旁路 LLM 维护板）
2. **工具的 promptSnippet**（影响 LLM 何时调）
3. **表格输出**（让 LLM 易读）
4. **sidecar tools vs solver tools 的边界**

## 前置条件

✅ 已完成 [课时 1-16](./README.md)

## 最终效果

跑一个 solver，让 Observer LLM 调 `memory_add` / `idea_add` 维护板：

```
[observer] memory_add({ kind: "fact", content: "..." })
[observer] idea_add({ content: "test XSS on /search" })
[observer] idea_update({ id: "idea_xxx", status: "testing", result: "..." })
```

---

## 第零步：概念扫盲

### 0.1 Observer sidecar 是什么？

主 Solver LLM 在解题（调 bash / read 等工具）。

Observer 是**另一个独立 LLM session**，定期 review solver 行为，维护策略板（ideas/memory）：

```
主 Solver (claude-sonnet)        Observer sidecar (gpt-4o-mini)
  ↓                                ↓
  调 bash / read 工具               定期看 Solver 的活动日志
  ↓                                ↓
  推进攻击                          维护 ideas/memory 板
                                   ↓
                                   偶尔给 Solver 发"纠偏提醒"
```

为什么要分两个 LLM？

1. **专注**：Solver 不用浪费 token 想"我该记什么"。
2. **角色清晰**：Solver 解题、Observer 维护板。
3. **成本**：Observer 可以用便宜模型。

### 0.2 sidecar tools 是什么？

Observer 通过工具维护板：

| 工具 | 作用 |
|---|---|
| `memory_list` | 查所有 memory |
| `memory_add` | 加 memory |
| `memory_update` | 改 memory |
| `memory_delete` | 删 memory |
| `idea_list` | 查 ideas |
| `idea_add` | 加 idea |
| `idea_update` | 改 idea 状态 / result |
| `idea_delete` | 删 idea |
| `send_efficiency_reminder` | 给 Solver 发纠偏 |
| `query_solver_history` | 深度回溯 Solver 历史 |

这些工具只给 Observer 用（通过 prompt 约束）。

### 0.3 promptSnippet 字段

defineTool 有个 promptSnippet 字段：

```typescript
defineTool({
    name: "memory_add",
    promptSnippet: "memory_add: add durable fact/evidence",
    // ...
})
```

SDK 把所有 promptSnippet 拼成"工具使用提示"注入 systemPrompt，让 LLM 更容易选对工具。

---

## 第一步：实现 board-format（表格输出）

### 1.1 创建 packages/core/src/solver/extension/challenge-observer/board-format.ts

```bash
mkdir -p packages/core/src/solver/extension/challenge-observer
```

新建 `packages/core/src/solver/extension/challenge-observer/board-format.ts`：

```typescript
import type { IdeaRecord, MemoryEntry } from "../../../../challenge/memory"

/** 把字符串裁剪到 maxChars，超出加 `...` */
function clipText(value: string, maxChars: number): string {
    const text = value.replace(/\s+/g, " ").trim()
    if (text.length <= maxChars) return text
    return `${text.slice(0, maxChars)}...`
}

/** 转义 Markdown 表格单元格 */
function escapeTableCell(value: string): string {
    return value.replaceAll("|", "\\|").replaceAll("\n", "<br>")
}

/** 用标准 Markdown 语法拼一张表 */
function formatMarkdownTable(headers: string[], rows: string[][]): string {
    const header = `| ${headers.join(" | ")} |`
    const separator = `| ${headers.map(() => "---").join(" | ")} |`
    const body = rows.map(
        (row) => `| ${row.map((cell) => escapeTableCell(cell)).join(" | ")} |`,
    )
    return [header, separator, ...body].join("\n")
}

function formatRefs(refs: string[]): string {
    return refs.length > 0 ? refs.join(", ") : "-"
}

/**
 * 把 memory 列表格式化为 Markdown 表格。
 * 让 Observer LLM 易读。
 */
export function formatMemoryTable(
    items: MemoryEntry[],
    options: { contentMaxChars?: number } = {},
): string {
    if (items.length === 0) return "No memory entries."
    const contentMaxChars = options.contentMaxChars ?? 120
    const rows = items.map((item) => [
        item.id,
        item.kind,
        clipText(item.content, contentMaxChars),
        formatRefs(item.refs),
        item.source,
        item.updated_at,
    ])
    return formatMarkdownTable(["ID", "Kind", "Content", "Refs", "Source", "Updated"], rows)
}

/** 把 ideas 列表格式化为 Markdown 表格。 */
export function formatIdeaTable(
    items: IdeaRecord[],
    options: { contentMaxChars?: number; resultMaxChars?: number } = {},
): string {
    if (items.length === 0) return "No ideas."
    const contentMaxChars = options.contentMaxChars ?? 100
    const resultMaxChars = options.resultMaxChars ?? 120
    const rows = items.map((item) => [
        item.id,
        item.status,
        clipText(item.content, contentMaxChars),
        item.result ? clipText(item.result, resultMaxChars) : "-",
        item.updated_at,
    ])
    return formatMarkdownTable(["ID", "Status", "Idea", "Result", "Updated"], rows)
}
```

---

## 第二步：实现 board-store（solver 本地板）

每个 solver 自己也有一份 board（与 challenge 级分开），存放在 solver session 目录的 `.observer/` 子目录。

### 2.1 创建 packages/core/src/solver/board-store.ts

新建 `packages/core/src/solver/board-store.ts`：

```typescript
import { join } from "node:path"
import type {
    AddIdeaInput,
    AddIdeaResult,
    IdeaRecord,
    MemoryEntry,
    MemoryKind,
    UpdateIdeaInput,
} from "../challenge/memory"
import {
    addChallengeIdea,
    appendChallengeMemory,
    deleteChallengeMemory,
    listChallengeIdeas,
    listChallengeMemory,
    searchChallengeIdeas,
    updateChallengeIdea,
    updateChallengeMemory,
} from "../challenge/memory"

/** solver 本地 board 的命名空间（充当 challengeId 占位） */
const SOLVER_BOARD_NAMESPACE = "board"

/**
 * 取 solver session 目录：优先参数，其次环境变量 TCH_SOLVER_SESSION_DIR。
 */
function requireSessionDir(sessionDir?: string): string {
    const value = sessionDir?.trim() || process.env.TCH_SOLVER_SESSION_DIR?.trim()
    if (!value) {
        throw new Error("TCH_SOLVER_SESSION_DIR is required for solver board storage")
    }
    return value
}

/** solver board 的根目录：<sessionDir>/.observer */
export function solverBoardRootDir(sessionDir?: string): string {
    return join(requireSessionDir(sessionDir), ".observer")
}

// ── Memory CRUD（委托给 challenge/memory.ts） ─────────

export async function appendSolverBoardMemory(
    input: Omit<Parameters<typeof appendChallengeMemory>[1], "challengeId">,
    sessionDir?: string,
): Promise<MemoryEntry> {
    return appendChallengeMemory(solverBoardRootDir(sessionDir), {
        ...input,
        challengeId: SOLVER_BOARD_NAMESPACE,
    })
}

export async function listSolverBoardMemory(sessionDir?: string): Promise<MemoryEntry[]> {
    return listChallengeMemory(solverBoardRootDir(sessionDir), SOLVER_BOARD_NAMESPACE)
}

export async function updateSolverBoardMemory(
    entryIdOrPrefix: string,
    patch: { kind?: MemoryKind; content?: string; refs?: string[]; source?: string },
    sessionDir?: string,
): Promise<MemoryEntry> {
    return updateChallengeMemory(
        solverBoardRootDir(sessionDir),
        SOLVER_BOARD_NAMESPACE,
        entryIdOrPrefix,
        patch,
    )
}

export async function deleteSolverBoardMemory(
    entryIdOrPrefix: string,
    sessionDir?: string,
): Promise<MemoryEntry> {
    return deleteChallengeMemory(
        solverBoardRootDir(sessionDir),
        SOLVER_BOARD_NAMESPACE,
        entryIdOrPrefix,
    )
}

// ── Ideas CRUD ────────────────────────────────────────

export async function listSolverBoardIdeas(sessionDir?: string): Promise<IdeaRecord[]> {
    return listChallengeIdeas(solverBoardRootDir(sessionDir), SOLVER_BOARD_NAMESPACE)
}

export async function searchSolverBoardIdeas(
    query: string,
    sessionDir?: string,
): Promise<IdeaRecord[]> {
    return searchChallengeIdeas(solverBoardRootDir(sessionDir), SOLVER_BOARD_NAMESPACE, query)
}

export async function addSolverBoardIdea(
    input: AddIdeaInput,
    sessionDir?: string,
): Promise<AddIdeaResult> {
    return addChallengeIdea(solverBoardRootDir(sessionDir), SOLVER_BOARD_NAMESPACE, input)
}

export async function updateSolverBoardIdea(
    ideaIdOrPrefix: string,
    patch: UpdateIdeaInput,
    sessionDir?: string,
): Promise<IdeaRecord> {
    return updateChallengeIdea(
        solverBoardRootDir(sessionDir),
        SOLVER_BOARD_NAMESPACE,
        ideaIdOrPrefix,
        patch,
    )
}
```

> 💡 注意：`updateChallengeMemory` 和 `deleteChallengeMemory` 在课时 16 的代码里没列出来，需要自己补全（结构和 challenge 级的对应方法一样，只是路径不同）。

---

## 第三步：实现 Observer sidecar 工具

### 3.1 创建 packages/core/src/solver/extension/challenge-observer/tools.ts

新建 `packages/core/src/solver/extension/challenge-observer/tools.ts`：

```typescript
import { defineTool } from "@mariozechner/pi-coding-agent"
import { Type } from "@sinclair/typebox"
import type { IdeaStatus, MemoryKind } from "../../../../challenge/memory"
import {
    addSolverBoardIdea,
    appendSolverBoardMemory,
    deleteSolverBoardMemory,
    listSolverBoardIdeas,
    listSolverBoardMemory,
    searchSolverBoardIdeas,
    updateSolverBoardIdea,
    updateSolverBoardMemory,
} from "../../../board-store"
import { formatIdeaTable, formatMemoryTable } from "./board-format"

const EmptyParams = Type.Object({})

const memoryKindToolParam = Type.Union([
    Type.Literal("fact"),
    Type.Literal("evidence"),
    Type.Literal("failure"),
    Type.Literal("note"),
    Type.Literal("hint"),
])

const ideaStatusToolParam = Type.Union([
    Type.Literal("pending"),
    Type.Literal("testing"),
    Type.Literal("verified"),
    Type.Literal("failed"),
    Type.Literal("skipped"),
])

/**
 * Observer sidecar 工具集。
 *
 * 这些工具让 Observer LLM 能维护 solver 本地的策略板（ideas + memory）。
 */
export const observerSidecarBoardTools = [
    // ── Memory ────────────────────────────────────────

    defineTool({
        name: "memory_list",
        label: "Memory List",
        description: "List current durable memory entries. Use first, and re-check before deleting or merging entries.",
        promptSnippet: "memory_list: inspect current durable memory before curating it",
        parameters: EmptyParams,
        async execute() {
            const items = await listSolverBoardMemory()
            return {
                content: [{ type: "text", text: formatMemoryTable(items) }],
                details: { items },
            }
        },
    }),

    defineTool({
        name: "memory_add",
        label: "Memory Add",
        description: "Add one durable memory entry. Use only for facts, evidence, failure boundaries, hints, or important constraints worth keeping.",
        promptSnippet: "memory_add: add durable fact/evidence/failure/hint/constraint",
        parameters: Type.Object({
            kind: memoryKindToolParam,
            content: Type.String({ minLength: 1 }),
            refs: Type.Optional(Type.Array(Type.String())),
            source: Type.Optional(Type.String()),
        }),
        async execute(_id, params: { kind: MemoryKind; content: string; refs?: string[]; source?: string }) {
            const entry = await appendSolverBoardMemory({
                kind: params.kind,
                content: params.content,
                refs: params.refs ?? [],
                source: params.source?.trim() || "observer",
            })
            return {
                content: [{ type: "text", text: `added memory [${entry.kind}] ${entry.id}: ${params.content.slice(0, 160)}` }],
                details: { entry },
            }
        },
    }),

    defineTool({
        name: "memory_update",
        label: "Memory Update",
        description: "Update one memory entry by id or id prefix.",
        parameters: Type.Object({
            entry_id: Type.String(),
            kind: Type.Optional(memoryKindToolParam),
            content: Type.Optional(Type.String()),
            refs: Type.Optional(Type.Array(Type.String())),
            source: Type.Optional(Type.String()),
        }),
        async execute(_id, params) {
            const entry = await updateSolverBoardMemory(params.entry_id, {
                ...(params.kind ? { kind: params.kind } : {}),
                ...(params.content !== undefined ? { content: params.content } : {}),
                ...(params.refs !== undefined ? { refs: params.refs } : {}),
                ...(params.source !== undefined ? { source: params.source } : {}),
            })
            return {
                content: [{ type: "text", text: `updated memory ${entry.id}` }],
                details: { entry },
            }
        },
    }),

    defineTool({
        name: "memory_delete",
        label: "Memory Delete",
        description: "Delete one memory entry by id or id prefix.",
        parameters: Type.Object({ entry_id: Type.String() }),
        async execute(_id, params) {
            const entry = await deleteSolverBoardMemory(params.entry_id)
            return {
                content: [{ type: "text", text: `deleted memory ${entry.id}` }],
            }
        },
    }),

    // ── Ideas ─────────────────────────────────────────

    defineTool({
        name: "idea_list",
        label: "Idea List",
        description: "List current ideas (attack hypotheses).",
        parameters: EmptyParams,
        async execute() {
            const items = await listSolverBoardIdeas()
            return {
                content: [{ type: "text", text: formatIdeaTable(items) }],
                details: { items },
            }
        },
    }),

    defineTool({
        name: "idea_search",
        label: "Idea Search",
        description: "Search ideas by query (in content or result).",
        parameters: Type.Object({ query: Type.String() }),
        async execute(_id, params) {
            const items = await searchSolverBoardIdeas(params.query)
            return {
                content: [{ type: "text", text: formatIdeaTable(items) }],
            }
        },
    }),

    defineTool({
        name: "idea_add",
        label: "Idea Add",
        description: "Add a new idea (attack hypothesis).",
        parameters: Type.Object({
            content: Type.String({ minLength: 1 }),
            status: Type.Optional(ideaStatusToolParam),
            result: Type.Optional(Type.String()),
        }),
        async execute(_id, params) {
            const result = await addSolverBoardIdea({
                content: params.content,
                status: params.status,
                result: params.result,
            })
            return {
                content: [{ type: "text", text: `${result.created ? "created" : "exists"} idea ${result.item.id}: ${result.item.content.slice(0, 100)}` }],
                details: result,
            }
        },
    }),

    defineTool({
        name: "idea_update",
        label: "Idea Update",
        description: "Update an idea's status/result by id or id prefix.",
        parameters: Type.Object({
            idea_id: Type.String(),
            status: Type.Optional(ideaStatusToolParam),
            result: Type.Optional(Type.String()),
        }),
        async execute(_id, params) {
            const updated = await updateSolverBoardIdea(params.idea_id, {
                status: params.status,
                result: params.result,
            })
            return {
                content: [{ type: "text", text: `updated idea ${updated.id}: status=${updated.status}` }],
                details: { item: updated },
            }
        },
    }),
]

/**
 * send_efficiency_reminder 工具：给 Solver 发纠偏。
 * 需要外部传入回调（Observer session 才能发到 Solver）。
 */
export function createSendReminderTool(
    sendCorrectionNotice: (message: string) => Promise<boolean> | boolean,
) {
    return defineTool({
        name: "send_efficiency_reminder",
        label: "Efficiency Reminder",
        description:
            "Send a short efficiency reminder when solver is clearly stuck in low-efficiency mode. Use sparingly.",
        promptSnippet:
            "send_efficiency_reminder: use sparingly, only for clear persistent low-efficiency behavior",
        parameters: Type.Object({
            message: Type.String({ minLength: 1 }),
        }),
        async execute(_id, params) {
            const delivered = await sendCorrectionNotice(params.message)
            return {
                content: [
                    {
                        type: "text",
                        text: delivered
                            ? `sent: ${params.message.slice(0, 200)}`
                            : `suppressed: ${params.message.slice(0, 200)}`,
                    },
                ],
                details: { delivered },
            }
        },
    })
}

/** 完整工具集（含 reminder） */
export function createObserverSidecarTools(options: {
    sendCorrectionNotice?: (message: string) => Promise<boolean> | boolean
} = {}) {
    const tools = [...observerSidecarBoardTools]
    if (options.sendCorrectionNotice) {
        tools.push(createSendReminderTool(options.sendCorrectionNotice))
    }
    return tools
}
```

---

## 第四步：在 createSolverSession 注册工具

### 4.1 修改 packages/core/src/solver/session.ts

```typescript
// 顶部加 import
import { createObserverSidecarTools } from "./extension/challenge-observer/tools"

// 在 createSolverSession 里，组装 customTools：
const observerTools = createObserverSidecarTools()

const sessionOpts = await config.resolvePromptSession(init.promptName)
if (!sessionOpts) throw new Error(...)

// 把 observer 工具加到 customTools
const mergedOpts = {
    ...sessionOpts,
    customTools: [...(sessionOpts.customTools ?? []), ...observerTools],
}

const { session } = await createAgentSession({
    ...mergedOpts,
    cwd: workspaceDir,
    sessionManager: SessionManager.create(workspaceDir, sessionDir),
})
```

### 4.2 修改 resolvePromptSession 兼容

确保 `resolvePromptSession` 不会覆盖 external customTools——上面的代码已经做了（mergedOpts 是 spread）。

---

## 第五步：验证

### 5.1 跑 solver 看是否注册了工具

```bash
bun run apps/cli/src/main.ts runtime launch --prompt SOLVER "list all your tools and describe each"
```

LLM 应该会列出 read / bash / edit / memory_list / memory_add / ... 等工具。

### 5.2 让 LLM 调 memory_add

```bash
bun run apps/cli/src/main.ts runtime launch --prompt SOLVER \
  "Use the memory_add tool to record that 'gpt-4o supports tool calling' as a fact"
```

LLM 调 `memory_add({ kind: "fact", content: "...", source: "solver" })`。

### 5.3 看落盘

```bash
ls ~/.tch-agent/solvers/<id>/session/.observer/memory/entries/
# 看到一条 mem_xxx.json

cat ~/.tch-agent/solvers/<id>/session/.observer/memory/entries/*.json
```

### 5.4 类型检查

```bash
bun run typecheck
```

---

## 第六步：故障排查

### 问题 1：LLM 调 memory_add 但报错

**原因**：可能 board-store 找不到 session 目录。

**解决**：检查环境变量 `TCH_SOLVER_SESSION_DIR` 是否被注入容器。

### 问题 2：表格输出乱码

**原因**：终端字体问题。

**解决**：用等宽字体；或检查 `escapeTableCell` 是否正确转义 `|` 和换行。

### 问题 3：observer 工具被主 solver 也调了

**原因**：工具是全局注册的，主 solver 也能看到。

**解决**：通过 prompt 约束主 solver "不要主动调 memory_* / idea_*"（下节课会写 observer contract）。

---

## 本课小结

✅ **你已完成**：

- 实现 board-format（表格输出）
- 实现 board-store（solver 本地存储适配）
- 实现 Observer sidecar 工具集（10 个工具）
- 注册到 createSolverSession

📦 **新增文件**：

```
packages/core/src/solver/extension/challenge-observer/
├── board-format.ts          ← Markdown 表格
└── tools.ts                 ← Observer 工具集

packages/core/src/solver/board-store.ts    ← solver 本地存储
```

🔑 **关键概念**：

- **sidecar tools**：只给 Observer 用的工具。
- **promptSnippet**：影响 LLM 选工具的提示。
- **复用 challenge/memory**：board-store 是 adapter，底层调同样的函数。

---

## 下一课预告

[课时 18：Observer loop —— 触发 review](./18-observer-loop.md)（待生成）—— 让 Observer 自动按节奏 review solver 行为。

继续课时 18 →
