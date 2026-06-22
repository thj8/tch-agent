# my-tch-agent

CTF / 渗透测试多 Agent 协作平台。

## 快速参考

- **运行时**：Bun（不是 Node.js）
- **包管理器**：bun install / bun run
- **类型检查**：bun run typecheck

## 代码风格

### 文件命名

- 文件 / 目录：kebab-case（`api-keys.ts`、`use-fetch.ts`）

### 导入规范

​```ts
// 类型导入用 import type，值导入用 import
import type { Config } from "./types"
import { ConfigManager } from "./config"
​```

### 函数风格

​```ts
// React 组件 + 工具方法：export function 声明
export function MyPage() { ... }
export function useFetch<T>() { ... }

// 不要用 export default
​```

### TypeScript

- `strict: true`
- 不要用 `any`（SDK 边界除外）
- 接口 / 类型用 PascalCase
- 常量用 UPPER_SNAKE_CASE

### Bun 偏好

- `bun <file>` 而不是 `node <file>`
- `bun test` 而不是 `jest`
- `Bun.file()` 而不是 `fs.readFile`
- `Bun.write()` 而不是 `fs.writeFile`