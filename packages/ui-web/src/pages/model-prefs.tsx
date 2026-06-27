import { useEffect, useState } from "react"
import { Brain, Pencil, Plus, Trash2 } from "lucide-react"
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
import { THINKING_LEVELS, type ModelConfigEntry } from "../lib/types"

interface FormState {
    id: string
    provider: string
    modelId: string
    thinkingLevel: string
    contextWindow: string
    maxTokens: string
}

const EMPTY_FORM: FormState = {
    id: "",
    provider: "",
    modelId: "",
    thinkingLevel: "",
    contextWindow: "",
    maxTokens: "",
}

function toForm(m: ModelConfigEntry): FormState {
    return {
        id: m.id,
        provider: m.provider ?? "",
        modelId: m.modelId ?? "",
        thinkingLevel: m.thinkingLevel ?? "",
        contextWindow: m.contextWindow != null ? String(m.contextWindow) : "",
        maxTokens: m.maxTokens != null ? String(m.maxTokens) : "",
    }
}

export function ModelPrefsPage() {
    const [list, setList] = useState<ModelConfigEntry[]>([])
    const [loading, setLoading] = useState(true)
    const [editing, setEditing] = useState<{ id: string; form: FormState } | null>(null)
    const [creating, setCreating] = useState<FormState | null>(null)
    const [submitting, setSubmitting] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [removingId, setRemovingId] = useState<string | null>(null)
    const [confirmDelete, setConfirmDelete] = useState<ModelConfigEntry | null>(null)

    async function reload() {
        setLoading(true)
        try {
            const res = await fetch("/api/config/model-prefs")
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
            const contextWindow = form.contextWindow.trim()
            const maxTokens = form.maxTokens.trim()
            const body: Record<string, unknown> = {
                provider: form.provider.trim(),
                modelId: form.modelId.trim(),
                thinkingLevel: form.thinkingLevel || undefined,
                contextWindow: contextWindow ? Number(contextWindow) : undefined,
                maxTokens: maxTokens ? Number(maxTokens) : undefined,
            }
            if (!id) {
                body.id = form.id.trim() || undefined
            }
            if (!body.provider || !body.modelId) {
                setError("Provider and Model ID are required")
                return false
            }
            const res = await fetch("/api/config/model-prefs", {
                method: id ? "PUT" : "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(id ? { id, ...body } : body),
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
            await fetch("/api/config/model-prefs", {
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
                title="Model Preferences"
                subtitle="Named model bindings referenced by prompts via model: <id>"
                count={list.length}
                icon={Brain}
                action={
                    <Button
                        variant="primary"
                        onClick={() => {
                            setError(null)
                            setCreating({ ...EMPTY_FORM })
                        }}
                    >
                        <Plus size={15} strokeWidth={2.5} />
                        Add Model Pref
                    </Button>
                }
            />

            {loading ? (
                <SkeletonRows />
            ) : list.length === 0 ? (
                <EmptyState
                    icon={Brain}
                    title="No model preferences"
                    hint="Bind a provider + modelId to a short id so prompts can reference it"
                />
            ) : (
                <div className="rounded-lg border border-border overflow-hidden">
                    <table className="w-full">
                        <thead>
                            <tr className="border-b border-border bg-surface/50">
                                <Th>ID</Th>
                                <Th>Provider</Th>
                                <Th>Model ID</Th>
                                <Th>Thinking</Th>
                                <Th>Context / Max Tokens</Th>
                                <Th align="right">Actions</Th>
                            </tr>
                        </thead>
                        <tbody>
                            {list.map((m) => (
                                <tr
                                    key={m.id}
                                    className="border-b border-border-subtle last:border-0 hover:bg-surface-hover transition-colors"
                                >
                                    <td className="px-4 py-3 font-mono text-sm text-foreground">{m.id}</td>
                                    <td className="px-4 py-3 font-mono text-xs text-muted">{m.provider}</td>
                                    <td className="px-4 py-3 font-mono text-xs text-muted">{m.modelId}</td>
                                    <td className="px-4 py-3">
                                        {m.thinkingLevel ? (
                                            <span className="font-mono text-[11px] px-1.5 py-0.5 rounded bg-surface-hover border border-border-subtle text-muted">
                                                {m.thinkingLevel}
                                            </span>
                                        ) : (
                                            <span className="text-xs text-subtle italic">default</span>
                                        )}
                                    </td>
                                    <td className="px-4 py-3 font-mono text-[11px] text-subtle">
                                        {m.contextWindow != null || m.maxTokens != null ? (
                                            <span>
                                                {m.contextWindow != null ? `${m.contextWindow.toLocaleString()} ctx` : "—"}
                                                {" / "}
                                                {m.maxTokens != null ? `${m.maxTokens.toLocaleString()} max` : "—"}
                                            </span>
                                        ) : (
                                            <span className="italic">defaults</span>
                                        )}
                                    </td>
                                    <td className="px-4 py-3 text-right whitespace-nowrap">
                                        <div className="inline-flex items-center gap-1">
                                            <IconButton
                                                icon={Pencil}
                                                label="edit"
                                                onClick={() => {
                                                    setError(null)
                                                    setEditing({ id: m.id, form: toForm(m) })
                                                }}
                                            />
                                            <IconButton
                                                icon={Trash2}
                                                label="delete"
                                                onClick={() => setConfirmDelete(m)}
                                            />
                                        </div>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}

            <ModelFormModal
                open={creating !== null}
                title="Add Model Preference"
                form={creating ?? EMPTY_FORM}
                allowIdEdit
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

            <ModelFormModal
                open={editing !== null}
                title={`Edit ${editing?.id ?? ""}`}
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
                title="Delete model preference"
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
                    Remove model preference{" "}
                    <span className="font-mono text-foreground">{confirmDelete?.id}</span>?
                    Prompts referencing it will fail to resolve.
                </p>
            </Modal>
        </div>
    )
}

function ModelFormModal({
    open,
    title,
    form,
    allowIdEdit,
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
    allowIdEdit?: boolean
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
                        disabled={submitting || !form.provider.trim() || !form.modelId.trim()}
                    >
                        {submitting ? "Saving..." : submitLabel}
                    </Button>
                </>
            }
        >
            {allowIdEdit && (
                <Field label="ID" hint="leave empty for auto-generated">
                    <input
                        type="text"
                        placeholder="work-gpt4"
                        value={form.id}
                        onChange={(e) => onChange({ ...form, id: e.target.value })}
                        autoFocus
                        className={`${inputClass} font-mono`}
                    />
                </Field>
            )}
            <div className="grid grid-cols-2 gap-3">
                <Field label="Provider" required hint="SDK provider, e.g. openai">
                    <input
                        type="text"
                        placeholder="openai"
                        value={form.provider}
                        onChange={(e) => onChange({ ...form, provider: e.target.value })}
                        autoFocus={!allowIdEdit}
                        className={`${inputClass} font-mono`}
                    />
                </Field>
                <Field label="Model ID" required hint="real model id">
                    <input
                        type="text"
                        placeholder="gpt-4o"
                        value={form.modelId}
                        onChange={(e) => onChange({ ...form, modelId: e.target.value })}
                        className={`${inputClass} font-mono`}
                    />
                </Field>
            </div>
            <div className="grid grid-cols-3 gap-3">
                <Field label="Thinking" hint="optional">
                    <select
                        value={form.thinkingLevel}
                        onChange={(e) => onChange({ ...form, thinkingLevel: e.target.value })}
                        className={inputClass}
                    >
                        <option value="">— default —</option>
                        {THINKING_LEVELS.map((lvl) => (
                            <option key={lvl} value={lvl}>
                                {lvl}
                            </option>
                        ))}
                    </select>
                </Field>
                <Field label="Context" hint="tokens">
                    <input
                        type="number"
                        min={1}
                        placeholder="128000"
                        value={form.contextWindow}
                        onChange={(e) => onChange({ ...form, contextWindow: e.target.value })}
                        className={`${inputClass} font-mono`}
                    />
                </Field>
                <Field label="Max Tokens" hint="output">
                    <input
                        type="number"
                        min={1}
                        placeholder="16384"
                        value={form.maxTokens}
                        onChange={(e) => onChange({ ...form, maxTokens: e.target.value })}
                        className={`${inputClass} font-mono`}
                    />
                </Field>
            </div>
            {error && (
                <p className="text-xs text-danger" role="alert">
                    {error}
                </p>
            )}
        </Modal>
    )
}
