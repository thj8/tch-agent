/**
 * Observer loop（lesson 18）：挂在主 solver session 的事件流上，按节奏触发 review。
 *
 * 一"轮" = 一次 assistant message_end + 期间的所有 tool calls。
 * 触发节奏：
 *   - 周期：每 OBSERVER_REVIEW_EVERY_ROUNDS 轮（默认 6）
 *   - 强制：challenge_get_hint 成功（攻击路线可能改变）
 *   - 末轮：agent_end
 *
 * review 走文件队列串行消费（drainReviewQueue），防并发 LLM 调用写穿存储。
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent"
import { runSolverObserverReview } from "./observer-agent"
import {
    enqueueObserverReview,
    loadLatestObserverRoundNumber,
    loadRecentObserverRounds,
    persistObserverRound,
    takeNextObserverReview,
    updateObserverState,
} from "./observer-store"
import type { ObserverReviewPayload, ObserverRoundPayload, ObserverToolLog } from "./types"

/** 每 N 轮一次周期 review */
const OBSERVER_REVIEW_EVERY_ROUNDS = 6
/** review 窗口大小：最近 N 轮 */
const OBSERVER_REVIEW_WINDOW_ROUNDS = 10
/** 工具 args 摘要长度 */
const TOOL_ARGS_PREVIEW_CHARS = 160
/** 工具 result 摘要长度 */
const TOOL_RESULT_PREVIEW_CHARS = 160
/** assistant 消息摘要长度 */
const ASSISTANT_SUMMARY_PREVIEW_CHARS = 220

/** review 执行器类型（可注入，便于测试） */
type ReviewRunner = typeof runSolverObserverReview

export interface AttachObserverLoopOptions {
    observerModel?: string
    /** 可选：注入自定义 review 执行器（测试用；默认 runSolverObserverReview） */
    runReview?: ReviewRunner
    /** 可选：注入自定义 hint 工具名判定（测试用） */
    hintToolName?: string
}

// ── 工具函数 ────────────────────────────────────────────

function clipText(value: string, maxChars: number): string {
    const text = value.trim()
    if (text.length <= maxChars) return text
    return `${text.slice(0, maxChars)}...`
}

function safeJsonStringify(value: unknown): string {
    try {
        return JSON.stringify(value)
    } catch {
        return String(value)
    }
}

function summarizeArgs(value: unknown): string {
    return clipText(safeJsonStringify(value), TOOL_ARGS_PREVIEW_CHARS)
}

function summarizeResult(value: unknown): string {
    if (typeof value === "string") return clipText(value, TOOL_RESULT_PREVIEW_CHARS)
    if (value && typeof value === "object" && "content" in (value as Record<string, unknown>)) {
        const content = (value as { content?: unknown }).content
        if (Array.isArray(content)) {
            const text = content
                .map((block) => {
                    if (typeof block === "object" && block && (block as { type?: string }).type === "text") {
                        return typeof (block as { text?: unknown }).text === "string"
                            ? (block as { text: string }).text
                            : ""
                    }
                    return ""
                })
                .join("\n")
            return clipText(text, TOOL_RESULT_PREVIEW_CHARS)
        }
    }
    return clipText(safeJsonStringify(value), TOOL_RESULT_PREVIEW_CHARS)
}

function extractAssistantSummary(content: unknown): string {
    if (!Array.isArray(content)) return ""
    return clipText(
        content
            .filter(
                (c): c is { type: "text"; text: string } =>
                    !!c && typeof c === "object" && (c as { type?: string }).type === "text",
            )
            .map((c) => c.text)
            .join(""),
        ASSISTANT_SUMMARY_PREVIEW_CHARS,
    )
}

// ── 主入口 ──────────────────────────────────────────────

/**
 * 把 Observer loop 挂到 pi-coding-agent。
 *
 * Hook：
 *   - tool_execution_start → 暂存 args
 *   - tool_execution_end   → 配对 args，生成 ObserverToolLog（hint 成功 → 标记强制 review）
 *   - message_end (assistant) → 封口当前轮 + 决定是否 review
 *   - agent_end            → 末轮 review
 */
