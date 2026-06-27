# 课时 16：ideas + memory 存储

> 🎯 **目标**：实现"策略板"——challenge 级和 solver 级的 ideas + memory 文件存储。
>
> ⏰ **预计耗时**：2-3 小时
>
> 📋 **难度**：⭐⭐⭐

---

## 你将学到什么

1. **ideas vs memory 的区别**（不同语义）
2. **双写设计**（索引 + by-id 文件）
3. **前缀匹配 ID 查询**（用户体验）
4. **normalized 去重**（避免近似重复）

## 前置条件

✅ 已完成 [课时 1-15](./README.md)

## 最终效果

```
~/.tinyfat/challenge/<id>/
├── ideas/
│   ├── index.json             ← 全部 ideas 扁平数组
│   └── by-id/
│       └── idea_xxxx.json     ← 单条 idea
├── memory/
│   └── entries/
│       └── <ts>-mem_xxxx.json ← 每条 memory 一个文件
└── locks/...
```

```bash
tinyfat memory add test-1 --kind fact --content "..." --source solver-abc
tinyfat memory list test-1
tinyfat idea add test-1 --content "test SQL injection"
tinyfat idea update test-1 idea_a3f9 --status testing --result "found vulnerability"
```

---

## 第零步：概念扫盲

### 0.1 ideas vs memory

| 字段 | ideas | memory |
|---|---|---|
| **是什么** | 待验证的攻击方向 | durable facts / 证据 / 失败边界 |
| **生命周期** | pending → testing → verified/failed | 永久（除非被 update/delete） |
| **示例** | "试试 SQL 注入" / "检查 /admin" | "OpenAI gpt-4o 拒绝生成 payload" |
| **目的** | 引导下一步行动 | 记住已验证的事实 |

两者都存"策略信息"，但语义不同。Observer 维护这两块板，让 solver 不重复试错。

### 0.2 challenge 级 vs solver 级

| 层级 | 位置 | 共享范围 |
|---|---|---|
| **challenge 级** | `~/.tinyfat/challenge/<id>/` | 该题目下所有 solver 共享 |
| **solver 级** | `~/.tinyfat/solvers/<id>/session/.observer/` | 单个 solver 私有 |

为什么分两层？

- challenge 级：solver A 拿到 flag，广播到 challenge 级 memory，solver B/C 立刻看到。
- solver 级：每个 solver 自己的"工作笔记"，不污染全局。

### 0.3 索引 + by-id 双写

ideas 需要：
- list：返回所有 ideas（频繁）
- update/delete by id：精确改一条（频繁）

如果只用一个 JSON 数组：

```typescript
// list O(1) 读
[{ id: "idea_1", ... }, { id: "idea_2", ... }]
// update O(N) 要遍历找
```

如果只用 by-id 文件：

```typescript
// list O(N) 要 readdir
ideas/by-id/idea_1.json
ideas/by-id/idea_2.json
```

**双写方案**（本项目用）：

```
ideas/
├── index.json     ← O(1) 读 list
└── by-id/<id>.json ← O(1) 改单条
```

每次写：同时更新 index.json 和 by-id/<id>.json。

---

## 第一步：实现 challenge 级存储

### 1.1 创建 packages/core/src/challenge/memory.ts

```bash
# 已经存在 challenge 目录
```

新建 `packages/core/src/challenge/memory.ts`：

