/**
 * Challenge 数据存储层。
 *
 * 布局（每个 challenge 一个目录，按 encodeURIComponent 编码 ID）：
 *
 *   <rootDir>/<encodedId>/
 *   ├── challenge.json          ← 元数据（小文件，频繁读，原子覆盖写）
 *   ├── attempts/
 *   │   └── <ts>-<id>.json      ← 每次起 solver 一个文件（append O(1)）
 *   ├── submissions/
 *   │   └── <ts>-<id>.json      ← 每次提交 flag 一个文件
 *   └── locks/
 *       └── challenge.lock/     ← mkdir 原子锁目录（含 lock-meta.json）
 *
 * 设计要点：
 *   - 元数据用单 JSON 覆盖写（小、频繁读）；日志用"每条一文件"避免读改写整个数组。
 *   - 原子写：先写 .tmp 再 rename（rename 同文件系统内原子）。
 *   - 文件锁：靠 mkdir 的原子性抢锁；锁目录里写 lock-meta.json 做 stale 检测。
 */
import { mkdir, readdir, rename, rm } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { TCH_AGENT_HOME_DIR } from "../config/index"

/** challenge 数据根目录：~/.tinyfat/challenge/ */
export const DEFAULT_CHALLENGE_DIR = resolve(TCH_AGENT_HOME_DIR, "challenge")

/**
 * 一道题目的核心元数据。
 */
export interface ChallengeRecord {
    /** 题目 ID（来自赛题平台） */
    id: string
    title: string
    difficulty: string
    description: string
    level: number
    total_score: number
    total_got_score: number
    flag_count: number
    flag_got_count: number
    hint_viewed: boolean
    hint_content?: string | null
    /** 实例状态：pending / running / stopped */
    instance_status: string
    /** 实例访问入口，如 ["127.0.0.1:8080"] */
    entrypoint: string[] | null
    /** 正确 flag 值（mock 模式才有） */
    flags?: string[]
}

/** ChallengeRecord + 审计字段 */
export interface ChallengeInfoRecord extends ChallengeRecord {
    updated_at: string
    /** 本次更新的来源标签 */
    source: string
}

/** 一次 solver 启动日志 */
export interface ChallengeAttemptLogRecord {
    id: string
    challenge_id: string
    solver_id: string
    prompt_name: string
    task: string
    created_at: string
}

/** 一次 flag 提交日志 */
export interface ChallengeSubmissionLogRecord {
    id: string
    challenge_id: string
    solver_id?: string
    prompt_name?: string
    model_name?: string
    flag: string
    correct: boolean
    message?: string
    writeup?: string
    created_at: string
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

function isDirectoryExistsError(error: unknown): boolean {
    return (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error as { code?: string }).code === "EEXIST"
    )
}

async function readJsonFile<T>(path: string): Promise<T | undefined> {
    const file = Bun.file(path)
    if (!(await file.exists())) return undefined
    try {
        return (await file.json()) as T
    } catch {
        return undefined
    }
}

/**
 * 原子写 JSON：先写 .tmp 再 rename。
 *
 * 必要性：长跑的 challenge 会被多个 solver 并发读写。
 * 如果直接 Bun.write，写一半进程崩了会留下半个文件。
 * rename 在同一文件系统内是原子的——要么旧文件、要么新文件。
 */
async function atomicWriteJson(path: string, data: unknown): Promise<void> {
    const tmpPath = `${path}.tmp-${process.pid}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`
    await mkdir(dirname(path), { recursive: true })
    await Bun.write(tmpPath, JSON.stringify(data, null, 2))
    await rename(tmpPath, path)
}

/**
 * 用"目录存在性"做互斥锁。
 *
 * 三层保护：
 *   1. 抢锁失败 → 自旋等待（25ms 间隔），最多 5 秒。
 *   2. 写 lock-meta.json（含创建时间），便于诊断谁持锁。
 *   3. 锁超过 60s 还没释放（持锁进程崩溃）→ stale，强制清理。
 */
