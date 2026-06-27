import {
    SessionManager,
    createAgentSession,
} from "@mariozechner/pi-coding-agent"
import type { AgentSession } from "@mariozechner/pi-coding-agent"
import { mkdir } from "node:fs/promises"
import { homedir } from "node:os"
import { resolve } from "node:path"
import { ConfigManager } from "../config/index"

/**
 * 一个已就绪的 Solver AgentSession + 目录路径。
 */
export interface SolverSession {
    session: AgentSession
    sessionDir: string
    workspaceDir: string
}

/**
 * 创建一个 Solver AgentSession。
 *
 * 流程：
 *   1. 准备 workspace / session 目录（默认在 ~/.tinyfat/solvers/<id>/）
 *   2. resolvePromptSession 装配 SDK 选项
 *   3. createAgentSession + bindExtensions
 *
 * 注意：本函数只创建并返回 session，**不发送 prompt**。
 * 调用方（runSolverCli）负责发送初始 task。
 */
export async function createSolverSession(init: {
    solverId: string
    promptName: string
    task: string
}): Promise<SolverSession> {
    const config = await ConfigManager.getInstance()

    // 1. 准备目录
    const homeDir = resolve(homedir(), ".tinyfat")
    const solversDir = resolve(homeDir, "solvers")
    const workspaceDir = resolve(solversDir, init.solverId, "workspace")
    const sessionDir = resolve(solversDir, init.solverId, "session")

    await mkdir(workspaceDir, { recursive: true })
    await mkdir(sessionDir, { recursive: true })

    // 2. 装配 SDK 选项（cwd 用 workspace，让 read/bash 等工具落在 workspace 里）
    const sessionOpts = await config.resolvePromptSession(
        init.promptName,
        [],
        workspaceDir,
    )
    if (!sessionOpts) {
        throw new Error(`prompt not found or disabled: ${init.promptName}`)
    }

    // 3. 创建 AgentSession
    const { session } = await createAgentSession({
        ...sessionOpts,
        sessionManager: SessionManager.create(workspaceDir, sessionDir),
    })
    await session.bindExtensions({})

    return { session, sessionDir, workspaceDir }
}
