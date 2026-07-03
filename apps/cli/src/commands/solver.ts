/**
 * solver 命令组：run（本地直跑）/ rpc（容器内 RPC server）。
 *
 * 两个入口都直接转发给 @my/core：
 *   - run  → runSolverCli（事件流 → stdout）
 *   - rpc  → runSolverRpc（stdin JSONL 命令循环，宿主 launch 拉起的容器里跑）
 */
import type { Command } from "commander"
import { runSolverCli, runSolverRpc } from "@my/core"

/** 在 program 上挂载 solver 命令组。 */
export function registerSolverCommands(program: Command): void {
  const solverCmd = program.command("solver").description("Solver entry points")

  solverCmd
    .command("run")
    .description("Run a solver locally (non-Docker) with the given prompt and task")
    .requiredOption("-p, --prompt <name>", "Prompt name")
    .argument("<task>", "Task description")
    .action(async (task: string, opts: { prompt: string }) => {
      try {
        await runSolverCli({
          promptName: opts.prompt,
          task,
        })
      } catch (error) {
        console.error(
          "[fatal]",
          error instanceof Error ? error.message : String(error),
        )
        process.exit(1)
      }
    })

  solverCmd
    .command("rpc")
    .description("Start RPC server (reads JSONL from stdin) — runs inside container")
    .action(async () => {
      try {
        await runSolverRpc()
      } catch (error) {
        console.error("[rpc] fatal:", error)
        process.exit(1)
      }
    })
}
