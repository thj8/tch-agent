import { describe, expect, test } from "bun:test"
import { buildChallengeAttackTimeline } from "./attack-timeline"
import type { IdeaRecord, MemoryEntry } from "./memory"
import type { ChallengeAttemptLogRecord, ChallengeSubmissionLogRecord } from "./store"

const CID = "test-multi"

function attempt(over: Partial<ChallengeAttemptLogRecord> = {}): ChallengeAttemptLogRecord {
  return {
    id: "att_1",
    challenge_id: CID,
    solver_id: "solver_a",
    prompt_name: "SOLVER",
    task: "solve",
    created_at: "2026-01-01T00:00:00.000Z",
    ...over,
  }
}

function submission(over: Partial<ChallengeSubmissionLogRecord> = {}): ChallengeSubmissionLogRecord {
  return {
    id: "sub_1",
    challenge_id: CID,
    solver_id: "solver_a",
    flag: "flag{x}",
    correct: true,
    created_at: "2026-01-01T00:01:00.000Z",
    ...over,
  }
}

function memory(over: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id: "mem_1",
    challengeId: CID,
    kind: "fact",
    content: "admin login at /admin",
    refs: [],
    source: "bash",
    created_at: "2026-01-01T00:02:00.000Z",
    updated_at: "2026-01-01T00:02:00.000Z",
    ...over,
  }
}

function idea(over: Partial<IdeaRecord> = {}): IdeaRecord {
  return {
    id: "idea_1",
    content: "try sql injection",
    normalized: "try sql injection",
    status: "testing",
    result: "",
    created_at: "2026-01-01T00:03:00.000Z",
    updated_at: "2026-01-01T00:03:00.000Z",
    ...over,
  }
}

describe("attack-timeline - 数据源聚合", () => {
  test("attempts → solver_started 事件", () => {
    const snap = buildChallengeAttackTimeline({
      challengeId: CID,
      attempts: [attempt()],
      submissions: [],
      memory: [],
      ideas: [],
    })
    expect(snap.events).toHaveLength(1)
    expect(snap.events[0]?.kind).toBe("solver_started")
    expect(snap.events[0]?.lane).toBe("challenge")
    expect(snap.events[0]?.solverId).toBe("solver_a")
    expect(snap.events[0]?.summary).toContain("SOLVER")
  })

  test("submissions → flag_submitted（correct ✓ / incorrect ✗）", () => {
    const snap = buildChallengeAttackTimeline({
      challengeId: CID,
      attempts: [],
      submissions: [
        submission({ id: "s1", flag: "flag{1}", correct: true }),
        submission({ id: "s2", flag: "flag{bad}", correct: false, created_at: "2026-01-01T00:01:30.000Z" }),
      ],
      memory: [],
      ideas: [],
    })
    const titles = snap.events.map((e) => e.title)
    expect(titles).toContain("✓ flag{1}")
    expect(titles).toContain("✗ flag{bad}")
    expect(snap.events.map((e) => e.summary)).toContain("incorrect")
  })

  test("memory updated_at != created_at → added + updated 两条", () => {
    const snap = buildChallengeAttackTimeline({
      challengeId: CID,
      attempts: [],
      submissions: [],
      memory: [memory({ updated_at: "2026-01-01T00:05:00.000Z" })],
      ideas: [],
    })
    expect(snap.events.map((e) => e.kind)).toEqual(["memory_added", "memory_updated"])
    expect(snap.events[0]?.timestamp).toBeLessThan(snap.events[1]!.timestamp)
  })

  test("idea updated → added + updated（summary 含 content -> result）", () => {
    const snap = buildChallengeAttackTimeline({
      challengeId: CID,
      attempts: [],
      submissions: [],
      memory: [],
      ideas: [idea({ result: "confirmed", updated_at: "2026-01-01T00:06:00.000Z" })],
    })
    expect(snap.events.map((e) => e.kind)).toEqual(["idea_added", "idea_updated"])
    expect(snap.events[1]?.summary).toContain("->")
    expect(snap.events[1]?.summary).toContain("confirmed")
  })
})

describe("attack-timeline - 排序与健壮性", () => {
  test("多源混合按 timestamp 升序", () => {
    const snap = buildChallengeAttackTimeline({
      challengeId: CID,
      // 故意打乱：submission 在前，attempt 在后
      attempts: [attempt({ created_at: "2026-01-01T00:10:00.000Z" })],
      submissions: [submission({ created_at: "2026-01-01T00:00:30.000Z" })],
      memory: [],
      ideas: [],
    })
    const ts = snap.events.map((e) => e.timestamp)
    expect(ts).toEqual([...ts].sort((a, b) => a - b))
    expect(snap.events[0]?.kind).toBe("flag_submitted")
    expect(snap.events[1]?.kind).toBe("solver_started")
  })

  test("非法 created_at 被跳过", () => {
    const snap = buildChallengeAttackTimeline({
      challengeId: CID,
      attempts: [attempt({ created_at: "not-a-date" })],
      submissions: [],
      memory: [],
      ideas: [],
    })
    expect(snap.events).toHaveLength(0)
  })

  test("快照带 challengeId + ISO updatedAt", () => {
    const snap = buildChallengeAttackTimeline({
      challengeId: CID,
      attempts: [],
      submissions: [],
      memory: [],
      ideas: [],
    })
    expect(snap.challengeId).toBe(CID)
    expect(Number.isFinite(Date.parse(snap.updatedAt))).toBe(true)
  })

  test("长 content 被 clip", () => {
    const long = "x".repeat(500)
    const snap = buildChallengeAttackTimeline({
      challengeId: CID,
      attempts: [],
      submissions: [],
      memory: [memory({ content: long })],
      ideas: [],
    })
    const summary = snap.events[0]?.summary ?? ""
    expect(summary.length).toBeLessThan(500)
    expect(summary.endsWith("…")).toBe(true)
  })
})
