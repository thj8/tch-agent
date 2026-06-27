# 课时 20：协作广播 + Attack Timeline

> 🎯 **目标**：完成"多 agent 协作"——让 solver 之间互通有无（hint、flag、思路板），并加 attack timeline 可视化。
>
> ⏰ **预计耗时**：3-4 小时
>
> 📋 **难度**：⭐⭐⭐⭐

---

## 你将学到什么

1. **协作广播模式**（多 solver 同步信息）
2. **steer vs follow_up**（两种消息优先级）
3. **时间线聚合**（多源数据 → 单一视图）
4. **项目最终架构回顾**

## 前置条件

✅ 已完成 [课时 1-19](./README.md)

## 最终效果

solver A 拿到 flag → 同题目其他 solver B/C 自动收到"flag 已拿到，转剩余"广播：

```
[solver A] challenge_submit_flag("flag{1}") → correct
[host] broadcasting to solvers on test-multi (excluding A)...
[solver B] [steer] 协作同步：同题已有 solver 提交正确 flag flag{1}...
[solver B] [assistant] 好，我转向剩余 flag。
```

浏览器 attack timeline 可视化：
- 每个 solver 一行
- 按 timestamp 排列的事件点（启动 / 工具调用 / flag 提交）

---

## 第零步：概念扫盲

### 0.1 多 solver 协作

一道题可以并行挂多个 solver（不同模型 / prompt）。如果它们之间不通信：
- A 找到 flag1 → B 也在挖 flag1（浪费）
- A 拿到 hint → B 不知道

**协作广播**：solver A 的关键事件自动推给同题目其他 solver。

### 0.2 广播时机

| 事件 | 广播内容 |
|---|---|
| challenge_get_hint 成功 | hint 内容 + "立即吸收" |
| challenge_submit_flag correct | flag + 思路板摘要 + "转向剩余" |
| challenge 完成 | "题目完成，停止" |

### 0.3 steer vs follow_up

SDK 的两种"投递消息"方式：

| 类型 | 优先级 | 用途 |
|---|---|---|
| `follow_up` | 普通 | 追加信息（不打断当前思考） |
| `steer` | 高 | 系统转向（高优先级，立即影响下一轮） |

hint / flag-correct 用 `steer`（让 solver 立刻注意到）。

---

## 第一步：在 host-bridge-handler 加广播逻辑

### 1.1 修改 packages/core/src/challenge/host-bridge-handler.ts

```typescript
// 顶部加 imports
import type { RuntimeManager } from "../runtime/runtime"
import type { ChallengeManager } from "./manager"

/** 广播选项 */
interface BroadcastOptions {
    /** 排除某个 solver（通常是事件发起者） */
    excludeSolverId?: string
    /** 投递级别：steer（高优先级）或 follow_up（普通） */
    delivery?: "steer" | "follow_up"
}

/**
 * 把 hint 包装成 steer 消息发给 solver。
 */
function sendHintToSolver(
    runtime: RuntimeManager,
    solverId: string,
    hintContent: string,
): void {
    const message = hintContent.trim()
    if (!message) return
    runtime.sendCommand(solverId, {
        type: "steer",
        message: `系统同步：赛题 hint 已更新。\n- 立即吸收 hint，刷新 memory/idea。\n- hint:\n${message}`,
    })
}

/**
 * 广播给同题目的所有活跃 solver。
 */
function broadcastToChallengeSolvers(
    runtime: RuntimeManager,
    challengeId: string,
    message: string,
    options: BroadcastOptions = {},
): void {
    const text = message.trim()
    if (!text) return

    for (const solver of runtime.list()) {
        if (solver.challengeId !== challengeId) continue
        if (solver.status !== "running") continue
        if (options.excludeSolverId && solver.id === options.excludeSolverId) continue

        try {
            if (options.delivery === "steer") {
                runtime.sendCommand(solverId, { type: "steer", message: text })
            } else {
                runtime.sendCommand(solverId, { type: "follow_up", message: text })
            }
        } catch (error) {
            console.error(`[broadcast] failed for ${solver.id}:`, error)
        }
    }
}

/**
 * 构造"flag 已拿到"的广播消息。
 */
function formatFlagSolvedBroadcastMessage(input: {
    flag: string
    gotCount?: number
    flagCount?: number
    isCompleted: boolean
}): string {
    const progress =
        typeof input.gotCount === "number" && typeof input.flagCount === "number"
            ? `${input.gotCount}/${input.flagCount}`
            : "-"
    const remaining =
        typeof input.gotCount === "number" && typeof input.flagCount === "number"
            ? Math.max(input.flagCount - input.gotCount, 0)
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
```