```typescript
import { mkdir, readdir, rename, rm } from "node:fs/promises"
import { dirname, join } from "node:path"

/** idea 状态 */
export type IdeaStatus = "pending" | "testing" | "verified" | "failed" | "skipped"

/** memory 类型 */
export type MemoryKind = "fact" | "evidence" | "failure" | "note" | "hint"

/** 一条 memory */
export interface MemoryEntry {
    id: string
    challengeId: string
    kind: MemoryKind
    content: string
    refs: string[]
    source: string
    created_at: string
    updated_at: string
}

export interface AddMemoryInput {
    challengeId: string
    kind: MemoryKind
    content: string
    refs?: string[]
    source: string
}

/** 一条 idea */
export interface IdeaRecord {
    id: string
    content: string
    /** trim + lowercase 后的内容，用于去重 */
    normalized: string
    status: IdeaStatus
    result: string
    created_at: string
    updated_at: string
}

interface IdeasIndexRecord {
    challengeId: string
    updated_at: string
    items: IdeaRecord[]
}

export interface AddIdeaResult {
    created: boolean
    item: IdeaRecord
}

export interface AddIdeaInput {
    content: string
    status?: IdeaStatus
    result?: string
}

export interface UpdateIdeaInput {
    content?: string
    status?: IdeaStatus
    result?: string
}

// ── 工具函数 ──────────────────────────────────────────────

function nowIso(): string {
    return new Date().toISOString()
}

function requireText(value: string, fieldName: string): string {
    const text = value.trim()
    if (!text) throw new Error(`${fieldName} is required`)
    return text
}

function normalizeIdeaText(content: string): string {
    return content.trim().toLowerCase()
}

function isDirectoryExistsError(error: unknown): boolean {
    return (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error as { code?: string }).code === "EEXIST"
    )
}

function createEntityId(prefix: string): string {
    return `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}`
}

// ── 路径计算 ──────────────────────────────────────────────

function challengeDir(rootDir: string, challengeId: string): string {
    return join(rootDir, encodeURIComponent(challengeId))
}

function ideasLockDir(rootDir: string, challengeId: string): string {
    return join(challengeDir(rootDir, challengeId), "locks", "ideas.lock")
}

function ideasIndexPath(rootDir: string, challengeId: string): string {
    return join(challengeDir(rootDir, challengeId), "ideas", "index.json")
}

function ideaByIdPath(rootDir: string, challengeId: string, ideaId: string): string {
    return join(challengeDir(rootDir, challengeId), "ideas", "by-id", `${ideaId}.json`)
}

function memoryEntriesDir(rootDir: string, challengeId: string): string {
    return join(challengeDir(rootDir, challengeId), "memory", "entries")
}

function memoryLockDir(rootDir: string, challengeId: string): string {
    return join(challengeDir(rootDir, challengeId), "locks", "memory.lock")
}

// ── 通用工具 ──────────────────────────────────────────────

async function readJsonFile<T>(path: string): Promise<T | undefined> {
    const file = Bun.file(path)
    if (!(await file.exists())) return undefined
    try {
        return (await file.json()) as T
    } catch {
        return undefined
    }
}

async function atomicWriteJson(path: string, data: unknown): Promise<void> {
    const tmpPath = `${path}.tmp-${process.pid}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`
    await mkdir(dirname(path), { recursive: true })
    await Bun.write(tmpPath, JSON.stringify(data, null, 2))
    await rename(tmpPath, path)
}

async function withDirectoryLock<T>(
    lockDir: string,
    action: () => Promise<T>,
): Promise<T> {
    const startedAt = Date.now()
    while (true) {
        try {
            await mkdir(lockDir)
            break
        } catch (error) {
            if (!isDirectoryExistsError(error)) throw error
            if (Date.now() - startedAt > 5000) {
                throw new Error(`lock timeout: ${lockDir}`)
            }
            await Bun.sleep(25)
        }
    }
    try {
        return await action()
    } finally {
        await rm(lockDir, { recursive: true, force: true })
    }
}

async function ensureChallengeDirs(rootDir: string, challengeId: string): Promise<void> {
    const id = requireText(challengeId, "challengeId")
    const baseDir = challengeDir(rootDir, id)
    await mkdir(baseDir, { recursive: true })
    await mkdir(join(baseDir, "memory", "entries"), { recursive: true })
    await mkdir(join(baseDir, "ideas", "by-id"), { recursive: true })
    await mkdir(join(baseDir, "locks"), { recursive: true })
}

// ── Memory CRUD ──────────────────────────────────────────

export async function appendChallengeMemory(
    rootDir: string,
    input: AddMemoryInput,
): Promise<MemoryEntry> {
    const challengeId = requireText(input.challengeId, "challengeId")
    await ensureChallengeDirs(rootDir, challengeId)

    const entry: MemoryEntry = {
        id: createEntityId("mem"),
        challengeId,
        kind: input.kind,
        content: requireText(input.content, "content"),
        refs: [...new Set((input.refs ?? []).map((r) => r.trim()).filter(Boolean))],
        source: requireText(input.source, "source"),
        created_at: nowIso(),
        updated_at: nowIso(),
    }
    const filename = `${Date.now()}-${entry.id}.json`
    await atomicWriteJson(join(memoryEntriesDir(rootDir, challengeId), filename), entry)
    return entry
}

export async function listChallengeMemory(
    rootDir: string,
    challengeId: string,
): Promise<MemoryEntry[]> {
    const dir = memoryEntriesDir(rootDir, requireText(challengeId, "challengeId"))
    let files: string[] = []
    try {
        files = (await readdir(dir)).filter((f) => f.endsWith(".json")).sort()
    } catch {
        return []
    }
    const items = await Promise.all(
        files.map((f) => readJsonFile<MemoryEntry>(join(dir, f))),
    )
    return items.filter((i): i is MemoryEntry => Boolean(i))
}

export async function updateChallengeMemory(
    rootDir: string,
    challengeId: string,
    entryIdOrPrefix: string,
    patch: { kind?: MemoryKind; content?: string; refs?: string[]; source?: string },
): Promise<MemoryEntry> {
    await ensureChallengeDirs(rootDir, challengeId)

    return withDirectoryLock(memoryLockDir(rootDir, challengeId), async () => {
        const dir = memoryEntriesDir(rootDir, requireText(challengeId, "challengeId"))
        let files: string[] = []
        try {
            files = (await readdir(dir)).filter((f) => f.endsWith(".json")).sort()
        } catch {
            throw new Error(`memory entry "${entryIdOrPrefix}" not found`)
        }

        const all = await Promise.all(
            files.map((f) => readJsonFile<MemoryEntry>(join(dir, f)).then((e) => ({ file: f, entry: e }))),
        )
        const matched = all.find(({ entry }) => entry?.id === entryIdOrPrefix || entry?.id.startsWith(entryIdOrPrefix))
        if (!matched?.entry) throw new Error(`memory entry "${entryIdOrPrefix}" not found`)

        const updated: MemoryEntry = {
            ...matched.entry,
            kind: patch.kind ?? matched.entry.kind,
            content: patch.content ?? matched.entry.content,
            refs: patch.refs ?? matched.entry.refs,
            source: patch.source ?? matched.entry.source,
            updated_at: nowIso(),
        }
        await atomicWriteJson(join(dir, matched.file), updated)
        return updated
    })
}

export async function deleteChallengeMemory(
    rootDir: string,
    challengeId: string,
    entryIdOrPrefix: string,
): Promise<MemoryEntry> {
    await ensureChallengeDirs(rootDir, challengeId)

    return withDirectoryLock(memoryLockDir(rootDir, challengeId), async () => {
        const dir = memoryEntriesDir(rootDir, requireText(challengeId, "challengeId"))
        let files: string[] = []
        try {
            files = (await readdir(dir)).filter((f) => f.endsWith(".json")).sort()
        } catch {
            throw new Error(`memory entry "${entryIdOrPrefix}" not found`)
        }

        const all = await Promise.all(
            files.map((f) => readJsonFile<MemoryEntry>(join(dir, f)).then((e) => ({ file: f, entry: e }))),
        )
        const matched = all.find(({ entry }) => entry?.id === entryIdOrPrefix || entry?.id.startsWith(entryIdOrPrefix))
        if (!matched?.entry) throw new Error(`memory entry "${entryIdOrPrefix}" not found`)

        await rm(join(dir, matched.file), { force: true })
        return matched.entry
    })
}

// ── Ideas CRUD ───────────────────────────────────────────

async function readIdeasIndex(rootDir: string, challengeId: string): Promise<IdeasIndexRecord> {
    const existing = await readJsonFile<IdeasIndexRecord>(ideasIndexPath(rootDir, challengeId))
    if (existing) return existing
    return { challengeId, updated_at: nowIso(), items: [] }
}

async function writeIdeasIndex(
    rootDir: string,
    challengeId: string,
    record: IdeasIndexRecord,
): Promise<void> {
    await atomicWriteJson(ideasIndexPath(rootDir, challengeId), record)
}

export async function listChallengeIdeas(
    rootDir: string,
    challengeId: string,
): Promise<IdeaRecord[]> {
    const index = await readIdeasIndex(rootDir, challengeId)
    return [...index.items]
}

export async function searchChallengeIdeas(
    rootDir: string,
    challengeId: string,
    query: string,
): Promise<IdeaRecord[]> {
    const q = requireText(query, "query").toLowerCase()
    const index = await readIdeasIndex(rootDir, challengeId)
    return index.items.filter(
        (item) =>
            item.content.toLowerCase().includes(q) || item.result.toLowerCase().includes(q),
    )
}

export async function addChallengeIdea(
    rootDir: string,
    challengeId: string,
    input: AddIdeaInput,
): Promise<AddIdeaResult> {
    await ensureChallengeDirs(rootDir, challengeId)

    return withDirectoryLock(ideasLockDir(rootDir, challengeId), async () => {
        const index = await readIdeasIndex(rootDir, challengeId)
        const normalized = normalizeIdeaText(requireText(input.content, "content"))

        // 去重
        const existing = index.items.find((item) => item.normalized === normalized)
        if (existing) return { created: false, item: existing }

        const now = nowIso()
        const idea: IdeaRecord = {
            id: createEntityId("idea"),
            content: input.content.trim(),
            normalized,
            status: input.status ?? "pending",
            result: input.result?.trim() ?? "",
            created_at: now,
            updated_at: now,
        }
        const next: IdeasIndexRecord = {
            ...index,
            updated_at: now,
            items: [...index.items, idea],
        }
        await writeIdeasIndex(rootDir, challengeId, next)
        await atomicWriteJson(ideaByIdPath(rootDir, challengeId, idea.id), idea)
        return { created: true, item: idea }
    })
}

function findIdeaByIdOrPrefix(items: IdeaRecord[], idOrPrefix: string): IdeaRecord {
    const lookup = requireText(idOrPrefix, "ideaIdOrPrefix")
    const exact = items.find((item) => item.id === lookup)
    if (exact) return exact
    const matched = items.filter((item) => item.id.startsWith(lookup))
    if (matched.length === 0) throw new Error(`idea "${lookup}" not found`)
    if (matched.length > 1) throw new Error(`idea id prefix "${lookup}" is ambiguous`)
    return matched[0]!
}

export async function updateChallengeIdea(
    rootDir: string,
    challengeId: string,
    ideaIdOrPrefix: string,
    patch: UpdateIdeaInput,
): Promise<IdeaRecord> {
    await ensureChallengeDirs(rootDir, challengeId)

    return withDirectoryLock(ideasLockDir(rootDir, challengeId), async () => {
        const index = await readIdeasIndex(rootDir, challengeId)
        const matched = findIdeaByIdOrPrefix(index.items, ideaIdOrPrefix)

        const updated: IdeaRecord = {
            ...matched,
            content: patch.content !== undefined ? patch.content.trim() : matched.content,
            status: patch.status ?? matched.status,
            result: patch.result !== undefined ? patch.result.trim() : matched.result,
            updated_at: nowIso(),
        }
        const next: IdeasIndexRecord = {
            ...index,
            updated_at: nowIso(),
            items: index.items.map((item) => (item.id === matched.id ? updated : item)),
        }
        await writeIdeasIndex(rootDir, challengeId, next)
        await atomicWriteJson(ideaByIdPath(rootDir, challengeId, updated.id), updated)
        return updated
    })
}

export async function deleteChallengeIdea(
    rootDir: string,
    challengeId: string,
    ideaIdOrPrefix: string,
): Promise<IdeaRecord> {
    await ensureChallengeDirs(rootDir, challengeId)

    return withDirectoryLock(ideasLockDir(rootDir, challengeId), async () => {
        const index = await readIdeasIndex(rootDir, challengeId)
        const matched = findIdeaByIdOrPrefix(index.items, ideaIdOrPrefix)
        const next: IdeasIndexRecord = {
            ...index,
            updated_at: nowIso(),
            items: index.items.filter((item) => item.id !== matched.id),
        }
        await writeIdeasIndex(rootDir, challengeId, next)
        await rm(ideaByIdPath(rootDir, challengeId, matched.id), { force: true })
        return matched
    })
}
```

