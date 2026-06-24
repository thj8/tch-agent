# 课时 1：初始化 Bun monorepo（从零开始）

> 🎯 **目标**：搭出仓库结构 + TypeScript 环境，跑出第一个 `hello world`。
>
> ⏰ **预计耗时**：1-2 小时
>
> 📋 **难度**：⭐（最容易，但概念多）

---

## 你将学到什么

读完 + 跟着做，你会理解：

1. **什么是 Bun，为什么不用 Node.js**
2. **什么是 monorepo，为什么我们用 monorepo 而不是单包**![`$![$``$![]()$``$]()$`]()
3. **TypeScript 项目的标准配置项都是干嘛的**
4. **ESM 和 CommonJS 的区别**
5. **怎么组织一个工程化 TS 项目**

## 最终效果

跑 `bun run apps/cli/src/main.ts` 能输出：

```
hello tch-agent
loaded package: @my/core
```

项目结构如下：

```
my-tch-agent/
├── package.json              # 根 package.json（workspaces 配置）
├── tsconfig.json             # TypeScript 配置
├── CLAUDE.md                 # 代码风格约定（Claude Code 自动读）
├── .gitignore
├── packages/
│   └── core/                 # 核心包（后续课时在这写代码）
│       ├── package.json
│       └── src/
│           └── index.ts
└── apps/
    └── cli/                  # CLI 入口
        ├── package.json
        └── src/
            └── main.ts
```

---

## 第零步：基础概念扫盲（新手必读）

如果你已经熟悉下面概念，可以跳到第一步。

### 0.1 什么是 Bun？

**Bun 是一个 JS/TS 运行时**，类似 Node.js，但更快、原生支持 TypeScript。

| 维度 | Node.js | Bun |
|---|---|---|
| 跑 TS 文件 | 需要 `ts-node` 或编译 | **原生支持** |
| 包管理器 | npm / yarn / pnpm | 内置 `bun install`（比 npm 快 25 倍） |
| 测试 | jest / vitest | 内置 `bun test` |
| Bundler | webpack / esbuild | 内置 `bun build` |
| 文件 API | `fs.readFile` (callback) | `Bun.file().text()`（同步简洁） |
| 启动 HTTP 服务 | express / fastify | 内置 `Bun.serve` |

**为什么用 Bun**：写 LLM agent 时要跑大量 IO，Bun 的性能 + 原生 TS 支持让开发体验提升巨大。

### 0.2 什么是 TypeScript？为什么不用 JavaScript？

JS 是动态类型语言：

```javascript
// JS —— 跑起来才发现错
function add(a, b) { return a + b }
add(1, "2")   // "12"，运行时才觉得奇怪
```

TS 是 JS 的超集，加了**静态类型**：

```typescript
// TS —— 写的时候就报错
function add(a: number, b: number): number { return a + b }
add(1, "2")   // ❌ 编辑器立刻报错
```

**好处**：
- 编辑器能自动补全
- 重构时不会漏改
- 团队协作更安全

本项目全程 TS + `strict: true`。

### 0.3 什么是 ESM？什么是 CommonJS？

JS 历史上有两种模块系统：

**CommonJS（旧）**：
```javascript
const fs = require("fs")
module.exports = { hello: () => "hi" }
```

**ESM（新，ECMAScript Modules）**：
```typescript
import fs from "fs"
export function hello() { return "hi" }
```

**现在都用 ESM**。本项目 `package.json` 里 `"type": "module"` 就是告诉 Bun/Node "这个项目用 ESM"。

### 0.4 什么是 monorepo？

**单包项目**：所有代码在一个 package.json 下。

```
my-app/
├── package.json
└── src/
    ├── frontend/
    ├── backend/
    └── shared/
```

**monorepo**：一个 Git 仓库里有多个相互依赖的 package，每个有自己的 package.json。

```
my-app/
├── package.json          ← 根 package.json（定义 workspaces）
├── packages/
│   ├── core/             ← @my/core
│   │   └── package.json
│   └── ui/               ← @my/ui
│       └── package.json
└── apps/
    └── web/              ← @my/web（依赖 @my/core 和 @my/ui）
        └── package.json
```

**为什么用 monorepo**：

