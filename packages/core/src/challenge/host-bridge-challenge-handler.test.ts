import { describe, expect, test } from "bun:test"
import type { RuntimeManager } from "../runtime/runtime"
import type { SolverInstance } from "../runtime/types"
import {
  broadcastToChallengeSolvers,
  formatFlagSolvedBroadcastMessage,
} from "./host-bridge-challenge-handler"

type Sent = { solverId: string; command: unknown }

/** 伪造 RuntimeManager：只实现 list + sendCommand，记录投递。 */
function createFakeRuntime(solvers: SolverInstance[]): {
  runtime: RuntimeManager
  sent: Sent[]
} {
  const sent: Sent[] = []
  const runtime = {
    list: () => solvers,
    sendCommand: (solverId: string, command: unknown) => {
      sent.push({ solverId, command })
    },
  } as unknown as RuntimeManager
  return { runtime, sent }
}

function solver(over: Partial<SolverInstance> = {}): SolverInstance {
  return {
    id: "s1",
    containerId: "c1",
    name: "solver-1",
    promptName: "SOLVER",
    task: "solve",
    challengeId: "ctf",
    status: "running",
    createdAt: 0,
    ...over,
  }
}

describe("host-bridge-challenge-handler - formatFlagSolvedBroadcastMessage", () => {
  test("含 flag / 进度 / 剩余 / 转向收尾", () => {
    const msg = formatFlagSolvedBroadcastMessage({
      flag: "flag{1}",
      gotCount: 1,
      flagCount: 3,
      isCompleted: false,
    })
    expect(msg).toContain("flag: flag{1}")
    expect(msg).toContain("进度: 1/3")
    expect(msg).toContain("剩余 flag: 2")
    expect(msg).toContain("转向剩余 flag")
  })

  test("isCompleted → 完成收尾，无剩余行", () => {
    const msg = formatFlagSolvedBroadcastMessage({
      flag: "flag{last}",
      gotCount: 3,
      flagCount: 3,
      isCompleted: true,
    })
    expect(msg).toContain("题目已完成")
    expect(msg).not.toContain("转向剩余 flag")
  })

  test("无计数 → 进度 -，不报剩余", () => {
    const msg = formatFlagSolvedBroadcastMessage({
      flag: "flag{?}",
      isCompleted: false,
    })
    expect(msg).toContain("进度: -")
    expect(msg).not.toContain("- 剩余 flag")
  })

  test("got > total → 剩余 clamp 到 0", () => {
    const msg = formatFlagSolvedBroadcastMessage({
      flag: "f",
      gotCount: 5,
      flagCount: 3,
      isCompleted: true,
    })
    expect(msg).toContain("剩余 flag: 0")
  })
})

describe("host-bridge-challenge-handler - broadcastToChallengeSolvers", () => {
  test("只投给同题 running 且非发起者的 solver（steer）", () => {
    const { runtime, sent } = createFakeRuntime([
      solver({ id: "A", challengeId: "ctf", status: "running" }),
      solver({ id: "B", challengeId: "ctf", status: "running" }),
      solver({ id: "C", challengeId: "other", status: "running" }),
      solver({ id: "D", challengeId: "ctf", status: "stopped" }),
    ])
    broadcastToChallengeSolvers(runtime, "ctf", "A", "转向剩余 flag", "steer")

    expect(sent.map((s) => s.solverId)).toEqual(["B"])
    expect(sent[0]?.command).toEqual({ type: "steer", message: "转向剩余 flag" })
  })

  test("follow_up 投递级别", () => {
    const { runtime, sent } = createFakeRuntime([solver({ id: "A" }), solver({ id: "B" })])
    broadcastToChallengeSolvers(runtime, "ctf", "A", "补充信息", "follow_up")
    expect(sent[0]?.command).toEqual({ type: "follow_up", message: "补充信息" })
  })

  test("runtime undefined → 静默跳过", () => {
    expect(() => broadcastToChallengeSolvers(undefined, "ctf", "A", "x")).not.toThrow()
  })

  test("空消息 → 不投递", () => {
    const { runtime, sent } = createFakeRuntime([solver({ id: "B" })])
    broadcastToChallengeSolvers(runtime, "ctf", "A", "   ")
    expect(sent).toHaveLength(0)
  })

  test("某 solver sendCommand 抛错 → 不影响其他 solver 投递", () => {
    const sent: Sent[] = []
    const runtime = {
      list: () => [solver({ id: "B" }), solver({ id: "C" })],
      sendCommand: (solverId: string, command: unknown) => {
        if (solverId === "B") throw new Error("boom")
        sent.push({ solverId, command })
      },
    } as unknown as RuntimeManager
    // 抑制预期的 console.error
    const orig = console.error
    console.error = () => {}
    try {
      expect(() => broadcastToChallengeSolvers(runtime, "ctf", "A", "hi")).not.toThrow()
    } finally {
      console.error = orig
    }
    expect(sent.map((s) => s.solverId)).toEqual(["C"])
  })
})