---

## 第二步：在 ChallengeManager 加便捷方法

修改 `packages/core/src/challenge/manager.ts`，在类里加：

```typescript
// 顶部加 import
import * as memory from "./memory"
import type { AddIdeaInput, UpdateIdeaInput, MemoryEntry, MemoryKind, IdeaRecord } from "./memory"

// 在 ChallengeManager 类里加：

async appendMemory(input: memory.AddMemoryInput): Promise<MemoryEntry> {
    const rootDir = await this.getRootDir()
    return memory.appendChallengeMemory(rootDir, input)
}

async listMemory(challengeId: string): Promise<MemoryEntry[]> {
    const rootDir = await this.getRootDir()
    return memory.listChallengeMemory(rootDir, challengeId)
}

async listIdeas(challengeId: string): Promise<IdeaRecord[]> {
    const rootDir = await this.getRootDir()
    return memory.listChallengeIdeas(rootDir, challengeId)
}

async searchIdeas(challengeId: string, query: string): Promise<IdeaRecord[]> {
    const rootDir = await this.getRootDir()
    return memory.searchChallengeIdeas(rootDir, query, challengeId)
}

async addIdea(challengeId: string, input: AddIdeaInput) {
    const rootDir = await this.getRootDir()
    return memory.addChallengeIdea(rootDir, challengeId, input)
}

async updateIdea(challengeId: string, ideaIdOrPrefix: string, patch: UpdateIdeaInput) {
    const rootDir = await this.getRootDir()
    return memory.updateChallengeIdea(rootDir, challengeId, ideaIdOrPrefix, patch)
}

async deleteIdea(challengeId: string, ideaIdOrPrefix: string) {
    const rootDir = await this.getRootDir()
    return memory.deleteChallengeIdea(rootDir, challengeId, ideaIdOrPrefix)
}
```

