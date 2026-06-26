import { StringDecoder } from "node:string_decoder"
import type { Readable } from "node:stream"

/**
 * 把任意值序列化成 `JSON\n` 一行。
 */
export function serializeJsonLine(value: unknown): string {
    return `${JSON.stringify(value)}\n`
}

/**
 * 把一个 Readable 流按行切分，每读到一行就调用 onLine。
 *
 * 处理两个边界情况：
 *   1. 一个 chunk 可能含多行 / 半行（甚至半字符，因为 UTF-8 多字节字符可能被切断）
 *      用 StringDecoder 处理跨 chunk 的多字节字符。
 *   2. 最后一个 chunk 可能没有 trailing newline；在 stream end 时 flush。
 *
 * @returns 取消订阅函数
 */
export function attachJsonlLineReader(
    stream: Readable,
    onLine: (line: string) => void,
): () => void {
    const decoder = new StringDecoder("utf8")
    let buffer = ""

    const onData = (chunk: string | Buffer) => {
        buffer += typeof chunk === "string" ? chunk : decoder.write(chunk)
        while (true) {
            const idx = buffer.indexOf("\n")
            if (idx === -1) return
            const line = buffer.slice(0, idx)
            buffer = buffer.slice(idx + 1)
            onLine(line.endsWith("\r") ? line.slice(0, -1) : line)
        }
    }

    const onEnd = () => {
        buffer += decoder.end()
        if (buffer.length > 0) {
            onLine(buffer)
            buffer = ""
        }
    }

    stream.on("data", onData)
    stream.on("end", onEnd)

    return () => {
        stream.off("data", onData)
        stream.off("end", onEnd)
    }
}
