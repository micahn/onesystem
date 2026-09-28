/**
 * The opencode TUI plugin: a status line, and a way to fix what it says.
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
 * ## Why installing is opt-in
 *
 * A model is several gigabytes of torch, and installing one is slow enough that it needs a
 * progress dialog rather than a spinner nobody can see. More to the point: doing it
 * implicitly turns opening a terminal into a 6 GB side effect, and a cancelled or failed
 * install leaves a half-configured backend — which is the exact class of failure this
 * project exists to eliminate. So the line tells you a model is missing and `/onesystem`
 * offers to install it; nothing happens until you choose that.
 *
 * ## Deliberately small
 *
 * One slot, one line, one command. The slot tree also offers `session.panel`,
 * `ui.router`, `ui.tabs` and free keybinds, and a detail panel is a plausible next step —
 * but a footer line that says the true thing is what was missing. Add a panel when there
 * is a second thing worth showing.
 *
 * No JSX: `ui.dialog.select` and friends return promises, and the one element we do
 * render is a `jsx("text", ...)` call, which is exactly what `<text>` compiles to. That
 * keeps this file a `.ts` with no transform configured in tsconfig.
 */

import { Plugin } from "@opencode/plugin/tui"
import { createSignal } from "solid-js"
import { jsx } from "@opentui/solid/jsx-runtime"
import { probeHealth, type HealthReport } from "../health.ts"
import { findModel, MODELS } from "../models.ts"
import { defaultCli, pluginLog, resolveBase, run } from "./discover.ts"

/** How often to re-read /health. */
const POLL_MS = 4_000

type Tone = "info" | "success" | "warning" | "error"
type Line = { text: string; tone: Tone }

/**
 * One line, for one daemon.
 *
 * Kept as a pure function of the report so it can be asserted without a terminal — the
 * formatting is the part that rots, because a state is added to the backend and nobody
 * remembers there is a switch here.
 */
