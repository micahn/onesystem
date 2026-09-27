/**
 * The opencode V2 plugin.
 *
 * This is what stops every session from loading its own copy of a model. The plugin
 * does three things:
 *
 *   1. Make sure the shared daemon is running. It calls `onesystem start`, which is
 *      race-safe, so N sessions starting at once still produce exactly one daemon.
 *   2. Register one remote MCP server per configured backend, pointing at that daemon.
 *   3. Put the daemon back if it has since exited -- see "Coming back" below, which is
 *      the only reason a session that outlives the idle window keeps working.
 *
 * What it deliberately does *not* do is wait for a model. `onesystem start` returns as
 * soon as /health answers, and /health answers before anything is loaded. So plugin
 * setup costs a process spawn and a health probe, not a 20-54s model load and 3 GB of
 * VRAM. The first time an agent actually calls a tool, the backend starts, and that
 * cost lands on the call that wanted it.
 *
 * ## How the plugin learns what to register
 *
 * It asks. `onesystem status` prints a `DaemonStatus`, and that one payload carries both
 * the address and the registrations, computed by the same code that will serve them.
 *
 * The plugin used to assemble the address itself, from `ONESYSTEM_PORT ?? 7331` and
 * `ONESYSTEM_HOST ?? "127.0.0.1"` — a port and a host it had to keep in step with
 * `config.ts` by hand, read from environment variables no daemon module looks at. Setting
 * `port` in the config and setting `ONESYSTEM_PORT` produced two daemons' worth of
 * disagreement, and the only symptom was an MCP server registered against a port nothing
 * was listening on: indistinguishable, to the user, from "Unable to connect" on a daemon
 * that had not started yet. `ONESYSTEM_PORT` survives only as an explicit override, and
 * it is validated now instead of being `Number(...)`-ed into `http://host:NaN`.
 *
 * The startup timeout
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
import { basename } from "node:path"
import type { DaemonStatus } from "../config.ts"
import { isLoopbackHost } from "../config.ts"
import { healthy } from "../health.ts"
import { formatLine } from "../log.ts"

export interface OnesystemOptions {
  /**
   * Executable used to start the daemon. Defaults to whatever runtime can execute a
   * .ts file, which is not always the host binary; see `runtime`.
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
function runtime(): string {
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
function defaultCli(): { command: string; args: string[] } {
  return { command: runtime(), args: [new URL("../cli.ts", import.meta.url).pathname] }
}

const DEFAULTS = {
  // Measured on this machine: a cold `laya` load is 20-54s, and the shim is silent for
  // another 25-30s while it imports transformers before it binds stdio.
  startupMs: 180_000,
  catalogMs: 60_000,
  // Matches LAYA_TOOL_TIMEOUT_SECS, the ceiling the shim enforces on a single call.
  executionMs: 120_000,
}

/**
 * Same line format as the daemon's, from the daemon's own formatter.
 *
 * It used to be written out by hand to the same convention, which meant two
 * implementations of a format that exists to be greppable — and no way to assert either.
 */
function log(msg: string, extra?: Record<string, unknown>) {
  process.stderr.write(formatLine("plugin", "info", msg, extra))
}

/**
 * Run a command and resolve with its exit code, never rejecting.
 *
 * stderr is reported on a non-zero exit. It is the only place the real reason shows up:
 * a wrong interpreter exits 1 having printed nothing useful to an exit code, and
 * reporting just `code` turns that into an unexplained missing daemon.
 */
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
    child.on("close", (code) => {
      if (code) log("command failed", { cmd, args, code, stderr: stderr.trim().slice(-800) })
      resolve(code ?? 1)
    })
  })
}

/**
 * True when a tool id belongs to one of the servers this plugin registered.
 *
 * The effective id opencode hands a hook is the server name joined to the tool name, and
 * the joiner has moved between `_` and `.` across versions while server names still carry
 * `-` (`onesystem-laya`). Normalising all three to `_` and comparing the prefix is stable
 * across those spellings, and a false positive is harmless anyway: the recovery path is a
 * health probe against a loopback port.
 */
export function belongsToServer(tool: string, serverNames: readonly string[]): boolean {
  const id = tool.replace(/[-.]/g, "_").toLowerCase()
  return serverNames.some((name) => {
    const server = name.replace(/-/g, "_").toLowerCase()
    return id === server || id.startsWith(server + "_")
  })
}

/**
 * Is a daemon answering on this base URL? Loads nothing, so it is safe to call often.
 *
 * Re-exported from the daemon's own health module rather than reimplemented. The copy
 * that used to live here was byte-identical to `daemon.probe`, in the same package, and
 * nothing in the import graph said so.
 */
export { healthy } from "../health.ts"

/**
 * What the plugin needs to register servers: the address, and the names.
 *
 * One call to `onesystem status` answers both. They used to come from two places — the
 * JSON for the names, and a rebuilt URL from environment variables for the address —
 * which is why they could disagree.
 */
interface DaemonAnswer {
  url: string
  registrations: { backend: string; serverName: string }[]
}

/**
 * Ask the CLI what to register, and where.
 *
 * `status` is the one command that answers without loading anything, and it reports the
 * resolved server names and the resolved address rather than a restatement of the
 * config. The plugin consumes those directly instead of re-deriving them, because a
 * plugin that computes its own names can disagree with the daemon about what the tools
 * are called -- and that shows up only as a missing tool.
 *
 * A failure here is not fatal: fall back to a single `onesystem` server so a misconfigured
 * install still exposes something rather than silently exposing nothing. The fallback
 * address is checked against loopback for the same reason the daemon's is: a bad override
 * must not put a URL on the network.
 */
