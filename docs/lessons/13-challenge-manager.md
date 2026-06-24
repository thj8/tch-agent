# 课时 13：ChallengeManager 控制平面

> 🎯 **目标**：实现 ChallengeManager 控制平面，封装 API + store，并接入 host bridge 让 solver 能查询 / 提交。
>
> ⏰ **预计耗时**：3-4 小时
>
> 📋 **难度**：⭐⭐⭐⭐

---

## 你将学到什么

1. **Manager 层的职责**（API + store + 业务逻辑）
2. **怎么把 host bridge 接入业务 handler**
3. **完成检测的副作用**（自动 finish）
4. **mock 模式 vs 真实模式的无缝切换**

## 前置条件

✅ 已完成 [课时 1-12](./README.md)

## 最终效果

容器内 solver 能调：
- `challenge_get_state` —— 查当前题目状态
- `challenge_submit_flag` —— 提交 flag
- `challenge_get_hint` —— 拉 hint

宿主侧：
- mock 模式下能跑完整流程（建题 → 启动 → 提交 → 完成）

---

## 第零步：概念扫盲

### 0.1 ChallengeManager 的职责

```
┌──────────────────────────────────────────┐
│  ChallengeManager (控制平面)              │
│  ├─ API client (调赛题平台)               │
│  ├─ Store (落盘)                          │
│  ├─ 业务逻辑 (start / stop / submit)      │
│  └─ Host bridge handler (容器调用入口)    │
└──────────────────────────────────────────┘
```

它是"控制平面"：
- 不亲自解题（solver 干）
- 不亲自跑工具（runtime 干）
- 负责**协调**：什么时候启动实例、什么时候提交 flag、什么时候算完成。

### 0.2 Manager 怎么被使用？

ChallengeManager 被 3 个地方调用：

1. **Planner LLM**（下节课）：通过 `planner_*` 工具调用，决定启动哪道题。
2. **Host bridge handler**（本节课）：solver 通过工具反查 challenge 状态。
3. **Web UI**：人类通过 REST API 查看进度。

---

## 第一步：实现 ChallengeManager

### 1.1 创建 packages/core/src/challenge/manager.ts

新建 `packages/core/src/challenge/manager.ts`：

```typescript
import { ChallengeApiClient } from "./api-client"
import type {
    ChallengeApiHintData,
    ChallengeApiListData,
    ChallengeApiStartData,
    ChallengeApiSubmitData,
    ChallengeApiChallenge,
} from "./api-client"
import {
    computeChallengeCompleted,
    saveChallengeRecord,
    readChallengeRecord,
    listChallengeRecords,
    appendChallengeAttemptLog,
    appendChallengeSubmissionLog,
    ensureChallengeStoreBaseDir,
    DEFAULT_CHALLENGE_DIR,
} from "./store"
import type {
    ChallengeInfoRecord,
    ChallengeRecord,
    ChallengeSubmissionLogRecord,
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
 */
export class ChallengeManager {
    private readonly config: ConfigManager
    private api: ChallengeApiClient | undefined
    private rootDir: string | undefined
    private runtime: RuntimeManager | undefined

    constructor(config: ConfigManager) {
        this.config = config
    }

    /** 注入 RuntimeManager（DaemonManager 装配时调用） */
    attachRuntime(runtime: RuntimeManager): void {
        this.runtime = runtime
    }

    getRuntime(): RuntimeManager | undefined {
        return this.runtime
    }

    /** 配置变更时清缓存 */
    reloadFromConfig(): void {
        this.api = undefined
    }

    // ── 内部工具 ────────────────────────────────────────

    private async getRootDir(): Promise<string> {
        if (this.rootDir) return this.rootDir
        await ensureChallengeStoreBaseDir(DEFAULT_CHALLENGE_DIR)
        this.rootDir = DEFAULT_CHALLENGE_DIR
        return this.rootDir
    }

    /** 是否启用 mock 模式 */
    private async isMockMode(): Promise<boolean> {
        const settings = await this.config.getHostSettings()
        return settings.challenge.mockEnabled === true
    }

    /**
     * 懒初始化 API client。
     * mock 模式用 createMock；真 API 模式用 create(baseUrl, token)。
     */
    private async getApi(): Promise<ChallengeApiClient> {
        if (this.api) return this.api

        const settings = await this.config.getHostSettings()
        if (settings.challenge.mockEnabled === true) {
            // mock 模式：用本地 store 模拟平台
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
            // 真 API 模式
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

        // 同步本地状态
        const rootDir = await this.getRootDir()
        const challenge = await readChallengeRecord(rootDir, challengeId)
        if (challenge) {
            const entrypoint = Array.isArray(remote) ? remote : challenge.entrypoint
            await saveChallengeRecord(
                rootDir,
                { ...challenge, instance_status: "running", entrypoint },
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
     *   4. 完成检测 → 若完成，调 finishChallenge
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

        const updated = await readChallengeRecord(rootDir, challengeId)
        const isCompleted = computeChallengeCompleted(updated)

        // 若完成，触发 finishChallenge
        if (isCompleted) {
            await this.finishChallenge(challengeId).catch((error) => {
                console.error("[challenge] finishChallenge error:", error)
            })
        }

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

        // 停实例
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
    async listAttemptLogs(challengeId: string): Promise<ChallengeSubmissionLogRecord[]> {
        // 简化：复用 store 的函数
        const rootDir = await this.getRootDir()
        const { listChallengeAttemptLogs } = await import("./store")
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
```

