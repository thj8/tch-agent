/**
 * memory / idea 命令组：策略板（ideas + memory）的 CRUD 入口（lesson 16）。
 *
 * 纯数据操作，直接用 ConfigManager + new ChallengeManager(config) ——
 * 不走 DaemonManager（会触发 runtime.init() / Docker），保证离线可跑，
 * 与 challenge sync 同一套路（见 commands/challenge.ts 的 sync）。
 */
import type { Command } from "commander"
import { ChallengeManager, ConfigManager } from "@my/core"
import type { IdeaStatus, MemoryKind } from "@my/core"

/** 在 program 上挂载 memory + idea 命令组。 */
export function registerMemoryCommands(program: Command): void {
  const memoryCmd = program.command("memory").description("Challenge-level memory CRUD")
  const ideaCmd = program.command("idea").description("Challenge-level ideas CRUD")

  // ── memory ──

  memoryCmd
    .command("add <challengeId>")
    .description("Add a memory entry")
    .requiredOption("--kind <kind>", "Kind (fact/evidence/failure/note/hint)")
    .requiredOption("--content <text>", "Content")
    .requiredOption("--source <source>", "Source (solver id or 'manual')")
    .option("--ref <refs...>", "References (repeatable)")
    .action(
      async (
        challengeId: string,
        opts: { kind: string; content: string; source: string; ref?: string[] },
      ) => {
        try {
          const config = await ConfigManager.getInstance()
          const mgr = new ChallengeManager(config)
          const entry = await mgr.appendMemory({
            challengeId,
            kind: opts.kind as MemoryKind,
            content: opts.content,
            source: opts.source,
            refs: opts.ref,
          })
          console.log(`✓ Added memory: ${entry.id}`)
        } catch (error) {
          console.error(`✗ ${error instanceof Error ? error.message : String(error)}`)
          process.exit(1)
        }
      },
    )

  memoryCmd
    .command("list <challengeId>")
    .description("List memory entries")
    .action(async (challengeId: string) => {
      try {
        const config = await ConfigManager.getInstance()
        const mgr = new ChallengeManager(config)
        const list = await mgr.listMemory(challengeId)
        if (list.length === 0) {
          console.log("(no memory)")
          return
        }
        for (const m of list) {
          console.log(`[${m.kind}] ${m.id}: ${m.content.slice(0, 80)}`)
        }
      } catch (error) {
        console.error(`✗ ${error instanceof Error ? error.message : String(error)}`)
        process.exit(1)
      }
    })

  memoryCmd
    .command("update <challengeId> <entryIdOrPrefix>")
    .description("Update a memory entry (by id or unique prefix)")
    .option("--kind <kind>", "Kind (fact/evidence/failure/note/hint)")
    .option("--content <text>", "Content")
    .option("--source <source>", "Source")
    .action(
      async (
        challengeId: string,
        entryIdOrPrefix: string,
        opts: { kind?: string; content?: string; source?: string },
      ) => {
        try {
          const config = await ConfigManager.getInstance()
          const mgr = new ChallengeManager(config)
          const updated = await mgr.updateMemory(challengeId, entryIdOrPrefix, {
            kind: opts.kind as MemoryKind | undefined,
            content: opts.content,
            source: opts.source,
          })
          console.log(`✓ Updated memory: ${updated.id}`)
        } catch (error) {
          console.error(`✗ ${error instanceof Error ? error.message : String(error)}`)
          process.exit(1)
        }
      },
    )

  memoryCmd
    .command("delete <challengeId> <entryIdOrPrefix>")
    .description("Delete a memory entry (by id or unique prefix)")
    .action(async (challengeId: string, entryIdOrPrefix: string) => {
      try {
        const config = await ConfigManager.getInstance()
        const mgr = new ChallengeManager(config)
        const deleted = await mgr.deleteMemory(challengeId, entryIdOrPrefix)
        console.log(`✓ Deleted memory: ${deleted.id}`)
      } catch (error) {
        console.error(`✗ ${error instanceof Error ? error.message : String(error)}`)
        process.exit(1)
      }
    })

  // ── idea ──

  ideaCmd
    .command("add <challengeId>")
    .description("Add an idea (deduped by normalized text)")
    .requiredOption("--content <text>", "Content")
    .option("--status <status>", "Status (pending/testing/verified/failed/skipped)", "pending")
    .option("--result <text>", "Result")
    .action(
      async (challengeId: string, opts: { content: string; status: string; result?: string }) => {
        try {
          const config = await ConfigManager.getInstance()
          const mgr = new ChallengeManager(config)
          const result = await mgr.addIdea(challengeId, {
            content: opts.content,
            status: opts.status as IdeaStatus,
            result: opts.result,
          })
          console.log(
            `✓ ${result.created ? "Created" : "Already exists"}: ${result.item.id} (${result.item.status})`,
          )
        } catch (error) {
          console.error(`✗ ${error instanceof Error ? error.message : String(error)}`)
          process.exit(1)
        }
      },
    )

  ideaCmd
    .command("list <challengeId>")
    .description("List ideas")
    .action(async (challengeId: string) => {
      try {
        const config = await ConfigManager.getInstance()
        const mgr = new ChallengeManager(config)
        const list = await mgr.listIdeas(challengeId)
        if (list.length === 0) {
          console.log("(no ideas)")
          return
        }
        for (const i of list) {
          console.log(`[${i.status}] ${i.id}: ${i.content}`)
        }
      } catch (error) {
        console.error(`✗ ${error instanceof Error ? error.message : String(error)}`)
        process.exit(1)
      }
    })

  ideaCmd
    .command("search <challengeId> <query>")
    .description("Search ideas by content/result substring")
    .action(async (challengeId: string, query: string) => {
      try {
        const config = await ConfigManager.getInstance()
        const mgr = new ChallengeManager(config)
        const list = await mgr.searchIdeas(challengeId, query)
        if (list.length === 0) {
          console.log("(no matching ideas)")
          return
        }
        for (const i of list) {
          console.log(`[${i.status}] ${i.id}: ${i.content}`)
        }
      } catch (error) {
        console.error(`✗ ${error instanceof Error ? error.message : String(error)}`)
        process.exit(1)
      }
    })

  ideaCmd
    .command("update <challengeId> <ideaIdOrPrefix>")
    .description("Update an idea (by id or unique prefix)")
    .option("--content <text>", "Content")
    .option("--status <status>", "Status (pending/testing/verified/failed/skipped)")
    .option("--result <text>", "Result")
    .action(
      async (
        challengeId: string,
        ideaIdOrPrefix: string,
        opts: { content?: string; status?: string; result?: string },
      ) => {
        try {
          const config = await ConfigManager.getInstance()
          const mgr = new ChallengeManager(config)
          const updated = await mgr.updateIdea(challengeId, ideaIdOrPrefix, {
            content: opts.content,
            status: opts.status as IdeaStatus | undefined,
            result: opts.result,
          })
          console.log(`✓ Updated: ${updated.id} (status=${updated.status})`)
        } catch (error) {
          console.error(`✗ ${error instanceof Error ? error.message : String(error)}`)
          process.exit(1)
        }
      },
    )

  ideaCmd
    .command("delete <challengeId> <ideaIdOrPrefix>")
    .description("Delete an idea (by id or unique prefix)")
    .action(async (challengeId: string, ideaIdOrPrefix: string) => {
      try {
        const config = await ConfigManager.getInstance()
        const mgr = new ChallengeManager(config)
        const deleted = await mgr.deleteIdea(challengeId, ideaIdOrPrefix)
        console.log(`✓ Deleted: ${deleted.id}`)
      } catch (error) {
        console.error(`✗ ${error instanceof Error ? error.message : String(error)}`)
        process.exit(1)
      }
    })
}
