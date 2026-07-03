# 课时 21：CLI 模块化重构 —— 拆开 main.ts

> **定位**：这是一节"回顾性重构"课。前面课时 1-10 把所有命令都堆在 `apps/cli/src/main.ts` 一个文件里，到课时 10 结束时它已经 581 行——命令注册、事件摘要、工具函数全混在一起,不好维护。本课把它拆成模块化结构。
>
> 入口仍是 `apps/cli/src/main.ts`(所有 `bun run apps/cli/src/main.ts ...` 示例子**照常工作**),只是内容变薄了。

## 1. 为什么要拆

拆之前 `main.ts` 长个文件里塞着:

| 内容 | 行数 | 问题 |
|---|---|---|
| 6 个 helper 函数(formatError / pathExists / summarizeEvent 一族) | ~90 | 和命令逻辑无关,混在一起难找 |
| 4 组命令注册(config / solver / runtime / init+paths+web) | ~460 | 一个 `main()` 函数从 129 行延伸到 577 行,滚动条全是命令 |
| 每组下面还有十几个子命令(api-keys / providers / model-prefs / prompts …) | ~300 | 想加一个命令得翻半天 |

核心痛点:**"找命令"和"改事件摘要"是两件完全不相关的事,却住在同一个文件、同一个函数里**。

## 2. 目标结构

```
apps/cli/src/
  main.ts            ← 入口:装配 program + 挂载命令组 + parseAsync + 全局错误处理(约 40 行)
  utils.ts           ← formatError, pathExists(通用小工具)
  event-summary.ts   ← summarizeEvent 一族(事件 → 一行摘要,只被 runtime launch 用)
  commands/
    misc.ts          ← registerMiscCommands:    init / paths / web(顶层命令)
    config.ts        ← registerConfigCommands:  config (api-keys / providers / model-prefs / prompts)
    solver.ts        ← registerSolverCommands:  solver (run / rpc)
    runtime.ts       ← registerRuntimeCommands: runtime (ping / build-image / has-image / launch / list)
```

拆分原则:

1. **一个文件一个职责**。命令按"组"分文件,helper 按用途分文件。
2. **入口最小化**。`main.ts` 只做"装配 + 挂载 + parseAsync",不写命令实现。
3. **命名统一**。每个命令模块导出 `registerXxxCommands(program)`,挂载方式一致。

## 3. helper 抽出( utils.ts / event-summary.ts)

先把和命令无关的函数搬出去。

### 3.1 `utils.ts` —— 通用小工具

```ts
// apps/cli/src/utils.ts
import { stat } from "node:fs/promises"

export function formatError(error: unknown): string {
  return error instanceof Error ? error.stack || error.message : String(error)
}

export async function pathExists(path: string): Promise<boolean> {
  try { await stat(path); return true } catch { return false }
}
```

`formatError` 给全局 `unhandledRejection` / `uncaughtException` 用,`pathExists` 给 `init` 命令用(检查目录是否就绪)。

### 3.2 `event-summary.ts` —— 事件摘要

`summarizeEvent` 一族(5 个函数)只被 `runtime launch` 的 onEvent handler 用,自成一类、自成文件:

```ts
// apps/cli/src/event-summary.ts

/** AgentSession 事件 → 一行摘要;不需要的事件返回 null。 */
export function summarizeEvent(event: unknown): string | null {
  if (typeof event !== "object" || event === null) return null
  const e = event as { type?: string; message?: { ... }; toolName?: string; ... }
  switch (e.type) {
    case "message_end":     { ... }   // 所有角色都打印
    case "tool_execution_start": return `[tool_call] ${e.toolName}(${summarizeArgs(e.args)})`
    case "tool_execution_end": { ... }
    case "agent_end":     return `[agent_end] stopReason=${extractStopReason(e.messages)}`
    default: return e.type ? `[${e.type}]` : null
  }
}

// summarizeMessageContent / extractStopReason / summarizeArgs / summarizeResult 都是模块内部函数,不导出
```

> 只导出 `summarizeEvent` 这一个对外接口,其余 4 个(`summarizeMessageContent` / `extractStopReason` / `summarizeArgs` / `summarizeResult`)是它的内部实现,保持 module-private。

## 4. 命令拆到 `commands/*.ts`

这是核心。每个命令组一个文件,导出一个 `registerXxxCommands(program)` 函数。

### 4.1 模式:`registerXxxCommands(program)`

```ts
// apps/cli/src/commands/config.ts
import type { Command } from "commander"
import { ConfigManager } from "@my/core"

export function registerConfigCommands(program: Command): void {
  const configCmd = program.command("config").description("Configuration management")

  const apiKeysCmd = configCmd.command("api-keys").description("Manage API keys")
  apiKeysCmd.command("set <provider> <key>").action(...)
  // ...
}
```

要点:

- 收 `program: Command`(commander 实例),在它上面 `.command("xxx")` 挂载子命令组。
- 函数**不返回任何东西**,纯副作用(挂命令)。
- `import type { Command }` 只导类型,不占运行时开销。

### 4.2 四个命令组

