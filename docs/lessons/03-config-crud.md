# 课时 3：API Key / Provider / Model 偏好 CRUD

> 🎯 **目标**：实现三套配置的增删查 + CLI 子命令，跑出"配 API Key → 查 → 删"完整闭环。
>
> ⏰ **预计耗时**：2-3 小时
>
> 📋 **难度**：⭐⭐⭐

---

## 你将学到什么

1. **三套配置的区别**：API Key vs Provider 偏好 vs Model 偏好
2. **pi-ai SDK 的 Provider / Model / Api 概念**
3. **如何在 Bun 里优雅地写 JSON 文件**（原子写、错误处理）
4. **CLI 表格输出**（让配置列表一目了然）
5. **TypeScript 字面量联合类型**（让 enum 安全）

## 前置条件

✅ 已完成 [课时 1](./01-init-monorepo.md) + [课时 2](./02-config-manager.md)

## 最终效果

跑这些命令，能看到清晰的输出：

```bash
# 加 API Key
tch-agent config api-keys set openai sk-xxxxx

# 列表（表格格式）
tch-agent config api-keys list
# ┌─────────┬────────────────┐
# │ Provider│ Key Preview    │
# ├─────────┼────────────────┤
# │ openai  │ sk-x...xxxxx   │
# └─────────┴────────────────┘

# 加 Provider 偏好（自建 OpenAI 兼容网关）
tch-agent config providers add \
  --id my-gateway \
  --name "My OpenAI Gateway" \
  --api openai-completions \
  --base-url https://gateway.example.com/v1

# 加 Model 偏好（给真实 model 起短别名）
tch-agent config model-prefs add \
  --id work-gpt4 \
  --provider my-gateway \
  --provider-id my-gateway \
  --model-id gpt-4o
```

完成后，`~/.tch-agent/config/` 下会多出 `provider-prefs.json` 和 `model-prefs.json`。

---

## 第零步：概念扫盲

### 0.1 三个概念的区别（必读！）

很多人会混，先理清：

| 概念 | 是什么 | 例子 |
|---|---|---|
| **API Key** | 供应商发的密钥（鉴权用） | `sk-xxx` (OpenAI) / `sk-ant-xxx` (Anthropic) |
| **Provider** | 模型供应商，一个抽象概念 | OpenAI、Anthropic、智谱、你自建的网关 |
| **Provider 偏好** | 你自己配的 Provider 实例 | "我用 https://my-gateway.com 这个网关跑 OpenAI 协议" |
| **Model** | Provider 下的具体模型 | gpt-4o / claude-sonnet-4 / glm-4 |
| **Model 偏好** | 你给某个真实 Model 起的短别名 | "work-gpt4" → "my-gateway/gpt-4o" |

**为什么要 Provider 偏好？**

OpenAI 标准端点是 `https://api.openai.com/v1`，但你可能用：
- 公司自建的 OpenAI 兼容网关
- 国内代理（兼容 OpenAI 协议）
- 自己部署的 vLLM

每个都是一个独立的"Provider 偏好"，有自己的 baseUrl 和 API Key。

**为什么要 Model 偏好？**

Prompt 文件里你不想写：
```yaml
model:
  provider: my-gateway
  modelId: gpt-4o
```

而是想写：
```yaml
model: work-gpt4
```

`work-gpt4` 是你起的短别名，背后对应 `my-gateway/gpt-4o`。换模型时只改 model-prefs.json，不用改所有 prompt。

### 0.2 Provider 的协议（Api 类型）

pi-ai SDK 支持几种协议：

| 协议名 | 适用 |
|---|---|
| `openai-completions` | OpenAI 兼容接口（含 Azure / 智谱 / 各种网关） |
| `anthropic-messages` | Anthropic 原生接口 |
| `google-gemini` | Google Gemini |
| `ollama` | 本地 Ollama |

加 Provider 偏好时要指定 api 协议，SDK 据此用不同的请求格式。

### 0.3 SDK 的 ModelRegistry 怎么用

```typescript
// 注册一个 Provider
config.models.registerProvider("my-gateway", {
    baseUrl: "https://gateway.example.com/v1",
    apiKey: "openai",                    // 引用 AuthStorage 里的 key 名
    api: "openai-completions",
    models: [
        { id: "gpt-4o", name: "GPT-4o", contextWindow: 128000, ... },
        ...
    ],
})

// 查找
const model = config.models.find({ provider: "my-gateway", id: "gpt-4o" })
```

