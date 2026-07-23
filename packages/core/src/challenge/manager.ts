import { ChallengeApiClient } from "./api-client"
import type {
    ChallengeApiChallenge,
    ChallengeApiHintData,
    ChallengeApiListData,
    ChallengeApiStartData,
    ChallengeApiSubmitData,
} from "./api-client"
import {
    appendChallengeAttemptLog,
    appendChallengeSubmissionLog,
    computeChallengeCompleted,
    DEFAULT_CHALLENGE_DIR,
    ensureChallengeStoreBaseDir,
    listChallengeAttemptLogs,
    listChallengeRecords,
    readChallengeRecord,
    saveChallengeRecord,
} from "./store"
import type {
    ChallengeAttemptLogRecord,
    ChallengeInfoRecord,
    ChallengeRecord,
} from "./store"
import type { ConfigManager } from "../config/index"
import type { RuntimeManager } from "../runtime/runtime"
import { createAgentSession, defineTool, SessionManager } from "@mariozechner/pi-coding-agent"
import type { ToolDefinition } from "@mariozechner/pi-coding-agent"
import { Type } from "typebox"
import type { TSchema } from "typebox"
import type { SolverInstance } from "../runtime/types"

/**
 * 提交 flag 时的元数据。
 */
export interface ChallengeSubmissionMeta {
    solverId?: string
    promptName?: string
    modelName?: string
    writeup?: string
}

/**
 * 一个 action 的结果。
 */
export interface ChallengeActionResult<T> {
    /** 平台原始返回 */
    remote: T
    /** 落盘后的本地记录（可能 undefined） */
    challenge?: ChallengeInfoRecord
    /** 完成检测 */
    is_completed: boolean
}

/**
 * ChallengeManager：控制平面。
 *
 * 协调 ChallengeApiClient（远端）+ store（本地）+ 业务逻辑。
 *
 * - 不亲自解题（solver 干）、不亲自跑工具（runtime 干），只负责协调：
 *   什么时候启动实例、什么时候提交 flag、什么时候算完成。
 * - mock 模式下用本地 store 模拟整个平台（list/start/stop/submit/hint）。
 *
 * @param rootDir challenge 数据根目录（默认 ~/.tinyfat/challenge；测试可注入 tmp 目录）
 */
export class ChallengeManager {
    private readonly config: ConfigManager
    private readonly rootDir: string
    private api: ChallengeApiClient | undefined
    private runtime: RuntimeManager | undefined

    // ── Planner 调度循环（lesson 14） ──
    private syncTimer: ReturnType<typeof setTimeout> | undefined
    private syncLoopStarted = false
    private plannerRunning = false
    /** 默认 30s tick */
    private static readonly DEFAULT_TICK_INTERVAL_MS = 30_000

    constructor(config: ConfigManager, rootDir: string = DEFAULT_CHALLENGE_DIR) {
        this.config = config
        this.rootDir = rootDir
    }

    /** 注入 RuntimeManager（DaemonManager 装配时调用） */
    attachRuntime(runtime: RuntimeManager): void {
        this.runtime = runtime
    }

    getRuntime(): RuntimeManager | undefined {
        return this.runtime
    }

    /** 配置变更时清 API 缓存 */
    reloadFromConfig(): void {
        this.api = undefined
    }

    // ── 内部工具 ────────────────────────────────────────

    private async getRootDir(): Promise<string> {
        await ensureChallengeStoreBaseDir(this.rootDir)
        return this.rootDir
    }

