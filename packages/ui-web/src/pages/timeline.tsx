import { useEffect, useState } from "react"
import { GitBranch, Inbox } from "lucide-react"
import { EmptyState, PageHeader, inputClass } from "../components/ui"

/** 后端 attack timeline 事件（与 @my/core attack-timeline.ts 对齐）。 */
interface AttackTimelineEvent {
    id: string
    timestamp: number
    lane: "challenge" | "submission" | "board"
    kind: string
    title: string
    summary: string
}

interface AttackTimelineSnapshot {
    challengeId: string
    updatedAt: string
    events: AttackTimelineEvent[]
}

const LANE_STYLE: Record<AttackTimelineEvent["lane"], string> = {
    challenge: "bg-blue-100 text-blue-800",
    submission: "bg-red-100 text-red-800",
    board: "bg-orange-100 text-orange-800",
}

export function TimelinePage() {
    const [challengeId, setChallengeId] = useState("")
    const [loadedId, setLoadedId] = useState<string | null>(null)
    const [timeline, setTimeline] = useState<AttackTimelineSnapshot | null>(null)
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState<string | null>(null)

    useEffect(() => {
        if (!loadedId) return
        let cancelled = false
        async function load() {
            try {
                const res = await fetch(`/api/runtime/challenges/${loadedId}/timeline`)
                if (!res.ok) throw new Error(`HTTP ${res.status}`)
                if (cancelled) return
                setTimeline(await res.json())
                setError(null)
            } catch (e) {
                if (!cancelled) setError(e instanceof Error ? e.message : String(e))
            } finally {
                if (!cancelled) setLoading(false)
            }
        }
        setLoading(true)
        void load()
        const timer = setInterval(load, 3000)
        return () => {
            cancelled = true
            clearInterval(timer)
        }
    }, [loadedId])

    return (
        <div className="max-w-5xl mx-auto px-8 py-8">
            <PageHeader
                title="Attack Timeline"
                subtitle="Aggregated events across solvers / submissions / strategy board"
                icon={GitBranch}
            />

            <form
                onSubmit={(e) => {
                    e.preventDefault()
                    const id = challengeId.trim()
                    if (id) setLoadedId(id)
                }}
                className="flex items-center gap-2 mb-6"
            >
                <input
                    className={inputClass}
                    placeholder="challenge id, e.g. test-multi"
                    value={challengeId}
                    onChange={(e) => setChallengeId(e.target.value)}
                />
                <button
                    type="submit"
                    className="px-4 py-2 rounded-md bg-foreground text-background text-sm font-medium hover:opacity-90"
                >
                    Load
                </button>
            </form>

            {error && (
                <div className="mb-4 px-3 py-2 rounded-md bg-red-50 text-red-700 text-sm">
                    ✗ {error}
                </div>
            )}

            {loadedId && (
                <div className="bg-surface rounded-lg border border-border-subtle">
                    {!timeline || loading ? (
                        timeline ? null : (
                            <div className="px-4 py-6 text-sm text-muted">Loading…</div>
                        )
                    ) : timeline.events.length === 0 ? (
                        <EmptyState
                            icon={Inbox}
                            title="No events yet"
                            hint={`No attempts / submissions / board changes for ${loadedId}`}
                        />
                    ) : (
                        <ul className="divide-y divide-border-subtle">
                            {timeline.events.map((e) => (
                                <li key={e.id} className="px-4 py-2.5 flex gap-3 items-start">
                                    <div className="text-subtle text-xs w-36 pt-0.5 font-mono shrink-0">
                                        {new Date(e.timestamp).toLocaleString()}
                                    </div>
                                    <div className="w-24 shrink-0">
                                        <span
                                            className={`inline-block px-2 py-0.5 rounded text-[11px] ${
                                                LANE_STYLE[e.lane] ?? "bg-slate-100 text-slate-700"
                                            }`}
                                        >
                                            {e.lane}
                                        </span>
                                    </div>
                                    <div className="flex-1 min-w-0">
                                        <div className="text-sm font-medium text-foreground">
                                            {e.title}
                                        </div>
                                        {e.summary && (
                                            <div className="text-xs text-muted truncate">
                                                {e.summary}
                                            </div>
                                        )}
                                    </div>
                                </li>
                            ))}
                        </ul>
                    )}
                </div>
            )}
        </div>
    )
}