注意 `apiKey: "openai"` 是引用 AuthStorage 里的 key 名，不是 key 本身。SDK 调用时自动从 AuthStorage 取。

---

## 第一步：定义类型

### 1.1 创建 packages/core/src/config/providers/types.ts

```bash
mkdir -p packages/core/src/config/providers
```

新建 `packages/core/src/config/providers/types.ts`：

```typescript
import type { ProviderConfig } from "@mariozechner/pi-coding-agent"
import type { Model, Api } from "@mariozechner/pi-ai"

/**
 * 自定义 provider 注册项。
 * 项目内置的 provider（比如智谱 AI）就用这个格式。
 */
export interface CustomProvider {
    /** Provider 名（唯一标识） */
    name: string
    /** SDK ProviderConfig（含 baseUrl / api / models 等） */
    config: ProviderConfig
}

/**
 * 用户配置的"Provider 偏好"条目。
 *
 * 用户自己配的 Provider 实例（比如自建的 OpenAI 网关）。
 * 落盘到 provider-prefs.json。
 */
export interface ProviderPrefEntry {
    /** 用户起的不重复 ID，如 "my-gateway" */
    id: string
    /** 内容 hash（用于检测变化，可选） */
    hash?: string
    /** 人类可读的名字 */
    name: string
    /** 协议：openai-completions / anthropic-messages / google-gemini / ollama */
    api?: string
    /** 端点 URL */
    baseUrl?: string
    /** API Key（直接存明文；安全方面由文件系统权限保护） */
    apiKey?: string
}

/**
 * 用户配置的"Model 偏好"条目。
 *
 * 给真实 Model 起的短别名，prompt 通过短 ID 引用。
 * 落盘到 model-prefs.json。
 */
export type ModelConfigEntry = {
    /** 用户起的不重复 ID，如 "work-gpt4" */
    id: string
    /** 内容 hash（可选） */
    hash?: string
    /** Provider 名（对应 ProviderPrefEntry.id 或内置 Provider 名） */
    provider: string
    /** Provider 偏好 ID（必填，指向某条 ProviderPrefEntry.id） */
    providerId: string
    /** 真实 model id（如 "gpt-4o"） */
    modelId: string
    /** 默认推理强度（low / medium / high / xhigh） */
    thinkingLevel?: string
} & Partial<Omit<Model<Api>, "id" | "provider" | "api" | "baseUrl">>
```

**关键设计**：

- 用 `& Partial<...>` 给 ModelConfigEntry 加了 SDK Model 的所有可选字段（maxTokens / contextWindow 等），用户可以覆盖默认值。
- `provider` 和 `providerId` 分开且 `providerId` 必填：`provider` 是 SDK 层的 provider 名（openai / anthropic），`providerId` 指向用户的某条 Provider 偏好。后续 resolve model 时要用 `providerId` 把 baseUrl / apiKey 找出来，所以不能没有。

---

## 第二步：在 ConfigManager 加 CRUD 方法

### 2.1 改 packages/core/src/config/index.ts

在 `ConfigManager` 类里追加方法（保留课时 2 的内容）。

**先在文件顶部把 `rename` 加到 `node:fs/promises` 的 import 里**（课时 2 只 import 了 `mkdir`）：

```typescript
// 课时 2 的 imports 保留
import { mkdir } from "node:fs/promises"
// ↓ 新增 rename
import { mkdir, rename } from "node:fs/promises"
```

也就是改成：

```typescript
import { AuthStorage, ModelRegistry, SettingsManager } from "@mariozechner/pi-coding-agent"
import { mkdir, rename } from "node:fs/promises"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import type { ProviderPrefEntry, ModelConfigEntry } from "./providers/types"
import type { AddResult } from "./types"
```

> 💡 **为什么不用动态 `await import("node:fs/promises")`？**
>
> 动态 import 在每次调用写盘方法时都解析一次模块（虽然 Node 有模块缓存，开销几乎可以忽略），但更重要的是：把所有依赖放在顶部一眼能看清，比藏在某个方法体里更易读、更易测试。模块加载只发生一次，静态 import 没有任何性能劣势。

然后在 `ConfigManager` 类里追加这些方法：

