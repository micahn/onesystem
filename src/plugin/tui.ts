/**
 * The opencode TUI plugin: a status line in the prompt footer.
 *
 * This is the second entrypoint of the same package. opencode resolves a plugin directory
 * into up to three independent entrypoints — `index`/`server`, `tui`, and `rpc` — and
 * they share no context object, so the TUI has its own `Context` with a UI surface and no
 * domains at all. Adding this file is why nothing was showing before: the package only
 * shipped the headless one.
 *
 * ## What it shows, and why that is the point
 *
 * opencode already reports the MCP server as active or not. That answer is nearly always
 * "active" and says nothing useful, because the daemon binds its port before any model
 * loads and then sits there cold for ten minutes. The interesting facts are one layer
 * down: is a model resident, on which device, and how long has it been idle. So the line
 * reports the backend's state, and its absence is the signal that the GPU is free.
 *
 * ## Deliberately small
 *
 * One slot, one line, no panel and no pages. The slot tree offers `session.panel`,
 * `ui.router`, `ui.tabs` and a keymap, and a detail view is a plausible next step — but a
 * footer line that says the true thing is the thing that was missing, and everything else
 * is a panel to maintain. Add a panel when there is a second thing worth showing.
 *
 * No JSX: the slot's `render` is called by the host's Solid renderer, and
 * `@opentui/solid/jsx-runtime` is a plain function. Calling `jsx("text", ...)` is the same
 * thing the `<text>` syntax compiles to, and it keeps this file a `.ts` with no transform
 * configured in tsconfig.
 */

import { Plugin } from "@opencode/plugin/tui"
import { createSignal } from "solid-js"
import { jsx } from "@opentui/solid/jsx-runtime"
import { probeHealth, type HealthReport } from "../health.ts"
import { defaultCli, pluginLog, resolveBase } from "./discover.ts"

/** How often to re-read /health. */
const POLL_MS = 4_000

/**
 * One line, for one daemon.
 *
 * Kept as a pure function of the report so it can be asserted without a terminal — the
 * formatting is the part that rots, because a state is added to the backend and nobody
 * remembers there is a switch here.
 */
export function statusLine(health: HealthReport | null): { text: string; tone: "info" | "success" | "warning" | "error" } {
  if (!health) return { text: "onesystem: down", tone: "error" }

  const backends = health.backends
  if (backends.length === 0) return { text: "onesystem: up, no backends", tone: "warning" }

  const local = backends.filter((b) => b.local)
  if (local.length === 0) return { text: "onesystem: up, no local model", tone: "info" }

  // One backend is the normal case and reads better alone; several get a count.
  const describe = (b: HealthReport["backends"][number]) =>
    b.state === "warm" ? `${b.name} warm` : `${b.name} ${b.state}`

  const parts = local.slice(0, 2).map(describe)
  const text =
    local.length === 1
      ? `onesystem: ${parts[0]}`
      : `onesystem: ${parts.join(", ")}${local.length > 2 ? ` +${local.length - 2}` : ""}`

  // Warm is the good state and worth noticing; cold is the cheap, correct default and
  // should not be coloured like a problem, or every idle session looks broken.
  const anyWarm = local.some((b) => b.state === "warm")
  const anyFailed = local.some((b) => b.state === "failed")
  return { text, tone: anyFailed ? "error" : anyWarm ? "success" : "info" }
}

export default Plugin.define({
  id: "onesystem",

  setup(ctx) {
    const [line, setLine] = createSignal<ReturnType<typeof statusLine>>({
      text: "onesystem: …",
      tone: "info",
    })

    const cli = defaultCli()
    let base: string | null = null

    const refresh = async () => {
      if (!base) {
        // Resolved once. `onesystem status` loads nothing, but it is still a process
        // spawn, and doing it on every poll would be absurd.
        base = await resolveBase(cli)
        if (!base) {
          setLine({ text: "onesystem: address unknown", tone: "error" })
          return
        }
      }
      setLine(statusLine(await probeHealth(base)))
    }

    // An immediate first read so the line is not blank for a poll interval, then a timer.
    // `unref` so a TUI plugin cannot hold the process open on its own.
    void refresh()
    const timer = setInterval(() => void refresh(), POLL_MS)
    timer.unref?.()

    const dispose = ctx.ui.slot({
      append: "prompt.footer.status",
      render: () => {
        const { text, tone } = line()
        return jsx("text", {
          fg: ctx.theme.text.feedback[tone].base,
          children: text,
        })
      },
    })

    return async () => {
      clearInterval(timer)
      dispose()
      pluginLog("status line disposed")
    }
  },
})
