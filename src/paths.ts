/** Filesystem paths and daemon URLs. Keep independent of config parsing. */

import { homedir } from "node:os"
import { join } from "node:path"

export function configDir(): string {
  return process.env.ONESYSTEM_CONFIG_DIR ?? join(homedir(), ".config", "onesystem")
}

export function stateDir(): string {
  return process.env.ONESYSTEM_STATE_DIR ?? join(homedir(), ".local", "state", "onesystem")
}

export function lockPath(): string {
  return join(stateDir(), "daemon.lock")
}

/** The one config path. A missing file is an error naming it, not a fallback to something else. */
export function configPath(): string {
  return join(configDir(), "onesystem.jsonc")
}

/**
 * Build the daemon's base URL. Plugins read this value from `onesystem status`.
 */
export function daemonUrl(host: string, port: number): string {
  const bracketed = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host
  return `http://${bracketed}:${port}`
}