1. **模块隔离**：每个包独立编译、独立测试，避免循环依赖。
2. **复用方便**：`@my/web` 里 `import { foo } from "@my/core"` 直接用，不用发 npm。
3. **共享配置**：tsconfig、lint 规则在根目录统一管。

**Bun workspaces**：Bun 内置 monorepo 支持，根 `package.json` 加 `"workspaces": ["packages/*", "apps/*"]`，Bun 就会自动识别这些子包并建立引用关系。

### 0.5 strict mode 是什么？

TypeScript 有 7-8 个严格检查选项，全部开启等价于 `"strict": true`：

- `noImplicitAny`：函数参数没类型就报错（默认 `any` 太危险）
- `strictNullChecks`：`null / undefined` 必须显式处理
- `strictFunctionTypes`：函数参数类型检查更严
- ... 等等

**好处**：bug 在编辑器里就发现，而不是上线后。
**坏处**：刚开始写代码时各种报错，但这是好事——它让你写出正确的代码。

---

## 第一步：环境检查

打开终端（Mac/Linux）或 WSL2（Windows）。

### 1.1 检查 Bun

```bash
bun --version
```

**预期输出**：`1.1.x` 或更高（比如 `1.2.0`）。

如果没有，安装：

```bash
# Mac / Linux
curl -fsSL https://bun.sh/install | bash

# 装完后刷新 shell
source ~/.zshrc   # 或 ~/.bashrc
```

### 1.2 检查 Git

```bash
git --version
```

