/**
 * The opencode V2 plugin.
 *
 * This is what stops every session from loading its own copy of a model. The plugin
 * does two things in `setup`:
 *
 *   1. Make sure the shared daemon is running. It calls `onesystem start`, which is
 *      race-safe, so N sessions starting at once still produce exactly one daemon.
 *   2. Register one remote MCP server per configured backend, pointing at that daemon.
 *
 * What it deliberately does *not* do is wait for a model. `onesystem start` returns as
 * soon as /health answers, and /health answers before anything is loaded. So plugin
 * setup costs a process spawn and a health probe, not a 20-54s model load and 3 GB of
 * VRAM. The first time an agent actually calls a tool, the backend starts, and that
 * cost lands on the call that wanted it.
 *
 * ## The startup timeout
 *
 * A cold `initialize` triggers the model load. opencode's default `mcp.timeout.startup`
 * is 30 seconds, which is shorter than a cold load, so without the override below a
 * cold backend reads as a failed MCP server. `startupMs` is set well above the
 * measured worst case and `executionMs` above the old shim's 120s per-call ceiling.
 *
 * ## Cleanup
 *
 * The returned cleanup only drops the MCP registration. It does not stop the daemon:
 * sessions close independently, and one closing must not pull the model out from under
 * the others. The daemon's own idle window is what ends it, and `onesystem stop` is
 * there for when you want it gone now.
 */

import { Plugin } from "@opencode/plugin"
import { spawn } from "node:child_process"

export interface OnesystemOptions {
  /**
   * Executable used to start the daemon. Defaults to the current runtime, which is
   * correct when opencode loads this plugin from a checkout.
   */
  command?: string
  /** Extra args inserted before the subcommand. */
  args?: string[]
  /** Skip starting the daemon; just register the servers. Useful in CI. */
  noStart?: boolean
  /** Override the per-server MCP timeouts, in ms. */
  startupMs?: number
  catalogMs?: number
  executionMs?: number
}

/**
 * Resolve the CLI that ships next to this plugin.
 *
 * The alternative is defaulting to `onesystem` on PATH, which is a trap: a plugin
 * loaded from a checkout has no reason to be on PATH, and when it is not, every spawn
 * fails with a bare ENOENT and the session silently ends up with no tools. Deriving it
 * from `import.meta.url` means the plugin works straight from a clone with no install
 * step and no PATH assumptions.
 */
function defaultCli(): { command: string; args: string[] } {
  return { command: process.execPath, args: [new URL("../cli.ts", import.meta.url).pathname] }
}

const DEFAULTS = {
  // Measured on this machine: a cold `laya` load is 20-54s, and the shim is silent for
  // another 25-30s while it imports transformers before it binds stdio.
  startupMs: 180_000,
  catalogMs: 60_000,
  // Matches LAYA_TOOL_TIMEOUT_SECS, the ceiling the shim enforces on a single call.
  executionMs: 120_000,
}

function log(msg: string, extra?: Record<string, unknown>) {
  process.stderr.write(`[onesystem:plugin] ${msg}${extra ? " " + JSON.stringify(extra) : ""}\n`)
}

/** Run a command and resolve with its exit code, never rejecting. */
function run(cmd: string, args: string[]): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "ignore", "pipe"] })
    let stderr = ""
    child.stderr?.on("data", (d) => {
      stderr += String(d)
      if (stderr.length > 4000) stderr = stderr.slice(-4000)
    })
    child.on("error", (err) => {
      log("failed to spawn onesystem", { cmd, error: String(err) })
      resolve(127)
    })
    child.on("close", (code) => resolve(code ?? 1))
  })
}

/**
 * Read what to register, without booting a daemon.
 *
 * `onesystem status` is the one command that answers without loading anything, and it
 * reports the resolved server names rather than a restatement of the config. The plugin
 * consumes those directly instead of re-deriving the naming rules, because a plugin that
 * computes its own names can disagree with the daemon about what the tools are called --
 * and that shows up only as a missing tool.
 *
 * A failure here is not fatal: fall back to a single `onesystem` server so a
 * misconfigured install still exposes something rather than silently exposing nothing.
 */
async function listBackends(
  command: string,
  args: string[],
): Promise<{ backend: string; serverName: string }[]> {
  const out = await new Promise<string>((resolve) => {
    const child = spawn(command, [...args, "status"], { stdio: ["ignore", "pipe", "pipe"] })
    let stdout = ""
    child.stdout?.on("data", (d) => (stdout += String(d)))
    child.on("error", () => resolve(""))
    child.on("close", () => resolve(stdout))
  })
  try {
    const parsed = JSON.parse(out) as {
      registrations?: { backend: string; serverName: string }[]
    }
    return parsed.registrations ?? []
  } catch {
    return []
  }
}

export default Plugin.define({
  id: "onesystem",

  async setup(ctx) {
    const options = (ctx.options ?? {}) as OnesystemOptions
    const fallback = defaultCli()
    const command = options.command ?? fallback.command
    const args = options.args ?? fallback.args
    const startupMs = options.startupMs ?? DEFAULTS.startupMs
    const catalogMs = options.catalogMs ?? DEFAULTS.catalogMs
    const executionMs = options.executionMs ?? DEFAULTS.executionMs

    const port = Number(process.env.ONESYSTEM_PORT ?? 7331)
    const host = process.env.ONESYSTEM_HOST ?? "127.0.0.1"
    const base = `http://${host}:${port}`

    if (!options.noStart) {
      // Race-safe: concurrent sessions all call this, exactly one daemon results, and
      // the losers wait on the winner's health check rather than starting a second.
      const code = await run(command, [...args, "start"])
      if (code !== 0) {
        log("daemon did not start; registering servers anyway", { code, base })
      }
    }

    const configured = await listBackends(command, args)
    const targets = configured.length > 0 ? configured : [{ backend: "laya", serverName: "onesystem" }]

    const registration = await ctx.mcp.transform((editor) => {
      for (const { backend, serverName } of targets) {
        editor.set(serverName, {
          type: "remote",
          url: `${base}/mcp/${backend}`,
          // Loopback-only service with no auth. OAuth is for remote servers; enabling
          // it here would just make every session stop and ask for credentials.
          oauth: false,
          timeout: { startup: startupMs, catalog: catalogMs, execution: executionMs },
        } as never)
      }
    })

    log("registered backends", { targets: targets.map((t) => t.serverName), base, startupMs })

    return async () => {
      // Registration only. The daemon is shared and outlives any single session; see
      // the note at the top of this file.
      await registration.dispose().catch(() => {})
      log("registration disposed; daemon left running")
    }
  },
})
