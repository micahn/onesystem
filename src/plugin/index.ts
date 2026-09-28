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
 * That claim used to be false, and the second half of this file used to say so. Setup
 * called `GET /catalog` to learn the tool surface, `/catalog` forwarded `tools/list` to
 * each backend, and forwarding starts the process — so opening a session was a
 * `Promise.all` of model loads, one per enabled backend, paid before the agent had asked
 * anything. The tool surface is declared in config now and `/catalog` reads it without
 * touching a process. `test/lazy.test.ts` pins the difference.
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
 * ## Cleanup
 *
 * The returned cleanup only drops the MCP registration. It does not stop the daemon:
 * sessions close independently, and one closing must not pull the model out from under
 * the others. The daemon's own idle window is what ends it, and `onesystem stop` is
 * there for when you want it gone now.
 */

import { Plugin } from "@opencode/plugin"
import { healthy } from "../health.ts"
import { planNames } from "../naming.ts"
import { resolve as resolveRouting } from "../routing.ts"
import { askDaemon, defaultCli, pluginLog, run } from "./discover.ts"
import { registerTools } from "./tools.ts"

const log = pluginLog

/**
 * MCP timeouts.
 *
 * There are none, and there used to be three. `startupMs`, `catalogMs` and `executionMs`
 * were overrides for registering remote MCP servers with extended timeouts, because
 * opencode's default `mcp.timeout.startup` of 30s is shorter than a cold load. Tools are
 * registered natively now, so no MCP server is registered and nothing overrides a host
 * timeout: the three were read into locals at setup and never used again, which is
 * interface left over from the MCP era and the kind that invites someone to "fix" it by
 * wiring it up.
 *
 * The request budget the dead `executionMs` used to describe now lives in one place, the
 * config's `requestTimeoutSecs`, enforced by the supervisor on the daemon side. The
 * plugin's own one live call is `GET /catalog`, which reads no process and is bounded by
 * `CATALOG_TIMEOUT_MS` below.
 */

const CATALOG_TIMEOUT_MS = 10_000

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
}

/**
 * True when a tool id is one of ours.
 *
 * The part we control is the tool name, not the namespace. `planTools` hands opencode bare
 * names — `predict`, `status` — so a hook normally sees the name verbatim and this is an
 * equality test. But opencode may namespace a plugin-registered tool the way it namespaces
 * an MCP one, and the joiner has moved between `_`, `.` and `-` across versions. The name
 * we registered is the thing that survives into a namespaced id as its tail, so match on
 * that: an id is ours if it *ends* with one of our names behind a separator.
 *
 * Which is the opposite of the rule this replaced, and the direction matters more than the
 * arithmetic. Matching a *prefix* meant that a namespaced id failed to match, and that
 * failure is silent: the recovery hook stops matching, nothing errors, and a session that
 * outlives the idle window gets "Unable to connect" against a port nothing is listening on
 * — the exact symptom the hook exists to prevent, with a daemon waiting for a human. The
 * old code's doc offered "a false positive is harmless anyway: the recovery path is a
 * health probe" as its mitigation, which covers false positives only. A false negative is
 * the failure this function exists to prevent.
 *
 * Suffix matching does not eliminate the false positive, and it is worth being precise
 * about what it is: with `predict` and `status` registered, `laya_status` has to match —
 * it is a name a two-backend session really gets from `planTools` — and that same rule
 * also accepts `predict_status`, which is not a name we ever register. The two are the
 * same string shape, so no amount of care in here separates them, and pretending otherwise
 * would be the same mistake the old doc made in the other direction. What it costs is one
 * extra `/health` probe, and on a dead daemon one spurious `onesystem start` for a tool
 * that was not ours. Cheap, bounded, and the opposite of a session-wide outage.
 */
function isOurTool(id: unknown, ourNames: readonly string[]): boolean {
  // `unknown`, not `string`, and narrowed here rather than trusted. `input.tool` is the
  // one value in this hook the host owns, and it arrives from a `tool.execute.before`
  // payload that is not ours to describe. A non-string here used to be a `TypeError` out
  // of a global hook; now it is a tool that is not ours, which is the only question this
  // function is being asked.
  if (typeof id !== "string") return false
  const norm = (s: string) => s.replace(/[-.]/g, "_").toLowerCase()
  const tool = norm(id)
  return ourNames.some((name) => {
    const ours = norm(name)
    return tool === ours || tool.endsWith("_" + ours)
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
      // The registrations and the preferred backend, handed straight through.
      //
      // The preferred used to travel as a bare string from `routing.resolve` through
      // `registerTools` into `planTools`, which re-derived the rule for which backends get
      // bare tool names -- a third implementation of a question `config.registrations` had
      // already answered for the server names, and the one that disagreed with the other
      // two about names. `planTools` asks `naming.planNames` now, which is also what makes
      // the property test in `test/naming.test.ts` writable: there is finally a single
      // answer for the other two modules to be compared against.
      const candidates = configured.map((r) => ({ backend: r.backend, serverName: r.serverName }))
      registration = await registerTools(ctx, base, candidates, route?.preferred, CATALOG_TIMEOUT_MS)
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
          // Total by construction, and that is the whole point of the try.
          //
          // `tool.execute.before` runs for *every* tool call in the session, ours or not,
          // and a throw from it does not fail that one call — it breaks the tool surface
          // for the entire session, which is a far worse failure than the one this hook
          // exists to prevent. That is not hypothetical: this exact hook shipped a
          // ReferenceError once. `belongsToServer` was renamed to `isOurTool` and the call
          // site was left naming the old binding, so the hook threw
          // `belongsToServer is not defined` on every call, and an agent with this plugin
          // loaded could not read, edit, or run a shell command — the failure took out the
          // harness doing the work, not just our tools.
          //
          // `healthy()` and `run()` are both documented never-throw, so nothing in the
          // body is *expected* to raise. This catches a bug in the body instead, and a
          // thrown hook body is indistinguishable from a dead session to whoever is
          // driving one. Degrading to "the call proceeds" costs one connection error, and
          // that error is the real diagnosis: the daemon saying nothing is listening is a
          // far better thing to hand back than a plugin erroring in a recoverer.
          try {
            if (!isOurTool(input.tool, serverNames)) return
            await ensureUp()
          } catch (err) {
            log("recovery hook failed; letting the call through to report its own error", {
              tool: String(input?.tool),
              error: String(err),
            })
          }
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
