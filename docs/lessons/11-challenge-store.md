# 课时 11：Challenge 数据存储层

> 🎯 **目标**：实现 challenge 元数据 + attempts/submissions 日志的文件存储，带原子写和文件锁。
>
> ⏰ **预计耗时**：2-3 小时
>
> 📋 **难度**：⭐⭐⭐

---

## 你将学到什么

1. **文件锁的实现**（mkdir 原子性）
2. **原子写**（先写 tmp 再 rename）
3. **ndjson 格式** vs 单 JSON 数组
4. **stale lock 检测**（处理崩溃残留）

## 前置条件

✅ 已完成 [课时 1-10](./README.md)

## 最终效果

```bash
tch-agent challenge create --id test-1 --title "Test CTF" --flag-count 3
tch-agent challenge list
tch-agent challenge show test-1
tch-agent challenge append-attempt --id test-1 --solver-id abc123 --prompt SOLVER
tch-agent challenge list-attempts test-1
```

---

## 第零步：概念扫盲

### 0.1 为什么需要专门的存储层？

challenge 有多种数据：

- **元数据**：title / difficulty / flags / 进度等（info.json）
- **启动日志**：每次起 solver 都记一条（attempts）
- **提交日志**：每次提交 flag 都记一条（submissions）

如果用一个 JSON 文件存所有东西：

```json
{
  "info": {...},
  "attempts": [{...}, {...}],
  "submissions": [{...}]
}
```

问题：
- 每次 append 一条 attempt，要读全文 + 改 + 写全文（O(N) 复杂度）。
- 并发写时容易冲突。

**我们用更合理的布局**：

```
~/.tch-agent/challenge/<encodedChallengeId>/
├── challenge.json             ← 元数据（小文件，频繁读）
├── attempts/
│   └── <ts>-<id>.json         ← 每次启动一个文件
└── submissions/
    └── <ts>-<id>.json         ← 每次提交一个文件
```

读 attempts 列表时只 readdir 一次，append 时只写一个新文件（O(1)）。

### 0.2 为什么用 encodeURIComponent？

challenge ID 可能含特殊字符（如 URL）：

```typescript
// ❌ 直接当目录名
const dir = join(rootDir, challengeId)
// 如果 challengeId = "http://example.com"，会变成多层目录！

// ✅ encodeURIComponent
const dir = join(rootDir, encodeURIComponent(challengeId))
// "http%3A%2F%2Fexample.com" 单层目录
```

### 0.3 文件锁：mkdir 原子性

POSIX 文件系统有个保证：**`mkdir` 在目录已存在时会失败**，且这个检查是原子的。

```typescript
try {
    await mkdir("lock-dir")  // 成功 = 抢到锁
} catch (error) {
    if (error.code === "EEXIST") {
        // 锁被别人持有，等
    }
}
```

这比 `lockfile` / `flock` 简单且跨平台。

### 0.4 stale lock 检测

如果持锁进程崩溃，锁目录永远不删，其他进程永远等不到。

**解决方案**：锁目录里写一个 `lock-meta.json`，记录创建时间。如果锁超过 60 秒还持有，强制清理。

---

## 第一步：定义类型

### 1.1 创建 packages/core/src/challenge/store.ts

新建 `packages/core/src/challenge/store.ts`：

```typescript
import { mkdir, readdir, rename, rm } from "node:fs/promises"
import { stat } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { TCH_AGENT_HOME_DIR } from "../config/index"

/** challenge 数据根目录：~/.tch-agent/challenge/ */
export const DEFAULT_CHALLENGE_DIR = resolve(TCH_AGENT_HOME_DIR, "challenge")

/**
 * 一道题目的核心元数据。
 */
export interface ChallengeRecord {
    /** 题目 ID（来自赛题平台） */
    id: string
    title: string
    difficulty: string
    description: string
    level: number
    total_score: number
    total_got_score: number
    flag_count: number
    flag_got_count: number
    hint_viewed: boolean
    hint_content?: string | null
    /** 实例状态：pending / running / stopped */
    instance_status: string
    /** 实例访问入口，如 ["127.0.0.1:8080"] */
    entrypoint: string[] | null
    /** 正确 flag 值（mock 模式才有） */
    flags?: string[]
}

/** ChallengeRecord + 审计字段 */
export interface ChallengeInfoRecord extends ChallengeRecord {
    updated_at: string
    /** 本次更新的来源标签 */
    source: string
}

/** 一次 solver 启动日志 */
export interface ChallengeAttemptLogRecord {
    id: string
    challenge_id: string
    solver_id: string
    prompt_name: string
    task: string
    created_at: string
}

/** 一次 flag 提交日志 */
export interface ChallengeSubmissionLogRecord {
    id: string
    challenge_id: string
    solver_id?: string
    prompt_name?: string
    model_name?: string
    flag: string
    correct: boolean
    message?: string
    writeup?: string
    created_at: string
}
```