```typescript
export class ConfigManager {
    // ... 课时 2 的字段和方法保留 ...

    // ↓↓↓ 新增以下方法 ↓↓↓

    // ── API Keys ────────────────────────────────────────────

    /** 设置指定 provider 的 API Key */
    setApiKey(provider: string, key: string): void {
        this.auth.set(provider, { type: "api_key", key })
    }

    /** 删除指定 provider 的 API Key */
    removeApiKey(provider: string): void {
        this.auth.remove(provider)
    }

    /** 取指定 provider 的 API Key（原始值） */
    getApiKey(provider: string): { type: "api_key"; key: string } | undefined {
        return this.auth.get(provider) as { type: "api_key"; key: string } | undefined
    }

    /** 取 API Key 的字符串值（便捷封装） */
    getApiKeyValue(provider: string): string | undefined {
        return this.getApiKey(provider)?.key
    }

    /** 是否已配置指定 provider 的 API Key */
    hasApiKey(provider: string): boolean {
        return this.auth.has(provider)
    }

    /** 列出所有已配置的 provider 名 */
    listApiKeys(): string[] {
        return this.auth.list()
    }

    // ── Provider 偏好 ────────────────────────────────────────

    /** provider-prefs.json 的路径 */
    private providerPrefsPath(): string {
        return join(this.dir, "provider-prefs.json")
    }

    /** 读所有 Provider 偏好 */
    async listProviderPrefs(): Promise<ProviderPrefEntry[]> {
        const file = Bun.file(this.providerPrefsPath())
        if (!(await file.exists())) return []
        try {
            const data = await file.json()
            return Array.isArray(data) ? (data as ProviderPrefEntry[]) : []
        } catch {
            return []
        }
    }

    /**
     * 加一条 Provider 偏好。
     * @returns 新分配的 ID（如果用户没传 id，自动生成）
     */
    async addProviderPref(entry: Partial<ProviderPrefEntry> & { name: string }): Promise<AddResult> {
        const list = await this.listProviderPrefs()

        // 自动生成 id
        const id = entry.id?.trim() || this.generateId("prov")
        if (list.some((item) => item.id === id)) {
            return { id, rejected: `provider pref id "${id}" already exists` }
        }

        const newEntry: ProviderPrefEntry = {
            id,
            name: entry.name,
            api: entry.api?.trim() || undefined,
            baseUrl: entry.baseUrl?.trim() || undefined,
            apiKey: entry.apiKey?.trim() || undefined,
        }
        await this.writeProviderPrefs([...list, newEntry])
        return { id }
    }

    /**
     * 按 id 删除 Provider 偏好。
     * @returns 是否真的删了。id 不存在时返回 false（让 CLI 能据此报错）。
     */
    async removeProviderPref(id: string): Promise<boolean> {
        const list = await this.listProviderPrefs()
        const next = list.filter((item) => item.id !== id)
        if (next.length === list.length) return false
        await this.writeProviderPrefs(next)
        return true
    }

    /** 按 id 更新 Provider 偏好 */
    async updateProviderPref(id: string, patch: Partial<ProviderPrefEntry>): Promise<ProviderPrefEntry | undefined> {
        const list = await this.listProviderPrefs()
        const idx = list.findIndex((item) => item.id === id)
        if (idx < 0) return undefined
        const updated: ProviderPrefEntry = { ...list[idx], ...patch, id: list[idx].id }
        list[idx] = updated
        await this.writeProviderPrefs(list)
        return updated
    }

    /** 写 provider-prefs.json（原子写，委托给 writeJsonAtomic） */
    private async writeProviderPrefs(list: ProviderPrefEntry[]): Promise<void> {
        await this.writeJsonAtomic(this.providerPrefsPath(), list)
    }

    // ── Model 偏好 ──────────────────────────────────────────

    /** model-prefs.json 的路径 */
    private modelPrefsPath(): string {
        return join(this.dir, "model-prefs.json")
    }

    /** 读所有 Model 偏好 */
    async listModelPrefs(): Promise<ModelConfigEntry[]> {
        const file = Bun.file(this.modelPrefsPath())
        if (!(await file.exists())) return []
        try {
            const data = await file.json()
            return Array.isArray(data) ? (data as ModelConfigEntry[]) : []
        } catch {
            return []
        }
    }

    /**
     * 加一条 Model 偏好。
     *
     * providerId 必填——每个 Model 偏好必须挂在一个具体的 Provider 偏好下，
     * 否则后续 resolve 时不知道用哪个 Provider 实例（baseUrl / apiKey）。
     */
    async addModelPref(
        entry: Partial<ModelConfigEntry> & { provider: string; providerId: string; modelId: string },
    ): Promise<AddResult> {
        const list = await this.listModelPrefs()

        const id = entry.id?.trim() || this.generateId("model")
        if (list.some((item) => item.id === id)) {
            return { id, rejected: `model pref id "${id}" already exists` }
        }

        const newEntry: ModelConfigEntry = {
            ...entry,
            id,
            provider: entry.provider.trim(),
            providerId: entry.providerId.trim(),
            modelId: entry.modelId.trim(),
            thinkingLevel: entry.thinkingLevel?.trim() || undefined,
        }
        await this.writeModelPrefs([...list, newEntry])
        return { id }
    }

    /**
     * 按 id 删除 Model 偏好。
     * @returns 是否真的删了。id 不存在时返回 false。
     */
    async removeModelPref(id: string): Promise<boolean> {
        const list = await this.listModelPrefs()
        const next = list.filter((item) => item.id !== id)
        if (next.length === list.length) return false
        await this.writeModelPrefs(next)
        return true
    }

    /** 写 model-prefs.json（原子写，委托给 writeJsonAtomic） */
    private async writeModelPrefs(list: ModelConfigEntry[]): Promise<void> {
        await this.writeJsonAtomic(this.modelPrefsPath(), list)
    }

    // ── 工具方法 ────────────────────────────────────────────

    /**
     * 原子写 JSON：先写 tmp 文件再 rename，避免半写状态。
     *
     * `tmp` 文件名带 PID + 时间戳，多个进程同时写时不会互相覆盖 tmp。
     * rename 在同一文件系统内是原子的（POSIX 保证），所以读方要么看到旧版要么看到新版，不会看到写一半的版本。
     */
    private async writeJsonAtomic(path: string, data: unknown): Promise<void> {
        const tmp = `${path}-${process.pid}-${Date.now()}`
        await Bun.write(tmp, JSON.stringify(data, null, 2))
        await rename(tmp, path)
    }

    /**
     * 生成不重复的短 ID。
     * 格式：<prefix>_<6 字符随机串>，如 "prov_a3f9b2"
     */
    private generateId(prefix: string): string {
        const random = crypto.randomUUID().replaceAll("-", "").slice(0, 6)
        return `${prefix}_${random}`
    }
}
```