### 1.2 扩展 createBuiltinHostBridgeHandler

修改原有的内置 handler，让它接收 `runtime` 和 `challengeManager`：

```typescript
export function createBuiltinHostBridgeHandler(
    options: {
        getSolverEnvValue?: (solverId: string, key: string) => string | undefined
        hasApiKey?: (provider: string) => boolean
        // 新增：
        runtime?: RuntimeManager
        challengeManager?: ChallengeManager
    } = {},
): HostBridgeHandler {
    return {
        async handle(ctx: HostBridgeHandleContext): Promise<HostBridgeHandleResult> {
            // 已有的 ping / get_env / get_api_key ...

            // challenge 相关 action 转给 challengeManager
            if (ctx.action.startsWith("challenge_") && options.challengeManager) {
                return handleChallengeAction(options.challengeManager, options.runtime, ctx)
            }

            // ... 默认分支 ...
        },
    }
}

/**
 * 处理 challenge 相关的 host bridge 请求（含协作广播）。
 */
async function handleChallengeAction(
    challengeManager: ChallengeManager,
    runtime: RuntimeManager | undefined,
    ctx: HostBridgeHandleContext,
): Promise<HostBridgeHandleResult> {
    const challengeId = ctx.getSolverEnvValue?.("TCH_CHALLENGE_ID")
    if (!challengeId) return { handled: false }

    switch (ctx.action) {
        case "challenge_get_hint": {
            const result = await challengeManager.getHint(challengeId)
            // 广播 hint 给同题目其他 solver
            if (runtime && result.remote.hint_content) {
                for (const solver of runtime.list()) {
                    if (solver.challengeId !== challengeId) continue
                    if (solver.status !== "running") continue
                    if (solver.id === ctx.solverId) continue  // 排除发起者
                    sendHintToSolver(runtime, solver.id, result.remote.hint_content)
                }
            }
            return { handled: true, data: result.remote }
        }

        case "challenge_submit_flag": {
            const params = (ctx.params ?? {}) as { flag: string; writeup?: string }
            if (!params.flag) return { handled: true, data: { error: "flag required" } }

            const result = await challengeManager.submitFlag(challengeId, params.flag, {
                solverId: ctx.solverId,
                writeup: params.writeup,
            })

            // correct → 广播给其他 solver
            if (result.remote.correct && runtime) {
                const message = formatFlagSolvedBroadcastMessage({
                    flag: params.flag,
                    gotCount: result.remote.flag_got_count,
                    flagCount: result.remote.flag_count,
                    isCompleted: result.is_completed,
                })
                broadcastToChallengeSolvers(runtime, challengeId, message, {
                    excludeSolverId: ctx.solverId,
                    delivery: "steer",
                })
            }

            return {
                handled: true,
                data: {
                    correct: result.remote.correct,
                    flag_got_count: result.remote.flag_got_count,
                    flag_count: result.remote.flag_count,
                    is_completed: result.is_completed,
                },
            }
        }

        // challenge_get_state / challenge_is_completed 已在课时 13 实现
    }

    return { handled: false }
}
```

### 1.3 在 DaemonManager 注入新参数

修改 `packages/core/src/index.ts`：

