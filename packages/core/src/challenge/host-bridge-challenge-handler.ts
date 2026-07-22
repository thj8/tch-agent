import { CHALLENGE_ENV_CHALLENGE_ID } from "./env"
import type {
    HostBridgeHandleContext,
    HostBridgeHandleResult,
    HostBridgeHandler,
} from "./host-bridge-handler"
import type { ChallengeManager } from "./manager"

/**
 * 创建 challenge 相关的 host bridge handler。
 *
 * 让容器内 solver 能调 challenge_get_state / challenge_submit_flag /
 * challenge_get_hint / challenge_is_completed。
 *
 * 前提：solver 容器必须注入了 TCH_CHALLENGE_ID 环境变量（否则一律 handled:false，
 * 让 handler 链继续往后试别的 handler）。
 */
export function createChallengeHostBridgeHandler(
    challengeManager: ChallengeManager,
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
