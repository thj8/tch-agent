import {
  SessionManager,
  createAgentSession,
} from "@mariozechner/pi-coding-agent"
import type { AgentSession, ExtensionFactory } from "@mariozechner/pi-coding-agent"
import { mkdir } from "node:fs/promises"
import { homedir } from "node:os"
import { resolve } from "node:path"
import { ConfigManager } from "../config/index"
import { createObserverSidecarTools } from "./extension/challenge-observer/tools"
import { attachObserverLoop } from "./extension/challenge-observer/observer-loop"

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
  /** Observer sidecar 用的 model pref id（可选；省略则 observer 用 SDK 默认 model） */
  observerModel?: string
}): Promise<SolverSession> {
  const config = await ConfigManager.getInstance()

  // 1. 准备目录
  const homeDir = resolve(homedir(), ".tinyfat")
  const solversDir = resolve(homeDir, "solvers")
  const workspaceDir = resolve(solversDir, init.solverId, "workspace")
  const sessionDir = resolve(solversDir, init.solverId, "session")

  await mkdir(workspaceDir, { recursive: true })
  await mkdir(sessionDir, { recursive: true })

  // 注入 sessionDir 给 observer board-store 工具（lesson 17）：board-store 的
  // requireSessionDir() 读 TCH_SOLVER_SESSION_DIR。单进程串行 solver 场景成立；
  // 多 solver 并发需改为按 session 闭包传参。
  process.env.TCH_SOLVER_SESSION_DIR = sessionDir

  // 2. 装配 SDK 选项（cwd 用 workspace，让 read/bash 等工具落在 workspace 里）
  //    Observer loop（lesson 18）通过 ExtensionFactory 注入：resolvePromptSession
  //    会把 factories 交给 DefaultResourceLoader，bindExtensions 时执行 → pi.on 挂钩生效。
  const observerFactory: ExtensionFactory = (pi) => {
    attachObserverLoop(pi, { observerModel: init.observerModel })
  }
  const sessionOpts = await config.resolvePromptSession(
    init.promptName,
    [observerFactory],
    workspaceDir,
  )
  if (!sessionOpts) {
    throw new Error(`prompt not found or disabled: ${init.promptName}`)
  }

  // 3. 把 observer sidecar 工具（memory_* / idea_*）并入 customTools。
  //    注意：这些工具目前对主 solver 也可见，靠 prompt 约束（lesson 18 写 observer contract）。
  const observerTools = createObserverSidecarTools()

  // 4. 创建 AgentSession
  const { session } = await createAgentSession({
    ...sessionOpts,
    customTools: [...(sessionOpts.customTools ?? []), ...observerTools],
    sessionManager: SessionManager.create(workspaceDir, sessionDir),
  })
  await session.bindExtensions({})

  return { session, sessionDir, workspaceDir }
}
