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
import { healthy } from "../health.ts"
import { resolve as resolveRouting } from "../routing.ts"
import { askDaemon, defaultCli, pluginLog, run } from "./discover.ts"
import { registerTools } from "./tools.ts"

const log = pluginLog

/**
 * MCP timeouts for the servers we register.
 *
 * opencode's default `mcp.timeout.startup` is 30s, shorter than a cold load, so without
 * these a cold backend reads as a failed MCP server. Measured on this machine: a cold
 * `laya` load is 20-54s, and the shim is silent for another 25-30s while it imports
 * transformers before it binds stdio.
 */
const DEFAULTS = {
  startupMs: 180_000,
  catalogMs: 60_000,
  // Matches LAYA_TOOL_TIMEOUT_SECS, the ceiling the shim enforces on a single call.
  executionMs: 120_000,
}

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
    // is included. This is the only source of the address in the normal path. The
    // registrations come from the same payload, so the two cannot disagree.
    const answer = await askDaemon(command, args)
    const base = answer?.url ?? null
    if (!base) {
      log("could not determine the daemon address; registering nothing", {
        hint: "run `onesystem status` to see why",
      })
      return async () => {}
    }
    // Routing, when the config asks for it. With one backend this returns null and the
    // daemon's own tool names stand, which is the point: a routing config that cannot
    // route should not change anything.
    const configured = answer?.registrations ?? []
    const route = resolveRouting(answer?.routing, configured)
    if (route) {
      log("routing is on", { preferred: route.preferred, others: route.others.map((o) => o.backend) })
      if (route.guidance.length > 0) {
        // Surfaced rather than enforced. A call cannot be dispatched by matching its text
        // for a task name without putting a classifier in front of a classifier; the agent
        // has the whole question and we do not.
        pluginLog(`declared task routing:\n${route.guidance.join("\n")}`)
      }
    }

    // Registered as native tools rather than as MCP servers. The daemon still speaks MCP
    // -- that is the interchange format for this model class, and it is what the catalog
    // is read from -- but opencode hosts the tools itself, so the sidebar shows one
    // service rather than one per model.
    let registration: { dispose(): Promise<void>; names: string[]; unreachable: { backend: string; error: string }[] }
    try {
      registration = await registerTools(ctx, base, route?.preferred)
    } catch (err) {
      log("could not register tools", { error: String(err) })
      return async () => {}
    }
    if (registration.names.length === 0) {
      log("the daemon reported no tools; registering nothing")
      return async () => {}
    }
    const serverNames = registration.names

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
        // Nothing else to do. Under the MCP registration there was a stale session id to
        // drop here, which is why this path used to reload the MCP client; a natively
        // registered tool makes a fresh request each call, so a restarted daemon is simply
        // answered on the next one.
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

    log("registered tools", { tools: serverNames, base, recovery: !options.noStart })

    return async () => {
      // Registration only. The daemon is shared and outlives any single session; see
      // the note at the top of this file.
      await recovery?.dispose().catch(() => {})
      await registration.dispose().catch(() => {})
      log("registration disposed; daemon left running")
    }
  },
})