---

## 第二步：扩展 host bridge 支持 challenge action

### 2.1 修改 host-bridge-types.ts

```typescript
export type HostBridgeAction =
    | "ping"
    | "get_env"
    | "get_api_key"
    // 新增：
    | "challenge_get_state"
    | "challenge_submit_flag"
    | "challenge_get_hint"
    | "challenge_is_completed"
```

### 2.2 创建 ChallengeHostBridgeHandler

新建 `packages/core/src/challenge/host-bridge-challenge-handler.ts`：

```typescript
import type { ChallengeManager } from "./manager"
import type { ChallengeInfoRecord } from "./store"
import type {
    HostBridgeHandleContext,
    HostBridgeHandleResult,
    HostBridgeHandler,
} from "./host-bridge-handler"

/**
 * 创建 challenge 相关的 host bridge handler。
 *
 * 让容器内 solver 能调 challenge_get_state / challenge_submit_flag 等。
 */
export function createChallengeHostBridgeHandler(
    challengeManager: ChallengeManager,
): HostBridgeHandler {
    return {
        async handle(ctx: HostBridgeHandleContext): Promise<HostBridgeHandleResult> {
            // 必须有 TCH_CHALLENGE_ID 环境变量
            const challengeId = ctx.getSolverEnvValue?.("TCH_CHALLENGE_ID")
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
```

### 2.3 在 DaemonManager 注册 handler

修改 `packages/core/src/index.ts`：

```typescript
import { ChallengeManager } from "./challenge/manager"
import { createChallengeHostBridgeHandler } from "./challenge/host-bridge-challenge-handler"
import { ConfigManager } from "./config/index"
import { RuntimeManager } from "./runtime/runtime"

export class DaemonManager {
    private static instance: Promise<DaemonManager> | undefined

    readonly config: ConfigManager
    readonly challenge: ChallengeManager
    readonly runtime: RuntimeManager

    private constructor(
        config: ConfigManager,
        challenge: ChallengeManager,
        runtime: RuntimeManager,
    ) {
        this.config = config
        this.challenge = challenge
        this.runtime = runtime
    }

    static async getInstance(): Promise<DaemonManager> {
        if (this.instance) return this.instance

        const created = (async () => {
            const config = await ConfigManager.getInstance()
            const challenge = new ChallengeManager(config)
            const runtime = new RuntimeManager(config, [
                createChallengeHostBridgeHandler(challenge),
            ])
            challenge.attachRuntime(runtime)
            await runtime.init()
            return new DaemonManager(config, challenge, runtime)
        })()

        this.instance = created.catch((error) => {
            if (this.instance === created) {
                this.instance = undefined
            }
            throw error
        })
        return this.instance
    }
}
```

