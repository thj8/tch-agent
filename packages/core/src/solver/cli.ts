import type {
  AgentSessionEvent,
  AgentSessionEventListener,
  PromptOptions,
} from "@mariozechner/pi-coding-agent"
import { createSolverSession } from "./session"

export interface RunSolverOptions {
  promptName: string
  task: string
}

/**
 * Solver CLI 入口：在本地跑一个 solver。
 *
 * 1. 创建 AgentSession
 * 2. 订阅事件流（打到 stdout）
 * 3. 发起首轮 prompt
 */
export async function runSolverCli(options: RunSolverOptions): Promise<void> {
  const solverId = crypto.randomUUID().slice(0, 8)

  console.log(`[init] solverId=${solverId}`)
  console.log(`[init] prompt=${options.promptName}`)

  const { session } = await createSolverSession({
    solverId,
    promptName: options.promptName,
    task: options.task,
  })

  // 订阅事件流（包一层 try-catch 防止回调异常炸掉 session）
  const handler: AgentSessionEventListener = (event) => {
    try {
      printEvent(event)
    } catch (error) {
      console.error("[event-handler-error]", error)
    }
  }
  session.subscribe(handler)

  console.log(`[start] task: ${options.task}\n`)

  // 发起首轮 prompt
  const promptOpts: PromptOptions = { source: "interactive" }
  await session.prompt(options.task, promptOpts)

  console.log(`\n[done] session ended`)
  session.dispose()
}

/**
 * 把 AgentSessionEvent 转成可读的 console 输出。
 *
 * 重点事件：
 *   - message_end (assistant)   → 打印 LLM 回复
 *   - tool_execution_start      → 打印工具调用
 *   - tool_execution_end        → 打印工具结果（前 500 字符）
 *   - agent_end                 → 打印结束原因（取最后一条 assistant 消息的 stopReason）
 */
function printEvent(event: AgentSessionEvent): void {
  switch (event.type) {
    case "message_end": {
      if (event.message.role === "assistant") {
        const text = extractText(event.message.content)
        if (text) console.log(`[assistant] ${text}`)
      }
      break
    }
    case "tool_execution_start": {
      console.log(`[tool_call] ${event.toolName}(${summarizeArgs(event.args)})`)
      break
    }
    case "tool_execution_end": {
      const preview = summarizeResult(event.result)
      const tag = event.isError ? "[tool_result(error)]" : "[tool_result]"
      console.log(`${tag} ${preview}`)
      break
    }
    case "agent_end": {
      const reason = extractStopReason(event.messages)
      console.log(`[agent_end] stopReason=${reason}`)
      break
    }
    // 忽略 message_update（流式 token）等其他事件
  }
}

/** 从 message.content 提取所有 TextContent 的文本 */
function extractText(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .filter(
      (p): p is { type: "text"; text: string } =>
        !!p && typeof p === "object" && (p as { type?: unknown }).type === "text",
    )
    .map((p) => p.text)
    .join("")
}

/** 从 messages 数组里找最后一条 AssistantMessage 的 stopReason */
function extractStopReason(messages: unknown): string {
  if (!Array.isArray(messages)) return "unknown"
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as { role?: string; stopReason?: string }
    if (m?.role === "assistant" && typeof m.stopReason === "string") {
      return m.stopReason
    }
  }
  return "unknown"
}

/** 把工具参数摘要成一行 */
function summarizeArgs(args: unknown): string {
  try {
    const json = JSON.stringify(args)
    return (json ?? "").slice(0, 120)
  } catch {
    return String(args)
  }
}

/** 把工具结果摘要成短文本 */
function summarizeResult(result: unknown): string {
  if (typeof result === "string") return result.slice(0, 500)
  if (result && typeof result === "object" && "content" in result) {
    const content = (result as { content?: unknown }).content
    if (Array.isArray(content)) {
      const text = content
        .map((c) => {
          if (typeof c === "object" && c && (c as { type?: string }).type === "text") {
            return (c as { text?: string }).text ?? ""
          }
          return ""
        })
        .join("\n")
      return text.slice(0, 500)
    }
  }
  try {
    return JSON.stringify(result).slice(0, 500)
  } catch {
    return String(result)
  }
}