export function statusLine(health: HealthReport | null): Line {
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
    // Two signals from one poll. The footer wants one line; the sidebar card wants the
    // per-backend detail. A second poll interval would be a second chance for them to
    // disagree about what the daemon is doing.
    const [line, setLine] = createSignal<Line>({ text: "onesystem: …", tone: "info" })
    const [report, setReport] = createSignal<HealthReport | null>(null)

    const cli = defaultCli()
    let base: string | null = null
    let busy = false

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
      const health = await probeHealth(base)
      setReport(health)
      setLine(statusLine(health))
    }

    // The re-entrancy guard lives here and only here. It also lived at the top of
    // `refresh`, which this calls *after* setting `busy` — so every read bailed on the
    // first statement and the line stayed on its placeholder forever. A guard in both the
    // caller and the callee is a guard that is always true.
    const tick = async () => {
      if (busy) return
      busy = true
      try {
        await refresh()
      } finally {
        busy = false
      }
    }

    // An immediate first read so the line is not blank for a poll interval, then a timer.
    // `unref` so a TUI plugin cannot hold the process open on its own.
    void tick()
    const timer = setInterval(() => void tick(), POLL_MS)
    timer.unref?.()

    /**
     * The one command. A select, because "install a model" and "show me the paths" are
     * both things someone wants and neither deserves its own keybind.
     */
    const menu = async () => {
      const choice = await ctx.ui.dialog.select<"status" | `install:${string}`>({
        title: "onesystem",
        options: [
          { title: "Show status", value: "status", description: "daemon, model and device" },
          ...MODELS.map((m) => ({
            title: `Install ${m.name}`,
            value: `install:${m.name}` as const,
            description: "downloads its own torch; several GB",
          })),
        ],
      })
      if (choice === "status") {
        const health = base ? await probeHealth(base) : null
        const lines = health
          ? [
              `daemon: ${base}`,
              `backends: ${health.backends.map((b) => `${b.name} ${b.state}${b.inflight ? ` (${b.inflight} in flight)` : ""}`).join(", ") || "none"}`,
              `idle window: ${health.idleShutdownSecs}s`,
            ]
          : ["no daemon is answering"]
        await ctx.ui.dialog.alert({ title: "onesystem", message: lines.join("\n") })
        return
      }
      if (!choice?.startsWith("install:")) return

      const name = choice.slice("install:".length)
      const spec = findModel(name)
      const ok = await ctx.ui.dialog.confirm({
        title: `Install ${name}?`,
        message: `This downloads ${name} and its own PyTorch build, which is several GB. It is installed into onesystem's own directory and does not touch any existing Python environment.`,
        label: { confirm: "Install", cancel: "Cancel" },
      })
      if (!ok) return

      ctx.ui.toast.show({ message: `installing ${name} — this takes a while`, variant: "info" })
      const code = await run(cli.command, [...cli.args, "install", name])
      if (code !== 0) {
        ctx.ui.toast.show({
          title: `could not install ${name}`,
          message: `\`onesystem install ${name}\` exited ${code}. Run it in a terminal to see why.`,
          variant: "error",
        })
        return
      }
      ctx.ui.toast.show({
        title: `${name} installed`,
        message: "Add it to your config as a backend — `onesystem install` prints the snippet.",
        variant: "success",
      })
    }

    // `keymap.layer` is owned by a component, and the only component we have is the slot's
    // render. Calling it from `setup` fails with "Keymap.Provider is missing", because
    // there is no reactive owner yet. So the command is registered there, once.
    let registered = false

    /**
     * The sidebar card.
     *
     * What belongs here and what does not: the things that change on their own and that
     * you would otherwise have to open a terminal to check. So the per-model state, and
     * how long until the daemon gives the GPU back — which is the one number whose answer
     * changes without the user doing anything, and the reason the idle window exists.
     *
     * Not model accuracy, not VRAM, not a benchmark. A status card that starts making
     * claims about quality is a dashboard nobody trusts.
     */
    const card = ctx.ui.slot({
      append: "sidebar.content",
      render: () => {
        const h = report()
        if (!h) {
          return jsx("text", { fg: ctx.theme.text.feedback.error.base, children: "onesystem: not running" })
        }
        const n = h.backends.length
        const warm = h.backends.filter((b) => b.state === "warm").length
        const quietest = h.backends
          .filter((b) => b.local)
          .reduce<number | null>((min, b) => (min === null || b.idleMs < min ? b.idleMs : min), null)
        const idleLeft = quietest === null ? null : Math.max(0, h.idleShutdownSecs * 1000 - quietest)

        const rows: unknown[] = [
          jsx("text", {
            fg: ctx.theme.text.base,
            children: `onesystem  ${warm}/${n} warm`,
          }),
        ]
        for (const b of h.backends) {
          rows.push(
            jsx("text", {
              fg:
                b.state === "failed"
                  ? ctx.theme.text.feedback.error.base
                  : b.state === "warm"
                    ? ctx.theme.text.feedback.success.base
                    : ctx.theme.text.muted,
              children: `  ${b.name} ${b.state}${b.inflight > 0 ? ` (${b.inflight})` : ""}`,
            }),
          )
        }
        if (idleLeft !== null) {
          rows.push(
            jsx("text", {
              fg: ctx.theme.text.muted,
              children: idleLeft === 0 ? "  winding down" : `  idle in ${Math.round(idleLeft / 1000)}s`,
            }),
          )
        }
        return jsx("box", { flexDirection: "column", children: rows })
      },
    })

    const dispose = ctx.ui.slot({
      append: "prompt.footer.status",
      render: () => {
        // Read the signal first. Registering the keymap layer inside this render
        // establishes a reactive owner, and doing it before the read leaves the returned
        // element outside the tracking scope — the line then renders once and never
        // updates again, which looks exactly like the probe failing to reach the daemon.
        const { text, tone } = line()
        if (!registered) {
          registered = true
          ctx.keymap.layer(() => ({
            commands: [
              {
                id: "onesystem.menu",
                title: "onesystem",
                description: "model status, install and switch",
                group: "onesystem",
                slash: { name: "onesystem" },
                palette: true,
                run: () => {
                  void menu()
                },
              },
            ],
          }))
        }
        // Getters, not values. Solid's JSX compiler emits `get children()` for exactly
        // this reason: a prop passed as a plain value is read once and never again, so the
        // host has no way to know it should re-render. `jsx()` called by hand gets no
        // compiler help, so the laziness has to be written out — without it the line
        // renders once at startup and then silently never updates, which reads as "the
        // probe cannot reach the daemon" rather than as a rendering bug.
        return jsx("text", {
          get fg() {
            return ctx.theme.text.feedback[line().tone].base
          },
          get children() {
            return line().text
          },
        })
      },
    })

    return async () => {
      clearInterval(timer)
      card()
      dispose()
      pluginLog("status line disposed")
    }
  },
})
