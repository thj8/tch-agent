import type { ThinkingLevel } from "@mariozechner/pi-ai"

/**
 * Solver 启动载荷（宿主 → 容器，stdin 第一行）。
 *
 * 容器拿到这个后调 createSolverSession。
 */
export interface SolverInitPayload {
    /** 8 字符 solver ID */
    solverId: string
    /** 用哪个 prompt */
    promptName: string
    /** 初始 task */
    task: string
    /** challenge 模式下的题目 ID（可选） */
    challengeId?: string
}

/**
 * 宿主 → 容器的所有命令。
 *
 * 每条命令有可选 `id`，用于在 RpcResponse 里配对。
 */
export type RpcCommand =
    // Prompting
    | { id?: string; type: "prompt"; message: string; streamingBehavior?: "steer" | "followUp" }
    | { id?: string; type: "steer"; message: string }
    | { id?: string; type: "follow_up"; message: string }
    | { id?: string; type: "abort" }
    // State
    | { id?: string; type: "get_state" }
    // Model
    | { id?: string; type: "set_model"; provider: string; modelId: string }
    | { id?: string; type: "cycle_model" }
    | { id?: string; type: "get_available_models" }
    // Thinking
    | { id?: string; type: "set_thinking_level"; level: ThinkingLevel }
    | { id?: string; type: "cycle_thinking_level" }
    // Bash
    | { id?: string; type: "bash"; command: string }
    | { id?: string; type: "abort_bash" }
    // Session
    | { id?: string; type: "get_messages" }
    | { id?: string; type: "get_session_stats" }

/**
 * 容器 → 宿主的命令应答。
 */
export type RpcResponse =
    | { id?: string; type: "response"; command: string; success: true; data?: unknown }
    | { id?: string; type: "response"; command: string; success: false; error: string }
