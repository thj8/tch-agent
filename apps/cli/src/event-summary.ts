/**
 * AgentSession 事件 → 一行摘要。
 *
 * 这是 CLI 用户观察 solver 思考过程的唯一通道：SDK 的事件流（message_end /
 * tool_execution_* / agent_end …）很高频，这里压成可读的单行打到 stdout。
 * 仅供 runtime launch 的 onEvent handler 使用。
 */

/**
 * 把一个 AgentSessionEvent 压成一行摘要；不需要展示的事件返回 null。
 *
 * - message_end：所有角色都打印（user / assistant / toolResult / custom …）
 * - tool_execution_start / end：工具调用 + 结果预览
 * - agent_end：本轮结束原因（stopReason）
 */
export function summarizeEvent(event: unknown): string | null {
  if (typeof event !== "object" || event === null) return null
  const e = event as { type?: string; message?: { role?: string; content?: unknown }; toolName?: string; args?: unknown; result?: unknown; isError?: boolean; messages?: unknown }
  switch (e.type) {
    case "message_end": {
      // 所有角色的 message_end 都打印（user / assistant / toolResult / custom …），
      // 不再只留 assistant 文本。content 可能含 text / tool_use / tool_result 块。
      const role = e.message?.role ?? "unknown"
      const body = summarizeMessageContent(e.message?.content)
      return body ? `[${role}] ${body}` : `[${role}]`
    }
    case "tool_execution_start":
      return `[tool_call] ${e.toolName}(${summarizeArgs(e.args)})`
    case "tool_execution_end": {
      const preview = summarizeResult(e.result)
      return `${e.isError ? "[tool_result(error)]" : "[tool_result]"} ${preview}`
    }
    case "agent_end":
      return `[agent_end] stopReason=${extractStopReason(e.messages)}`
    default:
      return e.type ? `[${e.type}]` : null
  }
}

/**
 * 把 message.content 压成一行预览，覆盖 text / tool_use / tool_result 三种 block。
 * message_end 现在要打印所有角色，不能只取 text——assistant 的 tool_use、toolResult
 * 的结果也得能看到。
 */
function summarizeMessageContent(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  const parts: string[] = []
  for (const block of content) {
    if (!block || typeof block !== "object") continue
    const b = block as { type?: string; text?: string; name?: string; input?: unknown; content?: unknown }
    if (b.type === "text" && typeof b.text === "string") {
      parts.push(b.text)
    } else if (b.type === "tool_use") {
      parts.push(`<tool_use ${b.name}(${summarizeArgs(b.input)})>`)
    } else if (b.type === "tool_result") {
      parts.push(`<tool_result ${summarizeResult(b.content)}>`)
    }
  }
  return parts.join(" ").trim()
}

/** 从 messages 末尾往前找第一个带 stopReason 的 assistant 消息。 */
function extractStopReason(messages: unknown): string {
  if (!Array.isArray(messages)) return "unknown"
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as { role?: string; stopReason?: string }
    if (m?.role === "assistant" && typeof m.stopReason === "string") return m.stopReason
  }
  return "unknown"
}

/** 工具入参 → 截断的 JSON（最多 120 字）。 */
function summarizeArgs(args: unknown): string {
  try {
    return (JSON.stringify(args) ?? "").slice(0, 120)
  } catch {
    return String(args)
  }
}

/** 工具结果 → 文本预览（最多 500 字）：字符串 / {content:[{text}]} / 兜底 JSON。 */
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
