import { defineTool } from "@mariozechner/pi-coding-agent"
import { Type } from "typebox"
import type { MemoryKind } from "../../../challenge/memory"
import {
    addSolverBoardIdea,
    appendSolverBoardMemory,
    deleteSolverBoardMemory,
    listSolverBoardIdeas,
    listSolverBoardMemory,
    searchSolverBoardIdeas,
    updateSolverBoardIdea,
    updateSolverBoardMemory,
} from "../../board-store"
import { formatIdeaTable, formatMemoryTable } from "./board-format"

const EmptyParams = Type.Object({})

const memoryKindToolParam = Type.Union([
    Type.Literal("fact"),
    Type.Literal("evidence"),
    Type.Literal("failure"),
    Type.Literal("note"),
    Type.Literal("hint"),
])

const ideaStatusToolParam = Type.Union([
    Type.Literal("pending"),
    Type.Literal("testing"),
    Type.Literal("verified"),
    Type.Literal("failed"),
    Type.Literal("skipped"),
])

/**
 * Observer sidecar 工具集（board 部分）。
 *
 * 这些工具让 Observer LLM 能维护 solver 本地的策略板（ideas + memory）。
 * 底层走 board-store（<sessionDir>/.observer），sessionDir 由环境变量
 * TCH_SOLVER_SESSION_DIR 决定（createSolverSession 注入）。
 */
export const observerSidecarBoardTools = [
    // ── Memory ────────────────────────────────────────

    defineTool({
        name: "memory_list",
        label: "Memory List",
        description: "List current durable memory entries. Use first, and re-check before deleting or merging entries.",
        promptSnippet: "memory_list: inspect current durable memory before curating it",
        parameters: EmptyParams,
        async execute() {
            const items = await listSolverBoardMemory()
            return {
                content: [{ type: "text", text: formatMemoryTable(items) }],
                details: { items },
            }
        },
    }),

    defineTool({
        name: "memory_add",
        label: "Memory Add",
        description: "Add one durable memory entry. Use only for facts, evidence, failure boundaries, hints, or important constraints worth keeping.",
        promptSnippet: "memory_add: add durable fact/evidence/failure/hint/constraint",
        parameters: Type.Object({
            kind: memoryKindToolParam,
            content: Type.String({ minLength: 1 }),
            refs: Type.Optional(Type.Array(Type.String())),
            source: Type.Optional(Type.String()),
        }),
        async execute(_id, params: { kind: MemoryKind; content: string; refs?: string[]; source?: string }) {
            const entry = await appendSolverBoardMemory({
                kind: params.kind,
                content: params.content,
                refs: params.refs ?? [],
                source: params.source?.trim() || "observer",
            })
            return {
                content: [{ type: "text", text: `added memory [${entry.kind}] ${entry.id}: ${params.content.slice(0, 160)}` }],
                details: { entry },
            }
        },
    }),

    defineTool({
        name: "memory_update",
        label: "Memory Update",
        description: "Update one memory entry by id or id prefix.",
        parameters: Type.Object({
            entry_id: Type.String(),
            kind: Type.Optional(memoryKindToolParam),
            content: Type.Optional(Type.String()),
            refs: Type.Optional(Type.Array(Type.String())),
            source: Type.Optional(Type.String()),
        }),
        async execute(_id, params) {
            const entry = await updateSolverBoardMemory(params.entry_id, {
                ...(params.kind ? { kind: params.kind } : {}),
                ...(params.content !== undefined ? { content: params.content } : {}),
                ...(params.refs !== undefined ? { refs: params.refs } : {}),
                ...(params.source !== undefined ? { source: params.source } : {}),
            })
            return {
                content: [{ type: "text", text: `updated memory ${entry.id}` }],
                details: { entry },
            }
        },
    }),

    defineTool({
        name: "memory_delete",
        label: "Memory Delete",
        description: "Delete one memory entry by id or id prefix.",
        parameters: Type.Object({ entry_id: Type.String() }),
        async execute(_id, params) {
            const entry = await deleteSolverBoardMemory(params.entry_id)
            return {
                content: [{ type: "text", text: `deleted memory ${entry.id}` }],
                details: undefined,
            }
        },
    }),

    // ── Ideas ─────────────────────────────────────────

    defineTool({
        name: "idea_list",
        label: "Idea List",
        description: "List current ideas (attack hypotheses).",
        parameters: EmptyParams,
        async execute() {
            const items = await listSolverBoardIdeas()
            return {
                content: [{ type: "text", text: formatIdeaTable(items) }],
                details: { items },
            }
        },
    }),

    defineTool({
        name: "idea_search",
        label: "Idea Search",
        description: "Search ideas by query (in content or result).",
        parameters: Type.Object({ query: Type.String() }),
        async execute(_id, params) {
            const items = await searchSolverBoardIdeas(params.query)
            return {
                content: [{ type: "text", text: formatIdeaTable(items) }],
                details: undefined,
            }
        },
    }),

    defineTool({
        name: "idea_add",
        label: "Idea Add",
        description: "Add a new idea (attack hypothesis).",
        parameters: Type.Object({
            content: Type.String({ minLength: 1 }),
            status: Type.Optional(ideaStatusToolParam),
            result: Type.Optional(Type.String()),
        }),
        async execute(_id, params) {
            const result = await addSolverBoardIdea({
                content: params.content,
                status: params.status,
                result: params.result,
            })
            return {
                content: [{ type: "text", text: `${result.created ? "created" : "exists"} idea ${result.item.id}: ${result.item.content.slice(0, 100)}` }],
                details: result,
            }
        },
    }),

    defineTool({
        name: "idea_update",
        label: "Idea Update",
        description: "Update an idea's status/result by id or id prefix.",
        parameters: Type.Object({
            idea_id: Type.String(),
            status: Type.Optional(ideaStatusToolParam),
            result: Type.Optional(Type.String()),
        }),
        async execute(_id, params) {
            const updated = await updateSolverBoardIdea(params.idea_id, {
                status: params.status,
                result: params.result,
            })
            return {
                content: [{ type: "text", text: `updated idea ${updated.id}: status=${updated.status}` }],
                details: { item: updated },
            }
        },
    }),
]

/**
 * send_efficiency_reminder 工具：给 Solver 发纠偏。
 * 需要外部传入回调（Observer session 才能发到 Solver）。
 */
export function createSendReminderTool(
    sendCorrectionNotice: (message: string) => Promise<boolean> | boolean,
) {
    return defineTool({
        name: "send_efficiency_reminder",
        label: "Efficiency Reminder",
        description:
            "Send a short efficiency reminder when solver is clearly stuck in low-efficiency mode. Use sparingly.",
        promptSnippet:
            "send_efficiency_reminder: use sparingly, only for clear persistent low-efficiency behavior",
        parameters: Type.Object({
            message: Type.String({ minLength: 1 }),
        }),
        async execute(_id, params) {
            const delivered = await sendCorrectionNotice(params.message)
            return {
                content: [
                    {
                        type: "text",
                        text: delivered
                            ? `sent: ${params.message.slice(0, 200)}`
                            : `suppressed: ${params.message.slice(0, 200)}`,
                    },
                ],
                details: { delivered },
            }
        },
    })
}

/** 完整工具集（含 reminder） */
export function createObserverSidecarTools(options: {
    sendCorrectionNotice?: (message: string) => Promise<boolean> | boolean
} = {}) {
    const tools = [...observerSidecarBoardTools]
    if (options.sendCorrectionNotice) {
        tools.push(createSendReminderTool(options.sendCorrectionNotice))
    }
    return tools
}