```typescript
static async getInstance(): Promise<DaemonManager> {
    // ...
    const created = (async () => {
        const config = await ConfigManager.getInstance()
        const challenge = new ChallengeManager(config)
        const runtime = new RuntimeManager(config, [
            // 先创建内置 handler，但 runtime 还没建好，怎么办？
            // 解法：用闭包延迟绑定
            createDeferredChallengeHandler(() => runtime, challenge),
        ])
        challenge.attachRuntime(runtime)
        await runtime.init()
        return new DaemonManager(config, challenge, runtime)
    })()
    // ...
}

/**
 * 延迟绑定 runtime 的 handler 工厂。
 * 解决循环依赖：runtime 构造时需要 handler，但 handler 需要 runtime。
 */
function createDeferredChallengeHandler(
    getRuntime: () => RuntimeManager,
    challengeManager: ChallengeManager,
): HostBridgeHandler {
    return {
        async handle(ctx) {
            const runtime = getRuntime()
            const builtin = createBuiltinHostBridgeHandler({
                runtime,
                challengeManager,
                getSolverEnvValue: (solverId, key) => {
                    // 通过 runtime 内部 map 查（需要 runtime 暴露这个能力）
                    return undefined
                },
                hasApiKey: (provider) => false,
            })
            return builtin.handle(ctx)
        },
    }
}
```

> 💡 **简化设计**：实际上 RuntimeManager 内部应该让 handler 能访问 solverEnvs。可以在 readStream 处理 host_bridge_request 时把 solverEnvs 注入 ctx。这部分留给读者完善。

---

## 第二步：实现 Attack Timeline（数据聚合）

### 2.1 创建 packages/core/src/challenge/attack-timeline.ts