---

## 第三步：CLI 命令

`DaemonManager` 已经在 lesson 13 顶部 import 过了，直接用。在 challenge 命令组后加 memory / idea 命令组：

```typescript
const memoryCmd = program.command("memory").description("Memory/Ideas CRUD")

memoryCmd
    .command("add <challengeId>")
    .description("Add a memory entry")
    .requiredOption("--kind <kind>", "Kind (fact/evidence/failure/note/hint)")
    .requiredOption("--content <text>", "Content")
    .requiredOption("--source <source>", "Source (solver id or 'manual')")
    .action(async (challengeId: string, opts) => {
        const daemon = await DaemonManager.getInstance()
        const entry = await daemon.challenge.appendMemory({
            challengeId,
            kind: opts.kind as MemoryKind,
            content: opts.content,
            source: opts.source,
        })
        console.log(`✓ Added memory: ${entry.id}`)
    })

memoryCmd
    .command("list <challengeId>")
    .description("List memory entries")
    .action(async (challengeId: string) => {
        const daemon = await DaemonManager.getInstance()
        const list = await daemon.challenge.listMemory(challengeId)
        if (list.length === 0) {
            console.log("(no memory)")
            return
        }
        for (const m of list) {
            console.log(`[${m.kind}] ${m.id}: ${m.content.slice(0, 80)}`)
        }
    })

const ideaCmd = program.command("idea").description("Ideas CRUD")

ideaCmd
    .command("add <challengeId>")
    .description("Add an idea")
    .requiredOption("--content <text>", "Content")
    .action(async (challengeId: string, opts) => {
        const daemon = await DaemonManager.getInstance()
        const result = await daemon.challenge.addIdea(challengeId, {
            content: opts.content,
        })
        console.log(`✓ ${result.created ? "Created" : "Already exists"}: ${result.item.id} (${result.item.status})`)
    })

ideaCmd
    .command("list <challengeId>")
    .description("List ideas")
    .action(async (challengeId: string) => {
        const daemon = await DaemonManager.getInstance()
        const list = await daemon.challenge.listIdeas(challengeId)
        if (list.length === 0) {
            console.log("(no ideas)")
            return
        }
        for (const i of list) {
            console.log(`[${i.status}] ${i.id}: ${i.content}`)
        }
    })

ideaCmd
    .command("update <challengeId> <ideaIdOrPrefix>")
    .description("Update an idea")
    .option("--status <status>", "Status (pending/testing/verified/failed/skipped)")
    .option("--result <text>", "Result")
    .action(async (challengeId: string, ideaIdOrPrefix: string, opts) => {
        const daemon = await DaemonManager.getInstance()
        const updated = await daemon.challenge.updateIdea(challengeId, ideaIdOrPrefix, {
            status: opts.status,
            result: opts.result,
        })
        console.log(`✓ Updated: ${updated.id} (status=${updated.status})`)
    })
```