    /**
     * 懒初始化 API client。
     * mock 模式用 createMock（用本地 store 模拟平台）；真 API 模式用 create(baseUrl, token)。
     */
    private async getApi(): Promise<ChallengeApiClient> {
        if (this.api) return this.api

        const settings = await this.config.getHostSettings()
        if (settings.challenge.mockEnabled === true) {
            const rootDir = await this.getRootDir()
            this.api = ChallengeApiClient.createMock({
                listChallenges: async () => {
                    const records = await listChallengeRecords(rootDir)
                    return {
                        current_level: records.reduce((max, r) => Math.max(max, r.level), 0),
                        total_challenges: records.length,
                        solved_challenges: records.filter(computeChallengeCompleted).length,
                        challenges: records.map(mapRecordToApiChallenge),
                    }
                },
                startChallenge: async (code) => {
                    const challenge = await readChallengeRecord(rootDir, code)
                    if (!challenge) throw new Error(`challenge "${code}" not found`)
                    if (computeChallengeCompleted(challenge)) {
                        return { already_completed: true }
                    }
                    if (challenge.instance_status === "running") {
                        return challenge.entrypoint ?? ["127.0.0.1:8080"]
                    }
                    const entrypoint = challenge.entrypoint ?? ["127.0.0.1:8080"]
                    await saveChallengeRecord(
                        rootDir,
                        { ...challenge, instance_status: "running", entrypoint },
                        "challenge-api:mock-start",
                    )
                    return entrypoint
                },
                stopChallenge: async (code) => {
                    const challenge = await readChallengeRecord(rootDir, code)
                    if (!challenge) throw new Error(`challenge "${code}" not found`)
                    await saveChallengeRecord(
                        rootDir,
                        { ...challenge, instance_status: "stopped", entrypoint: null },
                        "challenge-api:mock-stop",
                    )
                    return null
                },
                submitFlag: async (code, flag) => {
                    const challenge = await readChallengeRecord(rootDir, code)
                    if (!challenge) throw new Error(`challenge "${code}" not found`)
                    const flags = challenge.flags ?? []
                    const isCorrect = flags.includes(flag)
                    const alreadySolved = isCorrect && challenge.flag_got_count >= challenge.flag_count
                    const nextGotCount =
                        isCorrect && !alreadySolved
                            ? Math.min(challenge.flag_got_count + 1, challenge.flag_count)
                            : challenge.flag_got_count
                    if (nextGotCount !== challenge.flag_got_count) {
                        await saveChallengeRecord(
                            rootDir,
                            { ...challenge, flag_got_count: nextGotCount },
                            "challenge-api:mock-submit",
                        )
                    }
                    return {
                        correct: isCorrect,
                        message: isCorrect ? "correct" : "incorrect",
                        flag_count: challenge.flag_count,
                        flag_got_count: nextGotCount,
                    }
                },
                getHint: async (code) => {
                    const challenge = await readChallengeRecord(rootDir, code)
                    if (!challenge) throw new Error(`challenge "${code}" not found`)
                    const content = challenge.hint_content ?? null
                    if (!challenge.hint_viewed) {
                        await saveChallengeRecord(
                            rootDir,
                            { ...challenge, hint_viewed: true },
                            "challenge-api:mock-hint",
                        )
                    }
                    return { code, hint_content: content }
                },
            })
        } else {
            const { apiBaseUrl, agentToken } = settings.challenge
            if (!apiBaseUrl || !agentToken) {
                throw new Error("Challenge API not configured (need apiBaseUrl + agentToken)")
            }
            this.api = ChallengeApiClient.create(apiBaseUrl, agentToken)
        }
        return this.api
    }

    // ── 业务方法 ────────────────────────────────────────

    /** 列出所有题目（远端同步 + 本地） */
    async listChallenges(): Promise<{
        remote: ChallengeApiListData
        local: ChallengeInfoRecord[]
    }> {
        const api = await this.getApi()
        const remote = await api.listChallenges()

        // 把远端数据同步到本地
        const rootDir = await this.getRootDir()
        for (const apiChallenge of remote.challenges) {
            const existing = await readChallengeRecord(rootDir, apiChallenge.code)
            const record = mergeApiChallengeToRecord(apiChallenge, existing)
            await saveChallengeRecord(rootDir, record, "challenge-api:sync")
        }

        const local = await listChallengeRecords(rootDir)
        return { remote, local }
    }

