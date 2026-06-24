#!/usr/bin/env bun
import { Command } from "commander"
import { ConfigManager, DEFAULT_CONFIG_DIR, TCH_AGENT_HOME_DIR } from "@my/core"
import { stat } from "node:fs/promises"

function formatError(error: unknown): string {
  return error instanceof Error ? error.stack || error.message : String(error)
}

process.on("unhandledRejection", (reason) => {
  console.error("[fatal] unhandledRejection", formatError(reason))
  process.exit(1)
})

process.on("uncaughtException", (error) => {
  console.error("[fatal] uncaughtException", formatError(error))
  process.exit(1)
})

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function main() {
  const program = new Command()
    .name("tch-agent")
    .description("CTF / pentest multi-agent platform")
    .version("0.0.1")

  program.command("init")
    .description("Initialize config directories and show paths")
    .action(async () => {

      console.log("Initialize tch-agent...\n")

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

  // ── config 命令组 ───────────────────────────────────────
  const configCmd = program.command("config").description("Configuration management")

  // ── config / api-keys ──────────────────────────────────
  const apiKeysCmd = configCmd.command("api-keys").description("Manage API keys")

  apiKeysCmd.command("set <provider> <key>")
    .description("Set API key for a provider")
    .action(async (provider: string, key: string) => {
      const config = await ConfigManager.getInstance()
      config.setApiKey(provider, key)
      console.log(`✓ Set API key for ${provider}`)
    })

  apiKeysCmd.command("remove <provider>")
    .description("Remove API key for a provider")
    .action(async (provider: string) => {
      const config = await ConfigManager.getInstance()
      config.removeApiKey(provider)
      console.log(`✓ Removed API key for ${provider}`)
    })

  apiKeysCmd.command("list")
    .description("List all configured API keys")
    .action(async () => {
      const config = await ConfigManager.getInstance()
      const providers = config.listApiKeys()

      if (providers.length === 0) {
        console.log("(no API keys configured)")
        return
      }

      // 简单的 ASCII 表格
      console.log("PROVIDER\tKEY PREVIEW")
      console.log("--------\t-----------")
      for (const p of providers) {
        const key = config.getApiKey(p)?.key ?? ""
        // 只显示前 4 位和后 4 位
        const preview = key.length > 8 ? `${key.slice(0, 4)}...${key.slice(-4)}` : key
        console.log(`${p}\t\t${preview}`)
      }
    })

  // ── config / providers ─────────────────────────────────

  const providersCmd = configCmd.command("providers").description("Manage provider preferences")

  providersCmd.command("add")
    .description("Add a provider preference")
    .option("-i, --id <id>", "Unique ID (auto-generated if not provided)")
    .option("-a, --api <api>", "Protocol (openai-completions / anthropic-messages /...)")
    .option("-b, --base-url <url>", "Base URL")
    .requiredOption("-n, --name <name>", "Display name")
    .action(async (opts) => {
      const config = await ConfigManager.getInstance()
      const result = await config.addProviderPref({
        id: opts.id,
        name: opts.name,
        api: opts.api,
        baseUrl: opts.baseUrl,
      })

      if (result.rejected) {
        console.error(`✗ ${result.rejected}`)
        process.exit(1)
      }

      console.log(`✓ Added provider preferences: ${result.id}`)
    })

  providersCmd.command("list")
    .description("List all provider preferences")
    .action(async () => {
      const config = await ConfigManager.getInstance()
      const list = await config.listProviderPrefs()

      if (list.length === 0) {
        console.log("(no provider preferences)")
        return
      }

      console.log("ID\t\tNAME\t\t\tAPI\t\t\tBASE_URL")
      console.log("--\t\t----\t\t\t---\t\t\t--------")
      for (const p of list) {
        console.log(`${p.id}\t\t${p.name.slice(0, 20).padEnd(20)}\t${(p.api ?? "-").slice(0, 20).padEnd(20)}\t${p.baseUrl ?? "-"}`)
      }

    })

  providersCmd.command("remove <id>")
    .description("Remove a provider preference by ID")
    .action(async (id: string) => {
      const config = await ConfigManager.getInstance()
      const removed = await config.removeProviderPref(id)
      if (!removed) {
        console.error(`✗ No provider preference with id "${id}"`)
        process.exit(1)
      }
      console.log(`✓ Removed provider preference: ${id}`)
    })

  // ── config / model-prefs ───────────────────────────────

  const modelPrefsCmd = configCmd.command("model-prefs").description("Manage model preferences")

  modelPrefsCmd
    .command("add")
    .description("Add a model preference")
    .option("-i, --id <id>", "Unique ID (auto-generated if not provided)")
    .requiredOption("-p, --provider <provider>", "Provider name")
    .requiredOption("-m, --model-id <modelId>", "Real model ID")
    .requiredOption("--provider-id <providerId>", "Provider preference ID")
    .option("-t, --thinking-level <level>", "Default thinking level (low/medium/high/xhigh)")
    .action(async (opts) => {
      const config = await ConfigManager.getInstance()
      const result = await config.addModelPref({
        id: opts.id,
        provider: opts.provider,
        providerId: opts.providerId,
        modelId: opts.modelId,
        thinkingLevel: opts.thinkingLevel,
      })
      if (result.rejected) {
        console.error(`✗ ${result.rejected}`)
        process.exit(1)
      }
      console.log(`✓ Added model preference: ${result.id}`)
    })

  modelPrefsCmd
    .command("list")
    .description("List all model preferences")
    .action(async () => {
      const config = await ConfigManager.getInstance()
      const list = await config.listModelPrefs()

      if (list.length === 0) {
        console.log("(no model preferences)")
        return
      }

      console.log("ID\t\tPROVIDER\t\tMODEL_ID\t\tTHINKING")
      console.log("--\t\t--------\t\t--------\t\t--------")
      for (const m of list) {
        console.log(
          `${m.id}\t\t${(m.provider ?? "").slice(0, 15).padEnd(15)}\t\t${(m.modelId ?? "").slice(0, 15).padEnd(15)}\t\t${m.thinkingLevel ?? "-"}`,
        )
      }
    })

  modelPrefsCmd
    .command("remove <id>")
    .description("Remove a model preference by ID")
    .action(async (id: string) => {
      const config = await ConfigManager.getInstance()
      const removed = await config.removeModelPref(id)
      if (!removed) {
        console.error(`✗ No model preference with id "${id}"`)
        process.exit(1)
      }
      console.log(`✓ Removed model preference: ${id}`)
    })

  await program.parseAsync(process.argv)
}


main()
