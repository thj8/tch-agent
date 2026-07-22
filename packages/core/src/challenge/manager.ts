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
