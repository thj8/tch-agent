# 课时 14：Planner LLM 调度循环

> 🎯 **目标**：实现 README 说的"Manager 负责全局编排"——Planner LLM 每 30s 跑一次，通过工具调度 solver。
>
> ⏰ ⏰ **预计耗时**：3-4 小时
>
> 📋 **难度**：⭐⭐⭐⭐⭐（本阶段最重要）

---

## 你将学到什么

1. **LLM-as-orchestrator 模式**（让 LLM 调度而不是写规则）
2. **工具 schema 的安全设计**（用 Literal 限制参数）
3. **launchSolver 完整流程**（Manager → Runtime）
4. **循环 + 锁**（防并发跑多个 Planner）

## 前置条件

✅ 已完成 [课时 1-13](./README.md)

## 最终效果

```bash
tinyfat challenge start-loop
# → Planner 每 30s 跑一次
# → 看到 LLM 输出"我应该起 solver 解 test-1"
# → LLM 调 planner_launch_solver
# → 容器启动，开始解题
```

---

## 第零步：概念扫盲

### 0.1 为什么要 LLM 当编排者？

传统做法：写规则代码决定"什么时候起 solver"。

```typescript
// 传统做法
if (unsolvedChallenges > 0 && activeSolvers < 7) {
    if (memory.usage > 0.8) {
        launchSolver(cheapestModel)
    } else {
        launchSolver(bestModel)
    }
}
```

问题：规则越来越多，维护噩梦；新场景无法适应。

**LLM-as-orchestrator**：把决策交给 LLM。

```typescript
// 给 LLM 一个 snapshot
const snapshot = { unsolvedChallenges, activeSolvers, availableModels, ... }

// 让 LLM 通过工具调用做决策
const result = await plannerSession.prompt(`
  当前状态：${JSON.stringify(snapshot)}
  请决定下一步动作。
`)
// LLM 输出 tool_call: planner_launch_solver(...)
```

LLM 能理解复杂场景、自适应，不用维护规则。

### 0.2 工具 schema 的安全设计

LLM 可能输出无效参数：

```typescript
planner_launch_solver({ challengeId: "nonexistent-id" })
```

防御：用 `Type.Union` + `Type.Literal` 把参数限制为枚举：

```typescript
parameters: Type.Object({
    challengeId: Type.Union([
        Type.Literal("test-1"),
        Type.Literal("test-2"),
    ]),
})
```

LLM 只能从 snapshot 里实际存在的 ID 里选。

### 0.3 Planner 流程

```
每 30s:
   1. buildPlannerSnapshot()       拍快照（题、solver、可用 prompt）
   2. createAgentSession(planner)  用 Planner prompt 装配
   3. session.prompt("开始调度")    LLM 决策
   4. LLM 输出 tool_call            → 触发 planner_launch_solver 等
   5. session.dispose()             销毁（一次性）
```

---

## 第一步：在 ChallengeManager 加 launchSolver

修改 `packages/core/src/challenge/manager.ts`，在 ChallengeManager 类里加：