### 2.2 更新 packages/core/src/index.ts

把新类型也 export 出去：

```typescript
// 在已有的 export 后追加
export type { ProviderPrefEntry, ModelConfigEntry } from "./config/providers/types"
```

---

## 第三步：CLI 子命令

### 3.1 在 apps/cli/src/main.ts 加命令

在已有的 `program` 定义后追加（保留课时 2 的 init / paths / doctor 命令）：

```typescript
// ↓↓↓ 在 doctor 命令后面追加 ↓↓↓

// ── config 命令组 ───────────────────────────────────────

const configCmd = program.command("config").description("Configuration management")

// ── config / api-keys ──────────────────────────────────

const apiKeysCmd = configCmd.command("api-keys").description("Manage API keys")

apiKeysCmd
    .command("set <provider> <key>")
    .description("Set API key for a provider")
    .action(async (provider: string, key: string) => {
        const config = await ConfigManager.getInstance()
        config.setApiKey(provider, key)
        console.log(`✓ Set API key for ${provider}`)
    })

apiKeysCmd
    .command("remove <provider>")
    .description("Remove API key for a provider")
    .action(async (provider: string) => {
        const config = await ConfigManager.getInstance()
        config.removeApiKey(provider)
        console.log(`✓ Removed API key for ${provider}`)
    })

apiKeysCmd
    .command("list")
    .description("List all configured API keys")
    .action(async () => {
        const config = await ConfigManager.getInstance()
        const providers = config.listApiKeys()

        if (providers.length === 0) {
            console.log("(no API keys configured)")
            return
        }

        // 简单的 ASCII 表格
        console.log("PROVIDER\tKEY PREVIEW")
        console.log("--------\t-----------")
        for (const p of providers) {
            const key = config.getApiKey(p)?.key ?? ""
            // 只显示前 4 位和后 4 位
            const preview = key.length > 8 ? `${key.slice(0, 4)}...${key.slice(-4)}` : key
            console.log(`${p}\t\t${preview}`)
        }
    })

// ── config / providers ─────────────────────────────────

const providersCmd = configCmd.command("providers").description("Manage provider preferences")

providersCmd
    .command("add")
    .description("Add a provider preference")
    .option("-i, --id <id>", "Unique ID (auto-generated if not provided)")
    .option("-a, --api <api>", "Protocol (openai-completions / anthropic-messages / ...)")
    .option("-b, --base-url <url>", "Base URL")
    .requiredOption("-n, --name <name>", "Display name")
    .action(async (opts) => {
        const config = await ConfigManager.getInstance()
        const result = await config.addProviderPref({
            id: opts.id,
            name: opts.name,
            api: opts.api,
            baseUrl: opts.baseUrl,
        })
        if (result.rejected) {
            console.error(`✗ ${result.rejected}`)
            process.exit(1)
        }
        console.log(`✓ Added provider preference: ${result.id}`)
    })

providersCmd
    .command("list")
    .description("List all provider preferences")
    .action(async () => {
        const config = await ConfigManager.getInstance()
        const list = await config.listProviderPrefs()

        if (list.length === 0) {
            console.log("(no provider preferences)")
            return
        }

        console.log("ID\t\tNAME\t\t\tAPI\t\t\tBASE_URL")
        console.log("--\t\t----\t\t\t---\t\t\t--------")
        for (const p of list) {
            console.log(`${p.id}\t\t${p.name.slice(0, 20).padEnd(20)}\t${(p.api ?? "-").slice(0, 20).padEnd(20)}\t${p.baseUrl ?? "-"}`)
        }
    })

providersCmd
    .command("remove <id>")
    .description("Remove a provider preference by ID")
    .action(async (id: string) => {
        const config = await ConfigManager.getInstance()
        const removed = await config.removeProviderPref(id)
        if (!removed) {
            console.error(`✗ No provider preference with id "${id}"`)
            process.exit(1)
        }
        console.log(`✓ Removed provider preference: ${id}`)
    })

// ── config / model-prefs ───────────────────────────────

const modelPrefsCmd = configCmd.command("model-prefs").description("Manage model preferences")

modelPrefsCmd
    .command("add")
    .description("Add a model preference")
    .option("-i, --id <id>", "Unique ID (auto-generated if not provided)")
    .requiredOption("-p, --provider <provider>", "Provider name")
    .requiredOption("-m, --model-id <modelId>", "Real model ID")
    .requiredOption("--provider-id <providerId>", "Provider preference ID")
    .option("-t, --thinking-level <level>", "Default thinking level (low/medium/high/xhigh)")
    .action(async (opts) => {
        const config = await ConfigManager.getInstance()
        const result = await config.addModelPref({
            id: opts.id,
            provider: opts.provider,
            providerId: opts.providerId,
            modelId: opts.modelId,
            thinkingLevel: opts.thinkingLevel,
        })
        if (result.rejected) {
            console.error(`✗ ${result.rejected}`)
            process.exit(1)
        }
        console.log(`✓ Added model preference: ${result.id}`)
    })

modelPrefsCmd
    .command("list")
    .description("List all model preferences")
    .action(async () => {
        const config = await ConfigManager.getInstance()
        const list = await config.listModelPrefs()

        if (list.length === 0) {
            console.log("(no model preferences)")
            return
        }

        console.log("ID\t\tPROVIDER\t\tMODEL_ID\t\tTHINKING")
        console.log("--\t\t--------\t\t--------\t\t--------")
        for (const m of list) {
            console.log(
                `${m.id}\t\t${(m.provider ?? "").slice(0, 15).padEnd(15)}\t\t${(m.modelId ?? "").slice(0, 15).padEnd(15)}\t\t${m.thinkingLevel ?? "-"}`,
            )
        }
    })

modelPrefsCmd
    .command("remove <id>")
    .description("Remove a model preference by ID")
    .action(async (id: string) => {
        const config = await ConfigManager.getInstance()
        const removed = await config.removeModelPref(id)
        if (!removed) {
            console.error(`✗ No model preference with id "${id}"`)
            process.exit(1)
        }
        console.log(`✓ Removed model preference: ${id}`)
    })
```