---

## 第二步：实现工具函数（原子写 + 文件锁）

继续在 `store.ts` 追加：

```typescript
// ── 工具函数 ──────────────────────────────────────────────

function nowIso(): string {
    return new Date().toISOString()
}

function requireText(value: string, fieldName: string): string {
    const text = value.trim()
    if (!text) throw new Error(`${fieldName} is required`)
    return text
}

function isDirectoryExistsError(error: unknown): boolean {
    return (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error as { code?: string }).code === "EEXIST"
    )
}

async function readJsonFile<T>(path: string): Promise<T | undefined> {
    const file = Bun.file(path)
    if (!(await file.exists())) return undefined
    try {
        return (await file.json()) as T
    } catch {
        return undefined
    }
}

/**
 * 原子写 JSON：先写 .tmp 再 rename。
 *
 * 必要性：长跑的 challenge 会被多个 solver 并发读写。
 * 如果直接 Bun.write，写一半进程崩了会留下半个文件。
 * rename 在同一文件系统内是原子的——要么旧文件、要么新文件。
 */
async function atomicWriteJson(path: string, data: unknown): Promise<void> {
    const tmpPath = `${path}.tmp-${process.pid}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`
    await mkdir(dirname(path), { recursive: true })
    await Bun.write(tmpPath, JSON.stringify(data, null, 2))
    await rename(tmpPath, path)
}

/**
 * 用"目录存在性"做互斥锁。
 *
 * 三层保护：
 *   1. 抢锁失败 → 自旋等待（25ms 间隔），最多 5 秒。
 *   2. 写 lock-meta.json（含创建时间），便于诊断谁持锁。
 *   3. 锁超过 60s 还没释放（持锁进程崩溃）→ stale，强制清理。
 */
async function withDirectoryLock<T>(
    lockDir: string,
    action: () => Promise<T>,
): Promise<T> {
    const startedAt = Date.now()
    const timeoutMs = 5000
    const staleMs = 60_000

    while (true) {
        try {
            await mkdir(lockDir)  // 原子抢锁
            break
        } catch (error) {
            if (!isDirectoryExistsError(error)) throw error

            // 锁被别人持有，检查 stale
            const lockMeta = await readJsonFile<{ created_at?: string }>(
                join(lockDir, "lock-meta.json"),
            )
            const lockCreatedAt = lockMeta?.created_at ? Date.parse(lockMeta.created_at) : Number.NaN
            const lockAge = Number.isFinite(lockCreatedAt) ? Date.now() - lockCreatedAt : Number.NaN
            if (Number.isFinite(lockAge) && lockAge > staleMs) {
                // stale，清理重试
                await rm(lockDir, { recursive: true, force: true })
                continue
            }

            if (Date.now() - startedAt > timeoutMs) {
                throw new Error(`challenge lock timeout: ${lockDir}`)
            }
            await Bun.sleep(25)
        }
    }

    // 写 lock-meta
    await Bun.write(
        join(lockDir, "lock-meta.json"),
        JSON.stringify({ created_at: nowIso(), pid: process.pid }, null, 2),
    )

    try {
        return await action()
    } finally {
        await rm(lockDir, { recursive: true, force: true })
    }
}

// ── 路径计算 ──────────────────────────────────────────────

function challengeDir(rootDir: string, challengeId: string): string {
    return join(rootDir, encodeURIComponent(challengeId))
}

function challengePath(rootDir: string, challengeId: string): string {
    return join(challengeDir(rootDir, challengeId), "challenge.json")
}

function challengeLockDir(rootDir: string, challengeId: string): string {
    return join(challengeDir(rootDir, challengeId), "locks", "challenge.lock")
}

function attemptLogsDir(rootDir: string, challengeId: string): string {
    return join(challengeDir(rootDir, challengeId), "attempts")
}

function submissionLogsDir(rootDir: string, challengeId: string): string {
    return join(challengeDir(rootDir, challengeId), "submissions")
}

function createLogId(prefix: string): string {
    return `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}`
}

async function ensureChallengeDirs(rootDir: string, challengeId: string): Promise<void> {
    const id = requireText(challengeId, "challengeId")
    const baseDir = challengeDir(rootDir, id)
    await mkdir(baseDir, { recursive: true })
    await mkdir(join(baseDir, "locks"), { recursive: true })
    await mkdir(attemptLogsDir(rootDir, id), { recursive: true })
    await mkdir(submissionLogsDir(rootDir, id), { recursive: true })
}

// ── 对外 API ─────────────────────────────────────────────

export async function ensureChallengeStoreBaseDir(rootDir: string): Promise<void> {
    await mkdir(rootDir, { recursive: true })
}

/**
 * 保存（覆盖写）一道题的元数据。
 */
export async function saveChallengeRecord(
    rootDir: string,
    challenge: ChallengeRecord,
    source = "save",
): Promise<void> {
    const challengeId = requireText(challenge.id, "challenge.id")
    await ensureChallengeDirs(rootDir, challengeId)

    await withDirectoryLock(challengeLockDir(rootDir, challengeId), async () => {
        const record: ChallengeInfoRecord = {
            ...challenge,
            updated_at: nowIso(),
            source,
        }
        await atomicWriteJson(challengePath(rootDir, challengeId), record)
    })
}

/** 读单道题 */
export async function readChallengeRecord(
    rootDir: string,
    challengeId: string,
): Promise<ChallengeInfoRecord | undefined> {
    const id = requireText(challengeId, "challengeId")
    return readJsonFile<ChallengeInfoRecord>(challengePath(rootDir, id))
}

/** 列出全部题目 */
export async function listChallengeRecords(rootDir: string): Promise<ChallengeInfoRecord[]> {
    await ensureChallengeStoreBaseDir(rootDir)
    let entries: string[] = []
    try {
        const items = await readdir(rootDir, { withFileTypes: true })
        entries = items.filter((e) => e.isDirectory()).map((e) => e.name)
    } catch {
        return []
    }

    const ids = entries.map(decodeURIComponent).sort()
    const records = await Promise.all(ids.map((id) => readChallengeRecord(rootDir, id)))
    return records.filter((r): r is ChallengeInfoRecord => Boolean(r))
}

/** 追加启动日志 */
export async function appendChallengeAttemptLog(
    rootDir: string,
    input: {
        challengeId: string
        solverId: string
        promptName: string
        task: string
    },
): Promise<ChallengeAttemptLogRecord> {
    const challengeId = requireText(input.challengeId, "challengeId")
    await ensureChallengeDirs(rootDir, challengeId)

    const record: ChallengeAttemptLogRecord = {
        id: createLogId("attempt"),
        challenge_id: challengeId,
        solver_id: requireText(input.solverId, "solverId"),
        prompt_name: requireText(input.promptName, "promptName"),
        task: requireText(input.task, "task"),
        created_at: nowIso(),
    }
    await atomicWriteJson(
        join(attemptLogsDir(rootDir, challengeId), `${Date.now()}-${record.id}.json`),
        record,
    )
    return record
}

/** 列出全部启动日志 */
export async function listChallengeAttemptLogs(
    rootDir: string,
    challengeId: string,
): Promise<ChallengeAttemptLogRecord[]> {
    const id = requireText(challengeId, "challengeId")
    const dir = attemptLogsDir(rootDir, id)
    let files: string[] = []
    try {
        files = (await readdir(dir)).filter((f) => f.endsWith(".json")).sort()
    } catch {
        return []
    }
    const items = await Promise.all(
        files.map((f) => readJsonFile<ChallengeAttemptLogRecord>(join(dir, f))),
    )
    return items.filter((i): i is ChallengeAttemptLogRecord => Boolean(i))
}

/** 追加提交日志（无论对错） */
export async function appendChallengeSubmissionLog(
    rootDir: string,
    input: {
        challengeId: string
        solverId?: string
        promptName?: string
        modelName?: string
        flag: string
        correct: boolean
        message?: string
        writeup?: string
    },
): Promise<ChallengeSubmissionLogRecord> {
    const challengeId = requireText(input.challengeId, "challengeId")
    await ensureChallengeDirs(rootDir, challengeId)

    const record: ChallengeSubmissionLogRecord = {
        id: createLogId("submission"),
        challenge_id: challengeId,
        solver_id: input.solverId,
        prompt_name: input.promptName,
        model_name: input.modelName,
        flag: requireText(input.flag, "flag"),
        correct: input.correct,
        message: input.message,
        writeup: input.writeup,
        created_at: nowIso(),
    }
    await atomicWriteJson(
        join(submissionLogsDir(rootDir, challengeId), `${Date.now()}-${record.id}.json`),
        record,
    )
    return record
}

/** 列出全部提交日志 */
export async function listChallengeSubmissionLogs(
    rootDir: string,
    challengeId: string,
): Promise<ChallengeSubmissionLogRecord[]> {
    const id = requireText(challengeId, "challengeId")
    const dir = submissionLogsDir(rootDir, id)
    let files: string[] = []
    try {
        files = (await readdir(dir)).filter((f) => f.endsWith(".json")).sort()
    } catch {
        return []
    }
    const items = await Promise.all(
        files.map((f) => readJsonFile<ChallengeSubmissionLogRecord>(join(dir, f))),
    )
    return items.filter((i): i is ChallengeSubmissionLogRecord => Boolean(i))
}

/**
 * 判断一道题是否完成：
 *   - flag_count > 0
 *   - flag_got_count >= flag_count
 */
export function computeChallengeCompleted(challenge: ChallengeInfoRecord | undefined): boolean {
    if (!challenge) return false
    return challenge.flag_count > 0 && challenge.flag_got_count >= challenge.flag_count
}
```

