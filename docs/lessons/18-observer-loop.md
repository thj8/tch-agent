# 课时 18：Observer loop —— 触发 review

> 🎯 **目标**：让 Observer 自动按节奏 review solver 行为，触发 LLM 审查并维护策略板。
>
> ⏰ **预计耗时**：3-4 小时
>
> 📋 **难度**：⭐⭐⭐⭐⭐

---

## 你将学到什么

1. **Extension 事件 hook**（pi-coding-agent 的核心机制）
2. **review 触发节奏**（周期 / hint / agent_end）
3. **observer-store**（轮次记录 + review 队列）
4. **串行队列消费**（防并发 LLM 调用）

## 前置条件

✅ 已完成 [课时 1-17](./README.md)

## 最终效果

跑一个 solver，Observer 自动：

```
[solver] ... (调 bash / read 工具)
[solver] ... (继续解题)

[observer] round #6 due → review triggered
[observer] looking at last 6 rounds:
  - round 1: assistant said "let's start"
  - round 2: tool_call bash("ls /tmp")
  - ...
[observer] memory_add({ kind: "fact", content: "found /tmp/data" })
[observer] idea_add({ content: "check /tmp/data for hints" })
[observer] NO_CHANGE
```

---

## 第零步：概念扫盲

### 0.1 Extension 的 hook 机制

pi-coding-agent SDK 提供 ExtensionFactory：

```typescript
const factory: ExtensionFactory = (pi) => {
    pi.on("tool_execution_end", async (event) => {
        console.log(`Tool ${event.toolName} done`)
    })
    pi.on("message_end", async (event) => {
        if (event.message?.role === "assistant") {
            console.log("Assistant replied")
        }
    })
}

createAgentSession({ ..., extensionFactories: [factory] })
```

`pi` 是 ExtensionAPI，提供事件订阅。

### 0.2 一"轮"是什么？

我们定义：**一轮 = 一次 assistant message_end + 期间的所有 tool calls**。

```
[user prompt]
  ↓
[assistant message] (含 tool_call bash)
  ↓
[tool_result] bash
  ↓
[assistant message] (含 tool_call read)
  ↓
[tool_result] read
  ↓
[assistant message] (无 tool_call，纯文本)
  ↓
message_end  ← 这是一轮的结束
```

每轮结束后，Observer 累积这一轮的活动，决定要不要触发 review。

### 0.3 触发节奏

```
每 6 轮一次周期 review  → OBSERVER_REVIEW_EVERY_ROUNDS = 6
challenge_get_hint 成功 → 强制 review（hint 改变攻击路线）
agent_end 时           → 末轮快照 review
```

避免：
- 每轮都 review（成本太高）
- 永不 review（板会过时）

### 0.4 review 队列

```
event hook 产生 review payload
  ↓
入队（落盘 JSON 文件）
  ↓
drainReviewQueue 串行消费
  ↓
调 runSolverObserverReview
  ↓
LLM 维护板
```

为什么用队列？

- 防止并发 review 把 challenge store 写穿。
- 崩溃恢复：队列是文件，进程重启后还能继续。

---

## 第一步：实现 observer-store

### 1.1 创建 packages/core/src/solver/extension/challenge-observer/observer-store.ts

新建 `packages/core/src/solver/extension/challenge-observer/observer-store.ts`：