```typescript
import { readdir, stat } from "node:fs/promises"
import { join, resolve } from "node:path"
import { SOLVERS_DIR, ARCHIVE_SOLVERS_DIR } from "../runtime/types"
import type { ChallengeAttemptLogRecord, ChallengeSubmissionLogRecord } from "./store"
import type { IdeaRecord, MemoryEntry } from "./memory"

/** 时间线事件类型 */
export type AttackTimelineEventKind =
    | "solver_started"
    | "solver_ended"
    | "message"
    | "tool_call"
    | "tool_result"
    | "memory_added"
    | "memory_updated"
    | "idea_added"
    | "idea_updated"
    | "flag_submitted"

/** 泳道分类 */
export type AttackTimelineLane = "challenge" | "solver" | "observer" | "board" | "submission"

/** 一条时间线事件 */
export interface AttackTimelineEvent {
    id: string
    timestamp: number
    challengeId: string
    solverId?: string
    lane: AttackTimelineLane
    kind: AttackTimelineEventKind
    title: string
    summary: string
    payload?: unknown
}

/** 一道题的时间线快照 */
export interface AttackTimelineSnapshot {
    challengeId: string
    updatedAt: string
    events: AttackTimelineEvent[]
}

/** 构造输入 */
export interface BuildAttackTimelineInput {
    challengeId: string
    attempts: ChallengeAttemptLogRecord[]
    submissions: ChallengeSubmissionLogRecord[]
    memory: MemoryEntry[]
    ideas: IdeaRecord[]
}

/** ISO → 时间戳 */
function parseTimestamp(value?: string): number | undefined {
    if (!value) return undefined
    const ts = Date.parse(value)
    return Number.isFinite(ts) ? ts : undefined
}

/** 路径是否存在 */
async function isDirectory(path: string): Promise<boolean> {
    try {
        return (await stat(path)).isDirectory()
    } catch {
        return false
    }
}

/** 找 solver session 目录（活跃 + 归档） */
async function resolveSolverSessionDir(solverId: string): Promise<string | undefined> {
    const active = join(SOLVERS_DIR, solverId, "session")
    if (await isDirectory(active)) return active
    const archived = join(ARCHIVE_SOLVERS_DIR, solverId, "session")
    if (await isDirectory(archived)) return archived
    return undefined
}

/**
 * 构造 challenge 的 attack timeline。
 *
 * 数据来源：
 *   - attempts（启动事件）
 *   - submissions（flag 提交事件）
 *   - memory（板变更事件）
 *   - ideas（板变更事件）
 */
export async function buildChallengeAttackTimeline(
    input: BuildAttackTimelineInput,
): Promise<AttackTimelineSnapshot> {
    const events: AttackTimelineEvent[] = []

    // 1. solver 启动事件
    for (const attempt of input.attempts) {
        const ts = parseTimestamp(attempt.created_at)
        if (!ts) continue
        events.push({
            id: `attempt-${attempt.id}`,
            timestamp: ts,
            challengeId: input.challengeId,
            solverId: attempt.solver_id,
            lane: "challenge",
            kind: "solver_started",
            title: `Solver ${attempt.solver_id} started`,
            summary: `prompt=${attempt.prompt_name}`,
            payload: attempt,
        })
    }

    // 2. flag 提交事件
    for (const sub of input.submissions) {
        const ts = parseTimestamp(sub.created_at)
        if (!ts) continue
        events.push({
            id: `submission-${sub.id}`,
            timestamp: ts,
            challengeId: input.challengeId,
            solverId: sub.solver_id,
            lane: "submission",
            kind: "flag_submitted",
            title: `${sub.correct ? "✓" : "✗"} ${sub.flag}`,
            summary: sub.correct ? "correct" : "incorrect",
            payload: sub,
        })
    }

    // 3. memory 变更事件
    for (const m of input.memory) {
        const ts = parseTimestamp(m.created_at)
        const tsUpdate = parseTimestamp(m.updated_at)
        if (ts) {
            events.push({
                id: `memory-added-${m.id}`,
                timestamp: ts,
                challengeId: input.challengeId,
                lane: "board",
                kind: "memory_added",
                title: `[${m.kind}] memory added`,
                summary: m.content.slice(0, 100),
                payload: m,
            })
        }
        if (tsUpdate && tsUpdate !== ts) {
            events.push({
                id: `memory-updated-${m.id}`,
                timestamp: tsUpdate,
                challengeId: input.challengeId,
                lane: "board",
                kind: "memory_updated",
                title: `[${m.kind}] memory updated`,
                summary: m.content.slice(0, 100),
                payload: m,
            })
        }
    }

    // 4. idea 变更事件
    for (const idea of input.ideas) {
        const ts = parseTimestamp(idea.created_at)
        const tsUpdate = parseTimestamp(idea.updated_at)
        if (ts) {
            events.push({
                id: `idea-added-${idea.id}`,
                timestamp: ts,
                challengeId: input.challengeId,
                lane: "board",
                kind: "idea_added",
                title: `[${idea.status}] idea added`,
                summary: idea.content.slice(0, 100),
                payload: idea,
            })
        }
        if (tsUpdate && tsUpdate !== ts) {
            events.push({
                id: `idea-updated-${idea.id}`,
                timestamp: tsUpdate,
                challengeId: input.challengeId,
                lane: "board",
                kind: "idea_updated",
                title: `[${idea.status}] idea updated`,
                summary: `${idea.content.slice(0, 60)} -> ${idea.result.slice(0, 60)}`,
                payload: idea,
            })
        }
    }

    // 按时间戳升序
    events.sort((a, b) => a.timestamp - b.timestamp)

    return {
        challengeId: input.challengeId,
        updatedAt: new Date().toISOString(),
        events,
    }
}
```

---

## 第三步：在 ChallengeManager 加 timeline 方法

```typescript
// 在 ChallengeManager 类里加：

async buildAttackTimeline(challengeId: string): Promise<AttackTimelineSnapshot> {
    const rootDir = await this.getRootDir()

    // 并行拉取所有数据
    const [memory, ideas, attempts, submissions] = await Promise.all([
        this.listMemory(challengeId),
        this.listIdeas(challengeId),
        this.listAttemptLogs(challengeId),
        this.listSubmissionLogs(challengeId),
    ])

    return buildChallengeAttackTimeline({
        challengeId,
        memory,
        ideas,
        attempts,
        submissions,
    })
}
```

### 3.1 加 import

```typescript
import { buildChallengeAttackTimeline, type AttackTimelineSnapshot } from "./attack-timeline"
```

---

## 第四步：Web API 暴露 timeline

修改 `packages/ui-web/src/server.ts`，加路由：

