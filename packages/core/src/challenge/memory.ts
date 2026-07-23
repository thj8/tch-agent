/**
 * Challenge 级 ideas + memory 文件存储（lesson 16）。
 *
 * 两块"策略板"：
 *   - ideas：待验证的攻击方向（pending → testing → verified/failed），双写（index + by-id）
 *   - memory：durable facts / 证据 / 失败边界，每条一个文件
 *
 * 目录布局（rootDir = ~/.tinyfat/challenge，与 store.ts 同源）：
 *   <rootDir>/<encodeURIComponent(challengeId)>/
 *     ideas/index.json          ← 全部 ideas 扁平数组（O(1) list）
 *     ideas/by-id/<id>.json     ← 单条 idea（O(1) 改）
 *     memory/entries/<ts>-<id>.json
 *     locks/{ideas,memory}.lock ← mkdir 文件锁
 *
 * 注：fs 辅助函数（atomicWriteJson / withDirectoryLock / readJsonFile /
 * isDirectoryExistsError）与 store.ts 同构——store.ts 没导出它们，这里自备一份
 * 保持模块自洽（未来可抽到共享 fs-utils）。
 */
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

async function withDirectoryLock<T>(lockDir: string, action: () => Promise<T>): Promise<T> {
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
            files.map((f) =>
                readJsonFile<MemoryEntry>(join(dir, f)).then((e) => ({ file: f, entry: e })),
            ),
        )
        const matched = all.find(
            ({ entry }) =>
                entry?.id === entryIdOrPrefix || entry?.id.startsWith(entryIdOrPrefix),
        )
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
            files.map((f) =>
                readJsonFile<MemoryEntry>(join(dir, f)).then((e) => ({ file: f, entry: e })),
            ),
        )
        const matched = all.find(
            ({ entry }) =>
                entry?.id === entryIdOrPrefix || entry?.id.startsWith(entryIdOrPrefix),
        )
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

        // 去重（normalized = trim + lowercase）
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
