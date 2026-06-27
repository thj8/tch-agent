# 课时 7：RuntimeManager.launch —— 拉起容器

> 🎯 **目标**：用 `docker run -i` 拉起 solver 容器，建立 stdin/stdout pipe 通道。
>
> ⏰ **预计耗时**：2-3 小时
>
> 📋 **难度**：⭐⭐⭐⭐

---

## 你将学到什么

1. **`docker run -i` 的 -i 为什么重要**
2. **Bun.spawn 怎么 spawn 子进程并接管 stdin/stdout**
3. **挂载 volume 的实战**（host ↔ container 文件共享）
4. **solver 目录布局**（workspace / session / startup）

## 前置条件

✅ 已完成 [课时 1-6](./README.md)

## 最终效果

```bash
tinyfat runtime launch --prompt SOLVER "test task"
# → 容器启动，看到容器内的输出打到 stdout
# → Ctrl+C 停止

tinyfat runtime list
# → 看到正在跑的 solver 列表
```

---

## 第零步：概念扫盲

### 0.1 docker run -i 是干嘛的？

`docker run` 有几个常用 flag：

| Flag | 含义 |
|---|---|
| `-i` (`--interactive`) | 保持 stdin 打开（即使没 attach） |
| `-t` (`--tty`) | 分配伪终端 |
| `--rm` | 容器退出时自动删除 |
| `-v host:container` | 挂载 volume |
| `-e KEY=VAL` | 注入环境变量 |
| `-w <path>` | 容器内工作目录 |
| `--network <mode>` | 网络模式（host / bridge） |

**我们用 `-i` 不用 `-t`**：
- `-i` 让 stdin 保持打开，宿主可以持续通过 stdin 写命令。
- `-t` 会把容器输出做终端转义（彩色、光标控制），不适合程序读取。

### 0.2 Bun.spawn 接管子进程

```typescript
const proc = Bun.spawn(["docker", "run", "-i", ...], {
    stdin: "pipe",   // 让我们能 proc.stdin.write()
    stdout: "pipe",  // 让我们能 proc.stdout.getReader()
    stderr: "pipe",
})

// 写 stdin
proc.stdin.write("hello\n")

// 读 stdout
const reader = proc.stdout.getReader()
const { value } = await reader.read()

// 等待退出
const exitCode = await proc.exited
```

### 0.3 Volume 挂载：host ↔ container 文件共享

```bash
docker run -v /Users/me/data:/data ...
```

容器内访问 `/data/file.txt`，实际访问的是宿主的 `/Users/me/data/file.txt`。容器写入的内容，宿主能立刻看到。

**本项目用 volume 做 3 件事**：

1. **共享配置**：把 `~/.tinyfat/config/` 挂载到容器，让容器能读 prompt / skill。
2. **共享 workspace**：把 `~/.tinyfat/solvers/<id>/workspace/` 挂载到容器 cwd，让 LLM 的产物能落盘到宿主。
3. **共享 session**：把 `~/.tinyfat/solvers/<id>/session/` 挂载，让对话历史能落盘到宿主。

### 0.4 Solver 目录布局

```
~/.tinyfat/solvers/<solverId>/
├── workspace/      ← 容器 cwd（LLM 写文件、跑命令都在这）
├── session/        ← 对话历史 JSONL（SDK 落盘）
└── startup.json    ← 启动快照（事后调试用）
```

为什么 workspace 和 session 分开？
- workspace 是"工作产物"（漏洞 PoC、扫描结果）—— 归档时单独压缩。
- session 是"对话历史"—— 永远保留，便于事后看 LLM 怎么想的。

---

## 第一步：实现 resolveSolverInjection

`resolveSolverInjection` 决定容器内跑什么 binary，返回挂载路径和启动命令。

### 1.1 在 helpers.ts 加方法

修改 `packages/core/src/runtime/helpers.ts`，在文件末尾追加：