```typescript
"/api/runtime/challenges/:id/timeline": {
    GET: async (_req, params) => {
        const timeline = await daemon.challenge.buildAttackTimeline(params.id)
        return Response.json(timeline)
    },
},
```

### 4.1 前端时间线组件

在 `packages/ui-web/src/app.tsx` 加 TimelinePage：

```typescript
function ChallengeTimelinePage({ challengeId }: { challengeId: string }) {
    const [timeline, setTimeline] = useState<{ events: AttackTimelineEvent[] } | null>(null)

    useEffect(() => {
        async function load() {
            const res = await fetch(`/api/runtime/challenges/${challengeId}/timeline`)
            setTimeline(await res.json())
        }
        void load()
        const timer = setInterval(load, 3000)
        return () => clearInterval(timer)
    }, [challengeId])

    if (!timeline) return <div>Loading...</div>

    return (
        <div>
            <h2 className="text-2xl font-bold mb-4">Timeline: {challengeId}</h2>
            <div className="bg-white rounded shadow p-4">
                {timeline.events.length === 0 ? (
                    <div className="text-slate-500">No events yet</div>
                ) : (
                    timeline.events.map((e) => (
                        <div key={e.id} className="border-b py-2 flex gap-3">
                            <div className="text-slate-500 text-sm w-32">
                                {new Date(e.timestamp).toLocaleString()}
                            </div>
                            <div className="w-24">
                                <LaneBadge lane={e.lane} />
                            </div>
                            <div className="flex-1">
                                <div className="font-semibold">{e.title}</div>
                                <div className="text-sm text-slate-600">{e.summary}</div>
                            </div>
                        </div>
                    ))
                )}
            </div>
        </div>
    )
}

function LaneBadge({ lane }: { lane: string }) {
    const colors: Record<string, string> = {
        challenge: "bg-blue-100 text-blue-800",
        solver: "bg-green-100 text-green-800",
        observer: "bg-purple-100 text-purple-800",
        board: "bg-orange-100 text-orange-800",
        submission: "bg-red-100 text-red-800",
    }
    return (
        <span className={`px-2 py-1 rounded text-xs ${colors[lane] ?? "bg-slate-100"}`}>
            {lane}
        </span>
    )
}
```

---

## 第五步：验证

### 5.1 端到端测试

```bash
# 1. 开 mock + 建题
bun run apps/cli/src/main.ts settings set challenge.mockEnabled true
bun run apps/cli/src/main.ts challenge create --id multi --title "Multi" --flag-count 2

# 加 flags
cat ~/.tinyfat/challenge/multi/challenge.json | \
  jq '. + {flags: ["flag{a}", "flag{b}"]}' > /tmp/c.json && \
  mv /tmp/c.json ~/.tinyfat/challenge/multi/challenge.json

# 2. 启 web + planner loop
bun run apps/cli/src/main.ts web &
WEB_PID=$!
sleep 2

bun run apps/cli/src/main.ts challenge start-loop &
LOOP_PID=$!

# 3. 浏览器看 timeline
echo "打开 http://127.0.0.1:3000，看 timeline"
```

### 5.2 验证协作广播

跑两个 solver 同做一道题（手动）：

```bash
# 终端 A
bun run apps/cli/src/main.ts runtime launch --prompt SOLVER -e TCH_CHALLENGE_ID=multi "solve"

# 终端 B
bun run apps/cli/src/main.ts runtime launch --prompt SOLVER -e TCH_CHALLENGE_ID=multi "solve"
```

当 A 调 challenge_submit_flag 拿到正确 flag 后，B 应该立刻收到 steer 消息。

### 5.3 看 timeline

```bash
curl http://127.0.0.1:3000/api/runtime/challenges/multi/timeline | jq .
```

应该看到事件数组，含 solver_started / flag_submitted 等。

### 5.4 类型检查

```bash
bun run typecheck
```

---

## 第六步：故障排查

### 问题 1：广播没送达

**原因**：可能 solver 没注入 TCH_CHALLENGE_ID，或 runtime 找不到 solver。

**调试**：

```typescript
console.log('subscribers:', runtime.list().filter(s => s.challengeId === challengeId))
```

