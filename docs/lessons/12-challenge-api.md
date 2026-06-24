# 课时 12：Challenge API 客户端 + Mock 模式

> 🎯 **目标**：封装赛题平台 REST API + 实现限流 + 实现 mock 模式（离线可跑）。
>
> ⏰ **预计耗时**：2-3 小时
>
> 📋 **难度**：⭐⭐⭐

---

## 你将学到什么

1. **REST API 客户端的标准设计**（信封 / 鉴权 / 限流 / 超时）
2. **Promise 链串行化**（实现请求限流）
3. **mock 模式设计**（让生产代码和测试代码共用接口）

## 前置条件

✅ 已完成 [课时 1-11](./README.md)

## 最终效果

```bash
# mock 模式
tch-agent challenge mock-mode --enable
tch-agent challenge sync         # 同步赛题列表（mock）

# 或对接真实平台
tch-agent challenge mock-mode --disable
tch-agent config host-settings set challenge.apiBaseUrl https://api.ctf.example.com
tch-agent config host-settings set challenge.agentToken xxx
```

---

## 第零步：概念扫盲

### 0.1 REST API 客户端的标准组件

一个生产级 API 客户端需要：

| 组件 | 作用 |
|---|---|
| **统一信封解析** | 平台返回 `{ code, message, data }`，code !== 0 抛错 |
| **鉴权** | 每个请求带 token（header / cookie / query） |
| **限流** | 防止打爆对方服务器 |
| **超时** | 防止单请求卡死整个程序 |
| **错误归一** | 统一错误格式，便于上层处理 |
| **mock 模式** | 不真发 HTTP，用本地数据模拟 |

### 0.2 限流的实现

平台限流通常是 "X RPS"（每秒 X 次请求）。客户端要"自我节流"避免触发对方限流。

```typescript
// 简单实现：串行化所有请求
let schedule = Promise.resolve()
let nextAvailableAt = 0

async function runLimited<T>(fn: () => Promise<T>): Promise<T> {
    // 等待前面的请求完成 + 限流窗口
    await schedule
    const now = Date.now()
    const waitMs = Math.max(0, nextAvailableAt - now)
    if (waitMs > 0) await Bun.sleep(waitMs)
    nextAvailableAt = Date.now() + 333   // 333ms = 3 RPS

    return fn()
}
```

**关键**：`schedule` 是个 Promise 链尾，每个新请求都接到链尾，保证按发起顺序串行。

### 0.3 mock 模式

生产代码和 mock 代码用同一套接口：

```typescript
interface ChallengeApi {
    listChallenges(): Promise<...>
    submitFlag(code, flag): Promise<...>
}

// 真 API
class RealChallengeApi implements ChallengeApi { ... }

// mock
class MockChallengeApi implements ChallengeApi { ... }
```

工厂方法根据配置选哪个：

```typescript
function createChallengeApi(settings): ChallengeApi {
    return settings.mock ? new MockChallengeApi() : new RealChallengeApi(settings)
}
```

---

## 第一步：实现 ChallengeApiClient

### 1.1 创建 packages/core/src/challenge/api-client.ts

新建 `packages/core/src/challenge/api-client.ts`：

