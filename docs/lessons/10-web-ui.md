# 课时 10：Web UI 雏形（Bun.serve + REST API）

> 🎯 **目标**：搭出 web 进程入口 + REST API + 最简 React 前端，能在浏览器看 solver 列表。
>
> ⏰ **预计耗时**：3-4 小时
>
> 📋 **难度**：⭐⭐⭐⭐

---

## 你将学到什么

1. **Bun.serve** 怎么用
2. **DaemonManager** 装配根模式
3. **REST API 路由组织**
4. **Bun 的 HTML imports**（前端 + 后端同一个项目）
5. **React + Tailwind** 最简配置

## 前置条件

✅ 已完成 [课时 1-9](./README.md)

## 最终效果

```bash
tch-agent web
# → Web UI running at http://127.0.0.1:3000
```

浏览器打开看到：
- **左侧 sidebar**：API Keys / Solvers 两个菜单
- **API Keys 页**：列出 / 添加 / 删除 API Key
- **Solvers 页**：列出当前活跃的 solver

---

## 第零步：概念扫盲

### 0.1 Bun.serve 是什么？

Bun 内置的 HTTP 服务器，一行代码起服务：

```typescript
Bun.serve({
    port: 3000,
    fetch(req) {
        return new Response("Hello!")
    },
})
```

支持：
- HTTP/HTTPS
- WebSocket
- 静态文件
- 路由（routes 对象）
- HMR（开发模式）

比 Express / Fastify 简洁得多，性能也好。

### 0.2 HTML imports 是什么？

Bun 的特色功能：直接 import HTML 文件作为路由入口：

```typescript
import index from "./index.html"

Bun.serve({
    routes: {
        "/": index,   // ← 把 HTML 文件作为路由
    },
})
```

Bun 自动处理：
- HTML 里的 `<script src="./main.tsx">` 被打包
- `<link href="./style.css">` 被处理
- 支持热更新

这意味着前端和后端用**同一个项目**，不需要单独的 webpack/vite 配置。

### 0.3 DaemonManager 装配根

整个 web 进程需要：
- ConfigManager（配置）
- RuntimeManager（Docker 操作）

它们之间有依赖关系：RuntimeManager 需要 ConfigManager。

**DaemonManager 是装配根**：把所有依赖装配好，对外暴露统一的 `getInstance()`：

```typescript
const daemon = await DaemonManager.getInstance()
daemon.config.listApiKeys()
daemon.runtime.list()
```

这样 web server 不用关心构造顺序。

---

## 第一步：实现 DaemonManager

### 1.1 修改 packages/core/src/index.ts

```typescript
import { ConfigManager } from "./config/index"
import { RuntimeManager } from "./runtime/runtime"

// ... 已有 export 保留 ...

/**
 * DaemonManager：web 进程的"装配根"。
 *
 * 把 ConfigManager + RuntimeManager 装配在一起，让它们相互持有引用。
 *
 * 单例模式，整个 web 进程共用一份。
 */
export class DaemonManager {
    private static instance: Promise<DaemonManager> | undefined

    readonly config: ConfigManager
    readonly runtime: RuntimeManager

    private constructor(config: ConfigManager, runtime: RuntimeManager) {
        this.config = config
        this.runtime = runtime
    }

    static async getInstance(): Promise<DaemonManager> {
        if (this.instance) return this.instance

        const created = (async () => {
            const config = await ConfigManager.getInstance()
            const runtime = new RuntimeManager(config)
            await runtime.init()
            return new DaemonManager(config, runtime)
        })()

        this.instance = created.catch((error) => {
            if (this.instance === created) {
                this.instance = undefined
            }
            throw error
        })
        return this.instance
    }
}
```

---

## 第二步：创建 ui-web 包

### 2.1 创建目录和 package.json

```bash
mkdir -p packages/ui-web/src
```

新建 `packages/ui-web/package.json`：

```json
{
  "name": "@my/ui-web",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "main": "src/server.ts"
}
```

### 2.2 安装前端依赖

```bash
cd packages/ui-web
bun add react react-dom
bun add -d @types/react @types/react-dom tailwindcss
cd ../..
```

---

## 第三步：写 server.ts

### 3.1 创建 packages/ui-web/src/server.ts

新建 `packages/ui-web/src/server.ts`：