```typescript
/**
 * 容器内 package.json 的占位内容。
 * Bun 需要它把 cwd 当成包根。
 */
const GENERATED_RUNTIME_PACKAGE_JSON = {
    name: "tinyfat-runtime",
    version: "0.0.1",
    private: true,
    type: "module",
}

/**
 * 【dev 模式】用 Bun 现场编译一份 linux-x64 solver binary。
 *
 * 让本地改代码后，下次启动 solver 自动用最新版本。
 */
export async function ensureSolverBinary(): Promise<string> {
    const binDir = RUNTIME_SELF_DIR
    const binPath = resolve(binDir, "tinyfat-linux-x64")

    // 项目根目录
    const projectRoot = resolve(import.meta.dir, "../../../..")
    const buildScript = resolve(projectRoot, "scripts/build.ts")

    await mkdir(binDir, { recursive: true })

    console.log(`[build] compiling solver binary to ${binPath}...`)
    const proc = Bun.spawn(
        ["bun", buildScript, "bun-linux-x64-baseline", binPath],
        {
            cwd: projectRoot,
            stdout: "inherit",
            stderr: "inherit",
        },
    )
    const exitCode = await proc.exited
    if (exitCode !== 0) {
        throw new Error(`Failed to compile solver binary (exit ${exitCode})`)
    }

    // 写一份 package.json，让容器内 Bun 把 cwd 当包根
    await Bun.write(
        resolve(binDir, "package.json"),
        JSON.stringify(GENERATED_RUNTIME_PACKAGE_JSON, null, 2),
    )

    return binPath
}

/**
 * 确保 ~/.tinyfat/runtime/self/package.json 存在。
 * 容器内 Bun 需要它把 cwd 识别为包根。
 */
async function ensureRuntimePackageManifest(): Promise<string> {
    const binDir = RUNTIME_SELF_DIR
    const path = resolve(binDir, "package.json")
    await mkdir(binDir, { recursive: true })
    await Bun.write(path, JSON.stringify(GENERATED_RUNTIME_PACKAGE_JSON, null, 2))
    return path
}

/**
 * 决定容器内用什么 binary 跑 solver rpc，返回挂载和启动命令。
 *
 * 三种来源（按优先级）：
 *   1. Bun runtime (dev) → 现场编译 linux-x64 binary
 *   2. Linux x64 宿主 → 复用宿主 binary
 *   3. 其他平台 → 嵌入式 binary（本课时简化为 throw）
 *
 * @returns { binds, cmd }
 *   - binds: docker -v 参数
 *   - cmd: 容器启动命令
 */
export async function resolveSolverInjection(): Promise<{
    binds: string[]
    cmd: string[]
}> {
    let binary: string
    const packageJson = await ensureRuntimePackageManifest()

    if (isBunRuntime()) {
        binary = await ensureSolverBinary()
    } else if (process.platform === "linux" && process.arch === "x64") {
        // 复用宿主 binary
        binary = process.execPath
    } else {
        // 简化：本课时不实现嵌入式 binary
        throw new Error(
            `Unsupported platform: ${process.platform}/${process.arch}. Run under Bun instead.`,
        )
    }

    return {
        binds: [
            `${binary}:/opt/tinyfat/tinyfat:ro`,
            `${packageJson}:/opt/tinyfat/package.json:ro`,
        ],
        cmd: ["/opt/tinyfat/tinyfat", "solver", "rpc"],
    }
}
```

### 1.2 创建 scripts/build.ts

让 `bun scripts/build.ts bun-linux-x64-baseline <outfile>` 能编译 binary。

```bash
mkdir -p scripts
```

新建 `scripts/build.ts`：