### 2.4 加 challenge 工具（让 LLM 能调）

新建 `packages/core/src/config/tools/challenge-tools.ts`：

```typescript
import { defineTool } from "@mariozechner/pi-coding-agent"
import { Type } from "@sinclair/typebox"
import { requestHostBridge } from "../../../challenge/host-bridge-client"

export const challengeGetStateTool = defineTool({
    name: "challenge_get_state",
    label: "Challenge Get State",
    description: "Get current challenge state (progress, hint, instance status)",
    parameters: Type.Object({}),
    async execute() {
        const result = await requestHostBridge<{
            challenge_id: string
            challenge: unknown
            is_completed: boolean
        }>("challenge_get_state", {})
        return {
            content: [
                { type: "text", text: JSON.stringify(result, null, 2) },
            ],
        }
    },
})

export const challengeSubmitFlagTool = defineTool({
    name: "challenge_submit_flag",
    label: "Submit Flag",
    description: "Submit a flag for the current challenge",
    parameters: Type.Object({
        flag: Type.String({ description: "Flag value to submit" }),
        writeup: Type.Optional(
            Type.String({ description: "Optional writeup of how you got it" }),
        ),
    }),
    async execute(_id, params) {
        const result = await requestHostBridge<{
            correct: boolean
            flag_got_count: number
            flag_count: number
            is_completed: boolean
        }>("challenge_submit_flag", {
            flag: params.flag,
            ...(params.writeup ? { writeup: params.writeup } : {}),
        })
        return {
            content: [
                {
                    type: "text",
                    text: `submitted flag=${params.flag}: ${result.correct ? "correct" : "incorrect"} (${result.flag_got_count}/${result.flag_count}${result.is_completed ? ", completed" : ""})`,
                },
            ],
        }
    },
})

export const challengeGetHintTool = defineTool({
    name: "challenge_get_hint",
    label: "Get Hint",
    description: "Get hint for the current challenge",
    parameters: Type.Object({}),
    async execute() {
        const result = await requestHostBridge<{ hint_content: string | null }>(
            "challenge_get_hint",
            {},
        )
        return {
            content: [
                { type: "text", text: result.hint_content ?? "(no hint available)" },
            ],
        }
    },
})

export const challengeTools = [challengeGetStateTool, challengeSubmitFlagTool, challengeGetHintTool]
```

### 2.5 在 resolvePromptSession 注册工具

修改 `packages/core/src/config/index.ts` 的 `resolvePromptSession`：

```typescript
// 顶部加 import
import { challengeTools } from "./tools/challenge-tools"

// 把 challengeTools 加到 customTools：
const opts: CreateAgentSessionOptions = {
    tools,
    customTools: [...hostBridgeTools, ...challengeTools],
    // ...
}
```

---

## 第三步：CLI 命令

```typescript
// challenge 命令组里加 sync
challengeCmd
    .command("sync")
    .description("Sync challenges from API (or mock)")
    .action(async () => {
        const { DaemonManager } = await import("@my/core")
        const daemon = await DaemonManager.getInstance()
        const result = await daemon.challenge.listChallenges()
        console.log(`Remote: ${result.remote.total_challenges} challenges`)
        console.log(`Local: ${result.local.length} records`)
    })
```

---

## 第四步：验证

### 4.1 开启 mock 模式 + 创建题目

```bash
bun run apps/cli/src/main.ts settings set challenge.mockEnabled true
bun run apps/cli/src/main.ts challenge create \
  --id test-1 \
  --title "Test CTF" \
  --flag-count 1 \
  --total-score 100

# mock 模式下，需要手动加 flags（真实平台会下发）
# 直接编辑 challenge.json，加 "flags": ["flag{test}"]
cat ~/.tch-agent/challenge/test-1/challenge.json | jq '. + {flags: ["flag{test}"]}' > /tmp/c.json && mv /tmp/c.json ~/.tch-agent/challenge/test-1/challenge.json
```

