/**
 * runtime 命令组：Docker 容器操作平面。
 *
 * ping / build-image / has-image / launch / list —— 全部包装 RuntimeManager。
 * launch 是核心：拉容器 + init 握手 + 常驻打印事件流。
 */
import type { Command } from "commander"
import { ConfigManager, RuntimeManager } from "@my/core"
import { summarizeEvent } from "../event-summary"

/** 在 program 上挂载 runtime 命令组。 */
export function registerRuntimeCommands(program: Command): void {
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
        console.error(`✗ Image ${runtime.getConfig().image} not found`)
        process.exit(1)
      }
    })

  runtimeCmd
    .command("launch")
    .description("Launch a solver container")
    .requiredOption("-p, --prompt <name>", "Prompt name")
    .argument("<task>", "Task")
    .action(async (task: string, opts: { prompt: string }) => {
      const config = await ConfigManager.getInstance()
      const runtime = new RuntimeManager(config)

      // 镜像就绪检查：本地没有就 build（带 Dockerfile hash 增量）。首次可能很慢，
      // onProgress 把 build 进度逐行打到 stdout 让用户知道在干什么。
      await runtime.init((msg) => console.log(msg))

      // 注册事件 handler：容器内 AgentSession 的事件流经这里扇出。
      // summarizeEvent 把高频事件压成一行摘要 —— 这是 CLI 用户观察 solver
      // 思考过程（assistant 消息 / 工具调用 / 结束原因）的唯一通道。
      runtime.onEvent((solverId, event) => {
        const summary = summarizeEvent(event)
        if (summary) console.log(`[${solverId}] ${summary}`)
      })

      // 拉起容器 + init 握手（launch 内部 await initReady，30s 超时）。
      // 握手成功才认为 solver 就绪；失败会从这里抛出。
      const solver = await runtime.launch(opts.prompt, task)
      console.log(`\n✓ Launched solver ${solver.id} (container: ${solver.containerId})`)
      console.log(`Press Ctrl+C to stop...\n`)

      // Ctrl+C 优雅停机：docker stop 容器 + kill proc，避免遗留容器。
      process.on("SIGINT", async () => {
        console.log("\nStopping...")
        await runtime.stopSolver(solver.id)
        process.exit(0)
      })

      // 永不 resolve：常驻进程。容器事件靠上面的 onEvent 异步打印，
      // 真正退出全靠 SIGINT 触发 stopSolver。
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
}
