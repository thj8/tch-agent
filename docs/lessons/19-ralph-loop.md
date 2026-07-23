# 课时 19：Ralph Loop（强制续跑）

> 🎯 **目标**：实现"不让 solver 自己说停就停"的强制续跑机制——只要 challenge 未完成就继续推。
>
> ⏰ **预计耗时**：2-3 小时
>
> 📋 **难度**：⭐⭐⭐

---

## 你将学到什么

1. **结束条件外置**（不让 LLM 主观判断）
2. **agent_end hook + triggerTurn**（SDK 的关键 API）
3. **指数退避重试**（错误处理）
4. **challenge 状态查询**（通过 host bridge）

## 前置条件

✅ 已完成 [课时 1-18](./README.md)

## 最终效果

solver LLM 说"我做完了"想停 → 系统检查 challenge 是否真的完成 → 没完成 → 自动注入"继续"消息让 LLM 接着干。

```
[assistant] 我已经完成了任务，结束。
[agent_end] stopReason=end_turn
[ralph-loop] challenge not completed, continuing...
[injected] 继续当前任务。不要重复已经完成的步骤...
[assistant] 哦，还有 flag 没拿到。让我继续...
```

---

## 第零步：概念扫盲

### 0.1 为什么要"强制续跑"？

LLM agent 的常见问题：

```
用户: 解这道 CTF 题，找 3 个 flag
LLM: 找到 1 个 flag 了！我做完了。
[agent_end]
```

LLM 倾向于"做完一点就停"，因为：
- 训练时被教导"完成任务就回 stop"
- 长 task 时容易忘完整目标
- 容易满足

**Ralph Loop** 反其道而行：**只要系统判断没完成，就不让 LLM 停**。

### 0.2 "结束条件外置"是什么意思？

正常 LLM agent：模型自己决定何时停（输出 `stop_reason: end_turn`）。

外置结束条件：**系统**根据客观状态（challenge 完成度）决定。

```typescript
pi.on("agent_end", async () => {
    if (await isChallengeCompleted()) return  // 系统说完成了，真停
    // 系统说没完成 → 注入"继续"消息，重启一轮
    pi.sendMessage({ ..., "继续..." }, { triggerTurn: true })
})
```