```typescript
/**
 * 与赛题平台 REST API 的封装。
 *
 * 平台 API：
 *   GET  /api/challenges       列出所有赛题
 *   POST /api/start_challenge  启动赛题实例
 *   POST /api/stop_challenge   停止赛题实例
 *   POST /api/submit           提交 flag
 *   POST /api/hint             拉取 hint
 *
 * 鉴权：Agent-Token HTTP header
 * 响应信封：{ code, message, data }，code === 0 才算成功
 */

/** 平台 API 的统一响应信封 */
export interface ChallengeApiEnvelope<T> {
    code: number
    message: string
    data: T
}

/** 一道赛题在平台 API 视角下的描述 */
export interface ChallengeApiChallenge {
    title: string
    code: string  // 赛题 ID
    difficulty: string
    description: string
    level: number
    total_score: number
    total_got_score: number
    flag_count: number
    flag_got_count: number
    hint_viewed: boolean
    instance_status: string
    entrypoint: string[] | null
}

export interface ChallengeApiListData {
    current_level: number
    total_challenges: number
    solved_challenges: number
    challenges: ChallengeApiChallenge[]
}

export interface ChallengeApiSubmitData {
    correct: boolean
    message: string
    flag_count: number
    flag_got_count: number
}

export interface ChallengeApiHintData {
    code: string
    hint_content: string | null
}

export type ChallengeApiStartData = string[] | { already_completed: boolean }

// ── 限流常量 ────────────────────────────────────────────

/** 平台限流：3 RPS */
const CHALLENGE_API_MAX_REQUESTS_PER_SECOND = 3
const CHALLENGE_API_REQUEST_INTERVAL_MS = Math.ceil(1000 / CHALLENGE_API_MAX_REQUESTS_PER_SECOND)
const CHALLENGE_API_REQUEST_TIMEOUT_MS = 2500

// ── Mock State 接口 ─────────────────────────────────────

/** mock 模式下需要提供的状态接口 */
type ChallengeApiMockState = {
    listChallenges: () => Promise<ChallengeApiListData>
    startChallenge: (code: string) => Promise<ChallengeApiStartData>
    stopChallenge: (code: string) => Promise<null>
    submitFlag: (code: string, flag: string) => Promise<ChallengeApiSubmitData>
    getHint: (code: string) => Promise<ChallengeApiHintData>
}

// ── 工具函数 ────────────────────────────────────────────

function requireText(value: string | undefined, fieldName: string): string {
    const text = value?.trim() ?? ""
    if (!text) throw new Error(`${fieldName} is required`)
    return text
}

function stripTrailingSlash(value: string): string {
    return value.endsWith("/") ? value.slice(0, -1) : value
}

function normalizeBaseUrl(value: string): string {
    const baseUrl = stripTrailingSlash(requireText(value, "baseUrl"))
    return baseUrl.endsWith("/api") ? baseUrl : `${baseUrl}/api`
}

function formatRequestError(error: unknown): string {
    if (error instanceof Error) {
        const message = error.message.trim()
        return message || error.name
    }
    return String(error)
}

function hasHeader(headers: Headers, name: string): boolean {
    return headers.has(name) || headers.has(name.toLowerCase()) || headers.has(name.toUpperCase())
}

// ── 客户端类 ────────────────────────────────────────────

export class ChallengeApiClient {
    readonly baseUrl: string
    readonly agentToken: string
    private readonly mockState?: ChallengeApiMockState
    /** 下一次允许发请求的最早时间戳 */
    private nextRequestAt = 0
    /** 串行化 Promise 链尾 */
    private schedule = Promise.resolve()

    private constructor(baseUrl: string, agentToken: string, mockState?: ChallengeApiMockState) {
        this.baseUrl = normalizeBaseUrl(baseUrl)
        this.agentToken = requireText(agentToken, "agentToken")
        this.mockState = mockState
    }

    /** 生产模式 */
    static create(baseUrl: string, agentToken: string): ChallengeApiClient {
        return new ChallengeApiClient(baseUrl, agentToken)
    }

    /** mock 模式 */
    static createMock(mockState: ChallengeApiMockState): ChallengeApiClient {
        return new ChallengeApiClient("mock://challenge-api", "mock-agent-token", mockState)
    }

    // ── API 方法 ────────────────────────────────────────

    async listChallenges(): Promise<ChallengeApiListData> {
        return this.runLimited(() => {
            if (this.mockState) return this.mockState.listChallenges()
            return this.request<ChallengeApiListData>("/challenges", "GET")
        })
    }

    async startChallenge(code: string): Promise<ChallengeApiStartData> {
        return this.runLimited(() => {
            const c = requireText(code, "code")
            if (this.mockState) return this.mockState.startChallenge(c)
            return this.request<ChallengeApiStartData>("/start_challenge", "POST", { code: c })
        })
    }

    async stopChallenge(code: string): Promise<null> {
        return this.runLimited(() => {
            const c = requireText(code, "code")
            if (this.mockState) return this.mockState.stopChallenge(c)
            return this.request<null>("/stop_challenge", "POST", { code: c })
        })
    }

    async submitFlag(code: string, flag: string): Promise<ChallengeApiSubmitData> {
        return this.runLimited(() => {
            const c = requireText(code, "code")
            const f = requireText(flag, "flag")
            if (this.mockState) return this.mockState.submitFlag(c, f)
            return this.request<ChallengeApiSubmitData>("/submit", "POST", { code: c, flag: f })
        })
    }

    async getHint(code: string): Promise<ChallengeApiHintData> {
        return this.runLimited(() => {
            const c = requireText(code, "code")
            if (this.mockState) return this.mockState.getHint(c)
            return this.request<ChallengeApiHintData>("/hint", "POST", { code: c })
        })
    }

    // ── 限流核心 ────────────────────────────────────────

    /**
     * 包一层限流：执行任何 API 调用前先排队等待限流窗口。
     *
     * 实现要点：
     *   - 多个并发请求严格按发起顺序执行（schedule 链）。
     *   - 任意两个请求之间至少间隔 CHALLENGE_API_REQUEST_INTERVAL_MS。
     */
    private async runLimited<T>(run: () => Promise<T>): Promise<T> {
        await this.waitForRateLimitWindow()
        return run()
    }

    private async waitForRateLimitWindow(): Promise<void> {
        let release!: () => void
        const ready = new Promise<void>((resolve) => {
            release = resolve
        })

        const previous = this.schedule
        this.schedule = (async () => {
            await previous
            const now = Date.now()
            const waitMs = Math.max(0, this.nextRequestAt - now)
            if (waitMs > 0) await Bun.sleep(waitMs)
            this.nextRequestAt = Math.max(this.nextRequestAt, Date.now()) + CHALLENGE_API_REQUEST_INTERVAL_MS
            release()
        })()
        await ready
    }

    // ── HTTP 请求 ──────────────────────────────────────

    private async request<T>(
        path: string,
        method: "GET" | "POST",
        payload?: Record<string, unknown>,
    ): Promise<T> {
        const headers: Record<string, string> = {
            "Agent-Token": this.agentToken,
        }
        const requestInit: RequestInit = { method, headers }

        if (payload) {
            headers["Content-Type"] = "application/json"
            requestInit.body = JSON.stringify(payload)
        }

        // 2.5s 超时
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), CHALLENGE_API_REQUEST_TIMEOUT_MS)

        let response: Response
        try {
            response = await fetch(`${this.baseUrl}${path}`, {
                ...requestInit,
                signal: controller.signal,
            })
        } catch (error) {
            if (error instanceof Error && error.name === "AbortError") {
                throw new Error(`challenge api ${method} ${path} timeout after ${CHALLENGE_API_REQUEST_TIMEOUT_MS}ms`)
            }
            throw new Error(`challenge api ${method} ${path} request failed: ${formatRequestError(error)}`)
        } finally {
            clearTimeout(timeout)
        }

        // 解析响应
        let envelope: ChallengeApiEnvelope<T> | undefined
        try {
            envelope = (await response.json()) as ChallengeApiEnvelope<T>
        } catch {
            if (!response.ok) {
                throw new Error(`challenge api ${method} ${path} failed with HTTP ${response.status}`)
            }
            throw new Error(`challenge api ${method} ${path} returned invalid json`)
        }

        if (!response.ok) {
            const message = envelope?.message?.trim() || `HTTP ${response.status}`
            throw new Error(`challenge api ${method} ${path} failed: ${message}`)
        }

        if (!envelope || envelope.code !== 0) {
            const message = envelope?.message?.trim() || "unknown error"
            throw new Error(`challenge api ${method} ${path} failed: ${message}`)
        }

        return envelope.data
    }
}
```

