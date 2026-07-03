/**
 * CLI 通用小工具。
 *
 * 从 main.ts 搬出来的零碎函数，被多个命令模块复用。
 * 命令自己的专属辅助（比如事件摘要）不放在这里。
 */
import { stat } from "node:fs/promises"

/**
 * 把 unknown 错误格式化成字符串（优先取 stack，方便定位）。
 * 给全局 unhandledRejection / uncaughtException 用。
 */
export function formatError(error: unknown): string {
  return error instanceof Error ? error.stack || error.message : String(error)
}

/** 路径是否存在（不抛异常，不存在 / 无权限都返回 false）。 */
export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}
