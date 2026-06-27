import { DaemonManager } from "@my/core"
import { spawn } from "bun"
import { existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import index from "./index.html"

export interface WebServerOptions {
    hostname?: string
    port?: number
}

const __dirname = dirname(fileURLToPath(import.meta.url))
const STYLE_SOURCE = join(__dirname, "style.css")
const STYLE_OUTPUT = join(__dirname, "..", "dist", "tailwind.css")

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
    const { config, runtime } = daemon

    await runtime.init((msg: string) => console.log(`[runtime] ${msg}`))
    await startTailwindWatcher()
    await waitForBuiltCss()

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
