import { DaemonManager } from "@my/core"
import type { AgentSessionEvent } from "@mariozechner/pi-coding-agent"
import { spawn } from "bun"
import { existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import index from "./index.html"
import { encodeSse } from "./sse"

export interface WebServerOptions {
    hostname?: string
    port?: number
}

const __dirname = dirname(fileURLToPath(import.meta.url))
const STYLE_SOURCE = join(__dirname, "style.css")
const STYLE_OUTPUT = join(__dirname, "..", "dist", "tailwind.css")

/** SSE keepalive 间隔：每 5s 发一行 `: keepalive` 注释，防代理超时。 */
const SSE_KEEPALIVE_MS = 5000

async function waitForBuiltCss(timeoutMs = 10_000): Promise<void> {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
        if (existsSync(STYLE_OUTPUT)) return
        await new Promise((r) => setTimeout(r, 100))
    }
    throw new Error(`tailwind build did not produce ${STYLE_OUTPUT} within ${timeoutMs}ms`)
}

async function startTailwindWatcher(): Promise<void> {
    if (existsSync(STYLE_OUTPUT)) return
    await new Promise<void>((resolve, reject) => {
        const proc = spawn(
            ["bunx", "@tailwindcss/cli", "-i", STYLE_SOURCE, "-o", STYLE_OUTPUT, "--minify"],
            { stdout: "inherit", stderr: "inherit", cwd: __dirname },
        )
        proc.exited
            .then((code) => {
                if (code === 0) resolve()
                else reject(new Error(`tailwind initial build exited with ${code}`))
            })
            .catch(reject)
    })

    spawn(
        ["bunx", "@tailwindcss/cli", "-i", STYLE_SOURCE, "-o", STYLE_OUTPUT, "--watch"],
        { stdout: "inherit", stderr: "inherit", cwd: __dirname },
    )
}

/**
 * 启动 Web UI + REST API 服务。
 */
