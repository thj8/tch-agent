import { defineTool } from "@mariozechner/pi-coding-agent"
import { Type } from "typebox"
import { requestHostBridge } from "../../challenge/host-bridge-client"

/** Ping 工具：测试 host bridge 连通性 */
export const pingHostTool = defineTool({
    name: "ping_host",
    label: "Ping Host",
    description: "Test connectivity to the host process",
    parameters: Type.Object({}),
    async execute() {
        const result = await requestHostBridge<{ pong: boolean; time: number }>("ping", {})
        return {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
            details: undefined,
        }
    },
})

/** 读 env 工具 */
export const getEnvTool = defineTool({
    name: "get_env",
    label: "Get Environment Variable",
    description: "Read an environment variable from the host",
    parameters: Type.Object({
        key: Type.String({ description: "Environment variable name" }),
    }),
    async execute(_toolCallId, params) {
        const result = await requestHostBridge<{ value?: string }>("get_env", { key: params.key })
        return {
            content: [
                { type: "text", text: `${params.key}=${result.value ?? "(unset)"}` },
            ],
            details: undefined,
        }
    },
})

/** 检查 API Key 是否配置 */
export const hasApiKeyTool = defineTool({
    name: "has_api_key",
    label: "Check API Key",
    description: "Check if an API key is configured for a provider",
    parameters: Type.Object({
        provider: Type.String({ description: "Provider name (e.g., openai)" }),
    }),
    async execute(_toolCallId, params) {
        const result = await requestHostBridge<{ exists: boolean }>("get_api_key", {
            provider: params.provider,
        })
        return {
            content: [
                { type: "text", text: `${params.provider}: ${result.exists ? "configured" : "not configured"}` },
            ],
            details: undefined,
        }
    },
})

export const hostBridgeTools = [pingHostTool, getEnvTool, hasApiKeyTool]
