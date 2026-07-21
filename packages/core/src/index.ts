
export const PACKAGE_NAME = "@my/core"
import { ConfigManager } from "./config/index"
import { RuntimeManager } from "./runtime/runtime"

export { ConfigManager, TCH_AGENT_HOME_DIR, DEFAULT_CONFIG_DIR } from "./config/index"
export type { HostSettings, HostRuntimeSettings } from "./config/types"
export type { ProviderPrefEntry, ModelConfigEntry } from "./config/providers/types"
export * from "./config/prompts/index"
export { runSolverCli, runSolverRpc } from "./solver/cli"
export type { RunSolverOptions } from "./solver/cli"
export { createSolverSession } from "./solver/session"
export type { SolverSession } from "./solver/session"
export * from "./challenge/store"
export type { SolverInitPayload, RpcCommand, RpcResponse } from "./solver/rpc/rpc-types"
export { RuntimeManager } from "./runtime/runtime"
export type { SolverInstance, ContainerConfig, SolverEventHandler } from "./runtime/types"
export { SOLVERS_DIR, ARCHIVE_SOLVERS_DIR, solverDir, solverSessionDir, solverWorkspaceDir } from "./runtime/types"

/**
 * DaemonManager：web 进程的"装配根"。
 *
 * 把 ConfigManager + RuntimeManager 装配在一起，让它们相互持有引用。
 *
 * 单例模式，整个 web 进程共用一份。
 */
export class DaemonManager {
    private static instance: Promise<DaemonManager> | undefined

    readonly config: ConfigManager
    readonly runtime: RuntimeManager

    private constructor(config: ConfigManager, runtime: RuntimeManager) {
        this.config = config
        this.runtime = runtime
    }

    static async getInstance(): Promise<DaemonManager> {
        if (this.instance) return this.instance

        const created = (async () => {
            const config = await ConfigManager.getInstance()
            const runtime = new RuntimeManager(config)
            await runtime.init()
            return new DaemonManager(config, runtime)
        })()

        this.instance = created.catch((error) => {
            if (this.instance === created) {
                this.instance = undefined
            }
            throw error
        })
        return this.instance
    }
}



export function add(a: number, b: number): number {
  return a + b
}