### 4.2 sync 验证

```bash
bun run apps/cli/src/main.ts challenge sync
```

**预期**：

```
Remote: 1 challenges
Local: 1 records
```

### 4.3 启动 + 提交

写个测试脚本：

```bash
cat > /tmp/test-mgr.ts << 'EOF'
import { DaemonManager } from "@my/core"

const daemon = await DaemonManager.getInstance()
const mgr = daemon.challenge

console.log("Starting...")
await mgr.startChallenge("test-1")

console.log("Submitting wrong flag...")
const wrong = await mgr.submitFlag("test-1", "wrong")
console.log(`  correct: ${wrong.remote.correct}, got ${wrong.remote.flag_got_count}/${wrong.remote.flag_count}`)

console.log("Submitting correct flag...")
const correct = await mgr.submitFlag("test-1", "flag{test}")
console.log(`  correct: ${correct.remote.correct}, got ${correct.remote.flag_got_count}/${correct.remote.flag_count}`)
console.log(`  is_completed: ${correct.is_completed}`)

console.log("Done")
EOF
bun run /tmp/test-mgr.ts
```

**预期**：

```
Starting...
Submitting wrong flag...
  correct: false, got 0/1
Submitting correct flag...
  correct: true, got 1/1
  is_completed: true
Done
```

### 4.4 类型检查

```bash
bun run typecheck
```

---

## 第五步：故障排查

### 问题 1：`Challenge API not configured`

**原因**：mock 模式没开，但也没配真 API。

**解决**：

```bash
# 要么开 mock
bun run apps/cli/src/main.ts settings set challenge.mockEnabled true

# 要么配真 API
bun run apps/cli/src/main.ts settings set challenge.apiBaseUrl https://...
bun run apps/cli/src/main.ts settings set challenge.agentToken xxx
```

### 问题 2：mock submit flag 一直 correct=false

**原因**：mock 模式下 `flags` 字段需要手动设置（真实 API 会下发）。

**解决**：

```bash
cat ~/.tch-agent/challenge/test-1/challenge.json | jq '. + {flags: ["flag{test}"]}' > /tmp/c.json
mv /tmp/c.json ~/.tch-agent/challenge/test-1/challenge.json
```

### 问题 3：finishChallenge 没停 solver

**原因**：可能 runtime 没注入 challenge（attachRuntime 没调）。

**解决**：确保用 `DaemonManager.getInstance()` 拿 mgr（它会自动 attach）。

### 问题 4：host bridge 找不到 challengeId

**原因**：solver 容器没注入 `TCH_CHALLENGE_ID` 环境变量。

**解决**：跑 launch 时加 env：

```bash
tch-agent runtime launch --prompt SOLVER -e TCH_CHALLENGE_ID=test-1 "..."
```

---

## 本课小结

✅ **你已完成**：

- 实现 ChallengeManager（API + store + 业务逻辑）
- 实现 mock 模式的完整平台行为
- 实现 finishChallenge 自动收尾
- 加 challenge host bridge handler
- 加 challenge 工具让 LLM 能查 / 提交
- DaemonManager 装配升级

📦 **新增文件**：

```
packages/core/src/challenge/
├── manager.ts                          ← ChallengeManager 控制平面
└── host-bridge-challenge-handler.ts    ← challenge host bridge handler

packages/core/src/config/tools/challenge-tools.ts   ← LLM 工具
```

🔑 **关键概念**：

- **控制平面**：不亲自干活，协调 API / store / runtime。
- **mock 完整实现**：让离线开发也能跑通整个流程。
- **finishChallenge 副作用**：完成检测后自动停实例 + 停 solver。
- **host bridge 业务 handler**：把 Manager 方法暴露给容器。

---

## 下一课预告

[课时 14：Planner LLM 调度循环](./14-planner-loop.md)（待生成）—— 我们会：

- 实现 30s 周期的 Planner 循环
- 实现 planner_* 工具（让 LLM 调度 solver）
- 实现 launchSolver（Manager → Runtime）

继续课时 14 →
