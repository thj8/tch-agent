# 课时 10：Web UI 雏形（Bun.serve + REST API + React）

> 🎯 **目标**：搭出 web 进程入口 + REST API + React 前端，能在浏览器管理 API Key / Provider / Model 偏好，看 solver 列表。
>
> ⏰ **预计耗时**：4-5 小时
>
> 📋 **难度**：⭐⭐⭐⭐

---

## 你将学到什么

1. **Bun.serve** 怎么用（routes + HTML imports + HMR）
2. **DaemonManager** 装配根模式
3. **REST API 路由组织**（含 PUT 改操作）
4. **Bun 的 HTML imports** —— 前后端同项目
5. **Bun + Tailwind v4 的坑**：自动集成有 bug，要 sidecar
6. **React 多文件结构**：components / pages / lib 拆分
7. **Modal + Form** 的最小可用模式

## 前置条件

✅ 已完成 [课时 1-9](./README.md)

## 最终效果

```bash
tinyfat web
# → 🌐 Web UI running at http://127.0.0.1:3000
```

浏览器打开看到深色 Dashboard：

- **左侧 sidebar**：Solvers / API Keys / Providers / Model Prefs 四个菜单
- **API Keys 页**：列出 / 添加 / 删除 API Key
- **Providers 页**：列出 / 添加 / 编辑 / 删除 Provider 偏好（含 baseUrl / api / models）
- **Model Prefs 页**：列出 / 添加 / 编辑 / 删除 Model 偏好
- **Solvers 页**：列出活跃 solver + Docker 状态实时刷新

URL 支持 hash 深链：`http://127.0.0.1:3000/#providers` 直接落到 Providers 页。

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
- 路由（`routes` 对象，每个路径按 method 分发）
- HMR（开发模式）

比 Express / Fastify 简洁得多，性能也好。

### 0.2 HTML imports 是什么？

Bun 的特色功能：直接 import HTML 文件作为路由入口：

```typescript
import index from "./index.html"

Bun.serve({
    routes: {
        "/": index,   // ← HTML 文件作为路由
    },
})
```

Bun 自动处理：

- HTML 里的 `<script src="./main.tsx">` 被打包
- import 链上的 TS / TSX / CSS 一并编译
- 支持热更新

⚠️ **坑**：HTML 里 `<link href="/abs-path.css">` 会被 HTML 打包器在**构建期**解析，即使该路径是运行时路由也会报 "Could not resolve"。后面会讲绕过方法。

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

### 修改 packages/core/src/index.ts