| 文件 | 挂载的命令 | 挂载位置 |
|---|---|---|
| `commands/misc.ts` | `init` / `paths` / `web` | program 根(顶层命令,不属于子组) |
| `commands/config.ts` | `api-keys` / `providers` / `model-prefs` / `prompts` | `config` 子组 |
| `commands/solver.ts` | `run` / `rpc` | `solver` 子组 |
| `commands/runtime.ts` | `ping` / `build-image` / `has-image` / `launch` / `list` | `runtime` 子组 |

> **为什么 `web` 不在 `runtime` 组里?** 因为课时 10 里 `web` 是直接 `program.command("web")` 挂载的顶层命令(`tinyfat web`),不是 `tinyfat runtime web`。重构保持原命令树不变,所以 `web` 和 `init`/`paths` 一起放 `misc.ts`(都是顶层命令)。

`commands/runtime.ts` 是唯一需要 import event-summary 的命令(launch 的 onEvent):

```ts
// apps/cli/src/commands/runtime.ts
import type { Command } from "commander"
import { ConfigManager, RuntimeManager } from "@my/core"
import { summarizeEvent } from "../event-summary"   // ← 唯一跨模块依赖

export function registerRuntimeCommands(program: Command): void {
  const runtimeCmd = program.command("runtime").description("Manage Docker runtime")
  runtimeCmd.command("launch").action(async (task, opts) => {
    // ...
    runtime.onEvent((solverId, event) => {
      const summary = summarizeEvent(event)   // ← 用 event-summary
      if (summary) console.log(`[${solverId}] ${summary}`)
    })
    // ...
  })
}
```

### 4.3 `main.ts` 瘦瘦身成入口

```ts
#!/usr/bin/env bun
// apps/cli/src/main.ts
import { Command } from "commander"
import { formatError } from "./utils"
import { registerMiscCommands } from "./commands/misc"
import { registerConfigCommands } from "./commands/config"
import { registerSolverCommands } from "./commands/solver"
import { registerRuntimeCommands } from "./commands/runtime"

process.on("unhandledRejection", (reason) => {
  console.error("[fatal] unhandledRejection", formatError(reason))
  process.exit(1)
})
process.on("uncaughtException", (error) => {
  console.error("[fatal] uncaughtException", formatError(error))
  process.exit(1)
})

async function main() {
  const program = new Command()
    .name("tinyfat")
    .description("CTF / pentest multi-agent platform")
    .version("0.0.1")

  registerMiscCommands(program)     // init / paths / web
  registerConfigCommands(program)   // config ...
  registerSolverCommands(program)   // solver ...
  registerRuntimeCommands(program)  // runtime ...

  await program.parseAsync(process.argv)
}

main()
```

581 行 → 约 40 行。全局错误处理留在入口(它们是进程级的,不属于任何命令)。

## 5. 验证

```bash
# 1. 类型检查
bun run typecheck

# 2. 命令树完整(顶层应有 init/paths/web/config/solver/runtime)
bun apps/cli/src/main.ts --help

# 3. 子组完整
bun apps/cli/src/main.ts config --help      # api-keys / providers / model-prefs / prompts
bun apps/cli/src/main.ts runtime --help   # ping / build-image / has-image / launch / list

# 4. 真跑一个读命令(确认装配没断)
bun apps/cli/src/main.ts config prompts list
bun apps/cli/src/main.ts paths
```

预期 `config prompts list` 能列出 prompt(说明 config 模块 + ConfigManager 链接都正常),`paths` 能打印路径。

## 6. 故障排查

### `Cannot find module './commands/config'`

import 路径写错。`commands/*.ts` 里 import 同级用 `./commands/xxx`(同级目录),`event-summary`/`utils` 在上一级用 `../event-summary`。检查相对路径:

```
commands/runtime.ts  →  import { summarizeEvent } from "../event-summary"   ✓
commands/misc.ts  →  import { pathExists } from "../utils"          ✓
main.ts        →  import { registerXxx } from "./commands/xxx"     ✓
```

### 某个命令组没生效(子命令不显示)

`registerXxxCommands` 函数忘了在 `main()` 里调用,或函数里没挂到 `program` 上。检查 `main()` 四个 `register*` 都在。

### `web` 命令消失了

`web` 在 `misc.ts` 的 `registerMiscCommands` 里,不在 `runtime.ts`。如果 `bun apps/cli/src/main.ts --help` 看不到 `web`,检查 `registerMiscCommands(program)` 是否被调用。

## 7. 小结

| 拆前 | 拆后 |
|---|---|
| 1 个 581 行 `main.ts` | 1 个 ~40 行 `main.ts` + 6 个模块 |
| helper 和命令混在一起 | helper(`utils` / `event-summary`)与命令(`commands/*`)分开 |
| 加命令要翻 60 行 | 加命令就是在对应 `commands/*.ts` 里追加一个 `.command()` 链 |

拆分的本质:**按"会变"的维度(命令组 / helper 用途)切分文件,入口只管装配**。后面课时(11+)新增命令时,直接在对应 `commands/*.ts` 的 `registerXxxCommands` 里加 `.command(...)` 即可,不用再动 `main.ts`。