---

## 第三步：CLI 命令

在 `apps/cli/src/main.ts` 加 challenge 命令组：

```typescript
// ── challenge 命令组 ────────────────────────────────────

const challengeCmd = program.command("challenge").description("Challenge store operations")

challengeCmd
    .command("create")
    .description("Create a new challenge")
    .requiredOption("--id <id>", "Challenge ID")
    .requiredOption("--title <title>", "Title")
    .option("--difficulty <diff>", "Difficulty", "easy")
    .option("--flag-count <n>", "Flag count", "1")
    .option("--total-score <n>", "Total score", "100")
    .action(async (opts) => {
        const { ConfigManager, DEFAULT_CONFIG_DIR } = await import("@my/core")
        const config = await ConfigManager.getInstance()
        const { saveChallengeRecord, DEFAULT_CHALLENGE_DIR } = await import("@my/core")

        // 简化：直接用 DEFAULT_CHALLENGE_DIR
        await saveChallengeRecord(
            DEFAULT_CHALLENGE_DIR,
            {
                id: opts.id,
                title: opts.title,
                difficulty: opts.difficulty,
                description: "",
                level: 1,
                total_score: parseInt(opts.totalScore),
                total_got_score: 0,
                flag_count: parseInt(opts.flagCount),
                flag_got_count: 0,
                hint_viewed: false,
                instance_status: "stopped",
                entrypoint: null,
                flags: [],
            },
            "manual",
        )
        console.log(`✓ Created challenge: ${opts.id}`)
    })

challengeCmd
    .command("list")
    .description("List all challenges")
    .action(async () => {
        const { listChallengeRecords, DEFAULT_CHALLENGE_DIR } = await import("@my/core")
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
    .command("show <id>")
    .description("Show challenge details")
    .action(async (id: string) => {
        const { readChallengeRecord, DEFAULT_CHALLENGE_DIR } = await import("@my/core")
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
    .action(async (opts) => {
        const { appendChallengeAttemptLog, DEFAULT_CHALLENGE_DIR } = await import("@my/core")
        await appendChallengeAttemptLog(DEFAULT_CHALLENGE_DIR, {
            challengeId: opts.id,
            solverId: opts.solverId,
            promptName: opts.prompt,
            task: opts.task,
        })
        console.log(`✓ Appended attempt for ${opts.id}`)
    })

challengeCmd
    .command("list-attempts <id>")
    .description("List attempts for a challenge")
    .action(async (id: string) => {
        const { listChallengeAttemptLogs, DEFAULT_CHALLENGE_DIR } = await import("@my/core")
        const list = await listChallengeAttemptLogs(DEFAULT_CHALLENGE_DIR, id)
        if (list.length === 0) {
            console.log("(no attempts)")
            return
        }
        for (const a of list) {
            console.log(`[${a.created_at}] ${a.solver_id} (${a.prompt_name}): ${a.task.slice(0, 60)}`)
        }
    })
```

