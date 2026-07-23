import { describe, expect, test } from "bun:test"
import { OBSERVER_SYSTEM_PROMPT, buildObserverPrompt } from "./observer-agent"
import type { ObserverReviewPayload } from "./types"

describe("observer-agent - OBSERVER_SYSTEM_PROMPT", () => {
    test("含关键契约：NO_CHANGE / 角色 / Core Loop", () => {
        expect(OBSERVER_SYSTEM_PROMPT).toContain("NO_CHANGE")
        expect(OBSERVER_SYSTEM_PROMPT).toContain("observer sidecar")
        expect(OBSERVER_SYSTEM_PROMPT).toContain("close first, then shrink, then expand")
        expect(OBSERVER_SYSTEM_PROMPT).toContain("maintain the strategy board")
    })
})

describe("observer-agent - buildObserverPrompt", () => {
    test("含工具日志：[ok] tool / args / result", () => {
        const payload: ObserverReviewPayload = {
            reason: "periodic",
            session_context: "",
            rounds: [
                {
                    round: 1,
                    assistant_summary: "let's start",
                    tool_logs: [
                        {
                            tool_name: "bash",
                            args_summary: '{"cmd":"ls"}',
                            result_summary: "file1\nfile2",
                            is_error: false,
                        },
                    ],
                },
            ],
        }
        const out = buildObserverPrompt(payload)
        expect(out).toContain("Round 1")
        expect(out).toContain("- assistant: let's start")
        expect(out).toContain("[ok] bash")
        expect(out).toContain('args: {"cmd":"ls"}')
        expect(out).toContain("result: file1")
        expect(out).toContain("Response Contract")
    })

    test("error 工具标 [error]", () => {
        const out = buildObserverPrompt({
            reason: "periodic",
            session_context: "",
            rounds: [
                {
                    round: 2,
                    assistant_summary: "x",
                    tool_logs: [{ tool_name: "bash", args_summary: "", result_summary: "boom", is_error: true }],
                },
            ],
        })
        expect(out).toContain("[error] bash")
    })

    test("无工具 → (none)；空 assistant → (empty)", () => {
        const out = buildObserverPrompt({
            reason: "periodic",
            session_context: "",
            rounds: [{ round: 3, assistant_summary: "", tool_logs: [] }],
        })
        expect(out).toContain("- tools: (none)")
        expect(out).toContain("- assistant: (empty)")
    })

    test("header 含轮数计数", () => {
        const out = buildObserverPrompt({
            reason: "periodic",
            session_context: "",
            rounds: [
                { round: 1, assistant_summary: "a", tool_logs: [] },
                { round: 2, assistant_summary: "b", tool_logs: [] },
            ],
        })
        expect(out).toContain("last 2 rounds")
    })
})