```typescript
// 顶部加 import
import { defineTool, Type } from "@mariozechner/pi-coding-agent"
import type { SolverInstance } from "../runtime/types"

/**
 * 启动一个 Solver 处理指定 challenge。
 *
 * 流程：
 *   1. 校验 prompt + challenge
 *   2. 若实例未起，先 startChallenge 占槽位
 *   3. 生成 solverId + 装配 task
 *   4. runtime.launch 拉起容器（注入 TCH_CHALLENGE_ID）
 *   5. appendAttemptLog 记录
 */
async launchSolver(
    challengeId: string,
    promptName: string,
    options: { plannerHandoff?: string } = {},
): Promise<SolverInstance> {
    if (!this.runtime) throw new Error("runtime not attached")

    // 校验
    const prompt = await this.config.getPrompt(promptName)
    if (!prompt) throw new Error(`prompt not found: ${promptName}`)
    if (prompt.meta.disabled) throw new Error(`prompt disabled: ${promptName}`)

    const challenge = await this.getChallenge(challengeId)
    if (!challenge) throw new Error(`challenge not found: ${challengeId}`)
    if (computeChallengeCompleted(challenge)) {
        throw new Error(`challenge already completed: ${challengeId}`)
    }

    // 确保实例在跑
    if (challenge.instance_status !== "running") {
        await this.startChallenge(challengeId)
    }

    // 生成 solverId + task
    const solverId = crypto.randomUUID().slice(0, 8)
    const task = await this.buildSolverTask(challenge, options.plannerHandoff)

    // 拉起容器
    const solver = await this.runtime.launch(promptName, task, {
        TCH_CHALLENGE_ID: challengeId,
    })

    // 记录启动日志
    await this.appendAttemptLog({
        challengeId,
        solverId: solver.id,
        promptName,
        task,
    })

    console.log(`[challenge] launched solver ${solver.id} for ${challengeId}`)
    return solver
}

/**
 * 装配 solver 的初始 task 文本。
 */
private async buildSolverTask(
    challenge: ChallengeInfoRecord,
    plannerHandoff?: string,
): Promise<string> {
    const parts: string[] = []
    parts.push(`# Challenge: ${challenge.title}`)
    parts.push(`- id: ${challenge.id}`)
    parts.push(`- difficulty: ${challenge.difficulty}`)
    parts.push(`- level: ${challenge.level}`)
    parts.push(`- flags: ${challenge.flag_got_count}/${challenge.flag_count}`)
    parts.push(`- score: ${challenge.total_got_score}/${challenge.total_score}`)
    if (challenge.entrypoint && challenge.entrypoint.length > 0) {
        parts.push(`- entrypoint: ${challenge.entrypoint.join(", ")}`)
    }
    if (challenge.hint_content) {
        parts.push(`\n## Hint\n${challenge.hint_content}`)
    }
    if (plannerHandoff) {
        parts.push(`\n## Strategy\n${plannerHandoff}`)
    }
    parts.push(`\n## Your Goal\nSolve this challenge and submit all flags using challenge_submit_flag.`)
    return parts.join("\n")
}
```

---

## 第二步：实现 Planner 循环

### 2.1 在 ChallengeManager 加 Planner 字段和方法

继续在 ChallengeManager 类里加：

```typescript
// 类顶部加字段：
private syncTimer: ReturnType<typeof setTimeout> | undefined
private syncLoopStarted = false
private plannerRunning = false

/** 默认 30s tick */
private static readonly DEFAULT_TICK_INTERVAL_MS = 30_000

/**
 * 启动 Planner 调度循环。整个进程只调一次。
 */
startSyncLoop(): void {
    if (this.syncLoopStarted) return
    this.syncLoopStarted = true
    console.log(`[planner] sync loop started (interval=${ChallengeManager.DEFAULT_TICK_INTERVAL_MS}ms)`)

    const tick = async () => {
        try {
            await this.tickPlanner("challenge-planner:loop")
        } catch (error) {
            console.error("[planner] tick failed:", error)
        } finally {
            this.syncTimer = setTimeout(tick, ChallengeManager.DEFAULT_TICK_INTERVAL_MS)
        }
    }
    void tick()
}

/** 停止循环 */
stopSyncLoop(): void {
    if (this.syncTimer) clearTimeout(this.syncTimer)
    this.syncTimer = undefined
    this.syncLoopStarted = false
}

/**
 * 触发一次 Planner 调度。
 *
 * 用 plannerRunning 锁防并发。
 */
async tickPlanner(source = "manual"): Promise<string | undefined> {
    if (this.plannerRunning) {
        console.log("[planner] already running, skipping")
        return
    }
    this.plannerRunning = true
    try {
        return await this.runPlannerOnce(source)
    } catch (error) {
        console.error("[planner] tick failed:", error)
        return
    } finally {
        this.plannerRunning = false
    }
}

/**
 * 跑一次 Planner LLM。
 *
 * 流程：
 *   1. resolvePromptSession(CHALLENGE_PLANNER)
 *   2. buildPlannerSnapshot 拍快照
 *   3. createPlannerTools 注册调度工具
 *   4. createAgentSession + session.prompt("开始本轮比赛调度")
 *   5. LLM 输出 tool_call → 触发 launchSolver 等
 */