### 3.1 在 packages/core/src/index.ts 加 export

```typescript
export * from "./challenge/store"
```

---

## 第四步：验证

### 4.1 创建一道题

```bash
bun run apps/cli/src/main.ts challenge create \
  --id test-1 \
  --title "Test CTF" \
  --flag-count 3 \
  --total-score 300
```

**预期**：

```
✓ Created challenge: test-1
```

### 4.2 列出

```bash
bun run apps/cli/src/main.ts challenge list
```

**预期**：

```
ID              TITLE                   FLAGS
--              -----                   ------
test-1          Test CTF                0/3
```

### 4.3 查看

```bash
bun run apps/cli/src/main.ts challenge show test-1
```

**预期**：

```json
{
  "id": "test-1",
  "title": "Test CTF",
  ...
  "flag_count": 3,
  "flag_got_count": 0,
  "updated_at": "2025-...",
  "source": "manual"
}
```

### 4.4 追加 attempt

```bash
bun run apps/cli/src/main.ts challenge append-attempt \
  --id test-1 \
  --solver-id abc12345 \
  --prompt SOLVER \
  --task "solve test-1"
```

### 4.5 列出 attempts

```bash
bun run apps/cli/src/main.ts challenge list-attempts test-1
```

**预期**：

```
[2025-...T...] abc12345 (SOLVER): solve test-1
```

