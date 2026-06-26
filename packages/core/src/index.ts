
export const PACKAGE_NAME = "@my/core"
export { ConfigManager, TCH_AGENT_HOME_DIR, DEFAULT_CONFIG_DIR } from "./config/index"
export type { HostSettings, HostRuntimeSettings } from "./config/types"
export type { ProviderPrefEntry, ModelConfigEntry } from "./config/providers/types"
export * from "./config/prompts/index"
export { runSolverCli } from "./solver/cli"
export type { RunSolverOptions } from "./solver/cli"
export { createSolverSession } from "./solver/session"
export type { SolverSession } from "./solver/session"
export { RuntimeManager } from "./runtime/runtime"
export type { SolverInstance, ContainerConfig, SolverEventHandler } from "./runtime/types"
export { SOLVERS_DIR, ARCHIVE_SOLVERS_DIR, solverDir, solverSessionDir, solverWorkspaceDir } from "./runtime/types"



export function add(a: number, b: number): number {
  return a + b
}