```typescript
import { DaemonManager } from "@my/core"
import index from "./index.html"

export interface WebServerOptions {
    hostname?: string
    port?: number
}

/**
 * 启动 Web UI + REST API 服务。
 */
export async function startWeb(options: WebServerOptions = {}): Promise<void> {
    const { hostname = "127.0.0.1", port = 3000 } = options
    const daemon = await DaemonManager.getInstance()
    const { config, runtime } = daemon

    // 预热 Docker runtime
    await runtime.init((msg) => console.log(`[runtime] ${msg}`))

    const server = Bun.serve({
        hostname,
        port,
        idleTimeout: 30,
        routes: {
            // ── 前端页面 ──
            "/": index,

            // ── API: API Keys ──
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

            // ── API: Provider 偏好 ──
            "/api/config/providers": {
                GET: async () => Response.json(await config.listProviderPrefs()),
                POST: async (req) => {
                    const entry = await req.json()
                    const result = await config.addProviderPref(entry)
                    return Response.json(result)
                },
                DELETE: async (req) => {
                    const { id } = await req.json()
                    await config.removeProviderPref(id)
                    return Response.json({ ok: true })
                },
            },

            // ── API: Model 偏好 ──
            "/api/config/model-prefs": {
                GET: async () => Response.json(await config.listModelPrefs()),
                POST: async (req) => {
                    const entry = await req.json()
                    const result = await config.addModelPref(entry)
                    return Response.json(result)
                },
                DELETE: async (req) => {
                    const { id } = await req.json()
                    await config.removeModelPref(id)
                    return Response.json({ ok: true })
                },
            },

            // ── API: Prompts ──
            "/api/config/prompts": {
                GET: async () => Response.json(await config.listPrompts()),
            },

            // ── API: Runtime solver 列表 ──
            "/api/runtime/solvers": {
                GET: () => Response.json(runtime.list()),
            },

            // ── API: Docker ping ──
            "/api/runtime/ping": {
                GET: async () => Response.json({ ok: await runtime.ping() }),
            },
        },
        fetch(req) {
            // 未匹配的路径返回 404
            return new Response("Not Found", { status: 404 })
        },
        development: {
            hmr: true,
            console: true,
        },
    })

    console.log(`\n🌐 Web UI running at http://${hostname}:${port}\n`)
}
```

---

## 第四步：写 index.html

### 4.1 创建 packages/ui-web/src/index.html

新建 `packages/ui-web/src/index.html`：

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>tch-agent</title>
    <link rel="stylesheet" href="./style.css" />
</head>
<body>
    <div id="root"></div>
    <script type="module" src="./main.tsx"></script>
</body>
</html>
```

### 4.2 创建 packages/ui-web/src/style.css

```bash
@import "tailwindcss";
```

Tailwind v4 用 `@import` 引入。

### 4.3 创建 packages/ui-web/src/main.tsx

```typescript
import { createRoot } from "react-dom/client"
import { App } from "./app"

const root = document.getElementById("root")
if (!root) throw new Error("root element not found")

createRoot(root).render(<App />)
```

### 4.4 创建 packages/ui-web/src/app.tsx

最简版，两个页面：API Keys 和 Solvers。