    /** 读一道题（本地） */
    async getChallenge(challengeId: string): Promise<ChallengeInfoRecord | undefined> {
        const rootDir = await this.getRootDir()
        return readChallengeRecord(rootDir, challengeId)
    }

    /** 创建一道题（仅 mock 模式或手动导入） */
    async createChallenge(
        challenge: ChallengeRecord,
        source = "manual",
    ): Promise<ChallengeInfoRecord> {
        const rootDir = await this.getRootDir()
        await saveChallengeRecord(rootDir, challenge, source)
        const record = await readChallengeRecord(rootDir, challenge.id)
        if (!record) throw new Error("failed to save challenge")
        return record
    }

    /** 启动实例 */
    async startChallenge(challengeId: string): Promise<ChallengeActionResult<ChallengeApiStartData>> {
        const api = await this.getApi()
        const remote = await api.startChallenge(challengeId)

        const rootDir = await this.getRootDir()
        const challenge = await readChallengeRecord(rootDir, challengeId)
        // 平台给了入口数组 → 实例在跑，落盘 running + entrypoint。
        // 平台返回 { already_completed: true }（或其它非数组）→ 不改本地状态，避免把已完成题误标 running。
        if (challenge && Array.isArray(remote)) {
            await saveChallengeRecord(
                rootDir,
                { ...challenge, instance_status: "running", entrypoint: remote },
                "challenge:start",
            )
        }

        const updated = await readChallengeRecord(rootDir, challengeId)
        return {
            remote,
            challenge: updated,
            is_completed: computeChallengeCompleted(updated),
        }
    }

    /** 停止实例 */
    async stopChallenge(challengeId: string): Promise<ChallengeActionResult<null>> {
        const api = await this.getApi()
        const remote = await api.stopChallenge(challengeId)

        const rootDir = await this.getRootDir()
        const challenge = await readChallengeRecord(rootDir, challengeId)
        if (challenge) {
            await saveChallengeRecord(
                rootDir,
                { ...challenge, instance_status: "stopped", entrypoint: null },
                "challenge:stop",
            )
        }

        const updated = await readChallengeRecord(rootDir, challengeId)
        return {
            remote,
            challenge: updated,
            is_completed: computeChallengeCompleted(updated),
        }
    }

    /**
     * 提交 flag。
     *
     * 流程：
     *   1. 调 API submit
     *   2. 落盘新进度
     *   3. 追加 submission 日志
     *   4. 完成检测 → 若完成，调 finishChallenge（收尾：停实例 + 停活跃 solver）
     */
    async submitFlag(
        challengeId: string,
        flag: string,
        meta: ChallengeSubmissionMeta = {},
    ): Promise<ChallengeActionResult<ChallengeApiSubmitData>> {
        const api = await this.getApi()
        const remote = await api.submitFlag(challengeId, flag)

        const rootDir = await this.getRootDir()
        const challenge = await readChallengeRecord(rootDir, challengeId)
        if (challenge) {
            await saveChallengeRecord(
                rootDir,
                {
                    ...challenge,
                    flag_got_count: remote.flag_got_count,
                    total_got_score: challenge.total_got_score,
                },
                "challenge:submit",
            )
        }

        // 追加 submission 日志
        await appendChallengeSubmissionLog(rootDir, {
            challengeId,
            solverId: meta.solverId,
            promptName: meta.promptName,
            modelName: meta.modelName,
            flag,
            correct: remote.correct,
            message: remote.message,
            writeup: meta.writeup,
        })

        const beforeFinish = await readChallengeRecord(rootDir, challengeId)
        const isCompleted = computeChallengeCompleted(beforeFinish)

        // 若完成，触发收尾（失败只打日志，不影响 submit 结果）
        if (isCompleted) {
            await this.finishChallenge(challengeId).catch((error) => {
                console.error("[challenge] finishChallenge error:", error)
            })
        }

        // finishChallenge 会停实例（instance_status → stopped），所以完成分支必须重读，
        // 否则返回的 challenge 还是收尾前的快照（started 的题会误报 running）。
        const updated = await readChallengeRecord(rootDir, challengeId)
        return { remote, challenge: updated, is_completed: isCompleted }
    }