没有的话：
- Mac：`xcode-select --install`
- Linux：`apt install git` 或 `dnf install git`
- Windows：去 [git-scm.com](https://git-scm.com/) 下载

### 1.3 编辑器

推荐 **VS Code**（免费）+ 这些扩展：
- TypeScript（官方，必装）
- Tailwind CSS IntelliSense（阶段 2 用）
- ESLint（可选）

其他编辑器（WebStorm / Sublime / Neovim）也行，但本教程的截图假设你用 VS Code。

### 1.4 检查工作目录

选一个你放代码的位置（比如 `~/projects/`），确认目录存在：

```bash
# 看看家目录
echo $HOME

# 建议建一个专门的 projects 目录（如果没有）
mkdir -p ~/projects
cd ~/projects
pwd   # 应该输出 /Users/你的用户名/projects
```

---

## 第二步：创建项目目录

```bash
mkdir my-tch-agent
cd my-tch-agent
pwd   # 确认你在 /Users/.../my-tch-agent
```

> 💡 **提示**：
> - 项目名可以自己取，但后续课程里我会假设你在 `my-tch-agent/` 目录下操作。
> - 名字建议小写、不含空格、不含中文。

---

## 第三步：初始化根 package.json

### 3.1 生成 package.json

```bash
bun init -y
```

`-y` 表示所有问题都答 yes（用默认值）。

**生成的 package.json 长这样**：

```json
{
  "name": "my-tch-agent",
  "version": "0.0.1",
  "module": "index.ts",
  "type": "module",
  "devDependencies": {
    "@types/bun": "latest"
  },
  "peerDependencies": {
    "typescript": "^5"
  }
}
```

> ⚠️ **注意**：Bun 会同时生成一个 `index.ts` 文件，我们不需要它，删掉：
> ```bash
> rm index.ts   # 如果存在
> ```

### 3.2 改造 package.json

用 VS Code 打开 `package.json`，改成：

```json
{
  "name": "my-tch-agent",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "workspaces": [
    "packages/*",
    "apps/*"
  ],
  "scripts": {
    "start": "bun run apps/cli/src/main.ts",
    "typecheck": "bun ./node_modules/typescript/bin/tsc --noEmit",
    "test": "bun test"
  },
  "devDependencies": {
    "@types/bun": "latest",
    "@types/node": "^26.0.0"
  },
  "peerDependencies": {
    "typescript": "^5"
  }
}
```

**逐项解释**：

| 字段 | 含义 |
|---|---|
| `"name": "my-tch-agent"` | 项目名 |
| `"version": "0.0.1"` | 版本号（语义化版本：主.次.修） |
| `"private": true` | **私有项目**，禁止 `npm publish` 发布到 npm |
| `"type": "module"` | **告诉 Bun/Node 这个项目用 ESM**（不用 CommonJS） |
| `"workspaces": [...]` | **声明这是 monorepo**，Bun 会自动链接 packages/* 和 apps/* 下的子包 |
| `"scripts"` | 定义 `bun run xxx` 快捷命令 |
| `"devDependencies"` | 开发时用、运行时不需要的依赖。`@types/node` 显式声明，避免 Bun 没自动带上时 `node:fs` / `node:path` 等内置模块类型报错 |
| `"peerDependencies"` | TypeScript 放这里而不是 `devDependencies`——`bun ./node_modules/typescript/bin/tsc --noEmit` 这种直接调用方式在 peer 下更稳，团队成员装的 TS 版本由 peer 范围约束 |

`scripts` 里三个自定义命令：
- `bun run start` → 实际执行 `bun run apps/cli/src/main.ts`
- `bun run typecheck` → 实际执行 `tsc --noEmit`（类型检查不输出文件）
- `bun run test` → 实际执行 `bun test`（跑 `*.test.ts`，课时 3 之后会用到）

---

## 第四步：创建 tsconfig.json

在项目根目录新建 `tsconfig.json`：

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "allowSyntheticDefaultImports": true,
    "lib": ["ESNext", "DOM"],
    "types": ["bun", "node"],
    "jsx": "react-jsx",
    "jsxImportSource": "react",
    "noUncheckedIndexedAccess": false
  },
  "include": ["packages/**/*", "apps/**/*"],
  "exclude": ["node_modules", "dist", "bin"]
}
```

**关键选项解释**（按重要性排）：

| 选项 | 作用 |
|---|---|
| `"strict": true` | 开启所有严格类型检查（最重要） |
| `"target": "ESNext"` | 编译目标：最新 JS 标准（Bun 直接支持，不需要降级） |
| `"module": "ESNext"` | 模块系统：ESM |
| `"moduleResolution": "bundler"` | 模块解析策略：让 TS 像 Bun/webpack 那样找文件（支持 import 时省略扩展名） |
| `"lib": ["ESNext", "DOM"]` | 内置类型库：ESNext（Promise / Array）+ DOM（console / setTimeout 等）。**不要漏 DOM，否则会报 `Cannot find name 'console'`** |
| `"types": ["bun", "node"]` | 加载 `@types/bun` + `@types/node` 类型。**必须同时有 `"node"`**，否则 `node:path` / `node:fs` / `node:os` 等内置模块会报 `Cannot find module` |
| `"jsx": "react-jsx"` | JSX 编译模式（阶段 2 写 Web UI 时用） |
| `"noUncheckedIndexedAccess": false` | 显式声明：数组/对象索引访问返回 `T` 而非 `T \| undefined`。`strict` 默认就是 false，写出来是为了让团队成员一眼看到这个选择（避免有人误以为开了 `strict` 就会强制 undefined 检查） |
| `"include"` | 告诉 TS **只检查 packages/ 和 apps/ 下的代码** |
| `"exclude"` | **排除** node_modules 等不希望 TS 检查的目录 |

> 💡 **为什么没有 `noEmit: true`？**
>
> 因为 `scripts.typecheck` 已经传了 `--noEmit` 命令行参数，重复写在 tsconfig 里没必要。命令行参数优先级更高，且更直观（看 scripts 就知道 typecheck 不产出文件）。

> ⚠️ **常见错误 1**：`Cannot find name 'console'`
>
> `"lib"` 没包含 `"DOM"`（console 在 DOM lib 里定义）。

> ⚠️ **常见错误 2**：`Cannot find module 'node:path'` / `Cannot find module 'node:fs'`
>
> `"types"` 里漏了 `"node"`。Bun 兼容 Node 内置模块（`node:fs`、`node:path` 等），但类型定义在 `@types/node` 里，所以要同时声明 `"bun"` 和 `"node"`。

---

## 第五步：创建 .gitignore

新建 `.gitignore`：

```gitignore
# 依赖
node_modules/

# 构建产物
bin/
dist/
*.tsbuildinfo

# 运行时数据（用户配置）
.tch-agent/

# IDE
.vscode/
.idea/

# macOS
.DS_Store

# 日志
*.log