```typescript
import { useEffect, useState } from "react"

interface ApiKeyInfo {
    provider: string
    exists: boolean
}

interface SolverInfo {
    id: string
    status: string
    promptName: string
    containerId: string
}

type Page = "api-keys" | "solvers"

export function App() {
    const [page, setPage] = useState<Page>("api-keys")

    return (
        <div className="flex h-screen">
            {/* Sidebar */}
            <aside className="w-56 bg-slate-900 text-white p-4">
                <h1 className="text-xl font-bold mb-6">tch-agent</h1>
                <nav className="space-y-2">
                    <button
                        onClick={() => setPage("api-keys")}
                        className={`block w-full text-left px-3 py-2 rounded ${
                            page === "api-keys" ? "bg-slate-700" : "hover:bg-slate-800"
                        }`}
                    >
                        API Keys
                    </button>
                    <button
                        onClick={() => setPage("solvers")}
                        className={`block w-full text-left px-3 py-2 rounded ${
                            page === "solvers" ? "bg-slate-700" : "hover:bg-slate-800"
                        }`}
                    >
                        Solvers
                    </button>
                </nav>
            </aside>

            {/* Main */}
            <main className="flex-1 bg-slate-50 p-8">
                {page === "api-keys" && <ApiKeysPage />}
                {page === "solvers" && <SolversPage />}
            </main>
        </div>
    )
}

function ApiKeysPage() {
    const [providers, setProviders] = useState<string[]>([])
    const [loading, setLoading] = useState(true)
    const [newProvider, setNewProvider] = useState("")
    const [newKey, setNewKey] = useState("")

    async function reload() {
        setLoading(true)
        const res = await fetch("/api/config/api-keys")
        setProviders(await res.json())
        setLoading(false)
    }

    useEffect(() => {
        void reload()
    }, [])

    async function handleAdd() {
        if (!newProvider || !newKey) return
        await fetch("/api/config/api-keys", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ provider: newProvider, key: newKey }),
        })
        setNewProvider("")
        setNewKey("")
        void reload()
    }

    async function handleRemove(provider: string) {
        await fetch("/api/config/api-keys", {
            method: "DELETE",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ provider }),
        })
        void reload()
    }

    return (
        <div>
            <h2 className="text-2xl font-bold mb-4">API Keys</h2>

            <div className="bg-white rounded-lg shadow p-4 mb-4 flex gap-2">
                <input
                    type="text"
                    placeholder="provider (e.g. openai)"
                    value={newProvider}
                    onChange={(e) => setNewProvider(e.target.value)}
                    className="border rounded px-3 py-1 flex-1"
                />
                <input
                    type="password"
                    placeholder="key"
                    value={newKey}
                    onChange={(e) => setNewKey(e.target.value)}
                    className="border rounded px-3 py-1 flex-1"
                />
                <button
                    onClick={handleAdd}
                    className="bg-blue-500 text-white px-4 py-1 rounded hover:bg-blue-600"
                >
                    Add
                </button>
            </div>

            {loading ? (
                <div>Loading...</div>
            ) : providers.length === 0 ? (
                <div className="text-slate-500">No API keys configured</div>
            ) : (
                <table className="w-full bg-white rounded-lg shadow">
                    <thead>
                        <tr className="border-b">
                            <th className="text-left p-3">Provider</th>
                            <th className="text-left p-3">Actions</th>
                        </tr>
                    </thead>
                    <tbody>
                        {providers.map((p) => (
                            <tr key={p} className="border-b">
                                <td className="p-3 font-mono">{p}</td>
                                <td className="p-3">
                                    <button
                                        onClick={() => handleRemove(p)}
                                        className="text-red-500 hover:underline"
                                    >
                                        Remove
                                    </button>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            )}
        </div>
    )
}

function SolversPage() {
    const [solvers, setSolvers] = useState<SolverInfo[]>([])
    const [dockerOk, setDockerOk] = useState<boolean | null>(null)

    useEffect(() => {
        async function load() {
            const pingRes = await fetch("/api/runtime/ping")
            const pingData = await pingRes.json()
            setDockerOk(pingData.ok)

            const solversRes = await fetch("/api/runtime/solvers")
            setSolvers(await solversRes.json())
        }
        void load()
        const timer = setInterval(load, 2000)
        return () => clearInterval(timer)
    }, [])

    return (
        <div>
            <h2 className="text-2xl font-bold mb-4">Solvers</h2>

            <div className="bg-white rounded-lg shadow p-4 mb-4">
                <span className="font-semibold">Docker: </span>
                {dockerOk === null ? (
                    <span className="text-slate-500">checking...</span>
                ) : dockerOk ? (
                    <span className="text-green-600">✓ connected</span>
                ) : (
                    <span className="text-red-600">✗ not reachable</span>
                )}
            </div>

            {solvers.length === 0 ? (
                <div className="text-slate-500">No active solvers</div>
            ) : (
                <table className="w-full bg-white rounded-lg shadow">
                    <thead>
                        <tr className="border-b">
                            <th className="text-left p-3">ID</th>
                            <th className="text-left p-3">Status</th>
                            <th className="text-left p-3">Prompt</th>
                            <th className="text-left p-3">Container</th>
                        </tr>
                    </thead>
                    <tbody>
                        {solvers.map((s) => (
                            <tr key={s.id} className="border-b">
                                <td className="p-3 font-mono">{s.id}</td>
                                <td className="p-3">
                                    <StatusBadge status={s.status} />
                                </td>
                                <td className="p-3">{s.promptName}</td>
                                <td className="p-3 font-mono text-sm">{s.containerId}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            )}
        </div>
    )
}

function StatusBadge({ status }: { status: string }) {
    const colors: Record<string, string> = {
        starting: "bg-yellow-100 text-yellow-800",
        running: "bg-green-100 text-green-800",
        stopping: "bg-orange-100 text-orange-800",
        stopped: "bg-slate-100 text-slate-800",
        error: "bg-red-100 text-red-800",
    }
    const color = colors[status] ?? "bg-slate-100"
    return <span className={`px-2 py-1 rounded text-xs ${color}`}>{status}</span>
}
```

---

## 第五步：在 CLI 加 web 命令

### 5.1 修改 apps/cli/src/main.ts

加 web 命令：

```typescript
program
    .command("web")
    .description("Start the web UI server")
    .option("-p, --port <port>", "Port", "3000")
    .option("-h, --host <host>", "Hostname", "127.0.0.1")
    .action(async (opts: { port: string; host: string }) => {
        const { startWeb } = await import("@my/ui-web")
        await startWeb({
            hostname: opts.host,
            port: parseInt(opts.port, 10),
        })

        // 保持进程运行
        await new Promise(() => {})
    })
```

### 5.2 在 apps/cli 加对 ui-web 的依赖

修改 `apps/cli/package.json`：