```typescript
#!/usr/bin/env bun
/**
 * 编译 standalone binary。
 *
 * Usage:
 *   bun scripts/build.ts <target> <outfile>
 *
 * Targets（Bun 内置）：
 *   bun-linux-x64-baseline
 *   bun-linux-x64-modern
 *   bun-linux-arm64
 *   bun-darwin-arm64
 *   bun-darwin-x64
 *   bun-windows-x64-modern
 */

import { dirname } from "node:path"
import { mkdir } from "node:fs/promises"

const target = process.argv[2]
const outfile = process.argv[3]

if (!target || !outfile) {
    console.error("Usage: bun scripts/build.ts <target> <outfile>")
    process.exit(1)
}

console.log(`[build] target=${target} outfile=${outfile}`)

// 确保 outfile 目录存在
await mkdir(dirname(outfile) || ".", { recursive: true })

// 用 Bun.build + compile 编译 standalone binary
// 关键：compile 是对象（含 outfile / target），不是 boolean
const result = await Bun.build({
    entrypoints: ["apps/cli/src/main.ts"],
    outdir: dirname(outfile) || ".",
    compile: {
        outfile,
        target: target as never,  // Bun 自带类型对 target 要求严格
    },
    naming: {
        // 让输出文件名直接等于 outfile（不加 hash）
        entry: "[name]",
    },
})

if (!result.success) {
    for (const log of result.logs) {
        console.error(log.message)
    }
    process.exit(1)
}

console.log(`[build] ✓ output: ${outfile}`)
```

> ⚠️ **关键 API**：
> ```typescript
> Bun.build({
>     entrypoints: [...],
>     compile: { outfile, target },  // ← compile 是对象
> })
> ```
> **不是** `Bun.build({ compile: true, target })`。这是常见坑。

