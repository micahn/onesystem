/**
 * Finding the daemon, from either plugin entrypoint.
 *
 * The server plugin and the TUI plugin are separate entrypoints in one package, loaded
 * independently by opencode, and both need the same two facts: where the daemon is, and
 * what it is called. They are here rather than in one of them because a private helper in
 * `index.ts` is invisible to `tui.ts` — and a second copy is how the two drift.
 *
 * The rule is that the daemon answers, not the plugin. `onesystem status` prints a
 * `DaemonStatus` carrying the address computed from the config the daemon actually
 * loaded, so asking is the only way to be right. The plugin used to assemble the address
 * itself from `ONESYSTEM_PORT ?? 7331` and `ONESYSTEM_HOST ?? "127.0.0.1"` — a port and a
 * host it had to keep in step with `config.ts` by hand, read from environment variables
 * no daemon module looks at. Setting `port` in the config and setting `ONESYSTEM_PORT`
 * produced two daemons' worth of disagreement, and the only symptom was an MCP server
 * registered against a port nothing was listening on: indistinguishable, to the user,
 * from "Unable to connect" on a daemon that had not started yet.
 */

import { spawn } from "node:child_process"
import { basename } from "node:path"
import type { DaemonStatus } from "../health.ts"
import { formatLine } from "../log.ts"

/**
 * The part of the status payload this module reads.
 *
 * Derived from `DaemonStatus` with `Pick` rather than re-spelled, which is the point of the
 * whole arrangement and was previously only aspirational. The old comment on `DaemonStatus`
 * said it existed "rather than being re-spelled as an anonymous object in the CLI and parsed
 * as a second anonymous object in the plugin", and then went on to note that `toolPrefix` was
 * "produced here and discarded there" -- which is exactly the drift it was claiming to
 * prevent, and which nothing would have caught.
 *
 * With a `Pick`, dropping or renaming a field on `DaemonStatus` is a compile error here
 * rather than a plugin that quietly reads `undefined` at session start. Adding one is not an
 * error, and that is correct: a field nobody reads yet is not a problem.
 */
export type DaemonAnswer = Pick<DaemonStatus, "url" | "registrations"> & {
  /** Present only when the config declares one. */
  routing?: DaemonStatus["routing"]
}

export function pluginLog(msg: string, extra?: Record<string, unknown>): void {
  process.stderr.write(formatLine("plugin", "info", msg, extra))
}

/**
 * Find a runtime that can actually execute a .ts file.
 *
 * `process.execPath` is only a JS runtime when the host happens to be one. OpenCode
 * ships as a compiled single-file executable, so inside a plugin `process.execPath` is
 * the opencode binary itself. Spawning it with a script path does not run the script:
 * opencode's own CLI treats the path as a stray directory argument, prints its help,
 * and exits 1. The daemon is then never started and every session sees a registered
 * MCP server pointing at a port nothing is listening on -- reported as
 * "Unable to connect", which reads like a network fault rather than a bad argv.
 */
export function runtime(): string {
  const exe = basename(process.execPath).toLowerCase()
  if (exe === "bun" || exe === "bun.exe") return process.execPath
  // OpenCode is launched from a shell that has the real runtime on PATH, and it passes
  // that environment to plugins, so this resolves even though execPath does not.
  return Bun.which("bun") ?? process.execPath
}

/**
 * Resolve the CLI that ships next to this plugin.
 *
 * The alternative is defaulting to `onesystem` on PATH, which is a trap: a plugin
 * loaded from a checkout has no reason to be on PATH, and when it is not, every spawn
 * fails with a bare ENOENT and the session silently ends up with no tools. Deriving the
 * script from `import.meta.url` means the plugin works straight from a clone with no
 * install step, and resolving the interpreter separately keeps that true when the host
 * is not itself a runtime.
 */
export function defaultCli(): { command: string; args: string[] } {
  return { command: runtime(), args: [new URL("../cli.ts", import.meta.url).pathname] }
}

/**
 * Run a command and resolve with its exit code, never rejecting.
 *
 * stderr is reported on a non-zero exit. It is the only place the real reason shows up:
 * a wrong interpreter exits 1 having printed nothing useful to an exit code, and
 * reporting just `code` turns that into an unexplained missing daemon.
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
 * Ask the CLI what to register, and where.
 *
 * `status` is the one command that answers without loading anything, and it reports the
 * resolved server names and the resolved address rather than a restatement of the
 * config. Returns null if the CLI cannot be run or prints something unparseable, which
 * the caller must handle: registering against a guessed address produces a server that
 * 404s on every call, and the user cannot tell that from a slow daemon.
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
 * The base URL to talk to, or null if the CLI cannot answer.
 *
 * Null means "cannot determine", and callers must not paper over it by guessing: a server
 * registered against a guessed port 404s on every call, which the user cannot tell from a
 * daemon that is merely slow to start.
 *
 * There is deliberately no `ONESYSTEM_PORT` override. It used to be read here and nowhere
 * else — no daemon module ever looked at it — so setting it only worked if you also set
 * the same port in the config, which is exactly what `status` reports correctly. It was a
 * second source of truth that could only ever disagree with the first.
 */
export async function resolveBase(cli: { command: string; args: string[] }): Promise<string | null> {
  return (await askDaemon(cli.command, cli.args))?.url ?? null
}
