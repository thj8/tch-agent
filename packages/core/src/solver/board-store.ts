/**
 * Solver 本地策略板存储（lesson 17）。
 *
 * 每个 solver 自己也有一份 board（与 challenge 级分开），存放在 solver session
 * 目录的 `.observer/` 子目录。底层完全委托给 challenge/memory.ts（同一套文件存储），
 * 这里只是 adapter：把 `challengeId` 占位成固定命名空间 `"board"`，rootDir 指到
 * `<sessionDir>/.observer`。
 *
 * sessionDir 来源：优先参数，其次环境变量 `TCH_SOLVER_SESSION_DIR`（容器内注入）。
 */
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
