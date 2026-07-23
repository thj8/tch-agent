import { useEffect, useState } from "react"
import { Activity, Plug, Plug2, Server } from "lucide-react"
import {
    EmptyState,
    PageHeader,
    SkeletonRows,
    Th,
} from "../components/ui"
import type { SolverInfo } from "../lib/types"

export function SolversPage({ onSelectSolver }: { onSelectSolver?: (id: string) => void }) {
    const [solvers, setSolvers] = useState<SolverInfo[]>([])
    const [dockerOk, setDockerOk] = useState<boolean | null>(null)
    const [loading, setLoading] = useState(true)

    useEffect(() => {
        let cancelled = false
        async function load() {
            try {
                const [pingRes, solversRes] = await Promise.all([
                    fetch("/api/runtime/ping"),
                    fetch("/api/runtime/solvers"),
                ])
                if (cancelled) return
                setDockerOk((await pingRes.json()).ok)
                setSolvers(await solversRes.json())
            } finally {
                if (!cancelled) setLoading(false)
            }
        }
        void load()
        const timer = setInterval(load, 2000)
        return () => {
            cancelled = true
            clearInterval(timer)
        }
    }, [])

    const activeCount = solvers.filter(
        (s) => s.status === "running" || s.status === "starting",
    ).length

    return (
        <div className="max-w-5xl mx-auto px-8 py-8">
            <PageHeader
                title="Solvers"
                subtitle="Live solver containers managed by this host"
                count={solvers.length}
                icon={Server}
            />

            <div className="flex items-center gap-3 mb-6 px-3 py-2 rounded-md border border-border bg-surface text-sm">
                <DockerStatusPill ok={dockerOk} />
                <div className="h-3 w-px bg-border" />
                <Activity size={13} className="text-muted" />
                <span className="text-muted">
                    <span className="font-mono text-foreground">{activeCount}</span> active
                    {solvers.length !== activeCount && (
                        <span className="text-subtle"> · {solvers.length} total</span>
                    )}
                </span>
                {loading && (
                    <span className="ml-auto text-[11px] text-subtle font-mono">loading...</span>
                )}
            </div>

            {loading && solvers.length === 0 ? (
                <SkeletonRows />
            ) : solvers.length === 0 ? (
                <EmptyState
                    icon={Server}
                    title="No active solvers"
                    hint="Launch one from the CLI: tinyfat runtime launch -p SOLVER <task>"
                />
            ) : (
                <div className="rounded-lg border border-border overflow-hidden">
                    <table className="w-full">
                        <thead>
                            <tr className="border-b border-border bg-surface/50">
                                <Th>ID</Th>
                                <Th>Status</Th>
                                <Th>Prompt</Th>
                                <Th>Container</Th>
                                <Th align="right">Age</Th>
                            </tr>
                        </thead>
                        <tbody>
                            {solvers.map((s) => (
                                <tr
                                    key={s.id}
                                    onClick={() => onSelectSolver?.(s.id)}
                                    className={`border-b border-border-subtle last:border-0 hover:bg-surface-hover transition-colors${
                                        onSelectSolver ? " cursor-pointer" : ""
                                    }`}
                                >
                                    <td className="px-4 py-3 font-mono text-sm text-foreground">
                                        {s.id}
                                    </td>
                                    <td className="px-4 py-3">
                                        <StatusBadge status={s.status} />
                                    </td>
                                    <td className="px-4 py-3 text-sm text-muted font-mono">
                                        {s.promptName}
                                    </td>
                                    <td className="px-4 py-3 font-mono text-xs text-muted">
                                        {s.containerId}
                                    </td>
                                    <td className="px-4 py-3 text-right text-xs text-subtle font-mono">
                                        {s.createdAt ? formatAge(s.createdAt) : "—"}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
        </div>
    )
}

function StatusBadge({ status }: { status: string }) {
    const config: Record<string, { color: string; bg: string; dot: string; pulse?: boolean }> = {
        starting: { color: "text-warning", bg: "bg-warning/10", dot: "bg-warning", pulse: true },
        running: { color: "text-accent", bg: "bg-accent/10", dot: "bg-accent" },
        stopping: { color: "text-warning", bg: "bg-warning/10", dot: "bg-warning", pulse: true },
        stopped: { color: "text-muted", bg: "bg-surface-hover", dot: "bg-subtle" },
        error: { color: "text-danger", bg: "bg-danger/10", dot: "bg-danger" },
    }
    const c = config[status] ?? { color: "text-muted", bg: "bg-surface-hover", dot: "bg-subtle" }
    return (
        <span
            className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-[11px] font-medium font-mono ${c.color} ${c.bg}`}
        >
            <span className={`inline-block h-1.5 w-1.5 rounded-full ${c.dot} ${c.pulse ? "pulse-status" : ""}`} />
            {status}
        </span>
    )
}

function DockerStatusPill({ ok }: { ok: boolean | null }) {
    if (ok === null) {
        return (
            <span className="inline-flex items-center gap-1.5 text-muted">
                <Plug2 size={13} className="text-subtle" />
                <span className="font-mono text-xs">docker: checking...</span>
            </span>
        )
    }
    return (
        <span
            className={`inline-flex items-center gap-1.5 ${ok ? "text-accent" : "text-danger"}`}
        >
            {ok ? <Plug size={13} /> : <Plug2 size={13} />}
            <span className="font-mono text-xs">
                docker: {ok ? "connected" : "unreachable"}
            </span>
        </span>
    )
}

function formatAge(timestampMs: number): string {
    const seconds = Math.max(0, Math.floor((Date.now() - timestampMs) / 1000))
    if (seconds < 60) return `${seconds}s`
    const minutes = Math.floor(seconds / 60)
    if (minutes < 60) return `${minutes}m ${seconds % 60}s`
    const hours = Math.floor(minutes / 60)
    return `${hours}h ${minutes % 60}m`
}