### 问题 2：timeline 事件顺序错乱

**原因**：可能 timestamp 不一致（ISO 字符串 vs 毫秒数）。

**解决**：在 buildChallengeAttackTimeline 里都转成毫秒数排序。

### 问题 3：相同 flag 多次广播

**原因**：每次 submit 都触发，包括 incorrect。

**解决**：只在 `result.remote.correct === true` 时广播（已经这样了）。

---

## 本课小结

✅ **你已完成**：

- 实现协作广播（hint + flag-correct）
- 区分 steer / follow_up 投递级别
- 实现 attack timeline 数据聚合
- 加 timeline Web API + 前端组件

📦 **新增文件**：

```
packages/core/src/challenge/attack-timeline.ts
```

🔑 **关键概念**：

- **协作广播**：solver 之间互通，避免重复劳动。
- **steer vs follow_up**：高优先级 vs 普通追加。
- **timeline 聚合**：把多源数据统一成单一时间线视图。

---

## 🎉 项目完成！

恭喜！20 课时全部完成。你搭出了一个完整的 CTF / 渗透测试多 Agent 协作平台。

### 最终架构回顾

```
┌─ apps/cli ────────────────────────────────────────────┐
│  tinyfat 命令行入口（commander）                     │
└────────────────────────────────────────────────────────┘
          ↓
┌─ packages/core ───────────────────────────────────────┐
│  ┌─ ConfigManager ──────────────────────────────┐    │
│  │  auth.json / models.json / provider-prefs    │    │
│  │  model-prefs.json / prompts/ / skills/       │    │
│  └──────────────────────────────────────────────┘    │
│  ┌─ RuntimeManager ─────────────────────────────┐    │
│  │  Docker 容器操作 + 事件总线                   │    │
│  └──────────────────────────────────────────────┘    │
│  ┌─ ChallengeManager ───────────────────────────┐    │
│  │  API client + store + Planner LLM loop        │    │
│  │  + ideas/memory + attack timeline             │    │
│  └──────────────────────────────────────────────┘    │
│  ┌─ Solver session ─────────────────────────────┐    │
│  │  rpc-server + host bridge                     │    │
│  │  + Observer sidecar (ideas/memory 维护)       │    │
│  │  + Ralph loop (强制续跑)                      │    │
│  └──────────────────────────────────────────────┘    │
└────────────────────────────────────────────────────────┘
          ↓
┌─ packages/ui-web ─────────────────────────────────────┐
│  React + Tailwind 前端                                 │
│  + Bun.serve REST API + SSE 实时推送                  │
└────────────────────────────────────────────────────────┘
```

### 你已经掌握的技能

- ✅ Bun monorepo + TypeScript strict
- ✅ Docker 容器化 + stdin/stdout JSONL RPC
- ✅ LLM agent 调度（Planner + Observer + Solver 三角色）
- ✅ 文件存储 + 并发安全（原子写 + 文件锁）
- ✅ SSE 实时推送
- ✅ 多 agent 协作（广播 + 策略板）
- ✅ Prompt 工程（YAML frontmatter + system prompt 设计）

### 下一步建议

1. **跑端到端 demo**：mock 模式下让 Planner 自动解一道题。
2. **对接真实平台**：用真实 API token 替换 mock，跑真赛题。
3. **加更多工具**：参考 BreachWeave 源码，加 pentest-workspace / scope-guard 等扩展。
4. **优化 UI**：加 dashboard / stats / solver 详情可视化。
5. **加测试**：用 bun test 写单元测试，保证回归。

---

## 真实项目参考

本教程是 [BreachWeave](https://github.com/...) 项目的简化教学版。真实项目还有：

- **pentest 工具集**：subagent / kimi-search / pentest-workspace
- **scope-guard 扩展**：约束 solver 不出范围
- **stats 统计聚合**：dashboard 数据源
- **Solver 归档**：完成后归档不删

如果你想看完整实现，对照真实源码学习。

---

**完成全部 20 课后，你拥有了：一个能独立维护、可扩展、生产级的多 Agent LLM 平台。** 🚀