这就是 "Ralph Loop" 名字的由来（[Wreck-It Ralph](https://en.wikipedia.org/wiki/Wreck-It_Ralph) 里 "I'm gonna wreck it!" 的执着）。

### 0.3 triggerTurn 是什么？

pi-coding-agent 的 `sendMessage` 方法支持 `triggerTurn: true`：

```typescript
pi.sendMessage(message, { triggerTurn: true })
```

普通 sendMessage 只是把消息加到历史，不触发新一轮。

`triggerTurn: true` 让消息触发 LLM 新一轮生成（类似用户发了新消息）。

### 0.4 错误退避

如果 agent_end 是因为 LLM 错误（rate limit / 网络问题），不应立刻重试，要等一会。

```
agent_end (error) → 等 1s → 续跑
agent_end (error) → 等 2s → 续跑
agent_end (error) → 等 4s → 续跑
... 最多 10 次
```

指数退避防止刷错。

---

## 第一步：实现 ralph-loop

### 1.1 创建 packages/core/src/solver/extension/challenge-observer/ralph-loop.ts

新建 `packages/core/src/solver/extension/challenge-observer/ralph-loop.ts`：

```typescript
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent"
import { CHALLENGE_ENV_CHALLENGE_ID } from "../../../challenge/env"
import { requestHostBridge } from "../../../challenge/host-bridge-client"

/** 连续 agent_end 失败的最大重试次数 */
const MAX_CHALLENGE_RETRY_ATTEMPTS = 10

/** 续跑注入给 Solver 的提示语 */
const CHALLENGE_CONTINUATION_MESSAGE =
    "继续当前任务。不要重复已经完成的步骤，基于现有上下文继续推进；如果题目有多个 flag，不要因为提交对一个就停止，直到比赛 API 明确显示题目完成。"

/** 自定义消息类型标识（前端 / 日志识别用） */
const CHALLENGE_CUSTOM_MESSAGE_TYPE = "challenge-continuation"

/** 退避基数（毫秒） */
const BASE_CHALLENGE_DELAY_MS = 1000
/** 退避上限 */
const MAX_CHALLENGE_DELAY_MS = 10_000

/**
 * 当前 Solver 是否运行在 challenge 模式。
 *
 * 由环境变量 TCH_CHALLENGE_ID 标记。
 * Ralph Loop 只在 challenge 模式启用。
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
 * 从 agent_end 的消息里提取最后的 assistant 错误信息。
 *
 * 用 `readonly unknown[]` + 内部防御性 cast，而不是直接导入 `AgentMessage`
 * （`@mariozechner/pi-agent-core` 是 `pi-coding-agent` 的传递依赖，
 * 在 `@my/core` 里作为顶层 import 解析不到）。这与 observer-loop/observer-agent
 * 里 `event.message as { role?, content? }` 的防御性写法一致。
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
 * 指数退避：第 n 次失败后等待 BASE * 2^(n-1) ms，最多 MAX。
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
 * 任何错误都视为"未完成"——保证续跑机制不会误判提前结束。
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
 * "Ralph Loop" 强制续跑机制。
 *
 * 监听 agent_end 事件：
 *   1. challenge 已完成（host bridge 确认）→ 真正退出。
 *   2. 上一轮以 error 结束 → 累计错误次数，超过上限放弃；否则指数退避后继续。
 *   3. 否则立即注入 challenge-continuation 消息并 triggerTurn，重启一轮。
 *
 * @param pi pi-coding-agent 的 ExtensionAPI
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

        // 3. 注入续跑消息
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
```

### 1.2 关键设计点

#### setImmediate 的作用

```typescript
setImmediate(() => {
    pi.sendMessage(...)
})
```

把消息注入推到下一轮事件循环，**避免在 agent_end 回调内同步触发新 turn**。如果在回调内同步调 sendMessage(triggerTurn)，SDK 可能还没完全结束当前 turn，会出问题。

#### 退避公式

```typescript
function getChallengeDelayMs(attempt: number): number {
    return Math.min(BASE_CHALLENGE_DELAY_MS * 2 ** Math.max(attempt - 1, 0), MAX_CHALLENGE_DELAY_MS)
}
```

- attempt=1: 1000ms
- attempt=2: 2000ms
- attempt=3: 4000ms
- attempt=4: 8000ms
- attempt=5+: 10000ms（封顶）

#### `display: false`

注入的续跑消息设 `display: false`，前端不显示这条"系统消息"（避免噪音）。

---

## 第二步：在 createSolverSession 装配 ralph-loop

### 2.1 修改 packages/core/src/solver/session.ts

```typescript
// 顶部 import 换成统一入口（封装了 observer loop + ralph loop 两段 factory）
import { challengeObserverExtension } from "./extension/challenge-observer/index"

// 在 createSolverSession 里：
// challengeObserverExtension 根据是否 challenge 模式（isChallengeMode）
// 决定挂几段 factory：observer loop 始终挂，ralph loop 仅 challenge 模式挂。
// observerModel 从 init 线程传入（session.ts 看不到 prompt.meta，
// 这是 lesson 18 已确立的边界）。
const { factories } = challengeObserverExtension({ observerModel: init.observerModel })

// ⚠️ 关键：把 factories 传给 resolvePromptSession
// （SDK 规定 extensions 通过 DefaultResourceLoader 注入，不直接传给 createAgentSession）
const sessionOpts = await config.resolvePromptSession(init.promptName, factories, workspaceDir)
if (!sessionOpts) throw new Error(`prompt not found or disabled: ${init.promptName}`)

const { session } = await createAgentSession({
    ...sessionOpts,
    customTools: [...(sessionOpts.customTools ?? []), ...createObserverSidecarTools()],
    sessionManager: SessionManager.create(workspaceDir, sessionDir),
})
// bindExtensions 时 SDK 依次调各 factory(pi)，hook 才真正挂上
await session.bindExtensions({})
```

> 💡 **为什么这么设计**：
> SDK 把 extensions 当"资源"管理（像 prompt/skill 一样），统一从 ResourceLoader 注入。
> `session.bindExtensions({})` 才真正触发 factory 注册——这一步是异步的，让 SDK 先完成 session 初始化再挂 hook。

---

## 第三步：在 system prompt 加契约说明

让 solver 知道"会被强制续跑"，避免它困惑。

### 3.1 创建 challenge-observer/index.ts

新建 `packages/core/src/solver/extension/challenge-observer/index.ts`：

```typescript
import type { ExtensionFactory } from "@mariozechner/pi-coding-agent"
import { attachObserverLoop } from "./observer-loop"
import { attachChallengeContinuation, isChallengeMode } from "./ralph-loop"

// 统一再导出，供 config/session 等装配方判断 challenge 模式。
export { isChallengeMode }

/**
 * 注入到 Solver system prompt 的 challenge 契约说明。
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
 * challenge-observer 扩展统一入口：把两段扩展装配打包在一起。
 *   - observer loop（始终挂：周期 / hint / agent_end 触发策略板 review）
 *   - ralph loop（仅 challenge 模式挂：强制续跑）
 */
export function challengeObserverExtension(options: {
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
```

### 3.2 在 resolvePromptSession 加 appendSystemPrompt

修改 `packages/core/src/config/index.ts`：

```typescript
// 顶部 import（isChallengeMode 由 challenge-observer/index 再导出）
import {
    buildChallengeExtensionAppendPrompt,
    isChallengeMode,
} from "../solver/extension/challenge-observer/index"

// 在 resolvePromptSession 里，组装 systemPromptOverride 时：
// （注意：config → solver 是一条新的 import 边，与既有的 solver → config 形成环。
//  安全：两个函数都只在 resolvePromptSession 运行时调用，模块加载期不访问。）
const challengeAppend = isChallengeMode() ? buildChallengeExtensionAppendPrompt() : ""

const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir: this.dir,
    systemPromptOverride: () =>
        challengeAppend ? `${prompt.content}\n\n${challengeAppend}` : prompt.content,
    extensionFactories: extensions,
})
await resourceLoader.reload()
```

---

## 第四步：验证

### 4.1 准备 challenge

```bash
# 确保 mock 模式开启
bun run apps/cli/src/main.ts settings set challenge.mockEnabled true

# 创建一道 3 个 flag 的题
bun run apps/cli/src/main.ts challenge create \
  --id test-multi \
  --title "Multi Flag" \
  --flag-count 3 \
  --total-score 300

# 加 flags
cat ~/.tinyfat/challenge/test-multi/challenge.json | \
  jq '. + {flags: ["flag{1}", "flag{2}", "flag{3}"]}' > /tmp/c.json && \
  mv /tmp/c.json ~/.tinyfat/challenge/test-multi/challenge.json

# 启动实例
bun run apps/cli/src/main.ts challenge start test-multi 2>/dev/null || true
```

### 4.2 跑 solver 看强制续跑

```bash
bun run apps/cli/src/main.ts runtime launch \
  --prompt SOLVER \
  -e TCH_CHALLENGE_ID=test-multi \
  "随便看看"
```

**预期**：

```
[session] ralph loop attached
[session] observer extension attached
[start] task: 随便看看

[assistant] 好的，我看看 /tmp...
[tool_call] bash({command: "ls /tmp"})
[tool_result] ...
[assistant] 没什么特别的。我做完了。
[agent_end] stopReason=end_turn
[ralph] challenge not completed, continuing...
[injected] 继续当前任务...
[assistant] 哦，让我再仔细看看。
...
```

### 4.3 测退避重试

让 LLM 故意出错（比如断网），看 ralph 退避。

> 简化测试：模拟 error stopReason 不容易，可以跳过。

### 4.4 看落盘的 ralph 痕迹

```bash
ls ~/.tinyfat/solvers/<id>/session/
# 多个 .jsonl 文件

# 看消息历史，应该看到 customType=challenge-continuation 的消息
grep "challenge-continuation" ~/.tinyfat/solvers/<id>/session/*.jsonl | head -3
```

### 4.5 类型检查

```bash
bun run typecheck
```

---

## 第五步：故障排查

### 问题 1：续跑消息没注入

**原因**：可能 `isChallengeMode()` 返回 false。

**解决**：检查环境变量 `TCH_CHALLENGE_ID` 是否注入容器。

### 问题 2：无限续跑

**原因**：`isChallengeCompletedByHostBridge` 永远返回 false。

**解决**：检查 challenge 是否真的能完成（mock 模式下要有 flags 字段）。

### 问题 3：错误计数不重置

**原因**：可能正常结束时没清零。

**解决**：检查代码里 `consecutiveErrors = 0` 是否在非 error 分支。

### 问题 4：续跑消息显示在前端

**原因**：`display: false` 没设。

**解决**：检查 `pi.sendMessage` 的第一个参数有没有 `display: false`。

---

## 本课小结

✅ **你已完成**：

- 实现 ralph-loop（强制续跑）
- 用 host bridge 查询完成状态
- 指数退避错误重试
- 在 system prompt 加契约说明

📦 **新增文件**：

```
packages/core/src/solver/extension/challenge-observer/
├── ralph-loop.ts          ← 强制续跑（agent_end hook + 退避 + 注入续跑消息）
├── ralph-loop.test.ts     ← 14 个单测（纯函数 + fake pi 全分支）
└── index.ts               ← 统一入口 challengeObserverExtension（打包 observer + ralph）+ systemPrompt 契约
```

🔑 **关键概念**：

- **结束条件外置**：系统而非模型判断完成。
- **triggerTurn**：让消息触发新一轮生成。
- **指数退避**：防错误刷屏。
- **display: false**：注入消息不显示在前端。

---

## 下一课预告

[课时 20：协作广播 + Attack Timeline](./20-collaboration.md)（待生成）—— 阶段 4 收尾，让 solver 之间互通有无。

继续课时 20 →
