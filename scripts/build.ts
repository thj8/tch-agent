#!/usr/bin/env bun
/**
 * 编译 standalone binary。
 *
 * Usage:
 *   bun scripts/build.ts <target> <outfile>
 *
 * Targets（Bun 内置）：
 *   bun-linux-x64-baseline
 *   bun-linux-x64-modern
 *   bun-linux-arm64
 *   bun-darwin-arm64
 *   bun-darwin-x64
 *   bun-windows-x64-modern
 */

import { dirname } from "node:path"
import { mkdir } from "node:fs/promises"

const target = process.argv[2]
const outfile = process.argv[3]

if (!target || !outfile) {
    console.error("Usage: bun scripts/build.ts <target> <outfile>")
    process.exit(1)
}

console.log(`[build] target=${target} outfile=${outfile}`)

await mkdir(dirname(outfile) || ".", { recursive: true })

const result = await Bun.build({
    entrypoints: ["apps/cli/src/main.ts"],
    compile: {
        outfile,
        target: target as never,
    },
    // dockerode 是 host-side 依赖（动态 import），编译进 binary 会拉到
    // ssh2 → cpu-features 的原生包链（本机装不上）。容器内的 solver rpc
    // 路径根本不会触达 dockerode，所以编译时直接 external 掉。
    external: ["dockerode"],
})

if (!result.success) {
    for (const log of result.logs) {
        console.error(log.message)
    }
    process.exit(1)
}

console.log(`[build] ✓ output: ${outfile}`)