```typescript
import { mkdir, readdir, unlink } from "node:fs/promises"
import { join } from "node:path"
import type { ObserverReviewPayload, ObserverRoundPayload, ObserverToolLog } from "./types"

// ── 状态文件 ──────────────────────────────────────────────

const OBSERVER_RUNTIME_STATE_FILE = "state.json"
const OBSERVER_REVIEW_QUEUE_DIRNAME = "review-queue"
const OBSERVER_ROUNDS_DIRNAME = "rounds"

/**
 * Observer 运行时状态。
 */
export interface ObserverRuntimeState {
    /** 当前轮号 */
    round: number
    /** 当前轮累积的工具日志 */
    current_round_tool_logs: ObserverToolLog[]
    /** tool_execution_start 暂存的 args，等 end 时配对 */
    tool_args_by_call_id: Record<string, string>
    /** 强制 review 原因（hint 等） */
    force_review_reason?: ObserverReviewPayload["reason"]
}

function resolveObserverRootDir(): string {
    const solverSessionDir = process.env.TCH_SOLVER_SESSION_DIR?.trim()
    if (!solverSessionDir) {
        throw new Error("TCH_SOLVER_SESSION_DIR is required for observer runtime state")
    }
    return join(solverSessionDir, ".observer")
}

function resolveObserverRuntimeStatePath(): string {
    return join(resolveObserverRootDir(), OBSERVER_RUNTIME_STATE_FILE)
}

function resolveObserverReviewQueueDir(): string {
    return join(resolveObserverRootDir(), OBSERVER_REVIEW_QUEUE_DIRNAME)
}

function resolveObserverRoundsDir(): string {
    return join(resolveObserverRootDir(), OBSERVER_ROUNDS_DIRNAME)
}

function createDefaultState(): ObserverRuntimeState {
    return {
        round: 0,
        current_round_tool_logs: [],
        tool_args_by_call_id: {},
    }
}

async function ensureDir(path: string): Promise<void> {
    await mkdir(path, { recursive: true })
}

// ── State CRUD ────────────────────────────────────────────

export async function loadObserverState(): Promise<ObserverRuntimeState> {
    await ensureDir(resolveObserverRootDir())
    const file = Bun.file(resolveObserverRuntimeStatePath())
    if (!(await file.exists())) return createDefaultState()
    return (await file.json()) as ObserverRuntimeState
}

/**
 * 原子地"读 → 改 → 写"。
 *
 * mutate 函数：接收当前 state，返回 { nextState, result }。
 */
export async function updateObserverState<T>(
    mutate: (state: ObserverRuntimeState) => { nextState: ObserverRuntimeState; result: T },
): Promise<T> {
    const current = await loadObserverState()
    const { nextState, result } = mutate(current)
    await Bun.write(resolveObserverRuntimeStatePath(), JSON.stringify(nextState, null, 2))
    return result
}

// ── Review Queue ──────────────────────────────────────────

export async function enqueueObserverReview(payload: ObserverReviewPayload): Promise<void> {
    const dir = resolveObserverReviewQueueDir()
    await ensureDir(dir)
    const filePath = join(dir, `${Date.now()}-${crypto.randomUUID().slice(0, 8)}.json`)
    await Bun.write(filePath, JSON.stringify(payload, null, 2))
}

export async function takeNextObserverReview(): Promise<ObserverReviewPayload | undefined> {
    const dir = resolveObserverReviewQueueDir()
    await ensureDir(dir)
    const files = (await readdir(dir))
        .filter((name) => name.endsWith(".json"))
        .sort((left, right) => left.localeCompare(right))
    const nextFile = files[0]
    if (!nextFile) return undefined

    const filePath = join(dir, nextFile)
    const payload = (await Bun.file(filePath).json()) as ObserverReviewPayload
    await unlink(filePath)
    return payload
}

// ── Rounds Archive ────────────────────────────────────────

function formatRoundFileName(round: number): string {
    return `${String(round).padStart(6, "0")}.json`
}

export async function persistObserverRound(record: ObserverRoundPayload): Promise<void> {
    const dir = resolveObserverRoundsDir()
    await ensureDir(dir)
    await Bun.write(join(dir, formatRoundFileName(record.round)), JSON.stringify(record, null, 2))
}

export async function loadRecentObserverRounds(limit: number): Promise<ObserverRoundPayload[]> {
    if (limit <= 0) return []
    const dir = resolveObserverRoundsDir()
    let files: string[] = []
    try {
        files = (await readdir(dir))
            .filter((name) => name.endsWith(".json"))
            .sort((left, right) => left.localeCompare(right))
            .slice(-limit)
    } catch {
        return []
    }

    const rounds = await Promise.all(
        files.map(async (fileName) => {
            return (await Bun.file(join(dir, fileName)).json()) as ObserverRoundPayload
        }),
    )
    return rounds.sort((left, right) => left.round - right.round)
}

export async function loadLatestObserverRoundNumber(): Promise<number> {
    const rounds = await loadRecentObserverRounds(1)
    return rounds.at(-1)?.round ?? 0
}
```

