/** 工具调用摘要 */
export interface ObserverToolLog {
    tool_name: string
    args_summary: string
    result_summary: string
    is_error: boolean
}

/** 一"轮"的活动记录 */
export interface ObserverRoundPayload {
    round: number
    assistant_summary: string
    tool_logs: ObserverToolLog[]
}

/** 一次 review 的输入 */
export interface ObserverReviewPayload {
    reason: "periodic" | "hint" | "agent_end"
    rounds: ObserverRoundPayload[]
    session_context: string
}