async function askDaemon(command: string, args: string[]): Promise<DaemonAnswer | null> {
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
    return { url: parsed.url, registrations: parsed.registrations }
  } catch {
    return null
  }
}

/**
 * An explicit address override, or null.
 *
 * `ONESYSTEM_PORT` is an escape hatch for a daemon on a non-default port, not the normal
 * path — the normal path is the answer from `status`. It is validated here because the
 * old code did `Number(process.env.ONESYSTEM_PORT ?? 7331)` and would happily register
 * `http://127.0.0.1:NaN`, which fails at the tool call rather than at startup.
 */
function addressOverride(): string | null {
  const port = process.env.ONESYSTEM_PORT
  const host = process.env.ONESYSTEM_HOST
  if (port === undefined && host === undefined) return null

  const parsedPort = port === undefined ? NaN : Number(port)
  if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
    log("ONESYSTEM_PORT is not a valid port; ignoring the override", { value: port })
    return null
  }
  const resolvedHost = host ?? "127.0.0.1"
  if (!isLoopbackHost(resolvedHost)) {
    log("ONESYSTEM_HOST is not a loopback address; ignoring the override", { value: host })
    return null
  }
  log("using an explicit address override instead of the daemon's own", {
    host: resolvedHost,
    port: parsedPort,
  })
  return `http://${resolvedHost}:${parsedPort}`
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

    if (!options.noStart) {
      // Race-safe: concurrent sessions all call this, exactly one daemon results, and
      // the losers wait on the winner's health check rather than starting a second.
      const code = await run(command, [...args, "start"])
      if (code !== 0) log("daemon did not start; registering servers anyway", { code })
    }

    // The daemon's own answer, asked for after `start` so a daemon that was just spawned
    // is included. This is the only source of the address in the normal path.
    const answer = await askDaemon(command, args)
    const override = addressOverride()
    const base = override ?? answer?.url
    if (!base) {
      log("could not determine the daemon address; registering nothing", {
        hint: "run `onesystem status` to see why",
      })
      return async () => {}
    }
    // Only fall back to a guessed name when we could not ask. Guessing is worse than
    // nothing — a server registered under a name the daemon does not serve 404s on every
    // call — so it is logged, and the guess is a plain literal rather than a default
    // dressed up as a discovery.
    const configured = answer?.registrations ?? []
    const targets = configured.length > 0 ? configured : [{ backend: "laya", serverName: "onesystem" }]
    if (configured.length === 0) {
      log("daemon reported no backends; falling back to a guessed target", {
        target: targets[0]!.serverName,
      })
    }
    const serverNames = targets.map((t) => t.serverName)

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

    // ## Coming back after the daemon has exited
    //
    // The daemon ends its own life after the idle window, which is the point: nothing warm
    // means the GPU should be released. But a session outlives that, and opencode holds no
    // handle on the process -- the tools stay in the session catalog, so the agent keeps
    // calling them, and every call now fails with "Unable to connect" against a port
    // nothing is listening on. Nothing retries, because from opencode's side the server is
    // registered and healthy-looking; the only thing that ever brought it back was a human
    // running `onesystem start` in a terminal.
    //
    // So recovery hangs off the one moment it matters: a tool call that is about to be
    // forwarded. A `tool.execute.before` hook that matches our own server names probes
    // /health and, if nothing answers, starts the daemon and waits for it -- the call
    // pays a second of startup instead of failing. Deliberately not a timer: a poll would
    // either keep the daemon alive forever (defeating the idle window it exists for) or sit
    // on a long interval, which is the same "fails to reopen" this fixes.
    //
    // Concurrent calls share one restart, and the health probe is per call, so N agents
    // waking at once still produce exactly one daemon -- `start` is race-safe regardless.
    let inflight: Promise<boolean> | null = null
    const ensureUp = (): Promise<boolean> => {
      if (options.noStart) return Promise.resolve(false)
      inflight ??= (async () => {
        if (await healthy(base)) return false
        log("daemon is not answering; restarting it", { base })
        const code = await run(command, [...args, "start"])
        if (code !== 0) {
          log("restart failed; this call will report a connection error", { code })
          return false
        }
        // The client is still holding the MCP session id of the daemon that exited, so
        // the call it is about to make comes back as "session expired" and only
        // reconnects afterwards. Reloading drops that stale session first.
        await ctx.mcp.reload().catch((err) => log("mcp reload failed", { error: String(err) }))
        return true
      })().finally(() => {
        inflight = null
      })
      return inflight
    }

    const recovery = options.noStart
      ? null
      : await ctx.tool.hook("execute.before", async (input) => {
          if (!belongsToServer(input.tool, serverNames)) return
          await ensureUp()
        })

    log("registered backends", { targets: serverNames, base, startupMs, recovery: !options.noStart })

    return async () => {
      // Registration only. The daemon is shared and outlives any single session; see
      // the note at the top of this file.
      await recovery?.dispose().catch(() => {})
      await registration.dispose().catch(() => {})
      log("registration disposed; daemon left running")
    }
  },
})