---

## 第二步：在 ConfigManager 加 HostSettings 管理

### 2.1 修改 packages/core/src/config/types.ts

替换内容：

```typescript
export interface HostChallengeSettings {
    /** true 时用本地数据模拟平台 */
    mockEnabled?: boolean
    /** 真 API base URL */
    apiBaseUrl?: string
    /** 平台 agent token */
    agentToken?: string
}

export interface HostSettings {
    runtime: HostRuntimeSettings
    challenge: HostChallengeSettings
}
```

### 2.2 在 ConfigManager 加方法

修改 `packages/core/src/config/index.ts`：

```typescript
// 顶部加 imports
import type { HostSettings, HostChallengeSettings } from "./types"

// 在 ConfigManager 类里：

/** 读 host-settings.json */
async getHostSettings(): Promise<HostSettings> {
    const file = Bun.file(join(this.dir, "host-settings.json"))
    if (!(await file.exists())) {
        return { runtime: {}, challenge: {} }
    }
    try {
        const data = await file.json()
        return data as HostSettings
    } catch {
        return { runtime: {}, challenge: {} }
    }
}

/** 写 host-settings.json */
async setHostSettings(patch: Partial<HostSettings>): Promise<HostSettings> {
    const current = await this.getHostSettings()
    const next: HostSettings = {
        runtime: { ...current.runtime, ...(patch.runtime ?? {}) },
        challenge: { ...current.challenge, ...(patch.challenge ?? {}) },
    }
    await Bun.write(join(this.dir, "host-settings.json"), JSON.stringify(next, null, 2))
    return next
}

/** 便捷方法：判断是否启用 mock 模式 */
async isChallengeMockMode(): Promise<boolean> {
    const settings = await this.getHostSettings()
    return settings.challenge.mockEnabled === true
}
```

---

## 第三步：CLI 命令

在 `apps/cli/src/main.ts` 加：