private async runPlannerOnce(source: string): Promise<string | undefined> {
    if (!this.runtime) {
        console.log("[planner] runtime not attached, skipping")
        return
    }

    // 检查 CHALLENGE_PLANNER prompt 是否存在
    const plannerPromptName = "CHALLENGE_PLANNER"
    const sessionOpts = await this.config.resolvePromptSession(plannerPromptName)
    if (!sessionOpts?.resourceLoader) {
        console.log(`[planner] prompt "${plannerPromptName}" not found, skipping`)
        return
    }

    // 拍 snapshot
    const snapshot = await this.buildPlannerSnapshot(source)
    if (snapshot.challenges.length === 0) {
        console.log("[planner] no challenges to schedule")
        return
    }

    // 注入 snapshot 到 systemPrompt
    const resourceLoader = sessionOpts.resourceLoader
    const originalReload = resourceLoader.reload.bind(resourceLoader)
    const snapshotText = formatPlannerSnapshot(snapshot)
    // 简化：直接覆盖 systemPrompt
    ;(resourceLoader as { systemPromptOverride?: () => string }).systemPromptOverride = () =>
        `${plannerPromptName}\n\n## Current Snapshot\n${snapshotText}`
    await resourceLoader.reload()

    // 注册 planner 工具
    const plannerTools = this.createPlannerTools(snapshot)
    const { createAgentSession, SessionManager } = await import("@mariozechner/pi-coding-agent")

    const { session } = await createAgentSession({
        ...sessionOpts,
        resourceLoader,
        customTools: [...(sessionOpts.customTools ?? []), ...plannerTools],
        sessionManager: SessionManager.inMemory(),  // 一次性
    })

    let plannerOutput = ""
    session.subscribe((event) => {
        if (event.type === "message_end" && event.message?.role === "assistant") {
            const content = event.message.content
            if (Array.isArray(content)) {
                plannerOutput = content
                    .filter((c): c is { type: "text"; text: string } => c.type === "text")
                    .map((c) => c.text)
                    .join("")
            }
        }
        if (event.type === "tool_execution_end" && event.isError) {
            console.error(`[planner] tool ${event.toolName} failed:`, event.result)
        }
    })

    console.log(`\n========== planner round (source=${source}) ==========`)
    await session.prompt("开始本轮比赛调度。")
    session.dispose()
    console.log(`========== end planner round ==========\n`)

    return plannerOutput
}

/**
 * 拍 Planner snapshot。
 */
private async buildPlannerSnapshot(source: string): Promise<{
    source: string
    timestamp: string
    challenges: ChallengeInfoRecord[]
    activeSolvers: SolverInstance[]
    availablePrompts: string[]
}> {
    const { listChallengeRecords } = await import("./store")
    const rootDir = await this.getRootDir()
    const all = await listChallengeRecords(rootDir)
    // 只看未完成的
    const unsolved = all.filter((c) => !computeChallengeCompleted(c))

    const activeSolvers = this.runtime?.list() ?? []
    const prompts = await this.config.listAgentPrompts()
    const availablePromptNames = prompts.map((p) => p.name)

    return {
        source,
        timestamp: new Date().toISOString(),
        challenges: unsolved,
        activeSolvers,
        availablePrompts: availablePromptNames,
    }
}

/**
 * 创建 Planner 工具集。
 */
