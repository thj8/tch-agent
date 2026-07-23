import type { IdeaRecord, MemoryEntry } from "./memory"
import type { ChallengeAttemptLogRecord, ChallengeSubmissionLogRecord } from "./store"

/** 时间线事件类型 */
export type AttackTimelineEventKind =
  | "solver_started"
  | "flag_submitted"
  | "memory_added"
  | "memory_updated"
  | "idea_added"
  | "idea_updated"

/** 泳道分类（前端按泳道着色） */
export type AttackTimelineLane = "challenge" | "submission" | "board"

/** 一条时间线事件 */
export interface AttackTimelineEvent {
  id: string
  timestamp: number
  challengeId: string
  solverId?: string
  lane: AttackTimelineLane
  kind: AttackTimelineEventKind
  title: string
  summary: string
  payload?: unknown
}

/** 一道题的时间线快照 */
export interface AttackTimelineSnapshot {
  challengeId: string
  updatedAt: string
  events: AttackTimelineEvent[]
}

/** 构造输入（由 ChallengeManager 并行拉取后注入） */
export interface BuildAttackTimelineInput {
  challengeId: string
  attempts: ChallengeAttemptLogRecord[]
  submissions: ChallengeSubmissionLogRecord[]
  memory: MemoryEntry[]
  ideas: IdeaRecord[]
}

/** ISO 字符串 → 毫秒时间戳；非法 / 缺失返回 undefined。 */
function parseTimestamp(value?: string): number | undefined {
  if (!value) return undefined
  const ts = Date.parse(value)
  return Number.isFinite(ts) ? ts : undefined
}

/** 截断文本用于 summary（避免超长 board 内容撑爆时间线）。 */
function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

/**
 * 构造 challenge 的 attack timeline：把 attempts / submissions / memory / ideas
 * 四个数据源聚合成一条按时间戳升序的事件流。
 *
 * 数据源全部带 ISO 时间戳（store / memory 落盘格式），这里统一转毫秒排序。
 * memory / idea 各自可能产生 added + updated 两条事件（更新时间 != 创建时间时）。
 */
export function buildChallengeAttackTimeline(
  input: BuildAttackTimelineInput,
): AttackTimelineSnapshot {
  const events: AttackTimelineEvent[] = []

  // 1. solver 启动事件（attempts）
  for (const attempt of input.attempts) {
    const ts = parseTimestamp(attempt.created_at)
    if (ts === undefined) continue
    events.push({
      id: `attempt-${attempt.id}`,
      timestamp: ts,
      challengeId: input.challengeId,
      solverId: attempt.solver_id,
      lane: "challenge",
      kind: "solver_started",
      title: `Solver ${attempt.solver_id} started`,
      summary: `prompt=${attempt.prompt_name}`,
      payload: attempt,
    })
  }

  // 2. flag 提交事件（submissions）
  for (const sub of input.submissions) {
    const ts = parseTimestamp(sub.created_at)
    if (ts === undefined) continue
    events.push({
      id: `submission-${sub.id}`,
      timestamp: ts,
      challengeId: input.challengeId,
      solverId: sub.solver_id,
      lane: "submission",
      kind: "flag_submitted",
      title: `${sub.correct ? "✓" : "✗"} ${sub.flag}`,
      summary: sub.correct ? "correct" : "incorrect",
      payload: sub,
    })
  }

  // 3. memory 变更事件（added + 可选 updated）
  for (const m of input.memory) {
    const tsAdded = parseTimestamp(m.created_at)
    const tsUpdated = parseTimestamp(m.updated_at)
    if (tsAdded !== undefined) {
      events.push({
        id: `memory-added-${m.id}`,
        timestamp: tsAdded,
        challengeId: input.challengeId,
        lane: "board",
        kind: "memory_added",
        title: `[${m.kind}] memory added`,
        summary: clip(m.content, 100),
        payload: m,
      })
    }
    if (tsUpdated !== undefined && tsUpdated !== tsAdded) {
      events.push({
        id: `memory-updated-${m.id}`,
        timestamp: tsUpdated,
        challengeId: input.challengeId,
        lane: "board",
        kind: "memory_updated",
        title: `[${m.kind}] memory updated`,
        summary: clip(m.content, 100),
        payload: m,
      })
    }
  }

  // 4. idea 变更事件（added + 可选 updated）
  for (const idea of input.ideas) {
    const tsAdded = parseTimestamp(idea.created_at)
    const tsUpdated = parseTimestamp(idea.updated_at)
    if (tsAdded !== undefined) {
      events.push({
        id: `idea-added-${idea.id}`,
        timestamp: tsAdded,
        challengeId: input.challengeId,
        lane: "board",
        kind: "idea_added",
        title: `[${idea.status}] idea added`,
        summary: clip(idea.content, 100),
        payload: idea,
      })
    }
    if (tsUpdated !== undefined && tsUpdated !== tsAdded) {
      events.push({
        id: `idea-updated-${idea.id}`,
        timestamp: tsUpdated,
        challengeId: input.challengeId,
        lane: "board",
        kind: "idea_updated",
        title: `[${idea.status}] idea updated`,
        summary: `${clip(idea.content, 60)} -> ${clip(idea.result, 60)}`,
        payload: idea,
      })
    }
  }

  // 按时间戳升序（稳定排序：同时间戳保持插入顺序）
  events.sort((a, b) => a.timestamp - b.timestamp)

  return {
    challengeId: input.challengeId,
    updatedAt: new Date().toISOString(),
    events,
  }
}
