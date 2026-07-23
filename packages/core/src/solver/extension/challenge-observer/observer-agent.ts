/**
 * Observer LLM review 执行器（lesson 18）。
 *
 * 每次被 drainReviewQueue 调用时，开一个**独立的 AgentSession**（用 Observer 专用
 * systemPrompt + observer sidecar 工具），把 review payload 喂进去，让 LLM 维护
 * solver 本地的策略板（ideas/memory）。跑完即 dispose。
 */
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
export function buildObserverPrompt(payload: ObserverReviewPayload): string {
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
 * @param _challengeId 当前 challenge ID（预留：未来可写到 challenge 级板；当前 observer 写 solver 本地板）
 * @param payload      本轮 review 的输入
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