export function attachObserverLoop(
    pi: ExtensionAPI,
    options: AttachObserverLoopOptions = {},
): void {
    const runReview: ReviewRunner = options.runReview ?? runSolverObserverReview
    const hintToolName = options.hintToolName ?? "challenge_get_hint"
    let reviewRunning = false

    // 启动时对齐轮号（进程重启后从 rounds 目录恢复）
    const roundStateReady = updateObserverState((state) => ({
        nextState: { ...state, round: Math.max(state.round, 0) },
        result: undefined,
    })).then(async () => {
        const latest = await loadLatestObserverRoundNumber()
        return updateObserverState((state) => ({
            nextState: { ...state, round: Math.max(state.round, latest) },
            result: undefined,
        }))
    })

    /**
     * 串行消费 review 队列。
     */
    async function drainReviewQueue(): Promise<void> {
        if (reviewRunning) return
        reviewRunning = true
        try {
            while (true) {
                const next = await takeNextObserverReview()
                if (!next) return
                try {
                    await runReview("challenge", next, {
                        observerModel: options.observerModel,
                        // 简化：本课时不发 reminder
                    })
                } catch (error) {
                    console.error(`[observer] review failed: ${error instanceof Error ? error.message : String(error)}`)
                }
            }
        } finally {
            reviewRunning = false
        }
    }

    function enqueueReview(payload: ObserverReviewPayload): void {
        void enqueueObserverReview(payload)
            .then(() => drainReviewQueue())
            .catch((error) => {
                console.error(`[observer] enqueue failed: ${error instanceof Error ? error.message : String(error)}`)
            })
    }

    // ── Hook 1: tool_execution_start ─────────────────

    pi.on("tool_execution_start", async (event) => {
        await roundStateReady
        await updateObserverState((state) => ({
            nextState: {
                ...state,
                tool_args_by_call_id: {
                    ...state.tool_args_by_call_id,
                    [event.toolCallId]: summarizeArgs(event.args),
                },
            },
            result: undefined,
        }))
    })

    // ── Hook 2: tool_execution_end ───────────────────

    pi.on("tool_execution_end", async (event) => {
        await roundStateReady
        await updateObserverState((state) => {
            const nextArgs = { ...state.tool_args_by_call_id }
            const argsSummary = nextArgs[event.toolCallId] ?? ""
            delete nextArgs[event.toolCallId]
            const nextToolLogs: ObserverToolLog[] = [
                ...state.current_round_tool_logs,
                {
                    tool_name: event.toolName,
                    args_summary: argsSummary,
                    result_summary: summarizeResult(event.result),
                    is_error: event.isError,
                },
            ]
            return {
                nextState: {
                    ...state,
                    current_round_tool_logs: nextToolLogs,
                    tool_args_by_call_id: nextArgs,
                    // challenge_get_hint 成功 → 强制 review
                    force_review_reason:
                        !event.isError && event.toolName === hintToolName
                            ? "hint"
                            : state.force_review_reason,
                },
                result: undefined,
            }
        })
    })

    // ── Hook 3: message_end (assistant) ──────────────

    pi.on("message_end", async (event) => {
        const message = event.message as { role?: string; content?: unknown } | undefined
        if (message?.role !== "assistant") return
        await roundStateReady

        const assistantSummary = message.content ? extractAssistantSummary(message.content) : ""

        const { roundRecord, reviewReason } = await updateObserverState((state) => {
            const nextRound = state.round + 1
            const record: ObserverRoundPayload = {
                round: nextRound,
                assistant_summary: assistantSummary,
                tool_logs: state.current_round_tool_logs,
            }
            const periodicDue = nextRound % OBSERVER_REVIEW_EVERY_ROUNDS === 0
            const reason = state.force_review_reason ?? (periodicDue ? "periodic" : undefined)
            return {
                nextState: {
                    ...state,
                    round: nextRound,
                    current_round_tool_logs: [],
                    force_review_reason: undefined,
                },
                result: { roundRecord: record, reviewReason: reason },
            }
        })

        await persistObserverRound(roundRecord)
        const recent = await loadRecentObserverRounds(OBSERVER_REVIEW_WINDOW_ROUNDS)

        if (!reviewReason) return
        const reviewRounds = recent.slice(-OBSERVER_REVIEW_WINDOW_ROUNDS)
        if (reviewRounds.length === 0) return
        if (
            !reviewRounds.some(
                (item) => item.tool_logs.length > 0 || item.assistant_summary.trim().length > 0,
            )
        ) {
            return
        }

        enqueueReview({
            reason: reviewReason,
            rounds: reviewRounds,
            session_context: "",
        })
    })

    // ── Hook 4: agent_end ────────────────────────────

    pi.on("agent_end", async () => {
        await roundStateReady
        const recent = await loadRecentObserverRounds(OBSERVER_REVIEW_WINDOW_ROUNDS)
        if (recent.length === 0) return
        enqueueReview({
            reason: "agent_end",
            rounds: recent,
            session_context: "",
        })
    })

    // 启动时立刻消费一次（处理残留）
    void drainReviewQueue()
}
