import type { IdeaRecord, MemoryEntry } from "../../../challenge/memory"

/** 把字符串裁剪到 maxChars，超出加 `...` */
function clipText(value: string, maxChars: number): string {
    const text = value.replace(/\s+/g, " ").trim()
    if (text.length <= maxChars) return text
    return `${text.slice(0, maxChars)}...`
}

/** 转义 Markdown 表格单元格 */
function escapeTableCell(value: string): string {
    return value.replaceAll("|", "\\|").replaceAll("\n", "<br>")
}

/** 用标准 Markdown 语法拼一张表 */
function formatMarkdownTable(headers: string[], rows: string[][]): string {
    const header = `| ${headers.join(" | ")} |`
    const separator = `| ${headers.map(() => "---").join(" | ")} |`
    const body = rows.map(
        (row) => `| ${row.map((cell) => escapeTableCell(cell)).join(" | ")} |`,
    )
    return [header, separator, ...body].join("\n")
}

function formatRefs(refs: string[]): string {
    return refs.length > 0 ? refs.join(", ") : "-"
}

/**
 * 把 memory 列表格式化为 Markdown 表格。
 * 让 Observer LLM 易读。
 */
export function formatMemoryTable(
    items: MemoryEntry[],
    options: { contentMaxChars?: number } = {},
): string {
    if (items.length === 0) return "No memory entries."
    const contentMaxChars = options.contentMaxChars ?? 120
    const rows = items.map((item) => [
        item.id,
        item.kind,
        clipText(item.content, contentMaxChars),
        formatRefs(item.refs),
        item.source,
        item.updated_at,
    ])
    return formatMarkdownTable(["ID", "Kind", "Content", "Refs", "Source", "Updated"], rows)
}

/** 把 ideas 列表格式化为 Markdown 表格。 */
export function formatIdeaTable(
    items: IdeaRecord[],
    options: { contentMaxChars?: number; resultMaxChars?: number } = {},
): string {
    if (items.length === 0) return "No ideas."
    const contentMaxChars = options.contentMaxChars ?? 100
    const resultMaxChars = options.resultMaxChars ?? 120
    const rows = items.map((item) => [
        item.id,
        item.status,
        clipText(item.content, contentMaxChars),
        item.result ? clipText(item.result, resultMaxChars) : "-",
        item.updated_at,
    ])
    return formatMarkdownTable(["ID", "Status", "Idea", "Result", "Updated"], rows)
}