async function withDirectoryLock<T>(
    lockDir: string,
    action: () => Promise<T>,
): Promise<T> {
    const startedAt = Date.now()
    const timeoutMs = 5000
    const staleMs = 60_000

    while (true) {
        try {
            await mkdir(lockDir)  // 原子抢锁
            break
        } catch (error) {
            if (!isDirectoryExistsError(error)) throw error

            // 锁被别人持有，检查 stale
            const lockMeta = await readJsonFile<{ created_at?: string }>(
                join(lockDir, "lock-meta.json"),
            )
            const lockCreatedAt = lockMeta?.created_at ? Date.parse(lockMeta.created_at) : Number.NaN
            const lockAge = Number.isFinite(lockCreatedAt) ? Date.now() - lockCreatedAt : Number.NaN
            if (Number.isFinite(lockAge) && lockAge > staleMs) {
                // stale，清理重试
                await rm(lockDir, { recursive: true, force: true })
                continue
            }

            if (Date.now() - startedAt > timeoutMs) {
                throw new Error(`challenge lock timeout: ${lockDir}`)
            }
            await Bun.sleep(25)
        }
    }

    // 写 lock-meta
    await Bun.write(
        join(lockDir, "lock-meta.json"),
        JSON.stringify({ created_at: nowIso(), pid: process.pid }, null, 2),
    )

    try {
        return await action()
    } finally {
        await rm(lockDir, { recursive: true, force: true })
    }
}

// ── 路径计算 ──────────────────────────────────────────────

function challengeDir(rootDir: string, challengeId: string): string {
    return join(rootDir, encodeURIComponent(challengeId))
}

function challengePath(rootDir: string, challengeId: string): string {
    return join(challengeDir(rootDir, challengeId), "challenge.json")
}

function challengeLockDir(rootDir: string, challengeId: string): string {
    return join(challengeDir(rootDir, challengeId), "locks", "challenge.lock")
}

function attemptLogsDir(rootDir: string, challengeId: string): string {
    return join(challengeDir(rootDir, challengeId), "attempts")
}

function submissionLogsDir(rootDir: string, challengeId: string): string {
    return join(challengeDir(rootDir, challengeId), "submissions")
}

function createLogId(prefix: string): string {
    return `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}`
}

async function ensureChallengeDirs(rootDir: string, challengeId: string): Promise<void> {
    const id = requireText(challengeId, "challengeId")
    const baseDir = challengeDir(rootDir, id)
    await mkdir(baseDir, { recursive: true })
    await mkdir(join(baseDir, "locks"), { recursive: true })
    await mkdir(attemptLogsDir(rootDir, id), { recursive: true })
    await mkdir(submissionLogsDir(rootDir, id), { recursive: true })
}

// ── 对外 API ─────────────────────────────────────────────

export async function ensureChallengeStoreBaseDir(rootDir: string): Promise<void> {
    await mkdir(rootDir, { recursive: true })
}

/**
 * 保存（覆盖写）一道题的元数据。
 */
export async function saveChallengeRecord(
    rootDir: string,
    challenge: ChallengeRecord,
    source = "save",
): Promise<void> {
    const challengeId = requireText(challenge.id, "challenge.id")
    await ensureChallengeDirs(rootDir, challengeId)

    await withDirectoryLock(challengeLockDir(rootDir, challengeId), async () => {
        const record: ChallengeInfoRecord = {
            ...challenge,
            updated_at: nowIso(),
            source,
        }
        await atomicWriteJson(challengePath(rootDir, challengeId), record)
    })
}

/** 读单道题 */
export async function readChallengeRecord(
    rootDir: string,
    challengeId: string,
): Promise<ChallengeInfoRecord | undefined> {
    const id = requireText(challengeId, "challengeId")
    return readJsonFile<ChallengeInfoRecord>(challengePath(rootDir, id))
}