    /** 拉 hint */
    async getHint(challengeId: string): Promise<ChallengeActionResult<ChallengeApiHintData>> {
        const api = await this.getApi()
        const remote = await api.getHint(challengeId)

        const rootDir = await this.getRootDir()
        const challenge = await readChallengeRecord(rootDir, challengeId)
        if (challenge) {
            await saveChallengeRecord(
                rootDir,
                { ...challenge, hint_viewed: true, hint_content: remote.hint_content },
                "challenge:hint",
            )
        }

        const updated = await readChallengeRecord(rootDir, challengeId)
        return {
            remote,
            challenge: updated,
            is_completed: computeChallengeCompleted(updated),
        }
    }

    /** 完成检测（本地） */
    async isChallengeCompleted(challengeId: string): Promise<boolean> {
        const rootDir = await this.getRootDir()
        const challenge = await readChallengeRecord(rootDir, challengeId)
        return computeChallengeCompleted(challenge)
    }

    /**
     * 收尾一道已完成的题目：停实例 + 停活跃 solver。
     */
    async finishChallenge(challengeId: string): Promise<void> {
        console.log(`[challenge] finishing ${challengeId}...`)

        // 停实例（失败只打日志）
        try {
            await this.stopChallenge(challengeId)
        } catch (error) {
            console.error("[challenge] stopChallenge failed:", error)
        }

        // 停该题目的所有活跃 solver
        if (this.runtime) {
            const active = this.runtime
                .list()
                .filter((s) => s.challengeId === challengeId && s.status === "running")
            for (const solver of active) {
                await this.runtime.stopSolver(solver.id).catch((error) => {
                    console.error(`[challenge] stopSolver ${solver.id} failed:`, error)
                })
            }
        }
    }

    // ── Planner 调度（lesson 14：LLM-as-orchestrator） ──