### 1.2 创建 types.ts

新建 `packages/core/src/solver/extension/challenge-observer/types.ts`：

```typescript
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
```

---

## 第二步：实现 observer-agent（跑 LLM）

### 2.1 创建 packages/core/src/solver/extension/challenge-observer/observer-agent.ts

新建 `packages/core/src/solver/extension/challenge-observer/observer-agent.ts`：

```typescript
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { DefaultResourceLoader, SessionManager, createAgentSession } from "@mariozechner/pi-coding-agent"
import type { CreateAgentSessionOptions } from "@mariozechner/pi-coding-agent"
import { ConfigManager, DEFAULT_CONFIG_DIR } from "../../../config/index"
import { createObserverSidecarTools } from "./tools"
import type { ObserverReviewPayload } from "./types"

/**
 * Observer 的系统提示词。
 *
 * 这段 prompt 是 Observer 的"灵魂"——它定义了：
 *   1. 角色：不解题、只维护 ideas/memory 板。
 *   2. Core Loop：先闭环 → 后收缩 → 再扩张。
 *   3. Output Contract：默认 NO_CHANGE；有改动只回 1-4 条 bullet。
 */
export const OBSERVER_SYSTEM_PROMPT = `You are the observer sidecar for a CTF/pentest agent.

You are NOT the solver. You DO NOT solve the challenge yourself.
Your ONLY job is to maintain the strategy board (ideas + memory).

# Mission

Default stance (NOT a suggestion):
  NO_CHANGE > update existing > delete superseded > add new

# Core Loop

For each review:
1. Look at current ideas and memory.
2. Close existing threads first: did recent results verify/falsify/advance any idea?
3. If yes, update that idea's status/result or related memory.
4. If a payload/encoding/sub-branch failed, record failure boundary, don't kill the whole line.
5. Only add a new idea if recent results open a different attack direction.
6. If neither new direction nor stronger boundary conclusion, reply NO_CHANGE.

In one sentence: close first, then shrink, then expand.

# Board Pressure

Default targets:
- memory <= 12 entries
- ideas <= 8 entries

When over budget, compression IS the priority: merge/update/delete before add.

# Output Contract

- Final reply MUST NOT repeat the problem description, context, logs, or process.
- If no changes, reply only: NO_CHANGE
- If changes, output 1-4 short bullets describing what you maintained.

Bad examples (don't do this):
- "downloaded the binary"
- "visited /admin"
- "need to think more"

Good examples:
- "check upload bypass with polyglot php"
- "try time-based SQLi on login"
- "Union/time/error SQLi all failed on /login, likely parameterized"`

/**
 * 把 review payload 格式化为 prompt。
 */
function buildObserverPrompt(payload: ObserverReviewPayload): string {
    const parts: string[] = []

    parts.push(`## Recent Solver Activity (last ${payload.rounds.length} rounds)`)
    parts.push("")

    for (const round of payload.rounds) {
        parts.push(`### Round ${round.round}`)
        const summary = round.assistant_summary.trim()
        parts.push(`- assistant: ${summary || "(empty)"}`)
        if (round.tool_logs.length === 0) {
            parts.push("- tools: (none)")
        } else {
            parts.push("- tools:")
            for (const tool of round.tool_logs) {
                const status = tool.is_error ? "error" : "ok"
                parts.push(`  - [${status}] ${tool.tool_name}`)
                parts.push(`    args: ${tool.args_summary || "-"}`)
                parts.push(`    result: ${tool.result_summary || "-"}`)
            }
        }
        parts.push("")
    }

    parts.push("## Response Contract")
    parts.push("- No changes → reply only: NO_CHANGE")
    parts.push("- Changes → output 1-4 short bullets")

    return parts.join("\n")
}

/**
 * 跑一次 Observer LLM review。
 *
 * @param challengeId 当前 challenge ID
 * @param payload     本轮 review 的输入
 * @param options.observerModel         model pref id
 * @param options.sendCorrectionNotice  给 solver 发纠偏的回调
 */
