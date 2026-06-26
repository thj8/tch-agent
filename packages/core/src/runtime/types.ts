import { resolve } from "node:path"
import { TCH_AGENT_HOME_DIR } from "../config/index"
import type { AgentSessionEvent } from "@mariozechner/pi-coding-agent"

/**
 * 所有 solver 的根目录：~/.tch-agent/solvers/
 * 每个 solver 一个子目录，按 solverId 命名。
 */
export const SOLVERS_DIR = resolve(TCH_AGENT_HOME_DIR, "solvers")

/** 已归档（停止）的 solver：~/.tch-agent/archive_solvers/ */
export const ARCHIVE_SOLVERS_DIR = resolve(TCH_AGENT_HOME_DIR, "archive_solvers")

/**
 * Docker 容器配置。
 */
export interface ContainerConfig {
    /** Docker 镜像名 */
    image: string
    /** 注入容器的环境变量 */
    env?: Record<string, string>
    /** 额外的 volume binds（host:container 格式） */
    binds?: string[]
    /** Docker 网络模式 */
    networkMode?: "bridge" | "host"
}

/**
 * 一个 Solver 实例的元数据。
 *
 * 这是 runtime 注册表里的"指针"——所有对 solver 的引用都基于它。
 */
export interface SolverInstance {
    /** 8 字符 solver ID（不是 Docker container ID） */
    id: string
    /** Docker 容器名 */
    containerId: string
    /** 容器显示名 */
    name: string
    /** 用哪个 prompt 启动 */
    promptName: string
    /** 初始 task 文本 */
    task: string
    /** challenge 模式下的题目 ID */
    challengeId?: string
    /** 当前状态 */
    status: "starting" | "running" | "stopping" | "stopped" | "error"
    /** 创建时间戳 */
    createdAt: number
    /** 错误信息（status === "error" 时） */
    error?: string
}

/**
 * Solver 事件回调。
 * 每当容器内的 AgentSession 产生一个事件，就调用这个回调。
 */
export type SolverEventHandler = (solverId: string, event: AgentSessionEvent) => void

// ── 路径计算辅助 ──────────────────────────────────────

/** solver 根目录：~/.tch-agent/solvers/<solverId> */
export function solverDir(solverId: string): string {
    return resolve(SOLVERS_DIR, solverId)
}

/** solver session 目录（对话历史） */
export function solverSessionDir(solverId: string): string {
    return resolve(SOLVERS_DIR, solverId, "session")
}

/** solver 工作目录（容器 cwd） */
export function solverWorkspaceDir(solverId: string): string {
    return resolve(SOLVERS_DIR, solverId, "workspace")
}