### 3.1 加 import

```typescript
import type { MemoryKind } from "@my/core"
```

### 3.2 在 packages/core/src/index.ts 加 export

```typescript
export * from "./challenge/memory"
```

---

## 第四步：验证

### 4.1 加 memory

```bash
bun run apps/cli/src/main.ts memory add test-1 \
  --kind fact \
  --content "openai gpt-4o supports tool calling" \
  --source manual
```

### 4.2 列出 memory

```bash
bun run apps/cli/src/main.ts memory list test-1
```

**预期**：

```
[fact] mem_a3f9b2c1: openai gpt-4o supports tool calling
```

### 4.3 加 idea

```bash
bun run apps/cli/src/main.ts idea add test-1 --content "test SQL injection on /login"
```

### 4.4 列出 ideas

```bash
bun run apps/cli/src/main.ts idea list test-1
```

**预期**：

```
[pending] idea_b7c1d2e3: test SQL injection on /login
```

### 4.5 更新 idea（用前缀）

```bash
bun run apps/cli/src/main.ts idea update test-1 b7c1 --status testing --result "found error in response"
```

**预期**：

```
✓ Updated: idea_b7c1d2e3 (status=testing)
```

### 4.6 测试去重

```bash
# 第二次加同样的内容（大小写不同）
bun run apps/cli/src/main.ts idea add test-1 --content "TEST SQL INJECTION ON /login"
# → Already exists
```

