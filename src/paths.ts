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

/**
 * User config paths in search order. Prefer `.jsonc`; accept `.json` for compatibility.
 */
export function configPaths(): string[] {
  return [join(configDir(), "onesystem.jsonc"), join(configDir(), "onesystem.json")]
}

/** Where a bundled example lives, used when the user has no config yet. */
export function shippedConfigPath(): string {
  return new URL("../onesystem.config.jsonc", import.meta.url).pathname
}

/**
 * Search user configs, then the bundled template. An explicit path replaces this list.
 */
export function configCandidates(path?: string): string[] {
  return path ? [path] : [...configPaths(), shippedConfigPath()]
}

/**
 * Build the daemon's base URL. Plugins read this value from `onesystem status`.
 */
export function daemonUrl(host: string, port: number): string {
  const bracketed = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host
  return `http://${bracketed}:${port}`
}
