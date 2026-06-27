import { useEffect } from "react"
import { X } from "lucide-react"
import type { LucideIcon } from "lucide-react"

export function PageHeader({
    title,
    subtitle,
    count,
    icon: Icon,
    action,
}: {
    title: string
    subtitle: string
    count?: number
    icon: LucideIcon
    action?: React.ReactNode
}) {
    return (
        <div className="flex items-center justify-between mb-6 gap-3">
            <div className="flex items-center gap-3 min-w-0">
                <div className="h-9 w-9 rounded-md bg-surface border border-border flex items-center justify-center shrink-0">
                    <Icon size={18} strokeWidth={1.75} className="text-muted" />
                </div>
                <div className="min-w-0">
                    <h1 className="text-lg font-semibold leading-tight truncate">{title}</h1>
                    <p className="text-xs text-muted mt-0.5 truncate">{subtitle}</p>
                </div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
                {typeof count === "number" && (
                    <span className="font-mono text-xs px-2 py-1 rounded border border-border text-muted">
                        {count}
                    </span>
                )}
                {action}
            </div>
        </div>
    )
}

export function EmptyState({
    icon: Icon,
    title,
    hint,
}: {
    icon: LucideIcon
    title: string
    hint: string
}) {
    return (
        <div className="rounded-lg border border-dashed border-border bg-surface/40 py-12 flex flex-col items-center text-center">
            <div className="h-10 w-10 rounded-md bg-surface border border-border flex items-center justify-center mb-3">
                <Icon size={18} strokeWidth={1.5} className="text-subtle" />
            </div>
            <div className="text-sm font-medium">{title}</div>
            <div className="text-xs text-muted mt-1 max-w-md">{hint}</div>
        </div>
    )
}

export function SkeletonRows({ rows = 3 }: { rows?: number }) {
    return (
        <div className="rounded-lg border border-border overflow-hidden">
            <div className="p-4 space-y-2">
                {Array.from({ length: rows }).map((_, i) => (
                    <div key={i} className="h-8 rounded bg-surface animate-pulse" />
                ))}
            </div>
        </div>
    )
}

export function Th({
    children,
    align = "left",
}: {
    children: React.ReactNode
    align?: "left" | "right"
}) {
    return (
        <th
            className={`px-4 py-2.5 text-[11px] font-medium uppercase tracking-wider text-subtle ${
                align === "right" ? "text-right" : "text-left"
            }`}
        >
            {children}
        </th>
    )
}

export const inputClass =
    "w-full bg-background border border-border rounded-md px-3 py-2 text-sm placeholder:text-subtle outline-none focus:border-accent focus:ring-1 focus:ring-accent transition-colors"

export function Field({
    label,
    hint,
    required,
    children,
}: {
    label: string
    hint?: string
    required?: boolean
    children: React.ReactNode
}) {
    return (
        <label className="block">
            <div className="flex items-baseline justify-between mb-1.5">
                <span className="text-xs font-medium text-foreground">
                    {label}
                    {required && <span className="text-accent ml-0.5">*</span>}
                </span>
                {hint && <span className="text-[11px] text-subtle">{hint}</span>}
            </div>
            {children}
        </label>
    )
}

export function Modal({
    open,
    title,
    onClose,
    children,
    footer,
}: {
    open: boolean
    title: string
    onClose: () => void
    children: React.ReactNode
    footer?: React.ReactNode
}) {
    useEffect(() => {
        if (!open) return
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") onClose()
        }
        window.addEventListener("keydown", onKey)
        return () => window.removeEventListener("keydown", onKey)
    }, [open, onClose])

    if (!open) return null
    return (
        <div
            className="fixed inset-0 z-50 flex items-start justify-center pt-24 px-4 bg-black/60 backdrop-blur-sm animate-[fadeIn_120ms_ease-out]"
            onClick={onClose}
        >
            <div
                className="w-full max-w-lg rounded-lg border border-border bg-elevated shadow-2xl"
                onClick={(e) => e.stopPropagation()}
            >
                <div className="flex items-center justify-between px-5 py-3.5 border-b border-border-subtle">
                    <h2 className="text-sm font-semibold">{title}</h2>
                    <button
                        onClick={onClose}
                        aria-label="关闭"
                        className="text-muted hover:text-foreground transition-colors rounded p-1 -mr-1"
                    >
                        <X size={16} />
                    </button>
                </div>
                <div className="px-5 py-4 space-y-4">{children}</div>
                {footer && (
                    <div className="px-5 py-3 border-t border-border-subtle flex items-center justify-end gap-2">
                        {footer}
                    </div>
                )}
            </div>
            <style>{`@keyframes fadeIn { from { opacity: 0 } to { opacity: 1 } }`}</style>
        </div>
    )
}

export function Button({
    variant = "secondary",
    size = "md",
    children,
    ...props
}: {
    variant?: "primary" | "secondary" | "danger" | "ghost"
    size?: "sm" | "md"
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
    const base =
        "inline-flex items-center justify-center gap-1.5 rounded-md font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
    const sizes = {
        sm: "px-2.5 py-1 text-xs",
        md: "px-3.5 py-2 text-sm",
    }
    const variants = {
        primary: "bg-accent text-background hover:bg-accent-muted",
        secondary: "bg-surface text-foreground border border-border hover:bg-surface-hover",
        danger: "bg-danger/15 text-danger border border-danger/30 hover:bg-danger/25",
        ghost: "text-muted hover:text-foreground hover:bg-surface-hover",
    }
    return (
        <button className={`${base} ${sizes[size]} ${variants[variant]}`} {...props}>
            {children}
        </button>
    )
}

export function IconButton({
    icon: Icon,
    label,
    active,
    ...props
}: {
    icon: LucideIcon
    label: string
    active?: boolean
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
    return (
        <button
            aria-label={label}
            title={label}
            className={`inline-flex items-center gap-1 rounded px-1.5 py-1 text-xs transition-colors outline-none focus-visible:ring-2 focus-visible:ring-accent/60 ${
                active
                    ? "text-accent"
                    : "text-muted hover:text-foreground hover:bg-surface-hover"
            }`}
            {...props}
        >
            <Icon size={13} strokeWidth={1.75} />
            {label && <span>{label}</span>}
        </button>
    )
}
