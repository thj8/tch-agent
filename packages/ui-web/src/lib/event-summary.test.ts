import { describe, expect, test } from "bun:test"
import { summarizeEvent } from "./event-summary"

describe("summarizeEvent", () => {
    test("message_end：assistant 文本 block", () => {
        expect(
            summarizeEvent({
                type: "message_end",
                message: { role: "assistant", content: [{ type: "text", text: "hello" }] },
            }),
        ).toBe("[assistant] hello")
    })

    test("message_end：字符串 content", () => {
        expect(
            summarizeEvent({ type: "message_end", message: { role: "user", content: "hi there" } }),
        ).toBe("[user] hi there")
    })

    test("message_end：tool_use block 展开", () => {
        const out = summarizeEvent({
            type: "message_end",
            message: { role: "assistant", content: [{ type: "tool_use", name: "bash", input: { command: "ls" } }] },
        })
        expect(out).toContain("[assistant] <tool_use bash")
        expect(out).toContain("ls")
    })

    test("tool_execution_start", () => {
        const out = summarizeEvent({
            type: "tool_execution_start",
            toolName: "bash",
            args: { command: "ls /tmp" },
        })
        expect(out).toContain("[tool_call] bash(")
        expect(out).toContain("ls /tmp")
    })

    test("tool_execution_end：成功 / 错误标记", () => {
        expect(
            summarizeEvent({
                type: "tool_execution_end",
                toolName: "bash",
                result: { content: [{ type: "text", text: "done" }] },
                isError: false,
            }),
        ).toContain("[tool_result]")
        expect(
            summarizeEvent({ type: "tool_execution_end", toolName: "bash", result: "boom", isError: true }),
        ).toContain("[tool_result(error)]")
    })

    test("agent_end：从 messages 取 stopReason", () => {
        expect(
            summarizeEvent({
                type: "agent_end",
                messages: [{ role: "assistant", stopReason: "end_turn" }],
            }),
        ).toBe("[agent_end] stopReason=end_turn")
    })

    test("agent_end：缺 messages → unknown", () => {
        expect(summarizeEvent({ type: "agent_end" })).toBe("[agent_end] stopReason=unknown")
    })

    test("未知 type → [type]", () => {
        expect(summarizeEvent({ type: "custom_thing" })).toBe("[custom_thing]")
    })

    test("无 type 字段 → JSON 兜底", () => {
        expect(summarizeEvent({ foo: 1 })).toBe(JSON.stringify({ foo: 1 }))
    })
})
