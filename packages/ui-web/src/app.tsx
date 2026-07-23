import { useState } from "react"
import { Boxes, Brain, KeyRound, Server } from "lucide-react"
import type { LucideIcon } from "lucide-react"
import { ApiKeysPage } from "./pages/api-keys"
import { ModelPrefsPage } from "./pages/model-prefs"
import { ProvidersPage } from "./pages/providers"
import { SolverDetailPage } from "./pages/solver-detail"
import { SolversPage } from "./pages/solvers"

type NavPage = "solvers" | "api-keys" | "providers" | "model-prefs"
type Page = NavPage | { type: "solver-detail"; id: string }

const NAV: { id: NavPage; label: string; icon: LucideIcon }[] = [
    { id: "solvers", label: "Solvers", icon: Server },
    { id: "api-keys", label: "API Keys", icon: KeyRound },
    { id: "providers", label: "Providers", icon: Boxes },
    { id: "model-prefs", label: "Model Prefs", icon: Brain },
]

export function App() {
    const [page, setPage] = useState<Page>(() => {
        if (typeof window === "undefined") return "solvers"
        const hash = window.location.hash.replace("#", "")
        // solver 详情页用 #solver/<id> 编码，支持刷新/深链
        if (hash.startsWith("solver/")) {
            const id = hash.slice("solver/".length)
            if (id) return { type: "solver-detail", id }
        }
        return NAV.find((n) => n.id === hash)?.id ?? "solvers"
    })

    function navigate(p: Page) {
        setPage(p)
        if (typeof window !== "undefined") {
            window.location.hash = typeof p === "string" ? p : `solver/${p.id}`
        }
    }

    return (
        <div className="flex h-screen bg-background text-foreground">
            <Sidebar page={page} onChange={navigate} />
            <main className="flex-1 overflow-auto">
                {page === "solvers" && (
                    <SolversPage
                        onSelectSolver={(id) => navigate({ type: "solver-detail", id })}
                    />
                )}
                {page === "api-keys" && <ApiKeysPage />}
                {page === "providers" && <ProvidersPage />}
                {page === "model-prefs" && <ModelPrefsPage />}
                {typeof page === "object" && page.type === "solver-detail" && (
                    <SolverDetailPage solverId={page.id} onBack={() => navigate("solvers")} />
                )}
            </main>
        </div>
    )
}

function Sidebar({ page, onChange }: { page: Page; onChange: (p: Page) => void }) {
    return (
        <aside className="w-60 shrink-0 border-r border-border-subtle bg-surface flex flex-col">
            <div className="px-5 py-5 flex items-center gap-2.5">
                <span className="relative flex h-2.5 w-2.5">
                    <span className="absolute inset-0 rounded-full bg-accent pulse-status" />
                    <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-accent" />
                </span>
                <div className="leading-tight">
                    <div className="text-sm font-semibold tracking-tight">tinyfat</div>
                    <div className="text-[11px] text-subtle">control plane</div>
                </div>
            </div>

            <nav className="flex-1 px-3 py-2 space-y-0.5">
                {NAV.map(({ id, label, icon: Icon }) => {
                    const active = page === id
                    return (
                        <button
                            key={id}
                            onClick={() => onChange(id)}
                            aria-current={active ? "page" : undefined}
                            className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-md text-sm transition-colors ${
                                active
                                    ? "bg-background text-foreground"
                                    : "text-muted hover:text-foreground hover:bg-background/60"
                            }`}
                        >
                            <Icon
                                size={16}
                                strokeWidth={active ? 2.25 : 1.75}
                                className={active ? "text-accent" : ""}
                            />
                            <span className={active ? "font-medium" : ""}>{label}</span>
                        </button>
                    )
                })}
            </nav>

            <div className="px-5 py-4 border-t border-border-subtle text-[11px] text-subtle">
                v0.0.1 · <span className="font-mono">lesson 10</span>
            </div>
        </aside>
    )
}