### 4.7 看文件布局

```bash
ls ~/.tinyfat/challenge/test-1/
# attempts/  challenge.json  ideas/  locks/  memory/  submissions/

ls ~/.tinyfat/challenge/test-1/ideas/
# by-id/  index.json

cat ~/.tinyfat/challenge/test-1/ideas/index.json
# 看到 ideas 数组

ls ~/.tinyfat/challenge/test-1/ideas/by-id/
# idea_xxx.json
```

### 4.8 类型检查

```bash
bun run typecheck
```

---

## 第五步：故障排查

### 问题 1：`idea id prefix is ambiguous`

**原因**：前缀匹配到多条 idea。

**解决**：用更长的前缀，或用完整 ID。

### 问题 2：去重不生效

**原因**：normalized 字段不一致（可能 trim 了但 lowercase 没做）。

**解决**：检查 `normalizeIdeaText` 是否做了 trim + lowercase。

### 问题 3：写 ideas index 时报 EEXIST

**原因**：并发写时锁冲突。

**解决**：等 5 秒重试；withDirectoryLock 已经处理了。

### 问题 4：listIdeas 返回空但文件存在

**原因**：可能 readJsonFile 失败（JSON 损坏）。

**解决**：

```bash
cat ~/.tinyfat/challenge/test-1/ideas/index.json
# 检查是否合法 JSON
```

---

## 本课小结

✅ **你已完成**：

- 实现 ideas + memory 完整 CRUD
- 双写设计（索引 + by-id）
- 前缀匹配 ID 查询
- normalized 去重
- 文件锁

📦 **新增文件**：

```
packages/core/src/challenge/memory.ts
```

🔑 **关键概念**：

- **ideas vs memory**：方向 vs 事实。
- **challenge 级 vs solver 级**：共享 vs 私有。
- **双写**：list 用索引、改单条用 by-id，O(1) 性能。
- **前缀匹配**：LLM 友好的 ID 查询。

---

## 下一课预告

[课时 17：Observer sidecar 工具集](./17-observer-tools.md)（待生成）—— 让 Observer LLM 能维护策略板。

继续课时 17 →