export async function startWeb(options: WebServerOptions = {}): Promise<void> {
    const { hostname = "127.0.0.1", port = 3000 } = options
    const daemon = await DaemonManager.getInstance()
    const { config, runtime, challenge } = daemon

    await runtime.init((msg: string) => console.log(`[runtime] ${msg}`))
    await startTailwindWatcher()
    await waitForBuiltCss()

    // ── SSE 订阅注册表（课时 15）────────────────────────────
    // 两类频道：runtime 全局状态 + 单 solver 事件流
    const runtimeSubscribers = new Set<ReadableStreamDefaultController<Uint8Array>>()
    const solverSubscribers = new Map<string, Set<ReadableStreamDefaultController<Uint8Array>>>()

    const encoder = new TextEncoder()

    function closeController(controller: ReadableStreamDefaultController<Uint8Array>): void {
        try {
            controller.close()
        } catch {
            // 已经关了
        }
    }

    /** enqueue 容错：客户端已断会抛，捕获后清理。 */
    function safeEnqueue(
        controller: ReadableStreamDefaultController<Uint8Array>,
        frame: Uint8Array,
        onFailure?: () => void,
    ): boolean {
        try {
            controller.enqueue(frame)
            return true
        } catch {
            onFailure?.()
            closeController(controller)
            return false
        }
    }

    /**
     * 建一条 SSE 连接：
     *   - 立即发 `: connected` 注释
     *   - 每 SSE_KEEPALIVE_MS 发 `: keepalive` 注释（防代理超时）
     *   - 客户端 abort 时清理订阅 + 关流
     */
    function openSse(
        req: Request,
        onStart: (controller: ReadableStreamDefaultController<Uint8Array>) => void,
        onClose: (controller: ReadableStreamDefaultController<Uint8Array>) => void,
    ): Response {
        const stream = new ReadableStream<Uint8Array>({
            start(controller) {
                onStart(controller)
                safeEnqueue(controller, encoder.encode(": connected\n\n"), () => onClose(controller))

                const timer = setInterval(() => {
                    safeEnqueue(controller, encoder.encode(": keepalive\n\n"), () => {
                        clearInterval(timer)
                        onClose(controller)
                    })
                }, SSE_KEEPALIVE_MS)

                req.signal.addEventListener(
                    "abort",
                    () => {
                        clearInterval(timer)
                        onClose(controller)
                        closeController(controller)
                    },
                    { once: true },
                )
            },
        })
        return new Response(stream, {
            headers: {
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache",
                Connection: "keep-alive",
            },
        })
    }

    /** 把 runtime 快照广播给所有全局订阅者。 */
    async function broadcastRuntimeSnapshot(): Promise<void> {
        if (runtimeSubscribers.size === 0) return
        const frame = encodeSse("status", {
            docker: await runtime.ping(),
            solvers: runtime.list().length,
        })
        for (const controller of [...runtimeSubscribers]) {
            safeEnqueue(controller, frame, () => runtimeSubscribers.delete(controller))
        }
    }

    /** 把单 solver 事件扇出给该 solver 的所有订阅者。 */
    function broadcastSolverEvent(solverId: string, event: AgentSessionEvent): void {
        const subscribers = solverSubscribers.get(solverId)
        if (!subscribers || subscribers.size === 0) return
        const frame = encodeSse("agent_event", event)
        for (const controller of [...subscribers]) {
            safeEnqueue(controller, frame, () => {
                subscribers.delete(controller)
                if (subscribers.size === 0) solverSubscribers.delete(solverId)
            })
        }
    }

    // 订阅 RuntimeManager 事件总线（lesson 7 已实现），扇出给 web 订阅者；
    // agent_end 时刷新一次全局快照（solver 数量可能变了）。
    runtime.onEvent((solverId, event) => {
        broadcastSolverEvent(solverId, event)
        if ((event as { type?: string }).type === "agent_end") {
            void broadcastRuntimeSnapshot()
        }
    })

    Bun.serve({
        hostname,
        port,
        idleTimeout: 30,
        routes: {
            "/": index,

            "/tailwind.css": () =>
                new Response(Bun.file(STYLE_OUTPUT), {
                    headers: { "Content-Type": "text/css; charset=utf-8" },
                }),

            "/api/config/api-keys": {
                GET: () => Response.json(config.listApiKeys()),
                POST: async (req) => {
                    const { provider, key } = await req.json()
                    config.setApiKey(provider, key)
                    return Response.json({ ok: true })
                },
                DELETE: async (req) => {
                    const { provider } = await req.json()
                    config.removeApiKey(provider)
                    return Response.json({ ok: true })
                },
            },

            "/api/config/providers": {
                GET: async () => Response.json(await config.listProviderPrefs()),
                POST: async (req) => {
                    const entry = await req.json()
                    const result = await config.addProviderPref(entry)
                    return Response.json(result)
                },
                PUT: async (req) => {
                    const { id, ...patch } = await req.json()
                    const updated = await config.updateProviderPref(id, patch)
                    if (!updated) return Response.json({ rejected: "not found" }, { status: 404 })
                    return Response.json(updated)
                },
                DELETE: async (req) => {
                    const { id } = await req.json()
                    await config.removeProviderPref(id)
                    return Response.json({ ok: true })
                },
            },

            "/api/config/model-prefs": {
                GET: async () => Response.json(await config.listModelPrefs()),
                POST: async (req) => {
                    const entry = await req.json()
                    const result = await config.addModelPref(entry)
                    return Response.json(result)
                },
                PUT: async (req) => {
                    const { id, ...patch } = await req.json()
                    const updated = await config.updateModelPref(id, patch)
                    if (!updated) return Response.json({ rejected: "not found" }, { status: 404 })
                    return Response.json(updated)
                },
                DELETE: async (req) => {
                    const { id } = await req.json()
                    await config.removeModelPref(id)
                    return Response.json({ ok: true })
                },
            },

            "/api/config/prompts": {
                GET: async () => Response.json(await config.listPrompts()),
            },

            "/api/runtime/solvers": {
                GET: () => Response.json(runtime.list()),
            },

            "/api/runtime/ping": {
                GET: async () => Response.json({ ok: await runtime.ping() }),
            },

            // ── Attack Timeline（课时 20）：聚合 attempts/submissions/memory/ideas ──

            "/api/runtime/challenges/:id/timeline": {
                GET: async (_req, params) =>
                    Response.json(await challenge.buildAttackTimeline(params.id)),
            },

            // ── SSE 路由（课时 15）──

            "/api/runtime/stream": {
                GET: (req) =>
                    openSse(
                        req,
                        (controller) => {
                            runtimeSubscribers.add(controller)
                            // 连上立即推一次初始状态
                            void (async () => {
                                const statusFrame = encodeSse("status", {
                                    docker: await runtime.ping(),
                                    solvers: runtime.list().length,
                                })
                                safeEnqueue(controller, statusFrame, () =>
                                    runtimeSubscribers.delete(controller),
                                )
                                const solversFrame = encodeSse("solvers", runtime.list())
                                safeEnqueue(controller, solversFrame, () =>
                                    runtimeSubscribers.delete(controller),
                                )
                            })()
                        },
                        (controller) => runtimeSubscribers.delete(controller),
                    ),
            },

            "/api/runtime/solvers/:id/stream": {
                GET: (req, params) =>
                    openSse(
                        req,
                        (controller) => {
                            const solverId = params.id
                            const subscribers =
                                solverSubscribers.get(solverId) ?? new Set()
                            subscribers.add(controller)
                            solverSubscribers.set(solverId, subscribers)
                        },
                        (controller) => {
                            // 从所有频道的 set 里清理（同一 controller 理论上只在一个频道）
                            for (const [id, subscribers] of solverSubscribers) {
                                subscribers.delete(controller)
                                if (subscribers.size === 0) solverSubscribers.delete(id)
                            }
                        },
                    ),
            },
        },
        fetch() {
            return new Response("Not Found", { status: 404 })
        },
        development: {
            hmr: true,
            console: true,
        },
    })

    console.log(`\n🌐 Web UI running at http://${hostname}:${port}\n`)
}