### 4.6 看文件布局

```bash
ls ~/.tch-agent/challenge/test-1/
# challenge.json  attempts/  submissions/  locks/

cat ~/.tch-agent/challenge/test-1/challenge.json
ls ~/.tch-agent/challenge/test-1/attempts/
```

### 4.7 类型检查

```bash
bun run typecheck
```

---

## 第五步：故障排查

### 问题 1：`challenge lock timeout`

**原因**：上次跑挂了，锁目录残留。

**解决**：手动清理：

```bash
rm -rf ~/.tch-agent/challenge/test-1/locks
```

或等 60s 自动 stale 清理。

### 问题 2：`EACCES` 权限错误

**原因**：用户目录权限问题。

**解决**：

```bash
sudo chown -R $(whoami) ~/.tch-agent
```

### 问题 3：JSON 解析失败

**原因**：atomicWrite 写到一半进程崩了（极罕见）。

**解决**：readJsonFile 已经 catch 了，返回 undefined。但要修复原文件：

```bash
cat ~/.tch-agent/challenge/test-1/challenge.json
# 看是不是半个 JSON
```

### 问题 4：URL 含特殊字符导致目录创建失败

**原因**：challengeId 没正确 encodeURIComponent。

**解决**：用 `encodeURIComponent(challengeId)` 包一层。

---

## 本课小结

✅ **你已完成**：

- 实现 challenge 数据存储层
- 原子写（tmp + rename）
- 文件锁（mkdir 原子性 + stale 检测）
- 完成 检测（flag_count）

📦 **新增文件**：

```
packages/core/src/challenge/store.ts   ← 完整存储层
```

🔑 **关键概念**：

- **mkdir 原子性**：跨平台文件锁的基础。
- **stale 检测**：处理持锁进程崩溃的必备机制。
- **分文件存储**：append O(1)，比单 JSON 数组更扩展。
- **encodeURIComponent**：避免 ID 含特殊字符导致路径错乱。

---

## 下一课预告

[课时 12：Challenge API 客户端 + Mock 模式](./12-challenge-api.md)（待生成）—— 我们会：

- 封装赛题平台 REST API
- 实现限流（3 RPS）和超时（2.5s）
- 实现 mock 模式（离线测试）

继续课时 12 →