# 临时文件
*.swp
*.swo
*~
```

**每行作用**：

- `node_modules/`：依赖，不进 git（每个人 bun install 自己装）。
- `bin/` / `dist/`：构建产物，不进 git。
- `.tch-agent/`：后面课时会在项目根目录建一个临时数据目录，不进 git（真实数据在 `~/.tch-agent/`）。
- `.DS_Store`：macOS 文件系统垃圾文件。

---

## 第六步：创建 CLAUDE.md

新建 `CLAUDE.md`：

```markdown
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
```

> ⚠️ **注意**：上面 markdown 里的 ` ```ts ` 我用了全角字符（避免破坏 markdown 嵌套）。你实际写文件时用半角 ```` ```ts ````。

**CLAUDE.md 的作用**：

1. **人类协作者**：新人进项目读这个了解规则。
2. **AI 协作者**：Claude Code 启动时会自动加载项目根目录的 `CLAUDE.md`，让 AI 写出风格一致的代码。

> 💡 **AGENTS.md vs CLAUDE.md**：
>
> - `CLAUDE.md` 是 Claude Code 默认读取的文件名。
> - `AGENTS.md` 是跨工具通用约定（Cursor / Windsurf / Codex 等也读）。
>
> 本教程用 `CLAUDE.md`，因为后面课时会大量让 Claude Code 帮你写代码。如果你用其他 AI 工具，可以改成 `AGENTS.md` 或两个都建（内容一样）。

---

## 第七步：创建 packages/core 子包

### 7.1 创建目录结构

```bash
mkdir -p packages/core/src
```

`-p` 表示递归创建（包括 `packages/`）。

### 7.2 创建 packages/core/package.json

新建文件 `packages/core/package.json`：

```json
{
  "name": "@my/core",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "main": "src/index.ts",
  "types": "src/index.ts"
}
```

**字段解释**：

| 字段 | 含义 |
|---|---|
| `"name": "@my/core"` | 包名。`@my/` 是个 **scope**（命名空间），避免和 npm 上已有的 `core` 撞名 |
| `"private": true` | 不发 npm |
| `"main": "src/index.ts"` | 别人 `import { x } from "@my/core"` 时，会找这个文件 |
| `"types": "src/index.ts"` | 类型定义文件（和 main 一样即可） |

### 7.3 创建 packages/core/src/index.ts

新建文件 `packages/core/src/index.ts`：

```typescript
/**
 * @my/core 包的入口。
 * 后面课时会在这里 export ConfigManager / RuntimeManager 等。
 */

export const PACKAGE_NAME = "@my/core"

/**
 * 简单的加法函数，用于测试 TS 类型系统能正常工作。
 */
export function add(a: number, b: number): number {
    return a + b
}
```

---

## 第八步：创建 apps/cli 子包

### 8.1 创建目录结构

```bash
mkdir -p apps/cli/src
```

### 8.2 创建 apps/cli/package.json

新建文件 `apps/cli/package.json`：

```json
{
  "name": "@my/cli",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "bin": "src/main.ts",
  "dependencies": {
    "@my/core": "workspace:*"
  }
}
```

**字段解释**：

| 字段 | 含义 |
|---|---|
| `"name": "@my/cli"` | 包名（带 scope） |
| `"private": true` | 不发 npm |
| `"type": "module"` | 用 ESM |
| `"bin": "src/main.ts"` | CLI 入口文件 |
| `"dependencies": { "@my/core": "workspace:*" }` | **依赖 @my/core**，用 `workspace:*` 协议引用 workspace 内的包 |

> ⚠️ **关键**：必须显式声明 `dependencies`！
>
> Bun/npm/yarn/pnpm **不会自动**把 workspace 包加进 `node_modules`，必须消费者 package.json 里写明 `"@my/core": "workspace:*"`，Bun 才会建立软链接。少了这行，import 会报 `Cannot find module '@my/core'`。

### 8.3 创建 apps/cli/src/main.ts

新建文件 `apps/cli/src/main.ts`：

```typescript
import { PACKAGE_NAME, add } from "@my/core"

console.log("hello tch-agent")
console.log(`loaded package: ${PACKAGE_NAME}`)
console.log(`add(1, 2) = ${add(1, 2)}`)
```

**解释**：

- `import { PACKAGE_NAME, add } from "@my/core"` 引用 packages/core 的导出。
- Bun workspaces 会自动把 `@my/core` 解析到 `packages/core/src/index.ts`。

---

## 第九步：安装依赖

```bash
bun install
```

**预期输出**：

```
Resolving dependencies
Downloading @types/bun@latest
Downloading @types/node@latest  ← Bun 自动带的（@types/bun 依赖它）
Downloading typescript@5.x.x