private createPlannerTools(snapshot: {
    challenges: ChallengeInfoRecord[]
    activeSolvers: SolverInstance[]
    availablePrompts: string[]
}): ToolDefinition[] {
    const challengeIds = snapshot.challenges.map((c) => c.id)
    const promptNames = snapshot.availablePrompts
    const activeSolverIds = snapshot.activeSolvers.map((s) => s.id)

    const challengeIdSchema =
        challengeIds.length > 0
            ? Type.Union(challengeIds.map((id) => Type.Literal(id)))
            : Type.String({ description: "challenge id" })

    const promptNameSchema =
        promptNames.length > 0
            ? Type.Union(promptNames.map((name) => Type.Literal(name)))
            : Type.String({ description: "prompt name" })

    const solverIdSchema =
        activeSolverIds.length > 0
            ? Type.Union(activeSolverIds.map((id) => Type.Literal(id)))
            : Type.String({ description: "solver id" })

    return [
        defineTool({
            name: "planner_get_state",
            label: "Get State",
            description: "Get current planner snapshot",
            parameters: Type.Object({}),
            execute: async () => {
                const fresh = await this.buildPlannerSnapshot("tool-state")
                return {
                    content: [{ type: "text", text: formatPlannerSnapshot(fresh) }],
                }
            },
        }),

        defineTool({
            name: "planner_start_challenge",
            label: "Start Challenge",
            description: "Start a challenge instance",
            parameters: Type.Object({ challengeId: challengeIdSchema }),
            execute: async (_id, params: { challengeId: string }) => {
                const result = await this.startChallenge(params.challengeId)
                return {
                    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
                }
            },
        }),

        defineTool({
            name: "planner_stop_challenge",
            label: "Stop Challenge",
            description: "Stop a challenge instance",
            parameters: Type.Object({ challengeId: challengeIdSchema }),
            execute: async (_id, params: { challengeId: string }) => {
                const result = await this.stopChallenge(params.challengeId)
                return {
                    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
                }
            },
        }),

        defineTool({
            name: "planner_launch_solver",
            label: "Launch Solver",
            description:
                "Launch a solver for a challenge. solverHandoff is a brief strategy note for the solver.",
            parameters: Type.Object({
                challengeId: challengeIdSchema,
                promptName: promptNameSchema,
                solverHandoff: Type.String({
                    minLength: 1,
                    maxLength: 1200,
                    description: "Strategy note for the solver",
                }),
            }),
            execute: async (_id, params: {
                challengeId: string
                promptName: string
                solverHandoff: string
            }) => {
                try {
                    const solver = await this.launchSolver(params.challengeId, params.promptName, {
                        plannerHandoff: params.solverHandoff,
                    })
                    return {
                        content: [{ type: "text", text: `Launched solver ${solver.id} for ${params.challengeId}` }],
                    }
                } catch (error) {
                    return {
                        content: [
                            {
                                type: "text",
                                text: `Launch failed: ${error instanceof Error ? error.message : String(error)}`,
                            },
                        ],
                    }
                }
            },
        }),

        defineTool({
            name: "planner_stop_solver",
            label: "Stop Solver",
            description: "Stop a running solver",
            parameters: Type.Object({ solverId: solverIdSchema }),
            execute: async (_id, params: { solverId: string }) => {
                if (!this.runtime) throw new Error("runtime not attached")
                await this.runtime.stopSolver(params.solverId)
                return {
                    content: [{ type: "text", text: `Stopped solver ${params.solverId}` }],
                }
            },
        }),
    ]
}
```

### 2.2 工具函数

在 manager.ts 末尾加：

```typescript
function formatPlannerSnapshot(snapshot: {
    source: string
    timestamp: string
    challenges: ChallengeInfoRecord[]
    activeSolvers: SolverInstance[]
    availablePrompts: string[]
}): string {
    const parts: string[] = []
    parts.push(`# Snapshot (${snapshot.timestamp})`)
    parts.push(`Source: ${snapshot.source}`)
    parts.push("")
    parts.push(`## Active Solvers (${snapshot.activeSolvers.length})`)
    for (const s of snapshot.activeSolvers) {
        parts.push(`- ${s.id} (${s.status}, prompt=${s.promptName}, challenge=${s.challengeId ?? "-"})`)
    }
    parts.push("")
    parts.push(`## Available Prompts`)
    for (const p of snapshot.availablePrompts) {
        parts.push(`- ${p}`)
    }
    parts.push("")
    parts.push(`## Unsolved Challenges (${snapshot.challenges.length})`)
    for (const c of snapshot.challenges) {
        parts.push(
            `- ${c.id} (${c.difficulty}, flags=${c.flag_got_count}/${c.flag_count}, status=${c.instance_status})`,
        )
    }
    return parts.join("\n")
}
```

### 2.3 在文件顶部加 import

```typescript
import type { ToolDefinition } from "@mariozechner/pi-coding-agent"
```

---

## 第三步：创建 CHALLENGE_PLANNER prompt

新建 `~/.tinyfat/config/prompts/CHALLENGE_PLANNER.md`：

```markdown
---
description: Planner agent that schedules solvers for challenges
tools:
  - planner_get_state
  - planner_start_challenge
  - planner_stop_challenge
  - planner_launch_solver
  - planner_stop_solver
