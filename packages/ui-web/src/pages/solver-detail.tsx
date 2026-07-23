import { useEffect, useState } from "react"
import { ArrowLeft } from "lucide-react"
import { summarizeEvent } from "../lib/event-summary"

interface AgentEventEntry {
    timestamp: number
    event: unknown
}

/**
 * Solver 详情页（课时 15）：EventSource 订阅 `/api/runtime/solvers/:id/stream`，
 * 实时渲染该 solver 的事件流（assistant 思考 / 工具调用 / 结果 / agent_end）。
 */
export function SolverDetailPage({
    solverId,
    onBack,
}: {
    solverId: string
    onBack: () => void
}) {
    const [events, setEvents] = useState<AgentEventEntry[]>([])
    const [connected, setConnected] = useState(false)

    useEffect(() => {
        const es = new EventSource(`/api/runtime/solvers/${solverId}/stream`)

        es.addEventListener("open", () => setConnected(true))
        es.addEventListener("error", () => setConnected(false))
        es.addEventListener("agent_event", (e: MessageEvent) => {
            try {
                const event = JSON.parse(e.data)
                setEvents((prev) => [...prev, { timestamp: Date.now(), event }])
            } catch {
                // 非 JSON，忽略
            }
        })

        return () => es.close()
    }, [solverId])

    return (
        <div className="max-w-5xl mx-auto px-8 py-8">
            <button
                onClick={onBack}
                className="mb-4 inline-flex items-center gap-1.5 text-sm text-muted hover:text-foreground transition-colors"
            >
                <ArrowLeft size={14} /> Back to solvers
            </button>

            <h2 className="text-2xl font-bold mb-2 font-mono">{solverId}</h2>
            <div className="mb-4 text-sm">
                Status:{" "}
                {connected ? (
                    <span className="text-accent">● connected</span>
                ) : (
                    <span className="text-danger">● disconnected</span>
                )}
            </div>

            <div className="bg-black text-green-400 p-4 rounded font-mono text-sm overflow-auto max-h-[600px]">
                {events.length === 0 ? (
                    <div className="text-slate-500">waiting for events...</div>
                ) : (
                    events.map((e, i) => (
                        <div key={i} className="whitespace-pre-wrap break-words">
                            <span className="text-slate-500">
                                [{new Date(e.timestamp).toLocaleTimeString()}]
                            </span>{" "}
                            {summarizeEvent(e.event)}
                        </div>
                    ))
                )}
            </div>
        </div>
    )
}
