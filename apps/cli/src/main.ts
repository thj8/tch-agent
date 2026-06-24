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
    .option(
      "-m, --model <id>",
      "Custom model ID (full registration; can repeat)",
      (value: string, previous: string[] = []) => [...previous, value],
      [],
    )
    .action(async (opts) => {
      const config = await ConfigManager.getInstance()
      const result = await config.addProviderPref({
        id: opts.id,
        name: opts.name,
        api: opts.api,
        baseUrl: opts.baseUrl,
        ...(opts.model.length > 0 ? { models: opts.model } : {}),
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

      console.log("ID\t\tNAME\t\t\tAPI\t\t\tBASE_URL\t\t\tMODELS")
      console.log("--\t\t----\t\t\t---\t\t\t--------\t\t\t------")
      for (const p of list) {
        const models = (p.models ?? []).join(",") || "-"
        console.log(`${p.id}\t\t${p.name.slice(0, 20).padEnd(20)}\t${(p.api ?? "-").slice(0, 20).padEnd(20)}\t${p.baseUrl ?? "-"}\t\t${models}`)
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
    .requiredOption("-p, --provider <provider>", "Provider name (SDK key, e.g. anthropic / glm / openai)")
    .requiredOption("-m, --model-id <modelId>", "Real model ID (e.g. glm-5 / claude-sonnet-4-5)")
    .option("-t, --thinking-level <level>", "Default thinking level (low/medium/high/xhigh)")
    .action(async (opts) => {
      const config = await ConfigManager.getInstance()
      const result = await config.addModelPref({
        id: opts.id,
        provider: opts.provider,
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

  // ── config / prompts ───────────────────────────────────

  const promptsCmd = configCmd.command("prompts").description("Manage prompts")

  promptsCmd
    .command("list")
    .description("List all prompts")
    .action(async () => {
      const config = await ConfigManager.getInstance()
      const list = await config.listPrompts()

      if (list.length === 0) {
        console.log("(no prompts)")
        return
      }

      console.log("NAME\t\tDESCRIPTION")
      console.log("----\t\t-----------")
      for (const p of list) {
        const desc = (p.meta.description ?? "").slice(0, 40)
        console.log(`${p.name}\t\t${desc}`)
      }
    })

  promptsCmd
    .command("show <name>")
    .description("Show a prompt's content")
    .action(async (name: string) => {
      const config = await ConfigManager.getInstance()
      const prompt = await config.getPrompt(name)
      if (!prompt) {
        console.error(`✗ Prompt not found: ${name}`)
        process.exit(1)
      }
      console.log(`=== ${prompt.name} ===`)
      console.log(`description: ${prompt.meta.description ?? "-"}`)
      console.log(`model: ${prompt.meta.model ?? "-"}`)
      console.log(`tools: ${(prompt.meta.tools ?? []).join(", ") || "-"}`)
      console.log()
      console.log(prompt.content)
    })

  promptsCmd
    .command("remove <name>")
    .description("Remove a prompt")
    .action(async (name: string) => {
      const config = await ConfigManager.getInstance()
      const existing = await config.getPrompt(name)
      if (!existing) {
        console.error(`✗ No prompt with name "${name}"`)
        process.exit(1)
      }
      await config.removePrompt(name)
      console.log(`✓ Removed prompt: ${name}`)
    })

  promptsCmd
    .command("create <name>")
    .description("Create a new prompt interactively")
    .option("-d, --description <desc>", "Description", "")
    .option("-m, --model <modelId>", "Model preference ID")
    .action(async (name: string, opts) => {
      const config = await ConfigManager.getInstance()
      const existing = await config.getPrompt(name)
      if (existing) {
        console.error(`✗ Prompt already exists: ${name}`)
        process.exit(1)
      }

      await config.savePrompt({
        name,
        meta: {
          description: opts.description || `${name} prompt`,
          ...(opts.model ? { model: opts.model } : {}),
          tools: ["read", "bash"],
        },
        content: `You are a ${name} agent.\n\nDo your job well.`,
      })
      console.log(`✓ Created prompt: ${name}`)
      console.log(`  Edit at: ~/.tch-agent/config/prompts/${name}.md`)
    })

  // ── solver 命令 ─────────────────────────────────────────

  program
    .command("solver")
    .description("Run a solver locally (non-Docker) with the given prompt and task")
    .requiredOption("-p, --prompt <name>", "Prompt name")
    .argument("<task>", "Task description")
    .action(async (task: string, opts: { prompt: string }) => {
      const { runSolverCli } = await import("@my/core")
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

  await program.parseAsync(process.argv)
}


main()