    /**
     * 启动一个 Solver 处理指定 challenge（Planner → Runtime）。
     *
     * 流程：
     *   1. 校验 runtime / prompt / challenge
     *   2. 若实例未起，先 startChallenge 占槽位
     *   3. 装配 task 文本（solverId 由 runtime.launch 内部生成）
     *   4. runtime.launch 拉起容器（注入 TCH_CHALLENGE_ID）
     *   5. appendAttemptLog 记录
     */
    async launchSolver(
        challengeId: string,
        promptName: string,
        options: { plannerHandoff?: string } = {},
    ): Promise<SolverInstance> {
        if (!this.runtime) throw new Error("runtime not attached")

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

        // 装配 task（solverId 由 runtime.launch 内部生成）
        const task = buildSolverTask(challenge, options.plannerHandoff)

        // 拉起容器（TCH_CHALLENGE_ID 让容器内 solver 能反查 challenge）
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
     * 启动 Planner 调度循环。整个进程只调一次。
     * 每 DEFAULT_TICK_INTERVAL_MS（默认 30s）跑一次 tickPlanner。
     */
    startSyncLoop(): void {
        if (this.syncLoopStarted) return
        this.syncLoopStarted = true
        console.log(
            `[planner] sync loop started (interval=${ChallengeManager.DEFAULT_TICK_INTERVAL_MS}ms)`,
        )

        const tick = async (): Promise<void> => {
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

    /** 停止调度循环 */
    stopSyncLoop(): void {
        if (this.syncTimer) clearTimeout(this.syncTimer)
        this.syncTimer = undefined
        this.syncLoopStarted = false
    }

    /**
     * 触发一次 Planner 调度。用 plannerRunning 锁防并发。
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
     * 流程：snapshot → 注入 systemPrompt → 注册 planner 工具 → createAgentSession → prompt → dispose。
     * 任一前置不满足（runtime 未注入 / prompt 不存在 / 无未完成题）都优雅跳过，不抛错。
     */
    private async runPlannerOnce(source: string): Promise<string | undefined> {
        if (!this.runtime) {
            console.log("[planner] runtime not attached, skipping")
            return
        }

        const plannerPromptName = "CHALLENGE_PLANNER"
        const sessionOpts = await this.config.resolvePromptSession(plannerPromptName)
        if (!sessionOpts?.resourceLoader) {
            console.log(`[planner] prompt "${plannerPromptName}" not found, skipping`)
            return
        }

        const snapshot = await this.buildPlannerSnapshot(source)
        if (snapshot.challenges.length === 0) {
            console.log("[planner] no challenges to schedule")
            return
        }

        // 注入 snapshot 到 systemPrompt（覆盖 resourceLoader 的 override）
        const resourceLoader = sessionOpts.resourceLoader
        const snapshotText = formatPlannerSnapshot(snapshot)
        ;(resourceLoader as { systemPromptOverride?: () => string }).systemPromptOverride =
            () => `${plannerPromptName}\n\n## Current Snapshot\n${snapshotText}`
        await resourceLoader.reload()

        // 注册 planner 工具
        const plannerTools = this.createPlannerTools(snapshot)

        const { session } = await createAgentSession({
            ...sessionOpts,
            resourceLoader,
            customTools: [...(sessionOpts.customTools ?? []), ...plannerTools],
            sessionManager: SessionManager.inMemory(), // 一次性，不落盘
        })

        let plannerOutput = ""
        // 防御性断言：不依赖 SDK AgentEvent 的精确 d.ts，按需字段取。
        session.subscribe((event) => {
            const e = event as {
                type: string
                message?: { role?: string; content?: unknown }
                isError?: boolean
                toolName?: string
                result?: unknown
            }
            if (
                e.type === "message_end" &&
                e.message?.role === "assistant" &&
                Array.isArray(e.message.content)
            ) {
                plannerOutput = (
                    e.message.content as Array<{ type: string; text?: string }>
                )
                    .filter((c) => c.type === "text")
                    .map((c) => c.text ?? "")
                    .join("")
            }
            if (e.type === "tool_execution_end" && e.isError) {
                console.error(`[planner] tool ${e.toolName} failed:`, e.result)
            }
        })

        console.log(`\n========== planner round (source=${source}) ==========`)
        await session.prompt("开始本轮比赛调度。")
        session.dispose()
        console.log(`========== end planner round ==========\n`)

        return plannerOutput
    }

    /**
     * 拍 Planner snapshot：未完成题 + 活跃 solver + 可用 prompt。
     */
    private async buildPlannerSnapshot(source: string): Promise<{
        source: string
        timestamp: string
        challenges: ChallengeInfoRecord[]
        activeSolvers: SolverInstance[]
        availablePrompts: string[]
    }> {
        const rootDir = await this.getRootDir()
        const all = await listChallengeRecords(rootDir)
        const unsolved = all.filter((c) => !computeChallengeCompleted(c))

        const activeSolvers = this.runtime?.list() ?? []
        const promptsList = await this.config.listAgentPrompts()
        const availablePrompts = promptsList.map((p) => p.name)

        return {
            source,
            timestamp: new Date().toISOString(),
            challenges: unsolved,
            activeSolvers,
            availablePrompts,
        }
    }

    /**
     * 创建 Planner 工具集。
     *
     * 安全设计：challengeId / promptName / solverId 用 Literal 枚举限制，
     * LLM 只能从 snapshot 实际存在的 ID 里选（空集退化为自由 String）。
     */
    private createPlannerTools(snapshot: {
        challenges: ChallengeInfoRecord[]
        activeSolvers: SolverInstance[]
        availablePrompts: string[]
    }): ToolDefinition[] {
        const challengeIds = snapshot.challenges.map((c) => c.id)
        const activeSolverIds = snapshot.activeSolvers.map((s) => s.id)

        const challengeIdSchema = enumSchema(challengeIds, "challenge id")
        const promptNameSchema = enumSchema(snapshot.availablePrompts, "prompt name")
        const solverIdSchema = enumSchema(activeSolverIds, "solver id")

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
                        details: undefined,
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
                        details: undefined,
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
                        details: undefined,
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
                execute: async (
                    _id,
                    params: { challengeId: string; promptName: string; solverHandoff: string },
                ) => {
                    try {
                        const solver = await this.launchSolver(
                            params.challengeId,
                            params.promptName,
                            { plannerHandoff: params.solverHandoff },
                        )
                        return {
                            content: [
                                {
                                    type: "text",
                                    text: `Launched solver ${solver.id} for ${params.challengeId}`,
                                },
                            ],
                            details: undefined,
                        }
                    } catch (error) {
                        return {
                            content: [
                                {
                                    type: "text",
                                    text: `Launch failed: ${error instanceof Error ? error.message : String(error)}`,
                                },
                            ],
                            details: undefined,
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
                        details: undefined,
                    }
                },
            }),
        ]
    }

    /** 便捷方法：追加启动日志 */
    async appendAttemptLog(input: {
        challengeId: string
        solverId: string
        promptName: string
        task: string
    }): Promise<void> {
        const rootDir = await this.getRootDir()
        await appendChallengeAttemptLog(rootDir, input)
    }

    /** 列出 attempts */
    async listAttemptLogs(challengeId: string): Promise<ChallengeAttemptLogRecord[]> {
        const rootDir = await this.getRootDir()
        return listChallengeAttemptLogs(rootDir, challengeId)
    }
}

// ── 工具函数 ──────────────────────────────────────────────

function mapRecordToApiChallenge(r: ChallengeInfoRecord): ChallengeApiChallenge {
    return {
        title: r.title,
        code: r.id,
        difficulty: r.difficulty,
        description: r.description,
        level: r.level,
        total_score: r.total_score,
        total_got_score: r.total_got_score,
        flag_count: r.flag_count,
        flag_got_count: r.flag_got_count,
        hint_viewed: r.hint_viewed,
        instance_status: r.instance_status,
        entrypoint: r.entrypoint,
    }
}

function mergeApiChallengeToRecord(
    api: ChallengeApiChallenge,
    existing?: ChallengeInfoRecord,
): ChallengeRecord {
    return {
        id: api.code,
        title: api.title,
        difficulty: api.difficulty,
        description: api.description,
        level: api.level,
        total_score: api.total_score,
        total_got_score: api.total_got_score,
        flag_count: api.flag_count,
        flag_got_count: api.flag_got_count,
        hint_viewed: api.hint_viewed,
        hint_content: existing?.hint_content ?? null,
        instance_status: api.instance_status,
        entrypoint: api.entrypoint,
        // 保留原有的 flags（mock 模式下才有）
        flags: existing?.flags,
    }
}

// ── Planner 纯函数（lesson 14，导出便于单测） ───────────

/**
 * 装配 solver 的初始 task 文本。
 */
export function buildSolverTask(
    challenge: ChallengeInfoRecord,
    plannerHandoff?: string,
): string {
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
    parts.push(
        `\n## Your Goal\nSolve this challenge and submit all flags using challenge_submit_flag.`,
    )
    return parts.join("\n")
}

/**
 * 把 Planner snapshot 格式化成给 LLM 看的文本。
 */
export function formatPlannerSnapshot(snapshot: {
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
        parts.push(
            `- ${s.id} (${s.status}, prompt=${s.promptName}, challenge=${s.challengeId ?? "-"})`,
        )
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

/**
 * 把一组 ID 收紧成 typebox 枚举 schema（Literal Union）；
 * 空集时退化为自由 String，让 LLM 仍能调用（ albeit 无约束）。
 */
export function enumSchema(values: string[], fallbackDesc: string): TSchema {
    return values.length > 0
        ? Type.Union(values.map((v) => Type.Literal(v)))
        : Type.String({ description: fallbackDesc })
}