+ @types/bun@latest
+ @types/node@latest
+ typescript@5.x.x

1 packages installed
```

> 💡 **如果 `@types/node` 没自动装**（比如改了 package.json 后忘了重装），手动加：
> ```bash
> bun add -d @types/node
> ```

**这一步做了什么**：

1. 读 `package.json` 的依赖列表。
2. 下载依赖到 `node_modules/`。
3. 创建 `bun.lock`（锁定依赖版本，保证团队成员装的一模一样）。
4. 扫描 `workspaces`，把 `@my/core` 和 `@my/cli` 的引用链接好。

### 9.1 验证 workspace 链接

```bash
ls apps/cli/node_modules/@my/
```

**预期输出**：

```
core -> ../../../../packages/core
```

**为什么不是 `node_modules/@my/`？**

Bun（以及 pnpm）用的是 **isolated node_modules 布局**：每个 workspace 包的依赖被放进消费者自己的 `node_modules`，不放根目录。

```
my-tch-agent/
├── node_modules/           ← 根（只放真正的 npm 依赖，如 commander）
└── apps/
    └── cli/
        └── node_modules/   ← apps/cli 的依赖放这
            └── @my/
                └── core -> ../../../../packages/core
```

`apps/cli/node_modules/@my/core` 是个软链接，指向 `packages/core/`。这就是为什么 `import "@my/core"` 能解析到。

> 💡 **检查软链接的指向**：
> ```bash
> readlink apps/cli/node_modules/@my/core
> # 输出：../../../../packages/core
> ```

---

## 第十步：验证

### 10.1 跑 hello world

```bash
bun run apps/cli/src/main.ts
```

**预期输出**：

```
hello tch-agent
loaded package: @my/core
add(1, 2) = 3
```

如果看到这三行，说明：
- ✅ Bun 安装成功
- ✅ TypeScript 能跑（Bun 原生支持）
- ✅ monorepo workspaces 链接成功（能 import `@my/core`）
- ✅ TS 函数 + 类型正确工作（`add(1, 2) = 3`）

### 10.2 用快捷脚本跑

```bash
bun run start
```

应该和 10.1 一样输出（因为 `scripts.start` 就是 `bun run apps/cli/src/main.ts`）。

### 10.3 跑类型检查

```bash
bun run typecheck
```

**预期输出**：（**无任何输出**，说明类型检查通过）

如果有错误，TS 会列出所有问题。比如：

```
apps/cli/src/main.ts:1:28 - error TS2552: Cannot find name 'PACKAGE_NAM'. Did you mean 'PACKAGE_NAME'?
```

---

## 第十一步：提交到 Git

### 11.1 初始化 git

```bash
git init
```

**预期**：

```
Initialized empty Git repository in /Users/.../my-tch-agent/.git/
```

### 11.2 检查 git 看到哪些文件

```bash
git status
```

**预期**：

```
Untracked files:
  (use "git add <file>..." to include in what will be committed)
        .gitignore
        CLAUDE.md
        README.md
        apps/
        bun.lock
        package.json
        packages/
        tsconfig.json
```

**关键**：`node_modules/` **不应该**出现在列表里（因为 .gitignore 排除了）。

### 11.3 提交

```bash
git add .
git commit -m "init: bun monorepo scaffold"
```

**预期**：

```
[master (root-commit) xxxxxxx] init: bun monorepo scaffold
 8 files changed, ...
```

---

## 第十二步：理解刚才发生了什么（重要！）

让我们回顾一下"输入命令 → 看到输出"中间发生了什么：

### 12.1 `bun run apps/cli/src/main.ts` 的完整流程

```
1. 你输入 bun run apps/cli/src/main.ts
   ↓
2. Bun 读 apps/cli/src/main.ts
   ↓
3. 遇到 import { PACKAGE_NAME, add } from "@my/core"
   ↓
4. Bun 查 node_modules/@my/core（这是软链接）
   → 实际指向 packages/core/
   ↓