export async function runSolverObserverReview(
    _challengeId: string,
    payload: ObserverReviewPayload,
    options: {
        observerModel?: string
        sendCorrectionNotice?: (message: string) => Promise<boolean> | boolean
    } = {},
): Promise<{ applied: boolean; summary?: string }> {
    const rounds = payload.rounds.filter((r) => Array.isArray(r.tool_logs))
    if (rounds.length === 0) return { applied: false }

    const config = await ConfigManager.getInstance()

    // observer session 目录（与 board 同根：<sessionDir>/.observer）
    const solverSessionDir = process.env.TCH_SOLVER_SESSION_DIR?.trim()
    if (!solverSessionDir) throw new Error("TCH_SOLVER_SESSION_DIR required")
    const observerSessionDir = join(solverSessionDir, ".observer")
    const observerWorkspaceDir = process.env.TCH_SOLVER_WORKSPACE?.trim() ?? solverSessionDir
    await mkdir(observerSessionDir, { recursive: true })

    // 装配 session options（用 OBSERVER_SYSTEM_PROMPT，不挂主 solver 的工具）
    // ⚠️ DefaultResourceLoader 的 cwd / agentDir 都是必填，不能省 cwd
    const resourceLoader = new DefaultResourceLoader({
        cwd: observerWorkspaceDir,
        agentDir: DEFAULT_CONFIG_DIR,
        systemPromptOverride: () => OBSERVER_SYSTEM_PROMPT,
    })
    await resourceLoader.reload()

    const opts: CreateAgentSessionOptions = {
        tools: [],
        customTools: createObserverSidecarTools({
            sendCorrectionNotice: options.sendCorrectionNotice,
        }),
        resourceLoader,
        authStorage: config.auth,
        modelRegistry: config.models,
        settingsManager: config.settings,
    }

    // 解析 observer model（可选）
    if (options.observerModel) {
        try {
            const resolved = await config.resolveModelPref(options.observerModel)
            opts.model = resolved.model
            opts.thinkingLevel = resolved.thinkingLevel
        } catch (error) {
            console.warn(`[observer] model pref "${options.observerModel}" not found, using default`)
        }
    }

    const { session } = await createAgentSession({
        ...opts,
        cwd: observerWorkspaceDir,
        sessionManager: SessionManager.create(observerWorkspaceDir, observerSessionDir),
    })

    let summary = ""
    session.subscribe((event) => {
        if (event.type !== "message_end") return
        // AgentMessage 是联合类型（含 custom message），用宽松 cast 安全取 role/content
        const message = event.message as { role?: string; content?: unknown } | undefined
        if (message?.role !== "assistant") return
        const content = message.content
        if (Array.isArray(content)) {
            summary = content
                .filter(
                    (c): c is { type: "text"; text: string } =>
                        !!c && typeof c === "object" && (c as { type?: string }).type === "text",
                )
                .map((c) => c.text)
                .join("")
        }
    })

    try {
        await session.prompt(buildObserverPrompt({ ...payload, rounds }))
    } finally {
        session.dispose()
    }

    return { applied: true, summary: summary || undefined }
}
```

---

## 第三步：实现 observer-loop（事件 hook + 队列消费）

### 3.1 创建 packages/core/src/solver/extension/challenge-observer/observer-loop.ts

新建 `packages/core/src/solver/extension/challenge-observer/observer-loop.ts`：

```typescript
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
 *   - tool_execution_end   → 配对 args，生成 ObserverToolLog
 *   - message_end (assistant) → 封口当前轮 + 决定是否 review
 *   - agent_end            → 末轮 review
 */
/** review 执行器类型（可注入，便于测试） */
type ReviewRunner = typeof runSolverObserverReview

export interface AttachObserverLoopOptions {
    observerModel?: string
    /** 可选：注入自定义 review 执行器（测试用；默认 runSolverObserverReview） */
    runReview?: ReviewRunner
    /** 可选：注入自定义 hint 工具名判定（测试用） */
    hintToolName?: string
}

