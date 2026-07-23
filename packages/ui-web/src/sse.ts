/**
 * SSE 帧编码（课时 15）。
 *
 * 把一个 (event, data) 编码成 SSE 文本帧：
 *   `event: <name>\ndata: <json>\n\n`
 * 提成纯函数 + 单独文件，便于单元测试 wire format——格式错了浏览器一个事件都收不到。
 *
 * 注释帧（`: connected` / `: keepalive`）不是本函数职责，由 server 直接 TextEncoder.encode。
 */
export function encodeSse(event: string, data: unknown): Uint8Array {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
    return new TextEncoder().encode(payload)
}