### 3.2 用 commander 的注意点

- `command("set <provider> <key>")`：尖括号 `<>` 表示必填位置参数。
- `.requiredOption(...)`：必填选项（缺了就报错）。
- `.option(...)`：可选选项。
- `command("config")`：不带参数的子命令会成为"命令组"，不直接执行，只组织子命令。

---

## 第四步：验证

### 4.1 看 help

```bash
bun run apps/cli/src/main.ts --help
```

**预期**：

```
Usage: tch-agent [options] [command]

CTF / pentest multi-agent platform

Options:
  -V, --version              output the version number
  -h, --help                 display help for command

Commands:
  init [options]             Initialize config directories and show paths
  paths [options]            Print all configured paths without creating anything
  doctor [options]           Run environment health check
  config [options]           Configuration management
  help [command]             display help for command
```

```bash
bun run apps/cli/src/main.ts config --help
```

**预期**：

```
Usage: tch-agent config [options] [command]

Configuration management

Options:
  -h, --help                                      display help for command

Commands:
  api-keys [options]                              Manage API keys
  providers [options]                             Manage provider preferences
  model-prefs [options]                           Manage model preferences
```

### 4.2 测 API Key

```bash
# 设
bun run apps/cli/src/main.ts config api-keys set openai sk-test-1234567890abcdef

# 列表
bun run apps/cli/src/main.ts config api-keys list
```