5. Bun 读 packages/core/package.json，看到 "main": "src/index.ts"
   ↓
6. Bun 读 packages/core/src/index.ts，找到 export const PACKAGE_NAME 和 export function add
   ↓
7. Bun 回到 apps/cli/src/main.ts，执行 console.log("hello tch-agent")
   ↓
8. 输出 hello tch-agent
   ↓
9. 后续两行同理
```

### 12.2 为什么我们用了 ESM 而不是 CommonJS？

试想一下如果用 CommonJS：

```javascript
// CommonJS 风格
const { PACKAGE_NAME } = require("@my/core")
```

但现代 Bun / Node 推荐 ESM，原因是：
- **静态分析**：编辑器能静态分析 import 关系，提供更好的补全和错误提示。
- **Tree-shaking**：Bundler 能自动剔除没用到的代码。
- **标准**：ESM 是 ECMAScript 官方标准，CommonJS 是历史包袱。

### 12.3 strict: true 帮我们避免了什么？

打开 `packages/core/src/index.ts`，试试这样改：

```typescript
export function add(a: number, b: number): number {
    return a + b
}

// 故意写错：传字符串
const result = add("1", 2)
```

VS Code 会立刻在 `"1"` 下面画红线：`Argument of type 'string' is not assignable to parameter of type 'number'`。

这就是 strict mode 的价值——**bug 在编辑器里就发现**，不用等运行时。

---

## 故障排查（FAQ）

### 问题 1：`bun: command not found`

**原因**：Bun 没装好或 PATH 没刷新。

**解决**：

```bash
# 检查 Bun 是否在 PATH
which bun

# 如果输出空，检查 ~/.bun/bin 是否在 PATH
echo $PATH | tr ':' '\n' | grep bun

# 如果没有，手动加
export PATH="$HOME/.bun/bin:$PATH"

# 永久生效：加到 ~/.zshrc 或 ~/.bashrc
echo 'export PATH="$HOME/.bun/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc
```

### 问题 2：`Cannot find module '@my/core'`

**原因**：消费者包（如 `apps/cli`）的 `package.json` 里没声明对 `@my/core` 的依赖。Bun workspaces 不会自动链接，必须显式声明。

**解决**：

1. **检查消费者 package.json**：

   ```bash
   cat apps/cli/package.json
   ```

   必须有 `dependencies` 字段：
   ```json
   {
     "dependencies": {
       "@my/core": "workspace:*"
     }
   }
   ```

2. **重新安装**：

   ```bash
   bun install
   ```

3. **检查软链接**：

   ```bash
   ls apps/cli/node_modules/@my/
   # 应该看到 core -> ../../../../packages/core
   ```

   注意：Bun 用 **isolated node_modules 布局**，软链接在**消费者包的** `node_modules/`，不是根目录。

4. **根 package.json 的 workspaces 字段**：

   ```bash
   cat package.json | grep -A 3 workspaces
   # 应该看到：
   # "workspaces": [
   #   "packages/*",
   #   "apps/*"
   # ],
   ```

### 问题 3：TS 报 `Cannot find name 'console'. Do you need to change your target library?`

**原因**：`tsconfig.json` 的 `"lib"` 没包含 `"DOM"`（`console` 在 DOM lib 里定义）。

**解决**：

```bash
# 检查 tsconfig.json
cat tsconfig.json | grep -E '"lib"|"types"'
```

应该是：
```json
"lib": ["ESNext", "DOM"],   // ← 必须有 DOM
"types": ["bun"],            // ← bun 不是 bun-types
```

如果只有 `"ESNext"` 没 `"DOM"`，加上：
```bash
# 编辑 tsconfig.json 把 lib 改成 ["ESNext", "DOM"]
```

> 💡 **为什么 Bun 项目也要 DOM lib？** 因为 `console` / `setTimeout` / `URL` 这些全局对象在 TypeScript 里属于 DOM lib。即使你不跑浏览器，也需要 DOM lib 提供这些定义。

### 问题 3.5：TS 报 `Cannot find module 'node:path'`（或 `node:fs` / `node:os` 等）

**原因**：`tsconfig.json` 的 `"types"` 里漏了 `"node"`，导致 Node.js 内置模块的类型定义没加载。

**解决**：

```bash
# 1. 确认装了 @types/node
bun pm ls | grep "@types/node"
# 没有的话装：
bun add -d @types/node