/** 列出全部题目 */
export async function listChallengeRecords(rootDir: string): Promise<ChallengeInfoRecord[]> {
    await ensureChallengeStoreBaseDir(rootDir)
    let entries: string[] = []
    try {
        const items = await readdir(rootDir, { withFileTypes: true })
        entries = items.filter((e) => e.isDirectory()).map((e) => e.name)
    } catch {
        return []
    }

    const ids = entries.map(decodeURIComponent).sort()
    const records = await Promise.all(ids.map((id) => readChallengeRecord(rootDir, id)))
    return records.filter((r): r is ChallengeInfoRecord => Boolean(r))
}

/** 追加启动日志 */
export async function appendChallengeAttemptLog(
    rootDir: string,
    input: {
        challengeId: string
        solverId: string
        promptName: string
        task: string
    },
): Promise<ChallengeAttemptLogRecord> {
    const challengeId = requireText(input.challengeId, "challengeId")
    await ensureChallengeDirs(rootDir, challengeId)

    const record: ChallengeAttemptLogRecord = {
        id: createLogId("attempt"),
        challenge_id: challengeId,
        solver_id: requireText(input.solverId, "solverId"),
        prompt_name: requireText(input.promptName, "promptName"),
        task: requireText(input.task, "task"),
        created_at: nowIso(),
    }
    await atomicWriteJson(
        join(attemptLogsDir(rootDir, challengeId), `${Date.now()}-${record.id}.json`),
        record,
    )
    return record
}

/** 列出全部启动日志 */
export async function listChallengeAttemptLogs(
    rootDir: string,
    challengeId: string,
): Promise<ChallengeAttemptLogRecord[]> {
    const id = requireText(challengeId, "challengeId")
    const dir = attemptLogsDir(rootDir, id)
    let files: string[] = []
    try {
        files = (await readdir(dir)).filter((f) => f.endsWith(".json")).sort()
    } catch {
        return []
    }
    const items = await Promise.all(
        files.map((f) => readJsonFile<ChallengeAttemptLogRecord>(join(dir, f))),
    )
    return items.filter((i): i is ChallengeAttemptLogRecord => Boolean(i))
}

/** 追加提交日志（无论对错） */
export async function appendChallengeSubmissionLog(
    rootDir: string,
    input: {
        challengeId: string
        solverId?: string
        promptName?: string
        modelName?: string
        flag: string
        correct: boolean
        message?: string
        writeup?: string
    },
): Promise<ChallengeSubmissionLogRecord> {
    const challengeId = requireText(input.challengeId, "challengeId")
    await ensureChallengeDirs(rootDir, challengeId)

    const record: ChallengeSubmissionLogRecord = {
        id: createLogId("submission"),
        challenge_id: challengeId,
        solver_id: input.solverId,
        prompt_name: input.promptName,
        model_name: input.modelName,
        flag: requireText(input.flag, "flag"),
        correct: input.correct,
        message: input.message,
        writeup: input.writeup,
        created_at: nowIso(),
    }
    await atomicWriteJson(
        join(submissionLogsDir(rootDir, challengeId), `${Date.now()}-${record.id}.json`),
        record,
    )
    return record
}

/** 列出全部提交日志 */
export async function listChallengeSubmissionLogs(
    rootDir: string,
    challengeId: string,
): Promise<ChallengeSubmissionLogRecord[]> {
    const id = requireText(challengeId, "challengeId")
    const dir = submissionLogsDir(rootDir, id)
    let files: string[] = []
    try {
        files = (await readdir(dir)).filter((f) => f.endsWith(".json")).sort()
    } catch {
        return []
    }
    const items = await Promise.all(
        files.map((f) => readJsonFile<ChallengeSubmissionLogRecord>(join(dir, f))),
    )
    return items.filter((i): i is ChallengeSubmissionLogRecord => Boolean(i))
}

/**
 * 判断一道题是否完成：
 *   - flag_count > 0
 *   - flag_got_count >= flag_count
 */
export function computeChallengeCompleted(challenge: ChallengeInfoRecord | undefined): boolean {
    if (!challenge) return false
    return challenge.flag_count > 0 && challenge.flag_got_count >= challenge.flag_count
}
