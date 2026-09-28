/**
 * OpenCode V2 plugin. Start one shared daemon, read its address from `status`,
 * and register native tools from `/catalog`. Setup loads no model.
 * Before each tool call, restart the daemon if it exited while idle.
 * Cleanup removes this session's hooks and tools; other sessions keep the daemon.
 */

import { Plugin } from "@opencode/plugin"
import { healthy } from "../health.ts"
import { planNames } from "../naming.ts"
import { resolve as resolveRouting } from "../routing.ts"
import { askDaemon, defaultCli, pluginLog, run } from "./discover.ts"
import { registerTools } from "./tools.ts"

const log = pluginLog

/**
 * Bound catalog reads during setup. The supervisor enforces requestTimeoutSecs
 * for tool calls; native tools need no MCP startup-timeout override.
 */

const CATALOG_TIMEOUT_MS = 10_000

export interface OnesystemOptions {
  /**
   * Executable for the CLI. Defaults to Bun; see discover.runtime.
   */
  command?: string
  /** Extra args inserted before the subcommand. */
  args?: string[]
  /** Register tools without starting or restarting the daemon. Useful in CI. */
  noStart?: boolean
}

/**
 * Match registered names, including host namespaces separated by `_`, `.` or `-`.
 * Suffix matching can accept unrelated names such as `predict_status`. That costs
 * an extra health check and possibly a restart; a missed match prevents recovery.
 */
function isOurTool(id: unknown, ourNames: readonly string[]): boolean {
  // The host owns this value; malformed input must not break a global hook.
  if (typeof id !== "string") return false
  const norm = (s: string) => s.replace(/[-.]/g, "_").toLowerCase()
  const tool = norm(id)
  return ourNames.some((name) => {
    const ours = norm(name)
    return tool === ours || tool.endsWith("_" + ours)
  })
}

export { healthy } from "../health.ts"

export default Plugin.define({
  id: "onesystem",

  async setup(ctx) {
    const options = (ctx.options ?? {}) as OnesystemOptions
    const fallback = defaultCli()
    const command = options.command ?? fallback.command
    const args = options.args ?? fallback.args

    if (!options.noStart) {
      // Concurrent starts wait for the same daemon's health check.
      const code = await run(command, [...args, "start"])
      if (code !== 0) log("daemon did not start; registering servers anyway", { code })
    }

    // Read the address and registrations after startup.
    const answer = await askDaemon(command, args)
    const base = answer?.url ?? null
    if (!base) {
      log("could not determine the daemon address; registering nothing", {
        hint: "run `onesystem status` to see why",
      })
      return async () => {}
    }
    // Routing leaves single-backend names unchanged.
    const configured = answer?.registrations ?? []
    const route = resolveRouting(answer?.routing, configured)
    if (route) {
      log("routing is on", { preferred: route.preferred, others: route.others.map((o) => o.backend) })
      if (route.guidance.length > 0) {
        // Task categories are guidance only.
        pluginLog(`declared task routing:\n${route.guidance.join("\n")}`)
      }
    }

    // Native tools share the daemon without adding an MCP server per backend.
    let registration: { dispose(): Promise<void>; names: string[]; unreachable: { backend: string; error: string }[] }
    try {
      // planTools applies the shared naming rules to these candidates.
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

    // Recover on demand after idle shutdown. Concurrent calls share one restart;
    // no background timer starts an unused daemon.
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
        // Native tools make fresh HTTP requests, so no MCP session needs resetting.
        return true
      })().finally(() => {
        inflight = null
      })
      return inflight
    }

    const recovery = options.noStart
      ? null
      : await ctx.tool.hook("execute.before", async (input) => {
          // This hook runs for every tool. Catch recovery errors so unrelated tools
          // still work and the requested call can report its own connection error.
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
      // Leave the shared daemon running for other sessions.
      await recovery?.dispose().catch(() => {})
      await registration.dispose().catch(() => {})
    }
  },
})