# 2. 修 tsconfig.json，types 字段加 "node"
cat tsconfig.json | grep types
# 应该是 "types": ["bun", "node"]
```

如果之前是 `"types": ["bun"]`，改成 `"types": ["bun", "node"]` 就 OK。

> 💡 **为什么需要 `"node"`？**
>
> Bun 兼容 Node 的所有内置模块（`node:fs`、`node:path`、`node:os`、`node:crypto` 等），可以用 `import { resolve } from "node:path"` 引入。但这些模块的类型定义在 `@types/node` 包里，不在 `@types/bun` 里。所以两个 types 都要声明。

### 问题 4：`Cannot find type definition file for 'bun-types'`

**原因**：`@types/bun` 没装。

**解决**：

```bash
bun add -d @types/bun
```

### 问题 5：跑 `bun run typecheck` 时报很多 `.bun-test` 之类的错

**原因**：TS 把 `node_modules` 里的文件也检查了。

**解决**：确认 `tsconfig.json` 的 `"exclude": ["node_modules", ...]` 正确。

### 问题 6：macOS 上 `cat > xxx << 'EOF'` 报错

**原因**：你的 shell 可能不是 bash。

**解决**：直接用 VS Code 创建文件，不要用 heredoc。

### 问题 7：跑 main.ts 报 `error: Cannot find module 'commander'`

**原因**：如果加了依赖但没 install。

**解决**：

```bash
bun install
```

### 问题 8：git commit 报 `Author identity unknown`

**原因**：第一次用 git，没配置 user.email 和 user.name。

**解决**：

```bash
git config --global user.email "你的邮箱"
git config --global user.name "你的名字"
```

### 问题 9：VS Code 里所有类型都报错，红色波浪线满天飞

**原因**：VS Code 没正确加载 TypeScript。

**解决**：

1. Cmd+Shift+P (Mac) / Ctrl+Shift+P (Win)
2. 输入 "TypeScript: Restart TS Server"
3. 回车，重启 TS 服务

如果还不行：

```bash
# 重启 VS Code
# 或者强制重装 TS
bun remove -d typescript
bun add -d typescript
```

### 问题 10：Bun 跑 TS 时报 `Expected ',' but got 'b'` 之类的语法错误

**原因**：可能 TS 文件用了一个不被 Bun 支持的新语法（罕见）。

**解决**：

```bash
# 升级 Bun 到最新
bun upgrade
```

---

## 本课小结

✅ **你已完成**：

- 搭出 Bun monorepo 仓库
- 配好 TypeScript 严格模式
- 跑通 hello world
- 理解 workspaces 机制

📦 **新增文件**：

```
my-tch-agent/
├── .gitignore
├── CLAUDE.md
├── package.json
├── tsconfig.json
├── packages/
│   └── core/
│       ├── package.json
│       └── src/
│           └── index.ts
└── apps/
    └── cli/
        ├── package.json
        └── src/
            └── main.ts
```

🔑 **关键概念回顾**：

- **Bun**：JS/TS 运行时，原生支持 TS，比 Node 快。
- **monorepo**：一个 Git 仓库多个包，通过 workspaces 互相引用。
- **ESM**：现代 JS 模块系统（`import`/`export`），替代旧的 CommonJS（`require`）。
- **TypeScript strict**：开启严格类型检查，bug 早发现。
- **package.json scripts**：自定义快捷命令，用 `bun run xxx` 触发。

---

## 思考题（可选）

1. 如果不用 workspaces，要让 `apps/cli` 引用 `packages/core` 的代码，你会怎么做？（提示：相对路径 import 或发布到 npm）
2. 为什么 `node_modules/` 不进 git？（提示：可重建性、跨平台）
3. `"type": "module"` 删掉会怎样？试试看。

---

## 下一课预告

[课时 2：ConfigManager 骨架 + 目录布局](./02-config-manager.md) —— 我们会：

- 定义 `~/.tch-agent/` 目录结构
- 实现单例模式的 ConfigManager
- 用 SDK 的 AuthStorage / ModelRegistry / SettingsManager
- 跑一个脚本验证目录被创建

继续课时 2 →
