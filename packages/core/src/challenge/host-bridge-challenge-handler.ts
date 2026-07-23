import type { RuntimeManager } from "../runtime/runtime"
import { CHALLENGE_ENV_CHALLENGE_ID } from "./env"
import type {
    HostBridgeHandleContext,
    HostBridgeHandleResult,
    HostBridgeHandler,
} from "./host-bridge-handler"
import type { ChallengeManager } from "./manager"

/** 投递级别：steer（高优先级，立即影响下一轮）/ follow_up（普通追加）。 */
export type BroadcastDelivery = "steer" | "follow_up"

/**
 * 构造"flag 已拿到"的协作广播消息（导出便于单测）。
 *
 * 进度 got/total 与剩余 flag 数仅在两者都已知时给出；完成与未完成给出不同收尾。
 */
export function formatFlagSolvedBroadcastMessage(input: {
    flag: string
    gotCount?: number
    flagCount?: number
    isCompleted: boolean
}): string {
    const hasProgress =
        typeof input.gotCount === "number" && typeof input.flagCount === "number"
    const progress = hasProgress ? `${input.gotCount}/${input.flagCount}` : "-"
    const remaining = hasProgress
        ? Math.max((input.flagCount as number) - (input.gotCount as number), 0)
        : undefined

    const lines: string[] = [
        "协作同步：同题已有 solver 提交正确 flag。",
        `- flag: ${input.flag}`,
        `- 进度: ${progress}`,
    ]
    if (typeof remaining === "number") lines.push(`- 剩余 flag: ${remaining}`)
    lines.push(
        input.isCompleted
            ? "- 题目已完成，不要继续重复当前路线。"
            : "- 这条路线已经拿到一个 flag，转向剩余 flag。",
    )
    return lines.join("\n")
}

/**
 * 把消息广播给同题目、running 状态、非发起者的所有 solver（导出便于单测）。
 *
 * runtime 缺省 / 消息为空 / 无匹配 solver 时静默跳过；单条 sendCommand 失败只记日志，
 * 不影响其他 solver 的投递。
 */
export function broadcastToChallengeSolvers(
    runtime: RuntimeManager | undefined,
    challengeId: string,
    excludeSolverId: string,
    message: string,
    delivery: BroadcastDelivery = "steer",
): void {
    if (!runtime) return
    const text = message.trim()
    if (!text) return
    for (const solver of runtime.list()) {
        if (solver.challengeId !== challengeId) continue
        if (solver.status !== "running") continue
        if (solver.id === excludeSolverId) continue
        try {
            runtime.sendCommand(solver.id, { type: delivery, message: text })
        } catch (error) {
            console.error(`[broadcast] failed for ${solver.id}:`, error)
        }
    }
}

function broadcastHint(
    runtime: RuntimeManager | undefined,
    challengeId: string,
    excludeSolverId: string,
    hintContent: string | null,
): void {
    const hint = hintContent?.trim()
    if (!hint) return
    const message = [
        "系统同步：赛题 hint 已更新。",
        "- 立即吸收 hint，刷新 memory/idea。",
        `- hint:`,
        hint,
    ].join("\n")
    broadcastToChallengeSolvers(runtime, challengeId, excludeSolverId, message, "steer")
}

/**
 * 创建 challenge 相关的 host bridge handler。
 *
 * 让容器内 solver 能调 challenge_get_state / challenge_submit_flag /
 * challenge_get_hint / challenge_is_completed。
 *
 * 前提：solver 容器必须注入了 TCH_CHALLENGE_ID 环境变量（否则一律 handled:false，
 * 让 handler 链继续往后试别的 handler）。
 *
 * 协作广播（lesson 20）：可选传入 `runtimeGetter`（延迟取值，规避
 * runtime↔handler 的构造期循环依赖）。challenge_get_hint 拿到 hint、
 * challenge_submit_flag 判定 correct 时，向同题目其他 running solver 广播 steer 消息。
 */
export function createChallengeHostBridgeHandler(
    challengeManager: ChallengeManager,
    runtimeGetter?: () => RuntimeManager | undefined,
): HostBridgeHandler {
    return {
        async handle(ctx: HostBridgeHandleContext): Promise<HostBridgeHandleResult> {
            // 必须有 TCH_CHALLENGE_ID 环境变量
            const challengeId = ctx.getSolverEnvValue?.(CHALLENGE_ENV_CHALLENGE_ID)
            if (!challengeId) {
                return { handled: false }
            }

            switch (ctx.action) {
                case "challenge_get_state": {
                    const challenge = await challengeManager.getChallenge(challengeId)
                    const isCompleted = await challengeManager.isChallengeCompleted(challengeId)
                    return {
                        handled: true,
                        data: { challenge_id: challengeId, challenge, is_completed: isCompleted },
                    }
                }

                case "challenge_is_completed": {
                    const isCompleted = await challengeManager.isChallengeCompleted(challengeId)
                    return { handled: true, data: { challenge_id: challengeId, is_completed: isCompleted } }
                }

                case "challenge_get_hint": {
                    const result = await challengeManager.getHint(challengeId)
                    // 广播 hint 给同题目其他 solver（steer，让它们立刻吸收）
                    broadcastHint(runtimeGetter?.(), challengeId, ctx.solverId, result.remote.hint_content)
                    return { handled: true, data: result.remote }
                }

                case "challenge_submit_flag": {
                    const params = (ctx.params ?? {}) as { flag: string; writeup?: string }
                    if (!params.flag) {
                        return { handled: true, data: { error: "flag is required" } }
                    }
                    const result = await challengeManager.submitFlag(challengeId, params.flag, {
                        solverId: ctx.solverId,
                        writeup: params.writeup,
                    })

                    // correct → 广播给其他 solver：转剩余 flag（steer）
                    if (result.remote.correct) {
                        broadcastToChallengeSolvers(
                            runtimeGetter?.(),
                            challengeId,
                            ctx.solverId,
                            formatFlagSolvedBroadcastMessage({
                                flag: params.flag,
                                gotCount: result.remote.flag_got_count,
                                flagCount: result.remote.flag_count,
                                isCompleted: result.is_completed,
                            }),
                            "steer",
                        )
                    }

                    return {
                        handled: true,
                        data: {
                            challenge_id: challengeId,
                            correct: result.remote.correct,
                            flag_got_count: result.remote.flag_got_count,
                            flag_count: result.remote.flag_count,
                            is_completed: result.is_completed,
                        },
                    }
                }

                default:
                    return { handled: false }
            }
        },
    }
}
