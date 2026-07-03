import type Dockerode from "dockerode"
import { mkdir } from "node:fs/promises"
import { dirname } from "node:path"
import type { Subprocess } from "bun"
import type { AgentSessionEvent } from "@mariozechner/pi-coding-agent"
import { ConfigManager, TCH_AGENT_HOME_DIR } from "../config/index"
import type { ContainerConfig, SolverEventHandler, SolverInstance } from "./types"
import { solverDir, solverSessionDir, solverWorkspaceDir } from "./types"
import type { SolverInitPayload } from "../solver/rpc/rpc-types"
import {
    createBuiltinHostBridgeHandler,
    type HostBridgeHandleContext,
    type HostBridgeHandleResult,
    type HostBridgeHandler,
} from "../challenge/host-bridge-handler"
import type { HostBridgeRequestEvent } from "../challenge/host-bridge-types"
import {
    DOCKERFILE_HASH_LABEL,
    getSolverDockerfileContent,
    hashDockerfileContent,
    resolveDockerfilePath,
    resolveSolverInjection,
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
 *
 * dockerode 用 dynamic import 加载，避免 Bun.build compile 时
 * 静态拉到 ssh2 → cpu-features（原生包，本机构建失败）的传递依赖。
 * 容器内跑 solver rpc 路径根本不会触达 dockerode。
 */
export class RuntimeManager {
    private dockerPromise: Promise<Dockerode> | undefined
    private config: ContainerConfig
    private hostConfig: ConfigManager
    private eventHandlers: SolverEventHandler[] = []
    /** solverId → Subprocess 句柄 */
    private procs = new Map<string, Subprocess<"pipe", "pipe", "pipe">>()
    /** solverId → SolverInstance 元数据 */
    private solvers = new Map<string, SolverInstance>()
    private hostBridgeHandlers: HostBridgeHandler[]
    private solverEnvs = new Map<string, Record<string, string>>()

    /**
     * @param config ConfigManager（用于读 host settings）
     * @param hostBridgeHandlers 额外的 host bridge handler（自动加 builtin 在前）
     */
    constructor(config: ConfigManager, hostBridgeHandlers: HostBridgeHandler[] = []) {
        this.hostConfig = config
        this.config = {
            image: "tinyfat-agent:latest",
            binds: [],
        }

        this.hostBridgeHandlers = [
            createBuiltinHostBridgeHandler({
                getSolverEnvValue: (solverId, key) => this.solverEnvs.get(solverId)?.[key],
                hasApiKey: (provider) => this.hostConfig.hasApiKey(provider),
            }),
            ...hostBridgeHandlers,
        ]
    }

    /** 懒加载 dockerode 单例 */
    private getDocker(): Promise<Dockerode> {
        if (!this.dockerPromise) {
            this.dockerPromise = import("dockerode").then((m) => new m.default())
        }
        return this.dockerPromise
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
            await (await this.getDocker()).ping()
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
            const docker = await this.getDocker()
            await docker.getImage(imageName).inspect()
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
        const desiredHash = hashDockerfileContent(getSolverDockerfileContent())

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

    /** 从镜像 label 读 Dockerfile hash */
    private async getImageDockerfileHash(image: string): Promise<string | undefined> {
        try {
            const docker = await this.getDocker()
            const info = await docker.getImage(image).inspect()
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
        const context = dirname(dockerfilePath)
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

    /**
     * 拉起一个 Solver 容器，并完成 init 握手。
     *
     * 流程：
     *   1. 生成 solverId + 登记元数据
     *   2. 在宿主建 base / session / workspace 三个目录
     *   3. 决定 binary 注入方式（resolveSolverInjection）
     *   4. 组装 volume 挂载（binds）+ 环境变量
     *   5. 拼 docker run 命令行
     *   6. Bun.spawn 拉起容器，拿到 stdin/stdout pipe
     *   7. 挂 readStream（拿 initReady）→ 写 SolverInitPayload 到容器 stdin
     *   8. 等 init success（最多 30s 超时）
     *
     * @param promptName 用哪个 prompt
     * @param task 初始 task 文本
     * @param solverEnv 注入容器的环境变量（API key / challenge id 等）
     */
    async launch(
        promptName: string,
        task: string,
        solverEnv: Record<string, string> = {},
    ): Promise<SolverInstance> {
        // ── 步骤 1：生成 solverId + 登记元数据 ──
        // uuid 前 8 位当 id，短且好认；容器名跟着 id 走（tch-solver-<id>）。
        // 先把 solver 记进 map——哪怕后面拉容器失败，调用方也能用 list()/get() 查到这次。
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
        this.solverEnvs.set(id, solverEnv)

        // ── 步骤 2：在宿主侧建三个目录 ──
        //   base      ~/.tinyfat/solvers/<id>/          session 元数据 + binary 注入入口
        //   session   .../session/                      对话历史落盘（SDK SessionManager 写这里）
        //   workspace .../workspace/                    agent 工作目录，挂进容器当 /root/workspace
        const baseDir = solverDir(id)
        const sessionDir = solverSessionDir(id)
        const workspaceDir = solverWorkspaceDir(id)
        const containerRuntimeDir = "/runtime"
        const containerWorkspaceDir = "/root/workspace"

        await mkdir(baseDir, { recursive: true })
        await mkdir(sessionDir, { recursive: true })
        await mkdir(workspaceDir, { recursive: true })

        // ── 步骤 3：决定 binary 注入方式 ──
        // 生产环境挂编译好的 tinyfat-linux-x64；开发模式会按需重新编译。
        // 返回 { binds, cmd }：binds 是要 -v 挂的路径，cmd 是容器启动后执行的命令。
        const injection = await resolveSolverInjection()

        // ── 步骤 4：组装 volume 挂载（binds）+ 环境变量 ──
        // binds 最终长这样（宿主路径 → 容器内路径）：
        //   ~/.tinyfat                     → /root/.tinyfat        读配置 / auth / prompts
        //   solvers/<id>/                  → /runtime              session 元数据 + 注入入口
        //   solvers/<id>/workspace         → /root/workspace       agent 工作目录
        //   runtime/self/tinyfat-linux-x64 → /opt/tinyfat/tinyfat:ro    solver 二进制（只读）
        //   runtime/self/package.json      → /opt/tinyfat/package.json:ro
        const binds = [
            ...(this.config.binds ?? []),
            `${TCH_AGENT_HOME_DIR}:/root/.tinyfat`,
            `${baseDir}:${containerRuntimeDir}`,
            `${workspaceDir}:${containerWorkspaceDir}`,
            ...injection.binds,
        ]

        // 环境变量两部分拼一起：全局 config.env（所有 solver 共享）+ 本次 solverEnv（专属）。
        const envPairs: string[] = []
        for (const [k, v] of Object.entries(this.config.env ?? {})) {
            envPairs.push(`${k}=${v}`)
        }
        for (const [k, v] of Object.entries(solverEnv)) {
            envPairs.push(`${k}=${v}`)
        }

        // ── 步骤 5：拼 docker run 命令行 ──
        // -i          保持 stdin 打开（靠它跟容器做 JSONL 通信）
        // --platform  强制 linux/amd64（容器内跑的是编译好的 x64 binary）
        // --network   默认 host，agent 直接用宿主网络访问外网 / 本地服务最省事
        // -w          容器工作目录 = workspace
        // --rm        退出后自动删容器
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

        // ── 步骤 6：拉起容器，拿三个 pipe ──
        // stdin 发 RPC 命令、stdout 收事件流、stderr 看容器日志。
        const proc = Bun.spawn(args, {
            stdin: "pipe",
            stdout: "pipe",
            stderr: "pipe",
        })

        this.procs.set(id, proc)
        solver.status = "running"

        // ── 步骤 7：先挂 stdout reader，再发 init ──
        // 顺序不能反：readStream 会监听 stdout，容器回的第一行就是 init 响应。
        // 必须先挂好 reader 再写 payload，否则第一行会被错过，initReady 永远不 resolve。
        // readStream 立刻返回 initReady（此刻 pending），resolve 时机见步骤 8。
        const initReady = this.readStream(id, proc)

        // 写第一行 JSONL = SolverInitPayload。容器内的 runSolverRpc 只读 stdin 第一行
        // 作为 init 载荷，靠它建 AgentSession。
        const initPayload: SolverInitPayload = {
            solverId: id,
            promptName,
            task,
            ...(solver.challengeId ? { challengeId: solver.challengeId } : {}),
        }
        proc.stdin.write(JSON.stringify(initPayload) + "\n")

        // ── 步骤 8：等握手结果（init success / 30s 超时，二选一）──
        // 容器起来 + session 建好 → 容器回 {command:"init", success:true} → readStream 里 resolveInit。
        // 30s 还没回 → 认为容器没起来或卡住了，超时抛错给调用方。
        await Promise.race([
            initReady,
            new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error("solver init timeout (30s)")), 30_000),
            ),
        ])

        return solver
    }

    /**
     * 给指定 solver 容器发 RPC 命令。
     */
    sendCommand(solverId: string, command: unknown): void {
        const proc = this.procs.get(solverId)
        if (!proc) throw new Error(`No process for solver ${solverId}`)
        proc.stdin.write(JSON.stringify(command) + "\n")
    }

    /**
     * 处理一个 host bridge 请求：按 handler 链试，把结果推回容器。
     */
    private async handleHostBridgeRequest(
        solverId: string,
        request: HostBridgeRequestEvent,
    ): Promise<void> {
        const ctx: HostBridgeHandleContext = {
            solverId,
            action: request.action,
            params: request.params,
            getSolverEnvValue: (key) => this.solverEnvs.get(solverId)?.[key],
            hasApiKey: (provider) => this.hostConfig.hasApiKey(provider),
        }

        let result: HostBridgeHandleResult = { handled: false }
        for (const handler of this.hostBridgeHandlers) {
            try {
                result = await handler.handle(ctx)
                if (result.handled) break
            } catch (error) {
                console.error(`[host-bridge] handler error for ${request.action}:`, error)
            }
        }

        this.sendCommand(solverId, {
            type: "host_bridge_response",
            request_id: request.request_id,
            success: result.handled,
            ...(result.handled && result.data !== undefined ? { data: result.data } : {}),
            ...(!result.handled ? { error: `unhandled action: ${request.action}` } : {}),
        })
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
            const stopProc = Bun.spawn(
                ["docker", "stop", solver.containerId],
                { stdout: "ignore", stderr: "ignore" },
            )
            await stopProc.exited
        } catch {
            // 容器可能已经停了
        }

        if (proc) {
            try {
                proc.kill()
            } catch {}
        }

        this.procs.delete(solverId)
        solver.status = "stopped"
    }

    /**
     * 读容器的 stdout，做三件事：
     *   1. 等第一条 init 响应（用 external-promise 模式，让 launch() 能 await initReady）
     *   2. 拦截 host_bridge_request，转交 handleHostBridgeRequest（不计入事件流）
     *   3. 其余每行作为 AgentSessionEvent 转发给 event handler
     *
     * 返回的 initReady 在 launch() 里跟 30s 超时赛跑。
     */
    private readStream(
        solverId: string,
        proc: Subprocess<"pipe", "pipe", "pipe">,
    ): Promise<void> {
        const decoder = new TextDecoder()

        // external-promise 模式：把 resolve/reject 提取到外层作用域，下面的 stdout 读取
        // 循环收到 init 响应时就能直接调它们，launch() 才好 await 这个 Promise。
        let resolveInit!: () => void
        let rejectInit!: (err: Error) => void
        const initReady = new Promise<void>((res, rej) => {
            resolveInit = res
            rejectInit = rej
        })

        let initResolved = false

        // stdout 读取循环：stdout 是分块到达的，一个 chunk 可能只有半行、也可能好几行，
        // 所以攒在 buffer 里按 "\n" 切成一行行处理。
        ;(async () => {
            const reader = proc.stdout.getReader()
            let buffer = ""
            try {
                while (true) {
                    const { done, value } = await reader.read()
                    if (done) break
                    buffer += decoder.decode(value, { stream: true })

                    while (true) {
                        const idx = buffer.indexOf("\n")
                        if (idx === -1) break
                        const line = buffer.slice(0, idx).trim()
                        buffer = buffer.slice(idx + 1)
                        if (!line) continue

                        // 每行是一条 JSONL。解析失败只告警、跳过，不让坏行炸掉整个循环。
                        let event: unknown
                        try {
                            event = JSON.parse(line)
                        } catch {
                            console.warn(`[${solverId}] non-JSON stdout: ${line}`)
                            continue
                        }

                        // ── 职责 1：握手。第一条响应必须是 init，按 success 决定 resolve/reject。
                        //    initResolved 守卫保证只处理一次，之后这个分支就不再走了。
                        if (!initResolved) {
                            const response = event as {
                                type?: string
                                command?: string
                                success?: boolean
                                error?: string
                            }
                            if (response.type === "response" && response.command === "init") {
                                initResolved = true
                                if (response.success) {
                                    resolveInit()
                                } else {
                                    rejectInit(new Error(response.error || "init failed"))
                                }
                                continue
                            }
                        }

                        // ── 职责 2：host bridge。容器反查宿主的请求不走事件流，单独交给
                        //    handleHostBridgeRequest（结果会以 host_bridge_response 推回容器）。
                        const maybeBridgeReq = event as { type?: string }
                        if (maybeBridgeReq.type === "host_bridge_request") {
                            void this.handleHostBridgeRequest(solverId, event as HostBridgeRequestEvent)
                            continue
                        }

                        // ── 职责 3：普通 AgentSessionEvent，扇出给所有 handler（CLI 打印 / web 推送 / …）。
                        this.emit(solverId, event as AgentSessionEvent)
                    }
                }
            } catch (error) {
                // 读取过程抛错（流异常）：若 init 还没成功，把它当 init 失败报出去。
                if (!initResolved) rejectInit(error as Error)
            }

            // stdout 关闭 = 容器退出。收尾：记 exit code、更新 solver 状态、清掉 proc 句柄。
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

        // stderr 单开一个循环原样打印，方便看容器内的日志 / 报错（不影响上面的 stdout 协议）。
        if (proc.stderr) {
            const errReader = proc.stderr.getReader()
            ;(async () => {
                try {
                    while (true) {
                        const { done, value } = await errReader.read()
                        if (done) break
                        const text = decoder.decode(value, { stream: true })
                        for (const line of text.split("\n")) {
                            if (line.trim()) {
                                console.error(`[${solverId}][stderr] ${line}`)
                            }
                        }
                    }
                } catch (error) {
                    console.error(`[${solverId}] stderr read error:`, error)
                }
            })()
        }

        return initReady
    }
}
