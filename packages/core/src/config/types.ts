export interface AddResult {
  id: string
  rejected?: string
}

export interface HostRuntimeSettings {
  image?: string
  env?: Record<string, string>
  solverEnv: Record<string, string>
  binds?: string[]
  // 并发solver上限，默认是7 
  maxSolvers?: number
  networkMode?: "bridge" | "host"
}

export interface HostSettings {
  runtime: HostRuntimeSettings
  /** 允许其他字段（challenge / planner 课时会扩展） */
  [key: string]: unknown
}
