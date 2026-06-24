# my-tch-agent

CTF / 渗透测试多 Agent 协作平台。

## 快速参考

- **运行时**：Bun（不是 Node.js）
- **包管理器**：bun install / bun run
- **类型检查**：`bun run typecheck`
- **测试**：`bun test`
- **启动**：`bun run start`

## 项目结构

```
apps/cli/src/main.ts               commander CLI（命令注册都在这里）
packages/core/src/
  index.ts                         对外 barrel 导出
  config/
    index.ts                       ConfigManager 单例 + Provider/Model 偏好 CRUD
    types.ts                       AddResult
    providers/types.ts             ProviderPrefEntry / ModelConfigEntry
    config-manager.test.ts         bun:test 单元测试
```

monorepo：`apps/*` 是可执行应用，`packages/*` 是被 `@my/*` 引用的库。

## 配置层（ConfigManager）

- **单例**：`ConfigManager.getInstance(dir)` 缓存实例；测试用 `ConfigManager.resetInstance()` 清缓存
- **存储位置**：默认 `~/.tch-agent/config/`；不要直接写真实路径，测试用 `mkdtemp`
- **自管 JSON**：`provider-prefs.json` / `model-prefs.json`，文件不存在或解析失败 → 返回 `[]`
- **原子写**：tmp 文件 + rename，统一走 `writeJsonAtomic(path, data)`
- **CRUD 模式**：`listXxx` / `addXxx`（返回 `AddResult`，id 冲突返回 `{ rejected }`）/ `updateXxx` / `removeXxx`（返回 boolean）
- **ID 规范**：`generateId(prefix)` → `<prefix>_<6位hex>`，如 `prov_a3f9b2` / `model_c7d2e1`

## 代码风格

### 文件命名

- 文件 / 目录：kebab-case（`api-keys.ts`、`config-manager.test.ts`）

### 导入规范

```ts
// 类型导入用 import type，值导入用 import
import type { Config } from "./types"
import { ConfigManager } from "./config"
```

### 函数风格

```ts
// React 组件 + 工具方法：export function 声明
export function MyPage() { ... }
export function useFetch<T>() { ... }

// 不要用 export default
```

### TypeScript

- `strict: true`
- 不要用 `any`（SDK 边界除外）
- 接口 / 类型用 PascalCase
- 常量用 UPPER_SNAKE_CASE
- 相等比较用 `===`，不用 `==`

### Bun 偏好

- `bun <file>` 而不是 `node <file>`
- `bun test`（`bun:test`）而不是 jest
- `Bun.file()` 而不是 `fs.readFile`
- `Bun.write()` 而不是 `fs.writeFile`
- 文件改名等系统调用仍走 `node:fs/promises`（rename、mkdir 等）

## 测试约定

- 文件名：`<被测文件>.test.ts`，放在被测文件同目录
- 测试隔离：`beforeEach` 里 `mkdtemp` + `resetInstance`，`afterEach` 里 `rm -rf`
- 命令名一致：`describe("ConfigManager - Provider 偏好", ...)` 用业务语义分组
- 不 mock 配置文件，走真实文件系统（在 tmp 目录里）

## CLI 约定（apps/cli）

- 命令注册全在 `apps/cli/src/main.ts`，commander Program 单文件
- 每个命令 action 第一行：`const config = await ConfigManager.getInstance()`
- 失败路径：`console.error(\`✗ <原因>\`)` + `process.exit(1)`
- 成功路径：`console.log(\`✓ <动作>: <id>\`)`
- 必填选项用 `.requiredOption`，可选 `.option`，长选项用 kebab-case（`--base-url`、`--provider-id`）
- `program.parseAsync(process.argv)` 末尾调用
