import type { ExtensionAPI } from "@mariozechner/pi-coding-agent"
import { CHALLENGE_ENV_CHALLENGE_ID } from "../../../challenge/env"
import { requestHostBridge } from "../../../challenge/host-bridge-client"

/** 连续 agent_end 失败的最大重试次数（超过即放弃续跑）。 */
const MAX_CHALLENGE_RETRY_ATTEMPTS = 10

/** 续跑时注入给 Solver 的提示语。 */
const CHALLENGE_CONTINUATION_MESSAGE =
  "继续当前任务。不要重复已经完成的步骤，基于现有上下文继续推进；如果题目有多个 flag，不要因为提交对一个就停止，直到比赛 API 明确显示题目完成。"

/** 自定义消息类型标识（前端 / 日志识别用）。 */
const CHALLENGE_CUSTOM_MESSAGE_TYPE = "challenge-continuation"

/** 退避基数（毫秒）。 */
const BASE_CHALLENGE_DELAY_MS = 1000
/** 退避上限（毫秒）。 */
const MAX_CHALLENGE_DELAY_MS = 10_000

/**
 * 当前 Solver 是否运行在 challenge 模式。
 *
 * 由环境变量 TCH_CHALLENGE_ID 标记（容器启动时由 Manager 注入）。
 * Ralph Loop 只在 challenge 模式启用——非 challenge 模式下 Solver 说到停就停。
 */
export function isChallengeMode(): boolean {
  return Boolean(process.env[CHALLENGE_ENV_CHALLENGE_ID]?.trim())
}

/** agent_end 消息里我们关心的字段（防御性结构，避免依赖 SDK 内部消息联合类型）。 */
type AgentEndMessage = {
  role?: string
  stopReason?: string
  errorMessage?: string
}

/**
 * 从 agent_end 的消息流里提取最后一条 assistant 消息的错误信息。
 *
 * 从末尾向前找第一个 assistant 消息：若它的 stopReason 不是 error 说明这一轮
 * 是正常结束（stop / length / toolUse），返回 undefined；若是 error 则返回
 * 其 errorMessage（兜底一个通用文案）。
 */
export function getAgentEndError(messages: readonly unknown[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i] as AgentEndMessage | undefined
    if (message?.role !== "assistant") continue
    if (message.stopReason !== "error") return undefined
    return message.errorMessage ?? "Agent ended with an unknown error"
  }
  return undefined
}

/**
 * 指数退避：第 n 次失败后等待 BASE * 2^(n-1) ms，封顶 MAX。
 *
 * attempt=1 → 1000ms，2 → 2000ms，3 → 4000ms，4 → 8000ms，5+ → 10000ms。
 */
export function getChallengeDelayMs(attempt: number): number {
  return Math.min(
    BASE_CHALLENGE_DELAY_MS * 2 ** Math.max(attempt - 1, 0),
    MAX_CHALLENGE_DELAY_MS,
  )
}

/**
 * 通过 host bridge 查询当前 challenge 是否已完成。
 *
 * 任何异常都视为"未完成"——续跑机制宁可多跑也不误判提前结束。
 */
async function isChallengeCompletedByHostBridge(): Promise<boolean> {
  try {
    const result = await requestHostBridge<{ is_completed: boolean }>(
      "challenge_is_completed",
      {},
    )
    return result.is_completed === true
  } catch {
    return false
  }
}

/**
 * "Ralph Loop" 强制续跑机制：结束条件外置。
 *
 * 监听 agent_end 事件，三类处理：
 *   1. challenge 已完成（host bridge 确认）→ 真正退出，不续跑。
 *   2. 上一轮以 error 结束 → 累计连续错误次数；超过上限放弃，否则指数退避后续跑。
 *   3. 否则（模型自己说停）→ 清零错误计数，注入 challenge-continuation 消息并
 *      triggerTurn，重启一轮。
 *
 * `isChallengeCompleted` / `sleep` 可注入，便于无 host bridge / 无真实延时的单测。
 */
export function attachChallengeContinuation(
  pi: ExtensionAPI,
  options: {
    /** 覆盖完成判定（单测用）；默认走 host bridge。 */
    isChallengeCompleted?: () => Promise<boolean>
    /** 覆盖退避 sleep（单测用）；默认 Bun.sleep。 */
    sleep?: (ms: number) => Promise<void>
  } = {},
): void {
  let consecutiveErrors = 0
  const isChallengeCompleted = options.isChallengeCompleted ?? isChallengeCompletedByHostBridge
  const sleep = options.sleep ?? ((ms: number) => Bun.sleep(ms))

  pi.on("agent_end", async (event) => {
    // 1. challenge 完成 → 真正退出
    if (await isChallengeCompleted()) {
      console.log("[ralph] challenge completed, exiting loop")
      return
    }

    // 2. 上一轮是 error → 退避重试
    const errorMessage = getAgentEndError(event.messages)
    if (errorMessage) {
      consecutiveErrors += 1
      console.log(`[ralph] agent_end error #${consecutiveErrors}: ${errorMessage}`)
      if (consecutiveErrors > MAX_CHALLENGE_RETRY_ATTEMPTS) {
        console.error(`[ralph] giving up after ${MAX_CHALLENGE_RETRY_ATTEMPTS} errors`)
        return
      }
      const delay = getChallengeDelayMs(consecutiveErrors)
      console.log(`[ralph] backing off for ${delay}ms`)
      await sleep(delay)
    } else {
      // 上一轮正常结束（模型自己说停）→ 清零错误计数
      consecutiveErrors = 0
    }

    // 3. 注入续跑消息：用 setImmediate 推到下一轮事件循环，
    //    避免在 agent_end 回调内同步触发新 turn（SDK 当前 turn 可能还没收尾）。
    console.log("[ralph] challenge not completed, continuing...")
    setImmediate(() => {
      pi.sendMessage(
        {
          customType: CHALLENGE_CUSTOM_MESSAGE_TYPE,
          content: [{ type: "text", text: CHALLENGE_CONTINUATION_MESSAGE }],
          display: false,
          details: undefined,
        },
        { triggerTurn: true },
      )
    })
  })
}