---

You are the Planner for a CTF/pentest multi-agent system.

# Your Role

You decide which solvers to launch, which challenges to start, and which to stop.
You DO NOT solve challenges yourself. You ORCHESTRATE.

# Strategy

Each round:

1. Call `planner_get_state` to see the current snapshot.
2. Decide what to do based on:
   - How many unsolved challenges remain?
   - How many solver slots are free (max 7)?
   - Are any solvers stale or stuck?
   - Which challenges have hints we haven't used?
3. Take 1-3 actions (launch/stop), then end your turn.

# Rules

- Launch at most 1-2 solvers per round (avoid overwhelming resources).
- Each solver needs a `solverHandoff` (1-2 sentences of strategy).
- Don't launch a solver for a challenge that's already completed.
- Stop solvers that are stuck or no longer needed.

Be concise. Don't repeat the snapshot back—just take actions.
```

---

## 第四步：CLI 命令

`DaemonManager` 已经在 lesson 13 顶部 import 过了，直接用：

```typescript
challengeCmd
    .command("start-loop")
    .description("Start the planner sync loop")
    .action(async () => {
        const daemon = await DaemonManager.getInstance()
        daemon.challenge.startSyncLoop()
        console.log("Planner loop started. Press Ctrl+C to stop.")
        await new Promise(() => {})
    })

challengeCmd
    .command("tick")
    .description("Run one planner tick manually")
    .action(async () => {
        const daemon = await DaemonManager.getInstance()
        await daemon.challenge.tickPlanner("manual")
    })
```

---

## 第五步：验证

### 5.1 准备

- mock 模式开启
- 创建 1-2 道题（含 flags）
- CHALLENGE_PLANNER prompt 已创建
- 一个可用的 model pref（设为 CHALLENGE_PLANNER 的 model）

### 5.2 手动 tick

```bash
bun run apps/cli/src/main.ts challenge tick
```

**预期**：

```
========== planner round (source=manual) ==========
[challenge] launched solver abc12345 for test-1
========== end planner round ==========
```

### 5.3 启动循环

```bash
bun run apps/cli/src/main.ts challenge start-loop
```

**预期**：每 30s 跑一次，自动起 solver 解题。

### 5.4 类型检查

```bash
bun run typecheck
```

---

## 第六步：故障排查

### 问题 1：LLM 不调工具，只输出文本

**原因**：可能是 model 不支持 tool calling，或 prompt 没说清楚。

**解决**：
- 换支持 tool 的 model（gpt-4o-mini / claude-sonnet / glm-4 都支持）
- 在 prompt 里强化："You MUST use tools."

### 问题 2：`prompt "CHALLENGE_PLANNER" not found`

**原因**：prompt 文件没创建。

**解决**：按第三步创建 prompt 文件。

### 问题 3：launchSolver 报 "challenge not found"

**原因**：snapshot 里没有题目。

**解决**：先 `challenge create` 几道题。

### 问题 4：`plannerRunning` 锁卡住

**原因**：上次 LLM 调用异常，锁没释放。

**解决**：try/finally 已经处理了；如果还卡住，重启进程。

---

## 本课小结

✅ **你已完成**：

- 实现 launchSolver（Manager → Runtime）
- 实现 Planner 30s 循环
- 实现 5 个 planner_* 工具
- 用 LLM 调度 solver（LLM-as-orchestrator）

📦 **新增文件**：

```
~/.tinyfat/config/prompts/CHALLENGE_PLANNER.md
```

🔑 **关键概念**：

- **LLM-as-orchestrator**：让 LLM 而不是规则代码做决策。
- **工具 schema 安全**：用 Literal 限制参数为枚举。
- **plannerRunning 锁**：防并发跑多个 Planner。

---

## 下一课预告

[课时 15：SSE 实时推送](./15-sse-push.md)（待生成）—— 阶段 3 收尾，让 web UI 实时看 solver 事件。

继续课时 15 →
