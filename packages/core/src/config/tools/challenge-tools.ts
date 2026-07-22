import { defineTool } from "@mariozechner/pi-coding-agent"
import { Type } from "typebox"
import { requestHostBridge } from "../../challenge/host-bridge-client"

/** 查当前 challenge 状态（进度 / hint / 实例状态） */
export const challengeGetStateTool = defineTool({
    name: "challenge_get_state",
    label: "Challenge Get State",
    description: "Get current challenge state (progress, hint, instance status)",
    parameters: Type.Object({}),
    async execute() {
        const result = await requestHostBridge<{
            challenge_id: string
            challenge: unknown
            is_completed: boolean
        }>("challenge_get_state", {})
        return {
            content: [
                { type: "text", text: JSON.stringify(result, null, 2) },
            ],
            details: undefined,
        }
    },
})

/** 提交 flag */
export const challengeSubmitFlagTool = defineTool({
    name: "challenge_submit_flag",
    label: "Submit Flag",
    description: "Submit a flag for the current challenge",
    parameters: Type.Object({
        flag: Type.String({ description: "Flag value to submit" }),
        writeup: Type.Optional(
            Type.String({ description: "Optional writeup of how you got it" }),
        ),
    }),
    async execute(_id, params) {
        const result = await requestHostBridge<{
            correct: boolean
            flag_got_count: number
            flag_count: number
            is_completed: boolean
        }>("challenge_submit_flag", {
            flag: params.flag,
            ...(params.writeup ? { writeup: params.writeup } : {}),
        })
        return {
            content: [
                {
                    type: "text",
                    text: `submitted flag=${params.flag}: ${result.correct ? "correct" : "incorrect"} (${result.flag_got_count}/${result.flag_count}${result.is_completed ? ", completed" : ""})`,
                },
            ],
            details: undefined,
        }
    },
})

/** 拉 hint */
export const challengeGetHintTool = defineTool({
    name: "challenge_get_hint",
    label: "Get Hint",
    description: "Get hint for the current challenge",
    parameters: Type.Object({}),
    async execute() {
        const result = await requestHostBridge<{ hint_content: string | null }>(
            "challenge_get_hint",
            {},
        )
        return {
            content: [
                { type: "text", text: result.hint_content ?? "(no hint available)" },
            ],
            details: undefined,
        }
    },
})

export const challengeTools = [challengeGetStateTool, challengeSubmitFlagTool, challengeGetHintTool]
