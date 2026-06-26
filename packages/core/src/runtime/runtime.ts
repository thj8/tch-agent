import Dockerode from "dockerode"
import { dirname } from "node:path"
import { ConfigManager } from "../config/index"
import type { ContainerConfig, SolverEventHandler } from "./types"
import {
    DOCKERFILE_HASH_LABEL,
    getSolverDockerfileContent,
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
            image: "tch-agent:latest",
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

        // 同步 Dockerfile 到 ~/.tch-agent/runtime/
        const dockerfilePath = await resolveDockerfilePath(onProgress)

        // docker build
        await this.buildImage(dockerfilePath, desiredHash, onProgress)
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
}
