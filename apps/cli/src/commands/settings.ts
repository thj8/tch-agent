/**
 * settings 命令组：host-settings（runtime / challenge）的查看与修改。
 *
 * 直接转发给 ConfigManager.getHostSettings / setHostSettings（详见 lesson 12）。
 * set 用点号路径：challenge.mockEnabled / challenge.apiBaseUrl / runtime.maxSolvers …
 * 值支持 true / false / 字符串。
 */
import type { Command } from "commander"
import { ConfigManager, type HostChallengeSettings, type HostRuntimeSettings } from "@my/core"

/** 在 program 上挂载 settings 命令组。 */
export function registerSettingsCommands(program: Command): void {
  const settingsCmd = program.command("settings").description("Host settings (runtime / challenge)")

  settingsCmd
    .command("show")
    .description("Show current host settings")
    .action(async () => {
      const config = await ConfigManager.getInstance()
      const settings = await config.getHostSettings()
      console.log(JSON.stringify(settings, null, 2))
    })

  settingsCmd
    .command("set")
    .description("Set a host setting (dot path: challenge.mockEnabled / runtime.maxSolvers)")
    .argument("<path>", "Setting path (e.g., challenge.mockEnabled)")
    .argument("<value>", "Value (true / false / string)")
    .action(async (path: string, value: string) => {
      const config = await ConfigManager.getInstance()

      // 解析 value：true / false / 原样字符串
      let typedValue: unknown
      if (value === "true") typedValue = true
      else if (value === "false") typedValue = false
      else typedValue = value

      // 解析 path：只支持 challenge.xxx / runtime.xxx
      const parts = path.split(".")
      const section = parts[0]
      const key = parts[1]
      if ((section !== "challenge" && section !== "runtime") || !key) {
        console.error(`✗ Invalid path: ${path}. Use challenge.xxx or runtime.xxx`)
        process.exit(1)
      }

      const settings = await config.getHostSettings()
      if (section === "challenge") {
        const challenge: HostChallengeSettings = {
          ...settings.challenge,
          [key]: typedValue,
        }
        await config.setHostSettings({ challenge })
      } else {
        const runtime: HostRuntimeSettings = {
          ...settings.runtime,
          [key]: typedValue,
        }
        await config.setHostSettings({ runtime })
      }
      console.log(`✓ Set ${path} = ${value}`)
    })
}
