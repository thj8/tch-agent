export interface AddResult {
  id: string
  rejected?: string
}

export interface HostRuntimeSettings {
  image?: string
  env?: Record<string, string>
  solverEnv?: Record<string, string>
  binds?: string[]
  // 并发solver上限，默认是7
  maxSolvers?: number
  networkMode?: "bridge" | "host"
}

/** challenge 子系统相关 host 设置（lesson 12） */
export interface HostChallengeSettings {
  /** true 时用本地数据模拟平台（离线可跑） */
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
