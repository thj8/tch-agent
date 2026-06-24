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
}

export type ModelConfigEntry = {
  // 用户起的不重复 ID，如 "work-gpt4"
  id: string

  // 内容 hash（可选）
  hash?: string

  provider: string
  providerId: string

  // 真实model id（如"gpt-4"）
  modelId: string

  // 默认推理强度（low / medium / high / xhigh
  thinkingLevel?: string

} & Partial<Omit<Model<Api>, "id" | "provider" | "api" | "baseUrl">>
