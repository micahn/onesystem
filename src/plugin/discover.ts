/**
 * Shared daemon discovery for the server and TUI plugins.
 * Read the address and names from `onesystem status`, which uses the daemon config.
 */

import { spawn } from "node:child_process"
import { basename } from "node:path"
import type { DaemonStatus } from "../health.ts"
import { formatLine } from "../log.ts"

/**
 * Fields this module reads. Pick catches renamed or removed status fields at compile time.
 */
export type DaemonAnswer = Pick<DaemonStatus, "url" | "registrations"> & {
  /** Present only when the config declares one. */
  routing?: DaemonStatus["routing"]
}

export function pluginLog(msg: string, extra?: Record<string, unknown>): void {
  process.stderr.write(formatLine("plugin", "info", msg, extra))
}

/**
 * Find Bun to run TypeScript. In compiled OpenCode, process.execPath points to
 * OpenCode itself, which cannot run the CLI script.
 */
export function runtime(): string {
  const exe = basename(process.execPath).toLowerCase()
  if (exe === "bun" || exe === "bun.exe") return process.execPath
  // Use Bun from the host's PATH when the host is not Bun itself.
  return Bun.which("bun") ?? process.execPath
}

/**
 * Resolve the adjacent CLI so a checkout works without `onesystem` on PATH.
 */
export function defaultCli(): { command: string; args: string[] } {
  return { command: runtime(), args: [new URL("../cli.ts", import.meta.url).pathname] }
}

/**
 * Return the command's exit code without rejecting. Log stderr on failure.
 */
export function run(cmd: string, args: string[]): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "ignore", "pipe"] })
    let stderr = ""
    child.stderr?.on("data", (d) => {
      stderr += String(d)
      if (stderr.length > 4000) stderr = stderr.slice(-4000)
    })
    child.on("error", (err) => {
      pluginLog("failed to spawn onesystem", { cmd, error: String(err) })
      resolve(127)
    })
    child.on("close", (code) => {
      if (code) pluginLog("command failed", { cmd, args, code, stderr: stderr.trim().slice(-800) })
      resolve(code ?? 1)
    })
  })
}

/**
 * Read resolved names and address without loading a model. Return null if the CLI
 * fails or its output is invalid; callers must handle that instead of guessing.
 */
export async function askDaemon(command: string, args: string[]): Promise<DaemonAnswer | null> {
  const out = await new Promise<string>((resolve) => {
    const child = spawn(command, [...args, "status"], { stdio: ["ignore", "pipe", "pipe"] })
    let stdout = ""
    child.stdout?.on("data", (d) => (stdout += String(d)))
    child.on("error", () => resolve(""))
    child.on("close", () => resolve(stdout))
  })
  try {
    const parsed = JSON.parse(out) as Partial<DaemonStatus>
    if (typeof parsed.url !== "string" || !Array.isArray(parsed.registrations)) return null
    return { url: parsed.url, registrations: parsed.registrations, routing: parsed.routing }
  } catch {
    return null
  }
}

/**
 * Return the configured base URL, or null if unknown. The daemon config owns the port.
 */
export async function resolveBase(cli: { command: string; args: string[] }): Promise<string | null> {
  return (await askDaemon(cli.command, cli.args))?.url ?? null
}
