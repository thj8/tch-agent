import type { ExtensionFactory } from "@mariozechner/pi-coding-agent"
import { attachObserverLoop } from "./observer-loop"
import { attachChallengeContinuation, isChallengeMode } from "./ralph-loop"

// 统一再导出，供 config/session 等装配方判断 challenge 模式。
export { isChallengeMode }

/**
 * 注入到 Solver system prompt 的 challenge 契约说明。
 *
 * 让 solver 知道"会被强制续跑 + 会收到协作同步"，避免它把续跑消息当噪音。
 */
export function buildChallengeExtensionAppendPrompt(): string {
  return [
    "## Challenge Extension Contract",
    "- 你会持续收到系统同步或协作同步消息。它们是 challenge extension 注入的协作信号，不是噪音。",
    "- 这些同步消息可能来自：赛题 hint 更新、其他 solver 已提交正确 flag、以及续跑机制。",
    "- `idea` 是待验证的攻击假设，不是事实。observer sidecar 会维护你的 idea 板。",
    "- `memory` 是 durable facts。运行中的 `memory_list` 就看它。",
    "- 如果其他 solver 已拿到一个 flag，不要重复同一路线，优先转向剩余 flag。",
    "- 系统会判断题目是否完成；在完成前，请持续推进。",
  ].join("\n")
}

/**
 * challenge-observer 扩展统一入口。
 *
 * 把两段扩展装配打包在一起：
 *   - observer loop（始终挂：周期 / hint / agent_end 触发策略板 review）
 *   - ralph loop（仅 challenge 模式挂：强制续跑）
 *
 * `factories` 交给 resolvePromptSession → DefaultResourceLoader，bindExtensions 时
 * 依次执行各 factory(pi) 注册 hook。`appendSystemPrompt` 由 resolvePromptSession
 * 拼到 system prompt 末尾。
 */
export function challengeObserverExtension(options: {
  /** Observer sidecar 用的 model pref id（可选）。 */
  observerModel?: string
}): {
  factories: ExtensionFactory[]
  appendSystemPrompt: () => string
} {
  const factories: ExtensionFactory[] = [
    (pi) => {
      console.log("[session] observer extension attached")
      attachObserverLoop(pi, { observerModel: options.observerModel })
    },
  ]

  if (isChallengeMode()) {
    factories.push((pi) => {
      console.log("[session] ralph loop attached")
      attachChallengeContinuation(pi)
    })
  }

  return {
    factories,
    appendSystemPrompt: () => buildChallengeExtensionAppendPrompt(),
  }
}