> 💡 **注意**：Bun 的 `--compile` API 在不同版本略有差异。如果上面 build.ts 不工作，看 [Bun.compile 文档](https://bun.sh/docs/bundler/executables)。

### 1.3 在根 package.json 加 build script

```json
{
  "scripts": {
    "build:solver": "bun scripts/build.ts bun-linux-x64-baseline bin/tinyfat-linux-x64"
  }
}
```

试一下：

```bash
bun run build:solver
ls -la bin/
# 看到 tinyfat-linux-x64
```

---

## 第二步：在 RuntimeManager 加 launch 方法

### 2.1 修改 packages/core/src/runtime/runtime.ts

在 RuntimeManager 类里加 launch 方法：

```typescript
// 顶部加 import
import { mkdir } from "node:fs/promises"
import { resolve } from "node:path"
import type { Subprocess } from "bun"
import {
    solverDir,
    solverSessionDir,
    solverWorkspaceDir,
} from "./types"
import { resolveSolverInjection } from "./helpers"

// 在 RuntimeManager 类里加字段：
export class RuntimeManager {
    private docker: Dockerode
    private config: ContainerConfig
    private hostConfig: ConfigManager
    private eventHandlers: SolverEventHandler[] = []
    /** solverId → Subprocess 句柄 */
    private procs = new Map<string, Subprocess<"pipe", "pipe", "pipe">>()
    /** solverId → SolverInstance 元数据 */
    private solvers = new Map<string, SolverInstance>()

    // ... 已有方法保留 ...

    /**
     * 拉起一个 Solver 容器。
     *
     * 流程：
     *   1. 生成 solverId
     *   2. mkdir workspace / session / base
     *   3. 决定 binary injection
     *   4. 拼 docker run 命令
     *   5. Bun.spawn 拉起容器，拿到 stdin/stdout pipe
     *   6. 启动 readStream（监听容器 stdout）
     *
     * 注意：本课时**不做 init 握手**，下一课再补。
     * 这里容器能跑起来 + 事件流能转发就 OK。
     *
     * @param promptName 用哪个 prompt
     * @param task 初始 task 文本
     * @param solverEnv 注入容器的环境变量
     */
    async launch(
        promptName: string,
        task: string,
        solverEnv: Record<string, string> = {},
    ): Promise<SolverInstance> {
        const id = crypto.randomUUID().slice(0, 8)
        const name = `tch-solver-${id}`

        const solver: SolverInstance = {
            id,
            containerId: name,
            name,
            promptName,
            task,
            challengeId: solverEnv.TCH_CHALLENGE_ID,
            status: "starting",
            createdAt: Date.now(),
        }
        this.solvers.set(id, solver)

        // 准备目录
        const baseDir = solverDir(id)
        const sessionDir = solverSessionDir(id)
        const workspaceDir = solverWorkspaceDir(id)
        const containerRuntimeDir = "/runtime"
        const containerSessionDir = `${containerRuntimeDir}/session`
        const containerWorkspaceDir = "/root/workspace"

        await mkdir(baseDir, { recursive: true })
        await mkdir(sessionDir, { recursive: true })
        await mkdir(workspaceDir, { recursive: true })

        // 决定 binary injection
        const injection = await resolveSolverInjection()

        // 组装 binds
        const binds = [
            ...(this.config.binds ?? []),
            `${baseDir}:${containerRuntimeDir}`,
            `${workspaceDir}:${containerWorkspaceDir}`,
            ...injection.binds,
        ]

        // 组装 env（全局 env + solver 专属 env）
        const envPairs: string[] = []
        for (const [k, v] of Object.entries(this.config.env ?? {})) {
            envPairs.push(`${k}=${v}`)
        }
        for (const [k, v] of Object.entries(solverEnv)) {
            envPairs.push(`${k}=${v}`)
        }

        // 拼 docker run 命令
        const args: string[] = [
            "docker", "run",
            "-i",
            "--platform", "linux/amd64",
            "--network", this.config.networkMode ?? "host",
            "--name", name,
            "-w", containerWorkspaceDir,
            "--rm",
        ]
        for (const bind of binds) {
            args.push("-v", bind)
        }
        for (const envVar of envPairs) {
            args.push("-e", envVar)
        }
        args.push(this.config.image)
        args.push(...injection.cmd)

        console.log(`[runtime] launching solver ${id}...`)
        console.log(`[runtime] cmd: ${args.join(" ")}`)

        // 拉起容器
        const proc = Bun.spawn(args, {
            stdin: "pipe",
            stdout: "pipe",
            stderr: "pipe",
        })

        this.procs.set(id, proc)
        solver.status = "running"

        // 启动 stdout 监听
        this.readStream(id, proc)

        return solver
    }

    /**
     * 列出所有活跃 solver。
     */
    list(): SolverInstance[] {
        return [...this.solvers.values()]
    }

    /**
     * 获取一个 solver 的元数据。
     */
    get(solverId: string): SolverInstance | undefined {
        return this.solvers.get(solverId)
    }

    /**
     * 优雅停止一个 solver。
     */
    async stopSolver(solverId: string): Promise<void> {
        const solver = this.solvers.get(solverId)
        if (!solver) throw new Error(`Solver ${solverId} not found`)

        solver.status = "stopping"
        const proc = this.procs.get(solverId)

        try {
            // docker stop 容器
            const stopProc = Bun.spawn(
                ["docker", "stop", solver.containerId],
                { stdout: "ignore", stderr: "ignore" },
            )
            await stopProc.exited
        } catch {
            // 容器可能已经停了
        }

        // 关闭 Subprocess pipe
        if (proc) {
            try {
                proc.kill()
            } catch {}
        }

        this.procs.delete(solverId)
        solver.status = "stopped"
    }

    /**
     * 读容器的 stdout，把每行解析为 JSON 转发给事件 handler。
     *
     * 本课时简化：不解析 JSON，直接 print（下一课时改成事件流）。
     */
    private readStream(
        solverId: string,
        proc: Subprocess<"pipe", "pipe", "pipe">,
    ): void {
        const decoder = new TextDecoder()
        ;(async () => {
            const reader = proc.stdout.getReader()
            let buffer = ""
            try {
                while (true) {
                    const { done, value } = await reader.read()
                    if (done) break
                    buffer += decoder.decode(value, { stream: true })

                    // 按行切分
                    while (true) {
                        const idx = buffer.indexOf("\n")
                        if (idx === -1) break
                        const line = buffer.slice(0, idx).trim()
                        buffer = buffer.slice(idx + 1)
                        if (line) {
                            // 本课时：直接 print 容器输出
                            console.log(`[${solverId}] ${line}`)
                        }
                    }
                }
            } catch (error) {
                console.error(`[${solverId}] stdout read error:`, error)
            }

            // 流结束 = 容器退出
            const exitCode = await proc.exited
            console.log(`[${solverId}] container exited with code ${exitCode}`)

            const solver = this.solvers.get(solverId)
            if (solver && solver.status !== "stopped") {
                solver.status = exitCode === 0 ? "stopped" : "error"
                if (exitCode !== 0) {
                    solver.error = `Container exited with code ${exitCode}`
                }
            }
            this.procs.delete(solverId)
        })()
    }
}
```

---

## 第三步：CLI 命令

`ConfigManager` / `RuntimeManager` 已经在 lesson 6 的顶部 import 加好了，这里直接用。在 `apps/cli/src/main.ts` 的 runtimeCmd 后追加：

```typescript
runtimeCmd
    .command("launch")
    .description("Launch a solver container")
    .requiredOption("-p, --prompt <name>", "Prompt name")
    .argument("<task>", "Task")
    .action(async (task: string, opts: { prompt: string }) => {
        const config = await ConfigManager.getInstance()
        const runtime = new RuntimeManager(config)

        await runtime.init((msg) => console.log(msg))

        const solver = await runtime.launch(opts.prompt, task)
        console.log(`\n✓ Launched solver ${solver.id} (container: ${solver.containerId})`)
        console.log(`Press Ctrl+C to stop...\n`)

        // Ctrl+C 时停止
        process.on("SIGINT", async () => {
            console.log("\nStopping...")
            await runtime.stopSolver(solver.id)
            process.exit(0)
        })

        // 保持进程运行
        await new Promise(() => {})
    })

runtimeCmd
    .command("list")
    .description("List all tracked solver instances")
    .action(async () => {
        const config = await ConfigManager.getInstance()
        const runtime = new RuntimeManager(config)
        const list = runtime.list()

        if (list.length === 0) {
            console.log("(no solvers)")
            return
        }

        console.log("ID\t\tSTATUS\t\tPROMPT\t\tCONTAINER")
        console.log("--\t\t------\t\t------\t\t---------")
        for (const s of list) {
            console.log(`${s.id}\t\t${s.status}\t\t${s.promptName}\t\t${s.containerId}`)
        }
    })
```

---

## 第四步：验证

### 4.1 准备工作

确保：
- Docker daemon 在跑
- 已 build solver image（课时 6）
- `~/.tinyfat/config/prompts/SOLVER.md` 存在

### 4.2 跑 launch

```bash
bun run apps/cli/src/main.ts runtime launch --prompt SOLVER "just say hi"
```

**预期输出**：

```
[runtime] launching solver abc12345...
[runtime] cmd: docker run -i --platform linux/amd64 --network host --name tch-solver-abc12345 ...
✓ Launched solver abc12345 (container: tch-solver-abc12345)
Press Ctrl+C to stop...

[abc12345] ... (容器内启动日志)
```

容器会尝试跑 `/opt/tinyfat/tinyfat solver rpc`，但我们这课时还没实现 RPC server，所以容器会很快报错退出：

```
[abc12345] container exited with code 1
```

**这是正常的**！下一课时我们会实现容器内的 RPC server，那时就能正常跑了。

### 4.3 验证目录被创建

```bash
ls ~/.tinyfat/solvers/
# 看到一个 8 字符 ID 目录

ls ~/.tinyfat/solvers/<id>/
# workspace/ session/
```

### 4.4 看看 binary 真的被挂进去了

```bash
ls ~/.tinyfat/runtime/self/
# tinyfat-linux-x64 + package.json
```

### 4.5 手动测试镜像和 binary

直接跑 binary 看看：

```bash
~/.tinyfat/runtime/self/tinyfat-linux-x64 --help
```

应该看到课时 1 的 hello world（因为 binary 编译时是基于 apps/cli/src/main.ts，还没加真正的子命令路由）。

### 4.6 类型检查

```bash
bun run typecheck
```

---

## 第五步：故障排查

### 问题 1：`Error: Unsupported platform: darwin/arm64`

**原因**：你在 Apple Silicon Mac 上跑非 Bun 编译模式。

**解决**：本课时简化版只支持 Bun runtime。用 `bun run ...` 而不是 `node ...` 或编译过的 binary 跑。

### 问题 2：`docker: Error response from daemon: Conflict. The container name is already in use`

**原因**：上次跑挂了，容器残留。

**解决**：

```bash
docker rm -f tch-solver-xxx
# 或者全部清掉
docker ps -a | grep tch-solver | awk '{print $1}' | xargs docker rm -f
```

### 问题 3：编译 binary 报 `Cannot find module '@my/core'`

**原因**：Bun build 时 monorepo workspace 没正确链接。

**解决**：

```bash
bun install
# 再 build
bun run build:solver
```

### 问题 4：容器启动后立刻退出，看不到任何输出

**原因**：可能 binary 路径错或权限问题。

**调试**：

```bash
# 手动跑容器，进去看
docker run -it --rm \
  -v ~/.tinyfat/runtime/self/tinyfat-linux-x64:/opt/tinyfat/tinyfat:ro \
  -v ~/.tinyfat/runtime/self/package.json:/opt/tinyfat/package.json:ro \
  tinyfat:latest \
  bash

# 在容器里：
$ /opt/tinyfat/tinyfat --help
# 看错误信息
```

### 问题 5：`[solverId] container exited with code 1` 但没具体错误

**原因**：solver binary 报错只写到 stderr，但我们的 readStream 只读 stdout。

**解决**：加 stderr 监听：

```typescript
// 在 readStream 函数后追加：
if (proc.stderr) {
    const errReader = proc.stderr.getReader()
    ;(async () => {
        while (true) {
            const { done, value } = await errReader.read()
            if (done) break
            console.error(`[${solverId}][stderr] ${decoder.decode(value)}`)
        }
    })()
}
```

---

## 本课小结

✅ **你已完成**：

- 实现 resolveSolverInjection（决定容器内 binary）
- 实现 ensureSolverBinary（Bun 编译 standalone）
- 实现 RuntimeManager.launch（docker run + pipe）
- 实现 readStream（监听容器输出）
- 加 `runtime launch / list` CLI 命令
- 看到容器真的启动（虽然 RPC 通信下一课才做）

📦 **新增文件**：

```
scripts/build.ts                              ← Bun compile 脚本
packages/core/src/runtime/runtime.ts          ← RuntimeManager.launch
```

🔑 **关键概念**：

- **docker run -i**：保持 stdin 打开，宿主可持续写命令。
- **Bun.spawn pipe**：通过 `stdin: "pipe"` / `stdout: "pipe"` 接管子进程 IO。
- **Volume 挂载**：让容器内外共享文件（workspace / session / config）。
- **readStream**：按行切分 stdout，转发给事件 handler（下一课时改成 JSON 解析）。

---

## 下一课预告

[课时 8：Solver RPC 协议 + init 握手](./08-rpc-handshake.md)（待生成）—— 我们会：

- 定义 JSONL RPC 协议（RpcCommand / RpcResponse）
- 实现容器内 runSolverRpc
- 实现 init 握手（宿主发 SolverInitPayload → 容器回 init success）
- 让容器内的 LLM 真的能跑起来

继续课时 8 →
