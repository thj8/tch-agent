/**
 * 容器侧 host bridge client。
 *
 * 通过 stdout 写 host_bridge_request 事件给宿主，
 * 等宿主通过 stdin 推回 host_bridge_response。
 * 用 request_id 在 pendingRequests Map 里配对 Promise。
 */

import type { HostBridgeAction, HostBridgeRequestEvent } from "./host-bridge-types"

interface PendingRequest {
    resolve: (value: unknown) => void
    reject: (error: Error) => void
    timer: ReturnType<typeof setTimeout>
}

const pendingRequests = new Map<string, PendingRequest>()

const DEFAULT_TIMEOUT_MS = 30_000

function toErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}

function serializeJsonLine(value: unknown): string {
    return `${JSON.stringify(value)}\n`
}

/**
 * 向宿主发起一次 bridge 请求并等待响应。
 *
 * @throws 超时 / 宿主返回 error / stdout 写入失败
 */
export async function requestHostBridge<T>(
    action: HostBridgeAction,
    params: unknown,
): Promise<T> {
    const requestId = crypto.randomUUID()
    const event: HostBridgeRequestEvent = {
        type: "host_bridge_request",
        request_id: requestId,
        action,
        params,
    }

    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
            pendingRequests.delete(requestId)
            reject(new Error(`host bridge timeout: ${action}`))
        }, DEFAULT_TIMEOUT_MS)

        pendingRequests.set(requestId, {
            resolve: (value) => resolve(value as T),
            reject,
            timer,
        })

        try {
            process.stdout.write(serializeJsonLine(event))
        } catch (error) {
            clearTimeout(timer)
            pendingRequests.delete(requestId)
            reject(new Error(`host bridge write failed: ${toErrorMessage(error)}`))
        }
    })
}

/**
 * 配对宿主返回的响应。
 * 被 RPC server 在收到 host_bridge_response 命令时调用。
 */
export function resolveHostBridgeResponse(
    requestId: string,
    success: boolean,
    data?: unknown,
    error?: string,
): void {
    const pending = pendingRequests.get(requestId)
    if (!pending) return

    pendingRequests.delete(requestId)
    clearTimeout(pending.timer)

    if (!success) {
        pending.reject(new Error(error?.trim() || "host bridge request failed"))
        return
    }
    pending.resolve(data)
}