export function attachObserverLoop(
    pi: ExtensionAPI,
    options: AttachObserverLoopOptions = {},
): void {
    const runReview: ReviewRunner = options.runReview ?? runSolverObserverReview
    const hintToolName = options.hintToolName ?? "challenge_get_hint"
    let reviewRunning = false

    // 启动时对齐轮号
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
        // AgentMessage 是联合类型，宽松 cast 安全取 role/content
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
```

---

## 第四步：把 observer-loop 接入 session

### 4.1 修改 packages/core/src/solver/session.ts

Observer loop 通过 `ExtensionFactory` 注入。SDK 的 `createAgentSession` **不直接接收 extensions**，正确路径是：把 factory 传给 `resolvePromptSession(name, extensions)` → ConfigManager 交给 `DefaultResourceLoader({ extensionFactories })` → `session.bindExtensions({})` 时 SDK 依次调用各 `factory(pi)` → `pi.on(...)` 挂钩生效。

```typescript
// 顶部加 import
import type { AgentSession, ExtensionFactory } from "@mariozechner/pi-coding-agent"
import { attachObserverLoop } from "./extension/challenge-observer/observer-loop"

// createSolverSession 的 init 加一个可选字段（observer 用什么 model）
export async function createSolverSession(init: {
  solverId: string
  promptName: string
  task: string
  /** Observer sidecar 用的 model pref id（可选；省略则 observer 用 SDK 默认 model） */
  observerModel?: string
}): Promise<SolverSession> {
  // ...（mkdir + TCH_SOLVER_SESSION_DIR 注入，见 lesson 17）

  // observer factory：闭包捕获 observerModel
  const observerFactory: ExtensionFactory = (pi) => {
    attachObserverLoop(pi, { observerModel: init.observerModel })
  }

  // 把 factory 传给 resolvePromptSession（第二个参数 = ExtensionFactory[]）
  const sessionOpts = await config.resolvePromptSession(
    init.promptName,
    [observerFactory],
    workspaceDir,
  )
  if (!sessionOpts) {
    throw new Error(`prompt not found or disabled: ${init.promptName}`)
  }

  // ...（customTools 并入 observer 工具，见 lesson 17）
  const { session } = await createAgentSession({
    ...sessionOpts,
    customTools: [...(sessionOpts.customTools ?? []), ...createObserverSidecarTools()],
    sessionManager: SessionManager.create(workspaceDir, sessionDir),
  })
  // bindExtensions 触发 factory 注册 hook（observer 的 pi.on 在此刻挂上）
  await session.bindExtensions({})

  return { session, sessionDir, workspaceDir }
}
```

> ⚠️ **observerModel 从哪来**：原稿写 `prompt.meta.observerModel`，但 `session.ts` 里看不到 prompt（`resolvePromptSession` 内部才加载 prompt）。改成给 `createSolverSession` 的 `init` 加可选 `observerModel` 字段，由调用方（`runSolverCli` / 后续 CLI flag）传入；省略时 observer 用 SDK 默认 model。

> ⚠️ **关键**：SDK 的 `createAgentSession` **不直接接收 extensions**。
> 正确流程：
> 1. 把 ExtensionFactory 数组传给 `resolvePromptSession(name, extensions)`
> 2. ConfigManager 内部把它们传给 `DefaultResourceLoader({ extensionFactories: [...] })`
> 3. `session.bindExtensions({})` 时 SDK 才依次调用各 factory(pi)
> 4. factory 内部 `pi.on("tool_execution_end", ...)` 等订阅生效

> 💡 `ExtensionFactory` 类型已合进 §4.1 顶部的 `import type { AgentSession, ExtensionFactory }`。

---

## 第五步：验证

### 5.1 跑 solver，观察 Observer 启动

```bash
bun run apps/cli/src/main.ts runtime launch --prompt SOLVER "ls /tmp"
```

**预期**：

```
[session] observer extension attached
[observer] round 1 → no review due
[observer] round 2 → no review due
...
[observer] round 6 → periodic review triggered
[observer] looking at last 6 rounds
[observer] NO_CHANGE (or some bullet actions)
```

### 5.2 看 observer 状态文件

```bash
ls ~/.tinyfat/solvers/<id>/session/.observer/
# state.json  review-queue/  rounds/

cat ~/.tinyfat/solvers/<id>/session/.observer/state.json
# { "round": 6, ... }

ls ~/.tinyfat/solvers/<id>/session/.observer/rounds/
# 000001.json  000002.json ...

ls ~/.tinyfat/solvers/<id>/session/.observer/review-queue/
# 队列文件（处理后会自动删除）
```

### 5.3 强制 review（challenge_get_hint）

让 solver 调 challenge_get_hint（mock 模式下需要先建题）：

```bash
bun run apps/cli/src/main.ts runtime launch --prompt SOLVER \
  -e TCH_CHALLENGE_ID=test-1 \
  "调 challenge_get_hint 工具看看 hint"
```

**预期**：调完 hint 后立刻触发 review（不等 6 轮）。

### 5.4 类型检查

```bash
bun run typecheck
```

### 5.5 单元测试

三个测试文件（不依赖 LLM/API key）：

```bash
bun test packages/core/src/solver/extension/challenge-observer/
```

- `observer-store.test.ts`：state 读改写、review 队列 FIFO、rounds 归档 + `loadLatestObserverRoundNumber`。
- `observer-agent.test.ts`：`OBSERVER_SYSTEM_PROMPT` 关键契约；`buildObserverPrompt` 工具日志 / `[error]` / `(none)` / `(empty)` / 轮数 header。
- `observer-loop.test.ts`：用伪造 `ExtensionAPI`（只实现 `on`）+ 注入 `runReview` stub 驱动事件流，验证周期（每 6 轮）/ hint 强制 / `agent_end` / 工具日志配对，**全程不调真实 LLM**（`runReview` 可注入是为此服务）。

---

## 第六步：故障排查

### 问题 1：observer 不触发

**原因**：可能 extension 没正确注入。

**调试**：在 attachObserverLoop 开头加 `console.log("[observer] attached")`，跑 solver 看是否输出。

### 问题 2：review 卡住

**原因**：drainReviewQueue 的 while(true) 没退出。

**解决**：takeNextObserverReview 返回 undefined 时退出（已经这样了）；如果还卡，可能 enqueue 失败导致队列空但有 promise pending。

### 问题 3：轮号重置

**原因**：进程重启后 state.json 丢失。

**解决**：loadLatestObserverRoundNumber 从磁盘 rounds 目录恢复轮号（已实现）。

### 问题 4：observer LLM 调用错误

**原因**：observer model 没配 / 没注册。

**解决**：检查 `createSolverSession` 的 `observerModel` 参数（对应一条 model pref id）；或省略让 SDK 用默认。

---

## 本课小结

✅ **你已完成**：

- 实现 observer-store（state + review-queue + rounds）
- 实现 observer-agent（独立 LLM session）
- 实现 observer-loop（4 个事件 hook）
- 按节奏触发 review（周期 / hint / agent_end）
- 串行队列消费

📦 **新增文件**：

```
packages/core/src/solver/extension/challenge-observer/
├── types.ts                 ← 数据类型
├── observer-store.ts        ← 状态/队列/轮次存储
├── observer-store.test.ts   ← 存储层单元测试
├── observer-agent.ts        ← 跑一次 review
├── observer-agent.test.ts   ← prompt 构造单元测试
├── observer-loop.ts         ← 事件 hook + 触发逻辑
└── observer-loop.test.ts    ← 触发节奏集成测试（fake pi + stub review）
```

🔑 **关键概念**：

- **ExtensionFactory hook**：在 session 事件流里插入逻辑。
- **一"轮"定义**：assistant message_end + 期间的工具调用。
- **触发节奏**：周期（6 轮）+ hint 强制 + agent_end。
- **串行队列**：防并发 LLM 调用写穿存储。

---

## 下一课预告

[课时 19：Ralph Loop（强制续跑）](./19-ralph-loop.md)—— 让 solver 不让自己说停就停。

继续课时 19 →
