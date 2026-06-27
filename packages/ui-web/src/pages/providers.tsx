import { useEffect, useState } from "react"
import { Boxes, Pencil, Plus, Trash2 } from "lucide-react"
import {
    Button,
    EmptyState,
    Field,
    IconButton,
    Modal,
    PageHeader,
    SkeletonRows,
    Th,
    inputClass,
} from "../components/ui"
import { PROVIDER_APIS, type ProviderPrefEntry } from "../lib/types"

interface FormState {
    name: string
    api: string
    baseUrl: string
    apiKey: string
    modelsText: string
}

const EMPTY_FORM: FormState = {
    name: "",
    api: "",
    baseUrl: "",
    apiKey: "",
    modelsText: "",
}

function toForm(p: ProviderPrefEntry): FormState {
    return {
        name: p.name ?? "",
        api: p.api ?? "",
        baseUrl: p.baseUrl ?? "",
        apiKey: p.apiKey ?? "",
        modelsText: (p.models ?? []).join(", "),
    }
}

export function ProvidersPage() {
    const [list, setList] = useState<ProviderPrefEntry[]>([])
    const [loading, setLoading] = useState(true)
    const [editing, setEditing] = useState<{ id: string; form: FormState } | null>(null)
    const [creating, setCreating] = useState<FormState | null>(null)
    const [submitting, setSubmitting] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [removingId, setRemovingId] = useState<string | null>(null)
    const [confirmDelete, setConfirmDelete] = useState<ProviderPrefEntry | null>(null)

    async function reload() {
        setLoading(true)
        try {
            const res = await fetch("/api/config/providers")
            setList(await res.json())
        } finally {
            setLoading(false)
        }
    }

    useEffect(() => {
        void reload()
    }, [])

    async function submit(form: FormState, id?: string): Promise<boolean> {
        setSubmitting(true)
        setError(null)
        try {
            const models = form.modelsText
                .split(/[,\s]+/)
                .map((s: string) => s.trim())
                .filter(Boolean)
            const body = {
                ...(id ? { id } : {}),
                name: form.name.trim(),
                api: form.api || undefined,
                baseUrl: form.baseUrl.trim() || undefined,
                apiKey: form.apiKey.trim() || undefined,
                models: models.length > 0 ? models : undefined,
            }
            if (!body.name) {
                setError("Name is required")
                return false
            }
            const res = await fetch("/api/config/providers", {
                method: id ? "PUT" : "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
            })
            const data = await res.json().catch(() => ({}))
            if (!res.ok || data.rejected) {
                throw new Error(data.rejected || `HTTP ${res.status}`)
            }
            await reload()
            return true
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e))
            return false
        } finally {
            setSubmitting(false)
        }
    }

    async function handleDelete(id: string) {
        setRemovingId(id)
        try {
            await fetch("/api/config/providers", {
                method: "DELETE",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ id }),
            })
            await reload()
            setConfirmDelete(null)
        } finally {
            setRemovingId(null)
        }
    }

    return (
        <div className="max-w-5xl mx-auto px-8 py-8">
            <PageHeader
                title="Providers"
                subtitle="Provider endpoints registered with the model registry"
                count={list.length}
                icon={Boxes}
                action={
                    <Button
                        variant="primary"
                        onClick={() => {
                            setError(null)
                            setCreating({ ...EMPTY_FORM })
                        }}
                    >
                        <Plus size={15} strokeWidth={2.5} />
                        Add Provider
                    </Button>
                }
            />

            {loading ? (
                <SkeletonRows />
            ) : list.length === 0 ? (
                <EmptyState
                    icon={Boxes}
                    title="No providers registered"
                    hint="Add a provider to override an SDK built-in or register a custom gateway"
                />
            ) : (
                <div className="rounded-lg border border-border overflow-hidden">
                    <table className="w-full">
                        <thead>
                            <tr className="border-b border-border bg-surface/50">
                                <Th>Name</Th>
                                <Th>API</Th>
                                <Th>Base URL</Th>
                                <Th>Models</Th>
                                <Th align="right">Actions</Th>
                            </tr>
                        </thead>
                        <tbody>
                            {list.map((p) => (
                                <tr
                                    key={p.id}
                                    className="border-b border-border-subtle last:border-0 hover:bg-surface-hover transition-colors align-top"
                                >
                                    <td className="px-4 py-3">
                                        <div className="font-mono text-sm text-foreground">{p.name}</div>
                                        <div className="font-mono text-[11px] text-subtle mt-0.5">{p.id}</div>
                                    </td>
                                    <td className="px-4 py-3 font-mono text-xs text-muted">
                                        {p.api || "—"}
                                    </td>
                                    <td className="px-4 py-3 font-mono text-xs text-muted break-all max-w-xs">
                                        {p.baseUrl || "—"}
                                    </td>
                                    <td className="px-4 py-3">
                                        {p.models && p.models.length > 0 ? (
                                            <div className="flex flex-wrap gap-1">
                                                {p.models.map((m) => (
                                                    <span
                                                        key={m}
                                                        className="font-mono text-[11px] px-1.5 py-0.5 rounded bg-surface-hover border border-border-subtle text-muted"
                                                    >
                                                        {m}
                                                    </span>
                                                ))}
                                            </div>
                                        ) : (
                                            <span className="text-xs text-subtle italic">override-only</span>
                                        )}
                                    </td>
                                    <td className="px-4 py-3 text-right whitespace-nowrap">
                                        <div className="inline-flex items-center gap-1">
                                            <IconButton
                                                icon={Pencil}
                                                label="edit"
                                                onClick={() => {
                                                    setError(null)
                                                    setEditing({ id: p.id, form: toForm(p) })
                                                }}
                                            />
                                            <IconButton
                                                icon={Trash2}
                                                label="delete"
                                                onClick={() => setConfirmDelete(p)}
                                            />
                                        </div>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}

            <ProviderFormModal
                open={creating !== null}
                title="Add Provider"
                form={creating ?? EMPTY_FORM}
                submitting={submitting}
                error={error}
                submitLabel="Create"
                onClose={() => {
                    if (!submitting) setCreating(null)
                }}
                onChange={(form) => setCreating(form)}
                onSubmit={async () => {
                    if (creating && (await submit(creating))) setCreating(null)
                }}
            />

            <ProviderFormModal
                open={editing !== null}
                title={`Edit ${editing?.form.name ?? ""}`}
                form={editing?.form ?? EMPTY_FORM}
                submitting={submitting}
                error={error}
                submitLabel="Save"
                onClose={() => {
                    if (!submitting) setEditing(null)
                }}
                onChange={(form) => editing && setEditing({ id: editing.id, form })}
                onSubmit={async () => {
                    if (editing && (await submit(editing.form, editing.id))) setEditing(null)
                }}
            />

            <Modal
                open={confirmDelete !== null}
                title="Delete provider"
                onClose={() => setConfirmDelete(null)}
                footer={
                    <>
                        <Button onClick={() => setConfirmDelete(null)} disabled={removingId !== null}>
                            Cancel
                        </Button>
                        <Button
                            variant="danger"
                            onClick={() => confirmDelete && handleDelete(confirmDelete.id)}
                            disabled={removingId !== null}
                        >
                            <Trash2 size={14} />
                            {removingId !== null ? "Deleting..." : "Delete"}
                        </Button>
                    </>
                }
            >
                <p className="text-sm text-muted">
                    Remove provider <span className="font-mono text-foreground">{confirmDelete?.name}</span>?
                    This cannot be undone.
                </p>
            </Modal>
        </div>
    )
}

function ProviderFormModal({
    open,
    title,
    form,
    submitLabel,
    submitting,
    error,
    onClose,
    onChange,
    onSubmit,
}: {
    open: boolean
    title: string
    form: FormState
    submitLabel: string
    submitting: boolean
    error: string | null
    onClose: () => void
    onChange: (form: FormState) => void
    onSubmit: () => void
}) {
    return (
        <Modal
            open={open}
            title={title}
            onClose={onClose}
            footer={
                <>
                    <Button onClick={onClose} disabled={submitting}>
                        Cancel
                    </Button>
                    <Button
                        variant="primary"
                        onClick={onSubmit}
                        disabled={submitting || !form.name.trim()}
                    >
                        {submitting ? "Saving..." : submitLabel}
                    </Button>
                </>
            }
        >
            <Field label="Name" required hint="SDK provider key, e.g. anthropic">
                <input
                    type="text"
                    placeholder="anthropic"
                    value={form.name}
                    onChange={(e) => onChange({ ...form, name: e.target.value })}
                    autoFocus
                    className={`${inputClass} font-mono`}
                />
            </Field>
            <div className="grid grid-cols-2 gap-3">
                <Field label="API" hint="optional">
                    <select
                        value={form.api}
                        onChange={(e) => onChange({ ...form, api: e.target.value })}
                        className={inputClass}
                    >
                        <option value="">— inherit —</option>
                        {PROVIDER_APIS.map((a) => (
                            <option key={a} value={a}>
                                {a}
                            </option>
                        ))}
                    </select>
                </Field>
                <Field label="API Key" hint="optional, overrides auth.json">
                    <input
                        type="password"
                        placeholder="sk-..."
                        value={form.apiKey}
                        onChange={(e) => onChange({ ...form, apiKey: e.target.value })}
                        className={`${inputClass} font-mono`}
                    />
                </Field>
            </div>
            <Field label="Base URL" hint="optional">
                <input
                    type="text"
                    placeholder="https://api.anthropic.com"
                    value={form.baseUrl}
                    onChange={(e) => onChange({ ...form, baseUrl: e.target.value })}
                    className={`${inputClass} font-mono`}
                />
            </Field>
            <Field
                label="Models"
                hint="comma-separated; empty = override-only"
            >
                <input
                    type="text"
                    placeholder="glm-5, glm-5.2"
                    value={form.modelsText}
                    onChange={(e) => onChange({ ...form, modelsText: e.target.value })}
                    className={`${inputClass} font-mono`}
                />
            </Field>
            <p className="text-[11px] text-subtle leading-relaxed">
                Filling <span className="font-mono">models</span> registers a brand-new provider
                (full registration). Leaving it empty overrides the SDK built-in&apos;s base URL.
            </p>
            {error && (
                <p className="text-xs text-danger" role="alert">
                    {error}
                </p>
            )}
        </Modal>
    )
}
