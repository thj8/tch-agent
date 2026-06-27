export interface SolverInfo {
    id: string
    status: string
    promptName: string
    containerId: string
    createdAt?: number
}

export interface ProviderPrefEntry {
    id: string
    hash?: string
    name: string
    api?: string
    baseUrl?: string
    apiKey?: string
    models?: string[]
}

export interface ModelConfigEntry {
    id: string
    hash?: string
    provider: string
    modelId: string
    thinkingLevel?: string
    contextWindow?: number
    maxTokens?: number
}

export interface AddResult {
    id: string
    rejected?: string
}

export const PROVIDER_APIS = [
    "openai-completions",
    "anthropic-messages",
    "google-gemini",
    "ollama",
] as const

export const THINKING_LEVELS = ["low", "medium", "high", "xhigh"] as const