```json
{
  "name": "@my/cli",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "bin": "src/main.ts",
  "dependencies": {
    "@my/core": "workspace:*",
    "@my/ui-web": "workspace:*",
    "commander": "^12"
  }
}
```

然后 `bun install`。

---

## 第六步：验证

### 6.1 启动 web

```bash
bun run apps/cli/src/main.ts web
```

**预期**：

```
[runtime] Image tch-agent:latest up to date (hash=...)
🌐 Web UI running at http://127.0.0.1:3000
```

### 6.2 浏览器打开

打开 `http://127.0.0.1:3000`，应该看到：
- 左侧 sidebar：tch-agent 标题 + 两个菜单
- 右侧默认显示 API Keys 页（暂时空）

### 6.3 测 API

```bash
# 添加 API Key
curl -X POST http://127.0.0.1:3000/api/config/api-keys \
  -H "Content-Type: application/json" \
  -d '{"provider":"openai","key":"sk-test123"}'

# 列出
curl http://127.0.0.1:3000/api/config/api-keys
# ["openai"]

# 删除
curl -X DELETE http://127.0.0.1:3000/api/config/api-keys \
  -H "Content-Type: application/json" \
  -d '{"provider":"openai"}'
```

### 6.4 前端交互

在浏览器：
1. 在 API Keys 页加一个 `openai` / `sk-test`。
2. 看到 table 出现一行。
3. 点 Remove 删除。

### 6.5 Docker 状态

切到 Solvers 页：
- 看到 "Docker: ✓ connected"（绿色）。
- Solvers 列表暂时空（你没跑 solver）。

如果显示 "✗ not reachable"，启动 Docker Desktop。

### 6.6 类型检查

```bash
bun run typecheck
```

---

## 第七步：故障排查

### 问题 1：访问页面 404

**原因**：`/` 路由没正确指向 HTML 文件。

**解决**：

```typescript
import index from "./index.html"
// ...
routes: { "/": index }
```

确保 `import index from "./index.html"` 路径正确。

### 问题 2：页面打开但样式没加载

**原因**：Tailwind 没正确编译。

**解决**：
- 确认 `style.css` 第一行是 `@import "tailwindcss";`
- 确认装了 `tailwindcss` 依赖
- Bun v4 自动处理 Tailwind，无需 PostCSS 配置

### 问题 3：React 报 "Target container is not a DOM element"

**原因**：`<div id="root"></div>` 还没渲染就执行 main.tsx。

**解决**：确保 `<script>` 在 `<body>` 末尾（你的 HTML 已经是这样）。

### 问题 4：API 返回 500

**调试**：在 server.ts 加错误处理：

```typescript
GET: () => {
    try {
        return Response.json(config.listApiKeys())
    } catch (error) {
        return Response.json({ error: String(error) }, { status: 500 })
    }
}
```

### 问题 5：端口被占用

**解决**：换个端口：

```bash
bun run apps/cli/src/main.ts web --port 3001
```

### 问题 6：HMR 不工作

**原因**：可能 `development: { hmr: true }` 没加。

**解决**：确认 Bun.serve 配置里有这一段。

---

## 本课小结

✅ **你已完成**：

- 实现 DaemonManager 装配根
- 用 Bun.serve 起后端 + 前端
- 加 REST API（API Keys / Provider / Model / Prompts / Solvers / Ping）
- 写最简 React + Tailwind 前端
- 浏览器可视化配置

📦 **新增文件**：

```
packages/ui-web/
├── package.json
└── src/
    ├── server.ts       ← startWeb + routes
    ├── index.html      ← 前端入口
    ├── style.css       ← Tailwind
    ├── main.tsx        ← React mount
    └── app.tsx         ← 两个页面组件
```

🔑 **关键概念**：

- **DaemonManager**：web 进程的装配根，统一持有 ConfigManager / RuntimeManager。
- **Bun.serve routes**：声明式路由，支持 method 分发。
- **HTML imports**：前端 + 后端同项目，无需 webpack。
- **Tailwind v4**：用 `@import "tailwindcss";` 即可，不用 PostCSS。

---

## 阶段 2 完结 🎉

恭喜！阶段 2（课时 6-10）全部完成。你已经能：

1. 把 LLM agent 跑进 Docker 容器
2. 通过 stdin/stdout JSONL 通信
3. 让容器反向调用宿主（host bridge）
4. 在浏览器管理配置和看 solver 状态

**阶段 3 预告**（课时 11-15）：实现 Planner LLM 自动调度 solver、challenge 数据存储、实时 SSE 推送。

---

## 下一课预告

[课时 11：Challenge 数据存储层](./11-challenge-store.md)（待生成）—— 我们会：

- 设计 challenge 目录布局（info.json + attempts + submissions）
- 实现原子写 + 文件锁
- 加完成检测（flag_count / flag_got_count）

继续课时 11 →
