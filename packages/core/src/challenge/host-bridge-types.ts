/**
 * Host bridge 协议类型。
 *
 * Solver 容器通过 stdout 发起 host_bridge_request，
 * 宿主处理后通过 stdin 推回 host_bridge_response。
 */

export type HostBridgeAction =
    | "ping"
    | "get_env"
    | "get_api_key"

export interface HostBridgeRequestEvent {
    type: "host_bridge_request"
    request_id: string
    action: HostBridgeAction
    params: unknown
}
