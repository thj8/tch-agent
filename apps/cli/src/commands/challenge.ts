/**
 * challenge 命令组：challenge 元数据 + attempt 日志的手动操作入口。
 *
 * 直接转发给 @my/core 的 challenge store（文件存储层，详见 lesson 11）：
 *   - create / list / show        ← 元数据
 *   - append-attempt / list-attempts ← 启动日志
 *
 * 命令实现对 store 是"瘦封装"——真正的原子写/文件锁都在 core 层。
 */
import type { Command } from "commander"
import {
  ChallengeManager,
  ConfigManager,
  DEFAULT_CHALLENGE_DIR,
  appendChallengeAttemptLog,
  listChallengeAttemptLogs,
  listChallengeRecords,
  readChallengeRecord,
  saveChallengeRecord,
} from "@my/core"

/** 在 program 上挂载 challenge 命令组。 */
export function registerChallengeCommands(program: Command): void {
  const challengeCmd = program.command("challenge").description("Challenge store operations")

  challengeCmd
    .command("create")
    .description("Create a new challenge")
    .requiredOption("--id <id>", "Challenge ID")
    .requiredOption("--title <title>", "Title")
    .option("--difficulty <diff>", "Difficulty", "easy")
    .option("--flag-count <n>", "Flag count", "1")
    .option("--total-score <n>", "Total score", "100")
    .action(async (opts: {
      id: string
      title: string
      difficulty: string
      flagCount: string
      totalScore: string
    }) => {
      try {
        await saveChallengeRecord(
          DEFAULT_CHALLENGE_DIR,
          {
            id: opts.id,
            title: opts.title,
            difficulty: opts.difficulty,
            description: "",
            level: 1,
            total_score: parseInt(opts.totalScore, 10),
            total_got_score: 0,
            flag_count: parseInt(opts.flagCount, 10),
            flag_got_count: 0,
            hint_viewed: false,
            instance_status: "stopped",
            entrypoint: null,
            flags: [],
          },
          "manual",
        )
        console.log(`✓ Created challenge: ${opts.id}`)
      } catch (error) {
        console.error(`✗ ${error instanceof Error ? error.message : String(error)}`)
        process.exit(1)
      }
    })

  challengeCmd
    .command("list")
    .description("List all challenges")
    .action(async () => {
      const list = await listChallengeRecords(DEFAULT_CHALLENGE_DIR)
      if (list.length === 0) {
        console.log("(no challenges)")
        return
      }
      console.log("ID\t\tTITLE\t\t\tFLAGS")
      console.log("--\t\t-----\t\t\t------")
      for (const c of list) {
        console.log(
          `${c.id}\t\t${c.title.slice(0, 20).padEnd(20)}\t${c.flag_got_count}/${c.flag_count}`,
        )
      }
    })

  challengeCmd
    .command("sync")
    .description("Sync challenges from platform (mock store when mockEnabled) to local")
    .action(async () => {
      // 直接用 ConfigManager + ChallengeManager，不走 DaemonManager——
      // DaemonManager.getInstance() 会触发 runtime.init()（build Docker 镜像），
      // 而 sync 是纯数据操作（尤其 mock 模式要离线可跑），不该依赖 Docker。
      try {
        const config = await ConfigManager.getInstance()
        const mgr = new ChallengeManager(config)
        const { remote, local } = await mgr.listChallenges()
        console.log(
          `✓ Synced: ${remote.solved_challenges}/${remote.total_challenges} solved (level ${remote.current_level})`,
        )
        console.log(`  local records: ${local.length}`)
      } catch (error) {
        console.error(`✗ ${error instanceof Error ? error.message : String(error)}`)
        process.exit(1)
      }
    })

  challengeCmd
    .command("show <id>")
    .description("Show challenge details")
    .action(async (id: string) => {
      const c = await readChallengeRecord(DEFAULT_CHALLENGE_DIR, id)
      if (!c) {
        console.error(`✗ Challenge not found: ${id}`)
        process.exit(1)
      }
      console.log(JSON.stringify(c, null, 2))
    })

  challengeCmd
    .command("append-attempt")
    .description("Append an attempt log")
    .requiredOption("--id <challengeId>", "Challenge ID")
    .requiredOption("--solver-id <id>", "Solver ID")
    .requiredOption("--prompt <name>", "Prompt name")
    .requiredOption("--task <task>", "Task")
    .action(async (opts: { id: string; solverId: string; prompt: string; task: string }) => {
      try {
        await appendChallengeAttemptLog(DEFAULT_CHALLENGE_DIR, {
          challengeId: opts.id,
          solverId: opts.solverId,
          promptName: opts.prompt,
          task: opts.task,
        })
        console.log(`✓ Appended attempt for ${opts.id}`)
      } catch (error) {
        console.error(`✗ ${error instanceof Error ? error.message : String(error)}`)
        process.exit(1)
      }
    })

  challengeCmd
    .command("list-attempts <id>")
    .description("List attempts for a challenge")
    .action(async (id: string) => {
      const list = await listChallengeAttemptLogs(DEFAULT_CHALLENGE_DIR, id)
      if (list.length === 0) {
        console.log("(no attempts)")
        return
      }
      for (const a of list) {
        console.log(`[${a.created_at}] ${a.solver_id} (${a.prompt_name}): ${a.task.slice(0, 60)}`)
      }
    })
}