**预期**：

```
PROVIDER        KEY PREVIEW
--------        -----------
openai          sk-t...cdef
```

```bash
# 删
bun run apps/cli/src/main.ts config api-keys remove openai

# 再列
bun run apps/cli/src/main.ts config api-keys list
```

**预期**：

```
(no API keys configured)
```

### 4.3 测 Provider 偏好

```bash
bun run apps/cli/src/main.ts config providers add \
  --id my-gw \
  --name "My Gateway" \
  --api openai-completions \
  --base-url https://gateway.example.com/v1

bun run apps/cli/src/main.ts config providers list
```

**预期**：

```
ID              NAME                API                 BASE_URL
--              ----                ---                 --------
my-gw           My Gateway          openai-completions  https://gateway.example.com/v1
```

### 4.4 测 Model 偏好

```bash
bun run apps/cli/src/main.ts config model-prefs add \
  --id work-gpt4 \
  --provider openai \
  --provider-id my-gw \
  --model-id gpt-4o \
  --thinking-level medium

bun run apps/cli/src/main.ts config model-prefs list
```

**预期**：

```
ID              PROVIDER        MODEL_ID        THINKING
--              --------        --------        --------
work-gpt4       openai          gpt-4o          medium
```

### 4.5 验证文件真的写入

```bash
cat ~/.tch-agent/config/provider-prefs.json
cat ~/.tch-agent/config/model-prefs.json
```

应该看到刚才配置的 JSON。

### 4.6 类型检查

```bash
bun run typecheck
```

**预期**：无输出。

---

## 第五步：故障排查

### 问题 1：`commander` 报 `option 'name' argument missing`

**原因**：commander 不允许两个 option 同名。我在 providers add 里写了两次 `--name`。

**解决**：删掉重复的 `.option("-n, --name <name>", ...)`，只留 `.requiredOption(...)`。

### 问题 2：表格式输出对不齐

**原因**：终端字体可能不是等宽。

**解决**：可以装 `cli-table3` 库做更专业的表格。本课时用简单 `\t` 即可。

### 问题 3：写 JSON 时报 `EBUSY`

**原因**：可能多个进程同时写。

**解决**：本课时的实现已经用 `.tmp` + rename 做了原子写，不会出问题。如果还有问题，检查是不是同时跑多个 CLI。

### 问题 4：setApiKey 后 listApiKeys 没显示

**原因**：可能 AuthStorage 写盘是异步的，而 listApiKeys 是同步读内存。

**解决**：AuthStorage 通常 set 时同步写盘。试试退出进程后重新跑 list 命令。

---

## 本课小结

✅ **你已完成**：

- API Key / Provider 偏好 / Model 偏好 三套 CRUD
- 原子写 JSON 文件
- 一组嵌套的 CLI 子命令
- ASCII 表格输出

📦 **新增文件**：

```
packages/core/src/config/providers/types.ts
```

🔑 **关键概念**：

- **三层抽象**：API Key（鉴权）→ Provider 偏好（端点）→ Model 偏好（短别名）。
- **原子写**：`.tmp` + rename 让文件永远不损坏。
- **Commander 嵌套**：用 `.command("config")` 做命令组，可以无限嵌套。

---

## 下一课预告

[课时 4：Prompt 文件格式 + 加载器](./04-prompt-loader.md)（待生成）—— 我们会：

- 定义 Prompt 文件的 YAML frontmatter 格式
- 实现 load / save / list / remove CRUD
- 加 `tch-agent config prompts list` 等 CLI 命令
- 让 prompt 能引用 model 偏好 ID

继续课时 4 →
