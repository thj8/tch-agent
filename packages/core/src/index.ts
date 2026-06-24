
export const PACKAGE_NAME = "@my/core"
export { ConfigManager, TCH_AGENT_HOME_DIR, DEFAULT_CONFIG_DIR } from "./config/index"
export type { HostSettings, HostRuntimeSettings } from "./config/types"
export type { ProviderPrefEntry, ModelConfigEntry } from "./config/providers/types"



export function add(a: number, b: number): number {
  return a + b
}
