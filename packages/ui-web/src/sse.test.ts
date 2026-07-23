import { describe, expect, test } from "bun:test"
import { encodeSse } from "./sse"

describe("encodeSse", () => {
    test("event 行 + data 行 + 双换行结尾", () => {
        const text = new TextDecoder().decode(encodeSse("status", { solvers: 2 }))
        expect(text).toBe('event: status\ndata: {"solvers":2}\n\n')
    })

    test("data 经 JSON 序列化（含特殊字符转义）", () => {
        const text = new TextDecoder().decode(encodeSse("agent_event", { text: 'he"llo\nworld' }))
        expect(text).toContain('data: {"text":"he\\"llo\\nworld"}')
    })

    test("不同 event 名生成对应 event 行", () => {
        const text = new TextDecoder().decode(encodeSse("solvers", []))
        expect(text.startsWith("event: solvers\n")).toBe(true)
    })
})