```typescript
// ── host-settings 命令 ──────────────────────────────────

const settingsCmd = program.command("settings").description("Host settings")

settingsCmd
    .command("show")
    .description("Show current host settings")
    .action(async () => {
        const { ConfigManager } = await import("@my/core")
        const config = await ConfigManager.getInstance()
        const settings = await config.getHostSettings()
        console.log(JSON.stringify(settings, null, 2))
    })

settingsCmd
    .command("set")
    .description("Set a host setting (use dot notation: challenge.mockEnabled)")
    .argument("<path>", "Setting path (e.g., challenge.mockEnabled)")
    .argument("<value>", "Value (true/false/string)")
    .action(async (path: string, value: string) => {
        const { ConfigManager } = await import("@my/core")
        const config = await ConfigManager.getInstance()

        // 解析 value
        let typedValue: unknown
        if (value === "true") typedValue = true
        else if (value === "false") typedValue = false
        else typedValue = value

        // 解析 path（简化：只支持 challenge.xxx / runtime.xxx）
        const [section, key] = path.split(".")
        if (section !== "challenge" && section !== "runtime") {
            console.error(`✗ Invalid path: ${path}. Use challenge.xxx or runtime.xxx`)
            process.exit(1)
        }

        const settings = await config.getHostSettings()
        if (section === "challenge") {
            await config.setHostSettings({
                challenge: { ...settings.challenge, [key!]: typedValue },
            })
        } else {
            await config.setHostSettings({
                runtime: { ...settings.runtime, [key!]: typedValue },
            })
        }
        console.log(`✓ Set ${path} = ${value}`)
    })
```

---

## 第四步：验证

### 4.1 开启 mock 模式

```bash
bun run apps/cli/src/main.ts settings set challenge.mockEnabled true
bun run apps/cli/src/main.ts settings show
```

**预期**：

```json
{
  "runtime": {},
  "challenge": {
    "mockEnabled": true
  }
}
```

### 4.2 写一个 mock 测试脚本

```bash
cat > /tmp/test-mock-api.ts << 'EOF'
import { ChallengeApiClient } from "@my/core"

const client = ChallengeApiClient.createMock({
    listChallenges: async () => ({
        current_level: 1,
        total_challenges: 1,
        solved_challenges: 0,
        challenges: [{
            title: "Test CTF",
            code: "test-1",
            difficulty: "easy",
            description: "",
            level: 1,
            total_score: 100,
            total_got_score: 0,
            flag_count: 1,
            flag_got_count: 0,
            hint_viewed: false,
            instance_status: "stopped",
            entrypoint: null,
        }],
    }),
    startChallenge: async () => ["127.0.0.1:8080"],
    stopChallenge: async () => null,
    submitFlag: async (code, flag) => ({
        correct: flag === "flag{test}",
        message: "",
        flag_count: 1,
        flag_got_count: flag === "flag{test}" ? 1 : 0,
    }),
    getHint: async () => ({ code: "test-1", hint_content: "look at /etc/passwd" }),
})

console.log("List:", await client.listChallenges())
console.log("Start:", await client.startChallenge("test-1"))
console.log("Submit (wrong):", await client.submitFlag("test-1", "wrong"))
console.log("Submit (correct):", await client.submitFlag("test-1", "flag{test}"))
console.log("Hint:", await client.getHint("test-1"))
EOF
bun run /tmp/test-mock-api.ts
```

**预期**：所有调用都成功，能看到 mock 返回的数据。

### 4.3 类型检查

```bash
bun run typecheck
```

---

## 第五步：故障排查

### 问题 1：真实 API 调用超时

**原因**：网络慢或平台不可达。

**解决**：
- 增大 `CHALLENGE_API_REQUEST_TIMEOUT_MS`
- 检查网络 / 代理

### 问题 2：限流过于严格

**原因**：限流间隔太长。

**解决**：调小 `CHALLENGE_API_REQUEST_INTERVAL_MS`（但不要超过平台的实际限制）。

### 问题 3：mock 模式下行为和真实 API 不一致

**原因**：mock 回调返回的数据结构和真实 API 不一致。

**解决**：用 `ChallengeApiListData` 等类型约束 mock 返回值。

### 问题 4：`Agent-Token` header 被代理剥离

**原因**：某些反向代理会过滤非标准 header。

**解决**：联系平台管理员，或换标准 header（如 `Authorization: Bearer xxx`）。

---

## 本课小结

✅ **你已完成**：

- 实现 ChallengeApiClient（带限流 / 超时 / 信封解析）
- 实现 mock 模式（同一接口两套实现）
- 加 host-settings 管理
- 加 settings CLI 命令

📦 **新增文件**：

```
packages/core/src/challenge/api-client.ts
```

🔑 **关键概念**：

- **限流 = 串行化 Promise 链**：所有请求按发起顺序串行 + 间隔保护。
- **mock 模式**：实现同一接口的两种实现，按配置切换。
- **统一信封**：`{ code, message, data }` 让错误处理统一。

---

## 下一课预告

[课时 13：ChallengeManager 控制平面](./13-challenge-manager.md)（待生成）—— 我们会：

- 实现 ChallengeManager（封装 API + store）
- 实现 start/stop/submit/hint
- 接入 host bridge（让 solver 能调）

继续课时 13 →
