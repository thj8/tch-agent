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
 *
 * mock 模式（createMock）：不发 HTTP，所有方法走注入的 mockState 回调，
 * 让生产代码和测试代码共用同一套接口。
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
export type ChallengeApiMockState = {
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

// ── 客户端类 ────────────────────────────────────────────

export class ChallengeApiClient {
  readonly baseUrl: string
  readonly agentToken: string
  private readonly mockState?: ChallengeApiMockState
  /** 下一次允许发请求的最早时间戳 */
  private nextRequestAt = 0
  /** 串行化 Promise 链尾：保证请求按发起顺序排队 */
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

  /** 是否 mock 模式 */
  isMock(): boolean {
    return this.mockState !== undefined
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
