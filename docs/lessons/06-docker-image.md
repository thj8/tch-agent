# 课时 6：Docker 镜像 + Dockerfile

> 🎯 **目标**：做出一个最小可用的 solver Docker 镜像，能用 `docker run` 跑起来。
>
> ⏰ **预计耗时**：2-3 小时
>
> 📋 **难度**：⭐⭐⭐

---

## 你将学到什么

1. **为什么要用 Docker 跑 solver**（隔离 + 复用）
2. **Dockerfile 的基本写法**
3. **Bun 怎么编译 standalone binary**
4. **RuntimeManager 怎么管理镜像生命周期**
5. **Docker 增量构建**（用 label 做缓存）

## 前置条件

✅ 已完成 [课时 1-5](./README.md)
✅ 安装 Docker Desktop（[下载](https://www.docker.com/products/docker-desktop/)）
✅ `docker --version` 能跑

## 最终效果

```bash
tinyfat runtime build-image
# → 自动 build solver 镜像（首次较慢，之后秒级）

tinyfat runtime ping
# → ✓ Docker daemon connected

tinyfat runtime has-image
# → ✓ Image tinyfat:latest exists
```

---

## 第零步：概念扫盲

### 0.1 为什么要 Docker？

课时 5 我们让 LLM agent 在**本地直接跑**（`bun run apps/cli/src/main.ts solver`）。那为什么还要 Docker？

**原因 1：隔离**

LLM agent 会跑 bash 命令、读写文件。直接在你电脑上跑，它可能：
- 误删你的文件
- 改你的 shell 配置
- 占用你的全局 npm/bun 环境

Docker 容器是个沙箱，agent 在里面干什么都不影响宿主。

**原因 2：复用**

一道 CTF 题可能并行起 5 个 agent 同时探索。每个 agent 用不同模型 / 不同 prompt。Docker 让这 5 个 agent 完全独立，互不干扰。

**原因 3：可重建**

容器跑挂了 → 删掉再起。所有环境（依赖、PATH、shell）都白纸一张，复现 bug 容易。

### 0.2 Docker 的几个核心概念

| 概念 | 类比 | 说明 |
|---|---|---|
| **Dockerfile** | 食谱 | 描述怎么"做菜" |
| **Image（镜像）** | 菜的配方 | 不可变的模板 |
| **Container（容器）** | 一盘菜 | 镜像的运行实例 |
| **Volume（卷）** | 外卖盒 | 容器内外的共享文件 |
| **Network** | 餐桌 | 容器的网络环境 |

**镜像 → 容器** 的关系类似 **类 → 实例**：一个镜像可以跑多个容器实例。

### 0.3 Bun standalone binary

平时跑 TS 用 `bun file.ts`，需要装 Bun。但 Docker 容器里不想装 Bun，怎么办？

**方案**：用 Bun 编译 standalone binary：

```bash
bun build --compile --target=bun-linux-x64 file.ts --outfile my-app
```

这会生成一个 ~50MB 的 single executable，**不需要 Bun 也能跑**，直接 `/path/to/my-app arg1 arg2` 就能用。

我们用这个方案，让 solver binary 挂载进容器，容器里不用装任何运行时。

### 0.4 增量构建

每次改 Dockerfile 都 rebuild 很慢（基础镜像几百 MB）。怎么优化？

**方案**：用 Docker label 标记当前镜像的 Dockerfile 版本：

```dockerfile
LABEL ai.tinyfat.dockerfile-sha256=abc123...
```

启动时检查：
- 镜像存在 + label 匹配 → 跳过 build（秒级）。
- label 不匹配 → rebuild（首次较慢）。

这就是 `ensureImage` 的核心逻辑。

---

## 第一步：定义 RuntimeManager 类型和常量

### 1.1 安装 dockerode

```bash
bun add dockerode
bun add -d @types/dockerode
```

[dockerode](https://github.com/apocas/dockerode) 是 Node.js 的 Docker 客户端，让我们能用代码控制 Docker（不用 spawn `docker` 命令）。

### 1.2 创建 packages/core/src/runtime/types.ts

```bash
mkdir -p packages/core/src/runtime
```

新建 `packages/core/src/runtime/types.ts`：

```typescript
import { resolve } from "node:path"
import { TCH_AGENT_HOME_DIR } from "../config/index"
import type { AgentSessionEvent } from "@mariozechner/pi-coding-agent"
import type { Message } from "@mariozechner/pi-ai"

/**
 * 所有 solver 的根目录：~/.tinyfat/solvers/
 * 每个 solver 一个子目录，按 solverId 命名。
 */
export const SOLVERS_DIR = resolve(TCH_AGENT_HOME_DIR, "solvers")

/** 已归档（停止）的 solver：~/.tinyfat/archive_solvers/ */
export const ARCHIVE_SOLVERS_DIR = resolve(TCH_AGENT_HOME_DIR, "archive_solvers")

/**
 * Docker 容器配置。
 */
export interface ContainerConfig {
    /** Docker 镜像名 */
    image: string
    /** 注入容器的环境变量 */
    env?: Record<string, string>
    /** 额外的 volume binds（host:container 格式） */
    binds?: string[]
    /** Docker 网络模式 */
    networkMode?: "bridge" | "host"
}

/**
 * 一个 Solver 实例的元数据。
 *
 * 这是 runtime 注册表里的"指针"——所有对 solver 的引用都基于它。
 */
export interface SolverInstance {
    /** 8 字符 solver ID（不是 Docker container ID） */
    id: string
    /** Docker 容器名 */
    containerId: string
    /** 容器显示名 */
    name: string
    /** 用哪个 prompt 启动 */
    promptName: string
    /** 初始 task 文本 */
    task: string
    /** challenge 模式下的题目 ID */
    challengeId?: string
    /** 当前状态 */
    status: "starting" | "running" | "stopping" | "stopped" | "error"
    /** 创建时间戳 */
    createdAt: number
    /** 错误信息（status === "error" 时） */
    error?: string
}

/**
 * Solver 事件回调。
 * 每当容器内的 AgentSession 产生一个事件，就调用这个回调。
 */
export type SolverEventHandler = (solverId: string, event: AgentSessionEvent) => void

// ── 路径计算辅助 ──────────────────────────────────────

/** solver 根目录：~/.tinyfat/solvers/<solverId> */
export function solverDir(solverId: string): string {
    return resolve(SOLVERS_DIR, solverId)
}

/** solver session 目录（对话历史） */
export function solverSessionDir(solverId: string): string {
    return resolve(SOLVERS_DIR, solverId, "session")
}

/** solver 工作目录（容器 cwd） */
export function solverWorkspaceDir(solverId: string): string {
    return resolve(SOLVERS_DIR, solverId, "workspace")
}
```

### 1.3 创建 packages/core/src/runtime/helpers.ts

新建 `packages/core/src/runtime/helpers.ts`：

```typescript
import { createHash } from "node:crypto"
import { mkdir, readdir, stat } from "node:fs/promises"
import { basename, dirname, resolve } from "node:path"
import { TCH_AGENT_HOME_DIR } from "../config/index"

/** Docker image label：把 Dockerfile 的 sha256 存到镜像 label，便于增量构建。 */
export const DOCKERFILE_HASH_LABEL = "ai.tinyfat.dockerfile-sha256"

/** Solver 镜像的目标架构：固定 amd64 */
export const RUNTIME_IMAGE_ARCH = "amd64"

/** Runtime 资源目录：~/.tinyfat/runtime/ */
export const RUNTIME_DIR = resolve(TCH_AGENT_HOME_DIR, "runtime")

/** Runtime self 目录（存 solver binary）：~/.tinyfat/runtime/self/ */
export const RUNTIME_SELF_DIR = resolve(RUNTIME_DIR, "self")

/**
 * 计算 Dockerfile 内容的 sha256。
 * 用于增量构建：hash 没变就跳过 build。
 */
export function hashDockerfileContent(content: string): string {
    return createHash("sha256").update(content).digest("hex")
}

/** 路径是否存在（吞掉异常） */
export async function pathExists(path: string): Promise<boolean> {
    try {
        await stat(path)
        return true
    } catch {
        return false
    }
}

/** 当前进程是否跑在 Bun runtime 下 */
function isBunRuntime(): boolean {
    const execName = basename(process.execPath).toLowerCase()
    return execName === "bun" || execName === "bun.exe"
}

/**
 * 把 Dockerfile + 辅助脚本（统称"runtime assets"）同步到 ~/.tinyfat/runtime/。
 * 同步是幂等的——每次都覆盖一遍，保证是最新版本。
 */
export async function resolveDockerfilePath(onProgress?: (msg: string) => void): Promise<string> {
    const targetDockerfile = resolve(RUNTIME_DIR, "Dockerfile")
    await mkdir(dirname(targetDockerfile), { recursive: true })

    // 写 Dockerfile 内容（下个步骤会定义）
    const dockerfileContent = getSolverDockerfileContent()
    await Bun.write(targetDockerfile, dockerfileContent)

    onProgress?.(`Synced runtime Dockerfile to ${RUNTIME_DIR}`)
    return targetDockerfile
}

/**
 * 返回 solver Dockerfile 的内容。
 *
 * 设计原则：
 *   1. 基础镜像小（debian-slim）
 *   2. 装通用基础工具（curl/git/python 等）+ 少量 pentest 工具
 *   3. 工作目录 /root/workspace（容器 cwd）
 */
function getSolverDockerfileContent(): string {
    return `# tinyfat solver image
# Auto-generated by tinyfat - DO NOT EDIT MANUALLY

FROM debian:bookworm-slim

# 基础工具（这些都在 debian apt 源里，肯定能装上）
RUN apt-get update && apt-get install -y --no-install-recommends \\
    ca-certificates \\
    curl \\
    wget \\
    git \\
    unzip \\
    vim \\
    nano \\
    python3 \\
    python3-pip \\
    python3-venv \\
    jq \\
    dnsutils \\
    iputils-ping \\
    netcat-openbsd \\
    tcpdump \\
    procps \\
    file \\
    less \\
    && rm -rf /var/lib/apt/lists/*

# 通过 pip 装 pentest 工具（pip 包都是源码或 wheel，不依赖系统包）
RUN pip3 install --no-cache-dir --break-system-packages \\
    requests \\
    beautifulsoup4 \\
    pwntools \\
    cryptography

# 通过 GitHub release 装 nmap（nmap 在 apt 源里但依赖多，简化用二进制）
# 这部分可按需添加，本课时简化处理

# 工作目录
WORKDIR /root/workspace

# 默认命令（会被 docker run 的 cmd 覆盖）
CMD ["/bin/bash"]
`
}
```

> 💡 **简化**：真实项目的 Dockerfile 列表是从 `packages/core/src/config/builtin-assets.generated.ts` 拉的（脚本生成的字典）。我们这里硬编码，简化讲解。

---

## 第二步：实现 RuntimeManager

### 2.1 创建 packages/core/src/runtime/runtime.ts

新建 `packages/core/src/runtime/runtime.ts`：

```typescript
import Dockerode from "dockerode"
import { ConfigManager } from "../config/index"
import type { ContainerConfig, SolverInstance, SolverEventHandler } from "./types"
import {
    DOCKERFILE_HASH_LABEL,
    hashDockerfileContent,
    resolveDockerfilePath,
} from "./helpers"

/**
 * RuntimeManager：Docker 容器操作平面。
 *
 * 职责：
 *   1. Docker 镜像管理（ensureImage）
 *   2. Solver 容器生命周期（launch / stopSolver）—— 课时 7
 *   3. 事件总线（onEvent / emit）—— 课时 7
 *
 * 与 ChallengeManager 的边界：
 *   - ChallengeManager 决定"什么时候 launch / stop"。
 *   - RuntimeManager 负责怎么实际操作 Docker。
 */
export class RuntimeManager {
    private docker: Dockerode
    private config: ContainerConfig
    private hostConfig: ConfigManager
    private eventHandlers: SolverEventHandler[] = []

    /**
     * @param config ConfigManager（用于读 host settings）
     */
    constructor(config: ConfigManager) {
        this.docker = new Dockerode()
        this.hostConfig = config
        this.config = {
            image: "tinyfat:latest",
            binds: [],
        }
    }

    /**
     * 初始化：确保镜像就绪。
     * web 进程启动时调用一次。
     */
    async init(onProgress?: (msg: string) => void): Promise<void> {
        await this.ensureImage(onProgress)
    }

    /**
     * 注册事件处理器。
     * 每当任何 solver 容器产生事件，所有 handler 都会被调用。
     */
    onEvent(handler: SolverEventHandler): void {
        this.eventHandlers.push(handler)
    }

    /**
     * 触发事件：扇出给所有 handler。
     */
    protected emit(solverId: string, event: Parameters<SolverEventHandler>[1]): void {
        for (const handler of this.eventHandlers) {
            try {
                handler(solverId, event)
            } catch (error) {
                console.error("[runtime] event handler error:", error)
            }
        }
    }

    /**
     * 检查 Docker daemon 是否在线。
     */
    async ping(): Promise<boolean> {
        try {
            await this.docker.ping()
            return true
        } catch {
            return false
        }
    }

    /**
     * 检查指定镜像（默认当前配置）在本地是否存在。
     */
    async hasImage(image?: string): Promise<boolean> {
        const imageName = image ?? this.config.image
        try {
            await this.docker.getImage(imageName).inspect()
            return true
        } catch {
            return false
        }
    }

    /**
     * 确保 solver 镜像存在；不存在则构建。
     *
     * 增量构建：用 Dockerfile sha256 label 检查是否需要 rebuild。
     */
    async ensureImage(onProgress?: (msg: string) => void): Promise<void> {
        const desiredHash = hashDockerfileContent(await this.readDockerfileContent())

        // 检查现有镜像的 label
        if (await this.hasImage()) {
            const existingHash = await this.getImageDockerfileHash(this.config.image)
            if (existingHash === desiredHash) {
                onProgress?.(`Image ${this.config.image} up to date (hash=${desiredHash.slice(0, 8)})`)
                return
            }
            onProgress?.(`Image ${this.config.image} outdated, rebuilding...`)
        } else {
            onProgress?.(`Image ${this.config.image} not found, building...`)
        }

        // 同步 Dockerfile 到 ~/.tinyfat/runtime/
        const dockerfilePath = await resolveDockerfilePath(onProgress)

        // docker build
        await this.buildImage(dockerfilePath, desiredHash, onProgress)
    }

    /** 读当前 Dockerfile 内容（用于 hash 计算） */
    private async readDockerfileContent(): Promise<string> {
        // 这里简化：直接调 resolveDockerfilePath 同时拿到内容
        // 实际实现会把内容缓存
        const path = await resolveDockerfilePath()
        return Bun.file(path).text()
    }

    /** 从镜像 label 读 Dockerfile hash */
    private async getImageDockerfileHash(image: string): Promise<string | undefined> {
        try {
            const info = await this.docker.getImage(image).inspect()
            const labels = info.Config?.Labels ?? {}
            return (labels as Record<string, string>)[DOCKERFILE_HASH_LABEL]
        } catch {
            return undefined
        }
    }

    /**
     * 调 docker build。
     *
     * 简化实现：直接 spawn `docker build` 命令（不用 dockerode 的 buildImage，因为后者流式输出处理复杂）。
     */
    private async buildImage(
        dockerfilePath: string,
        hash: string,
        onProgress?: (msg: string) => void,
    ): Promise<void> {
        const context = Bun.dirname(dockerfilePath)
        const proc = Bun.spawn(
            [
                "docker", "build",
                "-t", this.config.image,
                "--label", `${DOCKERFILE_HASH_LABEL}=${hash}`,
                "-f", dockerfilePath,
                context,
            ],
            { stdout: "pipe", stderr: "pipe" },
        )

        // 流式读取输出（让用户看到 build 进度）
        if (proc.stdout) {
            const reader = proc.stdout.getReader()
            const decoder = new TextDecoder()
            while (true) {
                const { done, value } = await reader.read()
                if (done) break
                const text = decoder.decode(value, { stream: true })
                // 只打印含有 Step / Successfully / ERROR 的行
                for (const line of text.split("\n")) {
                    if (/^(Step|Successfully|ERROR|#)/.test(line)) {
                        onProgress?.(line)
                    }
                }
            }
        }

        const exitCode = await proc.exited
        if (exitCode !== 0) {
            const stderr = proc.stderr ? await new Response(proc.stderr).text() : ""
            throw new Error(`docker build failed (exit ${exitCode}): ${stderr}`)
        }

        onProgress?.(`✓ Image ${this.config.image} built`)
    }

    /**
     * 让外部代码访问当前 config（用于读镜像名等）。
     */
    getConfig(): ContainerConfig {
        return this.config
    }
}
```

### 2.2 在 packages/core/src/index.ts 加 export

```typescript
export { RuntimeManager } from "./runtime/runtime"
export type { SolverInstance, ContainerConfig, SolverEventHandler } from "./runtime/types"
export { SOLVERS_DIR, solverDir, solverSessionDir, solverWorkspaceDir } from "./runtime/types"
```

---

## 第三步：CLI 命令

先把 `RuntimeManager` 加到 `apps/cli/src/main.ts` 顶部的 `@my/core` import：

```typescript
import { ConfigManager, RuntimeManager } from "@my/core"
```

（`ConfigManager` 之前 lesson 2 已经导过；这里只是把 `RuntimeManager` 一并加上。`@my/core` 是 monorepo 内部包，统一在顶部 import，不用 `await import()`。）

然后加 `runtime` 命令组：

```typescript
// ── runtime 命令组 ──────────────────────────────────────

const runtimeCmd = program.command("runtime").description("Manage Docker runtime")

runtimeCmd
    .command("ping")
    .description("Check if Docker daemon is reachable")
    .action(async () => {
        const config = await ConfigManager.getInstance()
        const runtime = new RuntimeManager(config)
        const ok = await runtime.ping()
        if (ok) {
            console.log("✓ Docker daemon connected")
        } else {
            console.error("✗ Docker daemon not reachable")
            process.exit(1)
        }
    })

runtimeCmd
    .command("build-image")
    .description("Build the solver Docker image (incremental)")
    .action(async () => {
        const config = await ConfigManager.getInstance()
        const runtime = new RuntimeManager(config)
        await runtime.init((msg) => console.log(msg))
        console.log("✓ Done")
    })

runtimeCmd
    .command("has-image")
    .description("Check if solver image exists locally")
    .action(async () => {
        const config = await ConfigManager.getInstance()
        const runtime = new RuntimeManager(config)
        const exists = await runtime.hasImage()
        if (exists) {
            console.log(`✓ Image ${runtime.getConfig().image} exists`)
        } else {
            console.log(`✗ Image ${runtime.getConfig().image} not found`)
            process.exit(1)
        }
    })
```

---

## 第四步：验证

### 4.1 检查 Docker 安装

```bash
docker --version
# Docker version 24.x.x 或更新

docker info | head -5
# 看到 Containers / Images 等信息
```

如果报错，启动 Docker Desktop。

### 4.2 ping Docker daemon

```bash
bun run apps/cli/src/main.ts runtime ping
```

**预期**：

```
✓ Docker daemon connected
```

### 4.3 构建镜像

```bash
bun run apps/cli/src/main.ts runtime build-image
```

**预期输出**（首次较慢，约 2-5 分钟）：

```
Image tinyfat:latest not found, building...
Step 1/3 : FROM debian:bookworm-slim
Step 2/3 : RUN apt-get update && apt-get install -y ...
Step 3/3 : WORKDIR /root/workspace
Successfully built abc123...
Successfully tagged tinyfat:latest
✓ Image tinyfat:latest built
✓ Done
```

### 4.4 再跑一次（验证增量）

```bash
bun run apps/cli/src/main.ts runtime build-image
```

**预期**（秒级返回）：

```
Image tinyfat:latest up to date (hash=abc12345)
✓ Done
```

### 4.5 验证镜像存在

```bash
bun run apps/cli/src/main.ts runtime has-image
```

**预期**：

```
✓ Image tinyfat:latest exists
```

```bash
docker images | grep tinyfat
# tinyfat   latest   abc123...   5 minutes ago   500MB
```

### 4.6 手动测试镜像

```bash
docker run -it --rm tinyfat:latest bash
# 进入容器内的 bash

# 在容器里：
$ ls
$ python3 --version
$ nmap --version
$ exit
```

能跑说明镜像 OK。

### 4.7 类型检查

```bash
bun run typecheck
```

---

## 第五步：故障排查

### 问题 1：`Cannot connect to the Docker daemon`

**原因**：Docker Desktop 没启动。

**解决**：
- Mac：打开 Docker Desktop 应用
- Linux：`sudo systemctl start docker`
- Windows (WSL2)：启动 Docker Desktop

### 问题 2：`docker build` 卡住或超慢

**原因**：网络问题，apt 下载慢。

**解决**：
1. 配 Docker 镜像加速（国内推荐阿里云）
2. 或换基础镜像源：

```dockerfile
FROM registry.cn-hangzhou.aliyuncs.com/library/debian:bookworm-slim
```

### 问题 3：`no space left on device`

**原因**：Docker 磁盘满了。

**解决**：

```bash
docker system prune -a
# 清理所有未用的镜像 / 容器 / 网络 / 缓存
```

### 问题 4：镜像 label 读不到

**原因**：旧镜像没有 label。

**解决**：删掉旧镜像重 build：

```bash
docker rmi tinyfat:latest
bun run apps/cli/src/main.ts runtime build-image
```

### 问题 5：`dockerode` 报 `ENOENT: no such file docker.sock`

**原因**：Linux 上 docker socket 路径或权限问题。

**解决**：

```bash
# 把当前用户加进 docker 组
sudo usermod -aG docker $USER
# 重新登录生效
```

### 问题 6：构建成功但 `has-image` 找不到

**原因**：镜像名/tag 不一致。

**解决**：检查 `docker images` 的实际名字，对比 `RuntimeManager` 的 `config.image`。

---

## 本课小结

✅ **你已完成**：

- 写出 solver Dockerfile（含 CTF 常用工具）
- 实现 RuntimeManager 类骨架
- 实现 ensureImage（自动构建 + 增量构建）
- 加 `runtime ping / build-image / has-image` CLI 命令
- 验证 Docker 镜像可手动跑

📦 **新增文件**：

```
packages/core/src/runtime/
├── types.ts        ← SolverInstance / 路径常量
├── helpers.ts      ← Dockerfile 内容 / hash / 路径同步
└── runtime.ts      ← RuntimeManager 类
```

🔑 **关键概念**：

- **Docker 隔离**：每个 solver 跑在独立容器，互不影响。
- **Bun standalone binary**：编译成单文件可执行，容器里不用装运行时。
- **Docker label 增量构建**：用 sha256 label 判断 Dockerfile 是否变化，跳过未变的 build。
- **dockerode**：Node/Bun 控制 Docker 的标准库。

---

## 下一课预告

[课时 7：RuntimeManager.launch —— 拉起容器](./07-launch-container.md)（待生成）—— 我们会：

- 实现 `launch()` 方法（docker run + pipe stdin/stdout）
- 设计 solver 目录布局（workspace / session）
- 解决"宿主 ↔ 容器"的通信通道
- 看到容器真的跑起来（虽然还没 RPC 通信）

继续课时 7 →