```typescript
import { ConfigManager } from "./config/index"
import { RuntimeManager } from "./runtime/runtime"

// ... 已有 export 保留 ...

/**
 * DaemonManager：web 进程的"装配根"。
 *
 * 把 ConfigManager + RuntimeManager 装配在一起。
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

```bash
mkdir -p packages/ui-web/src
```

`packages/ui-web/package.json`：

```json
{
  "name": "@my/ui-web",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "main": "src/server.ts",
  "dependencies": {
    "@fontsource-variable/inter": "^5.2.8",
    "@fontsource-variable/jetbrains-mono": "^5.2.8",
    "@my/core": "workspace:*",
    "lucide-react": "^1.21.0",
    "react": "^19.2.7",
    "react-dom": "^19.2.7"
  },
  "devDependencies": {
    "@tailwindcss/cli": "^4.3.1",
    "@tailwindcss/postcss": "^4.3.1",
    "@types/react": "^19.2.17",
    "@types/react-dom": "^19.2.3",
    "postcss": "^8.5.6",
    "tailwindcss": "^4.3.1"
  }
}
```

依赖说明：

- `@fontsource-variable/inter` / `jetbrains-mono`：自托管字体（避免走 Google CDN）
- `lucide-react`：SVG 图标库（替代 emoji，符合 WCAG 推荐）
- `tailwindcss` + `@tailwindcss/cli`：见第四步"为什么 sidecar"

---

## 第三步：写 server.ts

`packages/ui-web/src/server.ts`：

```typescript
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
    // 首次构建（阻塞，等退出码）
    await new Promise<void>((resolve, reject) => {
        const proc = spawn(
            ["bunx", "@tailwindcss/cli", "-i", STYLE_SOURCE, "-o", STYLE_OUTPUT, "--minify"],
            { stdout: "inherit", stderr: "inherit", cwd: __dirname },
        )
        proc.exited
            .then((code) => code === 0 ? resolve() : reject(new Error(`tailwind exited ${code}`)))
            .catch(reject)
    })
    // watch 常驻
    spawn(
        ["bunx", "@tailwindcss/cli", "-i", STYLE_SOURCE, "-o", STYLE_OUTPUT, "--watch"],
        { stdout: "inherit", stderr: "inherit", cwd: __dirname },
    )
}

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
                    return Response.json(await config.addProviderPref(entry))
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
                POST: async (req) => Response.json(await config.addModelPref(await req.json())),
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
        development: { hmr: true, console: true },
    })

    console.log(`\n🌐 Web UI running at http://${hostname}:${port}\n`)
}
```

要点：

1. **Tailwind sidecar**：见第四步为什么这么写
2. **PUT 路由**：`{ id, ...patch }` 把 id 剥出来，剩下作为 patch 给 `updateXxx`
3. **routes 是声明式**：每个路径按 method 分发，未匹配走 `fetch()` 兜底 404

---

## 第四步：Bun + Tailwind v4 的坑

### 4.1 现象

如果只在 `style.css` 里写 `@import "tailwindcss";` 然后在 HTML 里 `<link href="./style.css">`，Bun 1.3.14 自带的 Tailwind 集成会**只处理 `@theme` 变量、不生成任何工具类**。结果：页面有颜色但没布局（`.flex` / `.h-screen` 全空），看起来像没加载 CSS。

GitHub issue：[oven-sh/bun#19021](https://github.com/oven-sh/bun/issues/19021)。

### 4.2 解决方案：sidecar

绕开 Bun 自动集成，手动起 `@tailwindcss/cli` 子进程：

1. 启动时先 `bunx @tailwindcss/cli -i style.css -o dist/tailwind.css --minify` 跑一次（等退出码）
2. 再起 `--watch` 模式常驻
3. Bun.serve 加 `/tailwind.css` 路由读构建产物

这就是 `server.ts` 里 `startTailwindWatcher()` 干的事。

### 4.3 `style.css` 写法

```css
@import "tailwindcss";
@source "./**/*.{tsx,ts}";

@theme {
    --color-background: #0F172A;
    --color-surface: #1E293B;
    --color-surface-hover: #243348;
    --color-elevated: #272F42;
    --color-border: #334155;
    --color-border-subtle: #1E293B;

    --color-foreground: #F8FAFC;
    --color-muted: #94A3B8;
    --color-subtle: #64748B;

    --color-accent: #22C55E;
    --color-accent-muted: #16A34A;
    --color-accent-soft: rgba(34, 197, 94, 0.12);

    --color-info: #3B82F6;
    --color-warning: #F59E0B;
    --color-danger: #EF4444;

    --font-sans: "Inter Variable", system-ui, -apple-system, "Segoe UI", sans-serif;
    --font-mono: "JetBrains Mono Variable", ui-monospace, "SF Mono", Menlo, monospace;
}

html, body, #root { height: 100%; }

body {
    background: var(--color-background);
    color: var(--color-foreground);
    font-family: var(--font-sans);
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
}

* {
    scrollbar-width: thin;
    scrollbar-color: var(--color-border) transparent;
}
*::-webkit-scrollbar { width: 8px; height: 8px; }
*::-webkit-scrollbar-track { background: transparent; }
*::-webkit-scrollbar-thumb { background: var(--color-border); border-radius: 4px; }
*::-webkit-scrollbar-thumb:hover { background: var(--color-subtle); }

