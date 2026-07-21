#!/usr/bin/env bun
/**
 * tinyfat CLI 入口。
 *
 * 这里只做三件事：装配 program、挂载各命令组、parseAsync。
 * 命令实现拆在 commands/*.ts，事件摘要/工具函数在 event-summary.ts / utils.ts。
 * 详见 docs/lessons/21-cli-refactor.md。
 */
import { Command } from "commander"
import { formatError } from "./utils"
import { registerMiscCommands } from "./commands/misc"
import { registerConfigCommands } from "./commands/config"
import { registerSolverCommands } from "./commands/solver"
import { registerRuntimeCommands } from "./commands/runtime"
import { registerChallengeCommands } from "./commands/challenge"

// 全局兜底：未捕获的异步错误直接打 stack 退出，避免静默挂死。
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
  registerConfigCommands(program)   // config (api-keys / providers / model-prefs / prompts)
  registerSolverCommands(program)   // solver (run / rpc)
  registerRuntimeCommands(program)  // runtime (ping / build-image / has-image / launch / list)
  registerChallengeCommands(program) // challenge (create / list / show / append-attempt / list-attempts)

  await program.parseAsync(process.argv)
}

main()
