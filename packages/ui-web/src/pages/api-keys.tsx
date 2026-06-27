import { useEffect, useState } from "react"
import { CircleDot, KeyRound, Plus, Trash2 } from "lucide-react"
import {
    Button,
    EmptyState,
    Field,
    IconButton,
    PageHeader,
    SkeletonRows,
    Th,
    inputClass,
} from "../components/ui"

export function ApiKeysPage() {
    const [providers, setProviders] = useState<string[]>([])
    const [loading, setLoading] = useState(true)
    const [newProvider, setNewProvider] = useState("")
    const [newKey, setNewKey] = useState("")
    const [submitting, setSubmitting] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [removingProvider, setRemovingProvider] = useState<string | null>(null)

    async function reload() {
        setLoading(true)
        try {
            const res = await fetch("/api/config/api-keys")
            setProviders(await res.json())
        } finally {
            setLoading(false)
        }
    }

    useEffect(() => {
        void reload()
    }, [])

    async function handleAdd() {
        const provider = newProvider.trim()
        if (!provider || !newKey.trim()) return
        setSubmitting(true)
        setError(null)
        try {
            const res = await fetch("/api/config/api-keys", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ provider, key: newKey.trim() }),
            })
            if (!res.ok) throw new Error(`HTTP ${res.status}`)
            setNewProvider("")
            setNewKey("")
            void reload()
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e))
        } finally {
            setSubmitting(false)
        }
    }

    async function handleRemove(provider: string) {
        setRemovingProvider(provider)
        try {
            await fetch("/api/config/api-keys", {
                method: "DELETE",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ provider }),
            })
            void reload()
        } finally {
            setRemovingProvider(null)
        }
    }

    return (
        <div className="max-w-4xl mx-auto px-8 py-8">
            <PageHeader
                title="API Keys"
                subtitle="Provider credentials stored on the host"
                count={providers.length}
                icon={KeyRound}
            />

            <div className="rounded-lg border border-border bg-surface p-4 mb-4">
                <div className="grid grid-cols-1 md:grid-cols-[1fr_2fr_auto] gap-2 items-end">
                    <Field label="Provider" required hint="e.g. openai">
                        <input
                            type="text"
                            placeholder="openai"
                            value={newProvider}
                            onChange={(e) => setNewProvider(e.target.value)}
                            onKeyDown={(e) => e.key === "Enter" && handleAdd()}
                            className={`${inputClass} font-mono`}
                        />
                    </Field>
                    <Field label="Key" required>
                        <input
                            type="password"
                            placeholder="sk-..."
                            value={newKey}
                            onChange={(e) => setNewKey(e.target.value)}
                            onKeyDown={(e) => e.key === "Enter" && handleAdd()}
                            className={`${inputClass} font-mono`}
                        />
                    </Field>
                    <Button
                        variant="primary"
                        onClick={handleAdd}
                        disabled={submitting || !newProvider.trim() || !newKey.trim()}
                    >
                        <Plus size={15} strokeWidth={2.5} />
                        {submitting ? "Adding..." : "Add"}
                    </Button>
                </div>
                {error && (
                    <p className="mt-2 text-xs text-danger" role="alert">
                        {error}
                    </p>
                )}
            </div>

            {loading ? (
                <SkeletonRows />
            ) : providers.length === 0 ? (
                <EmptyState
                    icon={KeyRound}
                    title="No API keys configured"
                    hint="Add a provider and key above to get started"
                />
            ) : (
                <div className="rounded-lg border border-border overflow-hidden">
                    <table className="w-full">
                        <thead>
                            <tr className="border-b border-border bg-surface/50">
                                <Th>Provider</Th>
                                <Th align="right">Actions</Th>
                            </tr>
                        </thead>
                        <tbody>
                            {providers.map((p) => (
                                <tr
                                    key={p}
                                    className="border-b border-border-subtle last:border-0 hover:bg-surface-hover transition-colors"
                                >
                                    <td className="px-4 py-3 font-mono text-sm">
                                        <span className="inline-flex items-center gap-2">
                                            <CircleDot size={13} className="text-accent" />
                                            {p}
                                        </span>
                                    </td>
                                    <td className="px-4 py-3 text-right">
                                        <IconButton
                                            icon={Trash2}
                                            label={removingProvider === p ? "removing..." : "remove"}
                                            onClick={() => handleRemove(p)}
                                            disabled={removingProvider === p}
                                        />
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
