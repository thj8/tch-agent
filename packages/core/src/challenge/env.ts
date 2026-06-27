/**
 * env.ts：challenge 模式下注入 Solver 容器的环境变量名常量。
 *
 * Manager 启动 challenge solver 时把这些变量塞进容器 env；
 * Solver 容器内的 extension / host-bridge-client 通过它们知道
 * "自己在做哪道题、平台 API 在哪、鉴权 token 是什么"。
 */

export const CHALLENGE_ENV_CHALLENGE_ID = "TCH_CHALLENGE_ID"
export const CHALLENGE_ENV_DIR = "TCH_CHALLENGE_DIR"
export const CHALLENGE_ENV_API_BASE_URL = "TCH_CHALLENGE_API_BASE_URL"
export const CHALLENGE_ENV_AGENT_TOKEN = "TCH_CHALLENGE_AGENT_TOKEN"
