/**
 * Observer 运行时存储（lesson 18）。
 *
 * 三块状态，都落在 <sessionDir>/.observer/ 下（sessionDir 来自 TCH_SOLVER_SESSION_DIR）：
 *   - state.json          ← 当前轮号 + 当前轮累积的工具日志 + 暂存的 tool args
 *   - review-queue/*.json ← 待消费的 review payload（FIFO，文件名 = <ts>-<rand>）
 *   - rounds/<NNNNNN>.json ← 已封口的轮次归档（供 review 取最近 N 轮窗口）
 *
 * state 用"读 → 改 → 写"（updateObserverState）；review-queue 用入队/出队原子文件操作。
 */
import { mkdir, readdir, unlink } from "node:fs/promises"
import { join } from "node:path"
import type { ObserverReviewPayload, ObserverRoundPayload, ObserverToolLog } from "./types"

// ── 状态文件 ──────────────────────────────────────────────

const OBSERVER_RUNTIME_STATE_FILE = "state.json"
const OBSERVER_REVIEW_QUEUE_DIRNAME = "review-queue"
const OBSERVER_ROUNDS_DIRNAME = "rounds"

/**
 * Observer 运行时状态。
 */
export interface ObserverRuntimeState {
    /** 当前轮号 */
    round: number
    /** 当前轮累积的工具日志 */
    current_round_tool_logs: ObserverToolLog[]
    /** tool_execution_start 暂存的 args，等 end 时配对 */
    tool_args_by_call_id: Record<string, string>
    /** 强制 review 原因（hint 等） */
    force_review_reason?: ObserverReviewPayload["reason"]
}

function resolveObserverRootDir(): string {
    const solverSessionDir = process.env.TCH_SOLVER_SESSION_DIR?.trim()
    if (!solverSessionDir) {
        throw new Error("TCH_SOLVER_SESSION_DIR is required for observer runtime state")
    }
    return join(solverSessionDir, ".observer")
}

function resolveObserverRuntimeStatePath(): string {
    return join(resolveObserverRootDir(), OBSERVER_RUNTIME_STATE_FILE)
}

function resolveObserverReviewQueueDir(): string {
    return join(resolveObserverRootDir(), OBSERVER_REVIEW_QUEUE_DIRNAME)
}

function resolveObserverRoundsDir(): string {
    return join(resolveObserverRootDir(), OBSERVER_ROUNDS_DIRNAME)
}

function createDefaultState(): ObserverRuntimeState {
    return {
        round: 0,
        current_round_tool_logs: [],
        tool_args_by_call_id: {},
    }
}

async function ensureDir(path: string): Promise<void> {
    await mkdir(path, { recursive: true })
}

// ── State CRUD ────────────────────────────────────────────

export async function loadObserverState(): Promise<ObserverRuntimeState> {
    await ensureDir(resolveObserverRootDir())
    const file = Bun.file(resolveObserverRuntimeStatePath())
    if (!(await file.exists())) return createDefaultState()
    return (await file.json()) as ObserverRuntimeState
}

/**
 * 原子地"读 → 改 → 写"。
 *
 * mutate 函数：接收当前 state，返回 { nextState, result }。
 */
export async function updateObserverState<T>(
    mutate: (state: ObserverRuntimeState) => { nextState: ObserverRuntimeState; result: T },
): Promise<T> {
    const current = await loadObserverState()
    const { nextState, result } = mutate(current)
    await Bun.write(resolveObserverRuntimeStatePath(), JSON.stringify(nextState, null, 2))
    return result
}

// ── Review Queue ──────────────────────────────────────────

export async function enqueueObserverReview(payload: ObserverReviewPayload): Promise<void> {
    const dir = resolveObserverReviewQueueDir()
    await ensureDir(dir)
    const filePath = join(dir, `${Date.now()}-${crypto.randomUUID().slice(0, 8)}.json`)
    await Bun.write(filePath, JSON.stringify(payload, null, 2))
}

export async function takeNextObserverReview(): Promise<ObserverReviewPayload | undefined> {
    const dir = resolveObserverReviewQueueDir()
    await ensureDir(dir)
    const files = (await readdir(dir))
        .filter((name) => name.endsWith(".json"))
        .sort((left, right) => left.localeCompare(right))
    const nextFile = files[0]
    if (!nextFile) return undefined

    const filePath = join(dir, nextFile)
    const payload = (await Bun.file(filePath).json()) as ObserverReviewPayload
    await unlink(filePath)
    return payload
}

// ── Rounds Archive ────────────────────────────────────────

function formatRoundFileName(round: number): string {
    return `${String(round).padStart(6, "0")}.json`
}

export async function persistObserverRound(record: ObserverRoundPayload): Promise<void> {
    const dir = resolveObserverRoundsDir()
    await ensureDir(dir)
    await Bun.write(join(dir, formatRoundFileName(record.round)), JSON.stringify(record, null, 2))
}

export async function loadRecentObserverRounds(limit: number): Promise<ObserverRoundPayload[]> {
    if (limit <= 0) return []
    const dir = resolveObserverRoundsDir()
    let files: string[] = []
    try {
        files = (await readdir(dir))
            .filter((name) => name.endsWith(".json"))
            .sort((left, right) => left.localeCompare(right))
            .slice(-limit)
    } catch {
        return []
    }

    const rounds = await Promise.all(
        files.map(async (fileName) => {
            return (await Bun.file(join(dir, fileName)).json()) as ObserverRoundPayload
        }),
    )
    return rounds.sort((left, right) => left.round - right.round)
}

export async function loadLatestObserverRoundNumber(): Promise<number> {
    const rounds = await loadRecentObserverRounds(1)
    return rounds.at(-1)?.round ?? 0
}
