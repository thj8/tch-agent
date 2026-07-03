/**
 * 顶层命令：init / paths / web。
 *
 * 这些不属于任何子命令组，直接挂在 program 根上。
 * web 用动态 import 拉起 ui-web，避免 CLI 启动时强依赖 web 打包链路。
 */
import type { Command } from "commander"
import { ConfigManager, DEFAULT_CONFIG_DIR, TCH_AGENT_HOME_DIR } from "@my/core"
import { pathExists } from "../utils"

/** 在 program 根上挂载 init / paths / web。 */
export function registerMiscCommands(program: Command): void {
  program.command("init")
    .description("Initialize config directories and show paths")
    .action(async () => {

      console.log("Initialize tinyfat...\n")

      const config = await ConfigManager.getInstance()
      console.log("✓ Config directories created:")
      console.log(` TCH_AGENT_HOME: ${TCH_AGENT_HOME_DIR}`)
      console.log(` CONFIG_DIR: ${DEFAULT_CONFIG_DIR}`)
      console.log(` AUTH_FILE: ${config.dir}/auth.json`)
      console.log(` MODELS_FILE: ${config.dir}/models.json`)
      console.log(` PROMPTS_DIR: ${config.dir}/prompts`)
      console.log(` SKILLS_DIR: ${config.dir}/skills\n`)

      console.log("✓ SDK objects initialized:")
      console.log(` AuthStorage: ${config.auth.constructor.name}`)
      console.log(` ModelRegistry: ${config.models.constructor.name}`)
      console.log(` SettingsManager: ${config.settings.constructor.name}\n`)


      const checks = await Promise.all([
        pathExists(config.dir),
        pathExists(`${config.dir}/prompts`),
        pathExists(`${config.dir}/skills`),
      ])

      if (checks.every(Boolean)) {
        console.log("✓ All directories verified")
      } else {
        console.error("✗ Some directories missing! Check permissions.")
        process.exit(1)
      }
    })

  program.command("paths")
    .description("Print all configured paths without creating anything")
    .action(async () => {
      console.log(`TCH_AGENT_HOME_DIR = ${TCH_AGENT_HOME_DIR}`)
      console.log(`DEFAULT_CONFIG_DIR = ${DEFAULT_CONFIG_DIR}`)
    })

  program
    .command("web")
    .description("Start the web UI server")
    .option("-p, --port <port>", "Port", "3000")
    .option("-H, --host <host>", "Hostname", "127.0.0.1")
    .action(async (opts: { port: string; host: string }) => {
      const { startWeb } = await import("@my/ui-web")
      await startWeb({
        hostname: opts.host,
        port: parseInt(opts.port, 10),
      })

      await new Promise(() => {})
    })
}
