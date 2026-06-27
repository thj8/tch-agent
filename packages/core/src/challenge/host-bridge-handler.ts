/**
 * 宿主侧 host bridge handler。
 *
 * 在 RuntimeManager 里注册成链：收到 host_bridge_request 时
 * 按顺序试 handler，第一个返回 handled:true 的胜出。
 */

import type { HostBridgeAction, HostBridgeRequestEvent } from "./host-bridge-types"

export interface HostBridgeHandleContext {
    solverId: string
    action: HostBridgeAction
    params: unknown
    getSolverEnvValue?: (key: string) => string | undefined
    hasApiKey?: (provider: string) => boolean
}

export interface HostBridgeHandleResult {
    handled: boolean
    data?: unknown
}

export interface HostBridgeHandler {
    handle(ctx: HostBridgeHandleContext): Promise<HostBridgeHandleResult>
}

export function createBuiltinHostBridgeHandler(
    options: {
        getSolverEnvValue?: (solverId: string, key: string) => string | undefined
        hasApiKey?: (provider: string) => boolean
    } = {},
): HostBridgeHandler {
    return {
        async handle(ctx: HostBridgeHandleContext): Promise<HostBridgeHandleResult> {
            switch (ctx.action) {
                case "ping": {
                    return { handled: true, data: { pong: true, time: Date.now() } }
                }

                case "get_env": {
                    const params = (ctx.params ?? {}) as { key?: string }
                    const key = params.key
                    if (!key) return { handled: true, data: { value: undefined } }
                    const value = ctx.getSolverEnvValue?.(key)
                        ?? options.getSolverEnvValue?.(ctx.solverId, key)
                    return { handled: true, data: { value } }
                }

                case "get_api_key": {
                    const params = (ctx.params ?? {}) as { provider?: string }
                    const provider = params.provider
                    if (!provider) return { handled: true, data: { exists: false } }
                    return { handled: true, data: { exists: options.hasApiKey?.(provider) ?? false } }
                }

                default:
                    return { handled: false }
            }
        },
    }
}

/** 类型仅用于让外部消费 HostBridgeRequestEvent 时不必重复 import */
export type { HostBridgeRequestEvent }