@keyframes pulse-status {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.55; }
}
.pulse-status { animation: pulse-status 1.8s ease-in-out infinite; }

@media (prefers-reduced-motion: reduce) {
    .pulse-status { animation: none; }
}
```

关键点：

- `@source "./**/*.{tsx,ts}"` 告诉 Tailwind 扫描所有 tsx 文件抽取用到的工具类
- `@theme` 定义语义化色 token，写组件时用 `bg-surface` / `text-muted` 等

### 4.4 HTML 不能写 `<link>`

Bun 的 HTML 打包器在构建期会尝试解析 `<link href="/foo.css">`，即使 `/foo.css` 是运行时路由也会报 "Could not resolve: /tailwind.css"。

绕过：在 `main.tsx` 里**运行时**注入 `<link>`。

---

## 第五步：前端入口三个文件

### 5.1 index.html

```html
<!DOCTYPE html>
<html lang="zh-CN" class="dark">
<head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="color-scheme" content="dark" />
    <title>tch-agent</title>
    <style>
        html, body { background: #0F172A; color: #F8FAFC; }
    </style>
</head>
<body>
    <div id="root"></div>
    <script type="module" src="./main.tsx"></script>
</body>
</html>
```

注意：

- **不要**在这里写 `<link rel="stylesheet" href="/tailwind.css">`（见 4.4）
- `<style>` 内联一个底色，避免白屏闪烁
- `class="dark"` + `color-scheme: dark` 让浏览器原生控件也是深色

### 5.2 main.tsx

```typescript
import "@fontsource-variable/inter"
import "@fontsource-variable/jetbrains-mono"
import { createRoot } from "react-dom/client"
import { App } from "./app"

// 运行时注入 Tailwind 样式表，避开 Bun HTML 打包器的构建期解析
const link = document.createElement("link")
link.rel = "stylesheet"
link.href = "/tailwind.css"
document.head.appendChild(link)

const root = document.getElementById("root")
if (!root) throw new Error("root element not found")

createRoot(root).render(<App />)
```

---

## 第六步：React 多文件结构

UI 长大了之后单文件维护很痛苦，按职责拆：

```
packages/ui-web/src/
├── app.tsx                  ← 装配：sidebar + 路由
├── components/
│   └── ui.tsx               ← 共享：PageHeader / Modal / Button / Field / ...
├── lib/
│   └── types.ts             ← 共享类型（ProviderPrefEntry / ModelConfigEntry / 常量）
├── pages/
│   ├── api-keys.tsx         ← API Keys CRUD
│   ├── providers.tsx        ← Providers CRUD（含 Modal 表单）
│   ├── model-prefs.tsx      ← Model Prefs CRUD（含 Modal 表单）
│   └── solvers.tsx          ← Solvers 列表（只读 + 轮询）
├── index.html
├── main.tsx
├── server.ts
└── style.css
```

### 6.1 lib/types.ts

把后端返回的类型集中放：

```typescript
export interface ProviderPrefEntry {
    id: string
    hash?: string
    name: string
    api?: string
    baseUrl?: string
    apiKey?: string
    models?: string[]
}

export interface ModelConfigEntry {
    id: string
    hash?: string
    provider: string
    modelId: string
    thinkingLevel?: string
    contextWindow?: number
    maxTokens?: number
}

export const PROVIDER_APIS = [
    "openai-completions",
    "anthropic-messages",
    "google-gemini",
    "ollama",
] as const

export const THINKING_LEVELS = ["low", "medium", "high", "xhigh"] as const
```

常量（`PROVIDER_APIS` / `THINKING_LEVELS`）让 select 选项和后端协议保持一致。

### 6.2 components/ui.tsx —— 共享 UI

最常用的几个：

```typescript
export function PageHeader({ title, subtitle, count, icon: Icon, action }) {
    // 一致的页面顶部：图标 + 标题 + 副标题 + 计数 chip + 操作按钮
}

export function EmptyState({ icon: Icon, title, hint }) {
    // 空状态占位（带图标 + 提示）
}

export function Modal({ open, title, onClose, children, footer }) {
    // 通用模态框，ESC 关闭 + 点遮罩关闭 + fadeIn 动画
}

export function Button({ variant = "secondary", size = "md", ...props }) {
    // variant: primary | secondary | danger | ghost
}

export function Field({ label, hint, required, children }) {
    // 表单 Field wrapper：label + hint + required asterisk
}

export const inputClass =
    "w-full bg-background border border-border rounded-md px-3 py-2 text-sm " +
    "placeholder:text-subtle outline-none focus:border-accent focus:ring-1 focus:ring-accent"
```

要点：

- `Modal` 用 `position: fixed` + `backdrop-blur` 遮罩，按 ESC 关闭
- `inputClass` 一处定义处处复用，保证输入框样式统一
- 所有可点击元素都有 `focus-visible:ring`，键盘可访问

### 6.3 pages/providers.tsx —— Providers CRUD

整个页面用一个组件搞定：列表 table + Add 模态框 + Edit 模态框 + Delete 确认框。

核心结构：

```typescript
export function ProvidersPage() {
    const [list, setList] = useState<ProviderPrefEntry[]>([])
    const [creating, setCreating] = useState<FormState | null>(null)   // null = 关闭
    const [editing, setEditing] = useState<{ id: string; form: FormState } | null>(null)
    const [confirmDelete, setConfirmDelete] = useState<ProviderPrefEntry | null>(null)

    async function reload() { /* GET /api/config/providers */ }
    async function submit(form: FormState, id?: string) {
        // 有 id → PUT，没 id → POST
        const res = await fetch("/api/config/providers", {
            method: id ? "PUT" : "POST",
            body: JSON.stringify(id ? { id, ...body } : body),
        })
        // 处理 rejected，更新 list
    }
    async function handleDelete(id: string) { /* DELETE */ }

    return (
        <div>
            <PageHeader title="Providers" ... action={<Button onClick={openAdd}>Add</Button>} />
            {list.length === 0 ? <EmptyState .../> : <table>...</table>}

            <ProviderFormModal open={creating !== null} ... />
            <ProviderFormModal open={editing !== null} ... />
            <Modal open={confirmDelete !== null} ...>确认删除？</Modal>
        </div>
    )
}
```

表单状态用单个 `FormState` 对象管理：

```typescript
interface FormState {
    name: string
    api: string
    baseUrl: string
    apiKey: string
    modelsText: string   // 逗号分隔，提交时拆成数组
}
```

`modelsText` 是字符串（"gpt-4o, gpt-4o-mini"），提交时 `.split(/[,\s]+/).filter(Boolean)` 转数组。这样表单输入简单，API 序列化时再规范化。

### 6.4 pages/model-prefs.tsx —— Model Prefs CRUD

模式跟 Providers 一模一样，只是字段不同（id / provider / modelId / thinkingLevel / contextWindow / maxTokens）。

### 6.5 app.tsx —— 装配 + 路由

```typescript
type Page = "solvers" | "api-keys" | "providers" | "model-prefs"

export function App() {
    const [page, setPage] = useState<Page>(() => {
        // 从 URL hash 恢复，支持深链
        const hash = window.location.hash.replace("#", "")
        return (NAV.find((n) => n.id === hash)?.id ?? "solvers") as Page
    })
    function navigate(p: Page) {
        setPage(p)
        window.location.hash = p
    }
    return (
        <div className="flex h-screen bg-background text-foreground">
            <Sidebar page={page} onChange={navigate} />
            <main className="flex-1 overflow-auto">
                {page === "solvers" && <SolversPage />}
                {page === "api-keys" && <ApiKeysPage />}
                {page === "providers" && <ProvidersPage />}
                {page === "model-prefs" && <ModelPrefsPage />}
            </main>
        </div>
    )
}
```

hash 路由的好处：刷新还在原页，URL 可以直接分享。

---

## 第七步：在 CLI 加 web 命令

`apps/cli/src/main.ts`：

```typescript
program
    .command("web")
    .description("Start the web UI server")
    .option("-p, --port <port>", "Port", "3000")
    .option("-H, --host <host>", "Hostname", "127.0.0.1")
    .action(async (opts: { port: string; host: string }) => {
        // ui-web 是另一个包，且重（Bun.serve + React + Tailwind sidecar），
        // 只有 web 命令用到 → 这里用 dynamic import 才有意义。
        // @my/core 里的所有符号都已在顶部静态 import。
        const { startWeb } = await import("@my/ui-web")
        await startWeb({
            hostname: opts.host,
            port: parseInt(opts.port, 10),
        })
        await new Promise(() => {})
    })
```

> 💡 **dynamic import 的判断标准**：
> - **顶部静态**：`@my/core` 这种 monorepo 内部包，被多个命令用到，反正躲不掉
> - **dynamic `await import()`**：只在某条命令里用到 + 包很重（拉 React / Docker / 大型 SDK） + 跟常用包没共享 chunk → 这种情况延迟加载才有真实收益
>
> `@my/ui-web` 满足所有条件（只有 `web` 用 + 拉 React），所以保留 dynamic；`@my/core` 不满足（已被 init 等命令静态 import），统一在顶部。

`apps/cli/package.json` 加依赖：

```json
{
  "dependencies": {
    "@my/core": "workspace:*",
    "@my/ui-web": "workspace:*"
  }
}
```

`bun install`。

---

## 第八步：验证

### 8.1 启动

```bash
bun apps/cli/src/main.ts web
```

**预期输出**：

```
[runtime] Image tinyfat:latest up to date (hash=...)
... (Tailwind CLI 构建日志)
🌐 Web UI running at http://127.0.0.1:3000
```

### 8.2 浏览器打开

访问 `http://127.0.0.1:3000`，应看到：

- 左侧 sidebar：tinyfat logo（脉动绿点）+ 四个菜单 + 版本号
- 默认落 Solvers 页，显示 Docker 状态 + "No active solvers" 空状态

试试切到 Providers 页（或直接访问 `/#providers`），点 **Add Provider**，弹模态框，填测试数据：

```
Name: anthropic-gw
API: anthropic-messages
Base URL: https://api.anthropic.com
Models: claude-sonnet-4-5, claude-haiku-4-5
```

提交后表格出现一行，Name / API / Base URL / 模型 chip / edit / delete 都可见。

### 8.3 API 测试

```bash
# 增
curl -X POST http://127.0.0.1:3000/api/config/providers \
  -H "Content-Type: application/json" \
  -d '{"name":"test","baseUrl":"https://example.com","models":["m1"]}'
# → {"id":"prov_xxxxxx"}

# 查
curl http://127.0.0.1:3000/api/config/providers

# 改
curl -X PUT http://127.0.0.1:3000/api/config/providers \
  -H "Content-Type: application/json" \
  -d '{"id":"prov_xxxxxx","name":"test-renamed"}'

# 删
curl -X DELETE http://127.0.0.1:3000/api/config/providers \
  -H "Content-Type: application/json" \
  -d '{"id":"prov_xxxxxx"}'
```

Model Prefs 同款四步（`POST` / `GET` / `PUT` / `DELETE` on `/api/config/model-prefs`）。

### 8.4 类型检查

```bash
bun run typecheck
```

应零错误。

---

## 第九步：故障排查

### 问题 1：页面打开纯文字、没样式

**原因**：Bun 1.3.14 自带的 `bun-plugin-tailwind` 有 bug（[issue #19021](https://github.com/oven-sh/bun/issues/19021)），只处理 `@theme`、不生成工具类。

**解决**：按第四步起 `@tailwindcss/cli` sidecar，不要依赖 Bun 的自动集成。

### 问题 2：构建报 "Could not resolve: /tailwind.css"

**原因**：HTML 打包器把 `<link href="/tailwind.css">` 当作构建期资源解析。

**解决**：从 `index.html` 删掉 link 标签，改在 `main.tsx` 里 `document.createElement("link")` 运行时注入。

### 问题 3：访问页面 404

**原因**：`/` 路由没正确指向 HTML 文件。

**解决**：确认 `import index from "./index.html"` 路径正确，`routes: { "/": index }`。

### 问题 4：API 返回 404 on DELETE / PUT

**原因**：路由对象的 method 漏写了，或者请求没带 `Content-Type: application/json` 导致 `req.json()` 抛错。

**解决**：用 `curl -H "Content-Type: application/json"` 重试，看 server 日志。

### 问题 5：HMR 不工作

**原因**：可能 `development: { hmr: true }` 没加。

**解决**：确认 `Bun.serve` 配置里有这一段。

### 问题 6：端口被占用

**解决**：换端口 `tinyfat web --port 3001`。

### 问题 7：Tailwind sidecar 一直没产物

**调试**：

```bash
cd packages/ui-web
bunx @tailwindcss/cli -i src/style.css -o /tmp/tw.css --minify
ls -la /tmp/tw.css   # 看有没有产物 + 体积是否合理（>5KB）
```

如果产物体积很小（< 1KB），说明 `@source` 没扫到 tsx，检查路径。

---

## 本课小结

✅ **你已完成**：

- 实现 DaemonManager 装配根
- 用 Bun.serve 起后端 + 前端
- 加 REST API（API Keys / Providers / Model Prefs / Prompts / Solvers / Ping，含 PUT 改操作）
- 跳过 Bun 自动 Tailwind 集成，用 sidecar 模式
- React 多文件结构（components / pages / lib 拆分）
- Modal + Form 模式实现完整 CRUD
- URL hash 深链路由

📦 **新增文件**：

```
packages/ui-web/
├── package.json
└── src/
    ├── server.ts            ← startWeb + Tailwind sidecar + routes
    ├── index.html           ← 前端入口（运行时注入 CSS）
    ├── style.css            ← Tailwind v4 + @theme tokens
    ├── main.tsx             ← React mount + 字体 + CSS 注入
    ├── app.tsx              ← sidebar + hash 路由
    ├── components/
    │   └── ui.tsx           ← PageHeader / Modal / Button / Field / ...
    ├── lib/
    │   └── types.ts         ← 共享类型 + 常量
    └── pages/
        ├── api-keys.tsx
        ├── providers.tsx    ← CRUD + Modal
        ├── model-prefs.tsx  ← CRUD + Modal
        └── solvers.tsx
```

🔑 **关键概念**：

- **DaemonManager**：web 进程的装配根
- **Bun.serve routes**：声明式路由，每个路径按 method 分发
- **HTML imports**：前后端同项目，无需 webpack
- **Tailwind v4 + Bun**：自动集成有 bug，用 `@tailwindcss/cli` sidecar 绕过
- **运行时 CSS 注入**：避开 HTML 打包器的构建期路径解析
- **Modal + FormState**：CRUD 表单的最小可用模式

---

## 阶段 2 完结 🎉

恭喜！阶段 2（课时 6-10）全部完成。你已经能：

1. 把 LLM agent 跑进 Docker 容器
2. 通过 stdin/stdout JSONL 通信
3. 让容器反向调用宿主（host bridge）
4. 在浏览器管理 API Key / Provider / Model 偏好，看 solver 实时状态

**阶段 3 预告**（课时 11-15）：实现 Planner LLM 自动调度 solver、challenge 数据存储、实时 SSE 推送。

---

## 下一课预告

[课时 11：Challenge 数据存储层](./11-challenge-store.md) —— 我们会：

- 设计 challenge 目录布局（info.json + attempts + submissions）
- 实现原子写 + 文件锁
- 加完成检测（flag_count / flag_got_count）

继续课时 11 →
