import type { ProviderConfig } from "@mariozechner/pi-coding-agent"
import type { Model, Api } from "@mariozechner/pi-ai"


export interface CustomProvider {
  name: string
  config: ProviderConfig
}

export interface ProviderPrefEntry {
  id: string
  hash?: string
  name: string
  //协议：openai-completions / anthropic-messages / google-gemini / ollama
  api?: string
  baseUrl?: string
  apiKey?: string
  /**
   * 自定义 model ID 列表（如 ["glm-5", "glm-5.2"]）。
   *
   * - 不填：走 SDK override-only 模式（name 必须是 SDK 内置 provider，
   *   如 anthropic / openai，替换 baseUrl 复用 SDK 自带 model 列表）
   * - 填了：走 full registration，SDK 注册一个全新 provider（name 可任意），
   *   每个 model 用合理默认元数据注册成 ModelRegistry 里的实体
   */
  models?: string[]
}

export type ModelConfigEntry = {
  // 用户起的不重复 ID，如 "work-gpt4"
  id: string

  // 内容 hash（可选）
  hash?: string

  // SDK provider 名（openai / anthropic / glm / ...），ModelRegistry 查 model 用
  provider: string

  // 真实 model id（如 "gpt-4" / "glm-5"）
  modelId: string

  // 默认推理强度（low / medium / high / xhigh）
  thinkingLevel?: string

} & Partial<Omit<Model<Api>, "id" | "provider" | "api" | "baseUrl">>
