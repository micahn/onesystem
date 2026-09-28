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
 * ## One report, four renderers, one answer
 *
 * There are four places that turn a health report into text: the footer line, the sidebar
 * card, the detail dialog, and the idle countdown inside the card. They were four
 * independent readings of the same report, and they did not agree — the footer counted
 * `b.local` when deciding what a model is, the card counted every backend, the dialog
 * counted anything, and the card recomputed the supervisor's idle rule from raw numbers
 * while the report already carried the signal for it. So one local warm backend beside one
 * remote cold one rendered `1/2 warm` in the card and `laya warm` in the footer: two
 * descriptions of two different machines, from a single source of truth.
 *
 * `daemonView` is where that is decided, once, and every renderer is a formatting of it.
 * `cardRows` exists separately from `renderCard` because `jsx()` needs a live Solid
 * renderer and would throw outside one, which is the reason the sidebar had no test at all
 * while three formatters that existed only to be testable did.
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
import type { BackendStatus } from "../backend/types.ts"
import { findModel, MODELS } from "../models.ts"
import { defaultCli, pluginLog, resolveBase, run } from "./discover.ts"

/** How often to re-read /health. */
const POLL_MS = 4_000

type Tone = "info" | "success" | "warning" | "error"
type Line = { text: string; tone: Tone }

/**
 * The card's per-model usage line.
 *
 * This doc used to claim it was "shared by the card and the dialog" and warned that "a
 * second copy is how they start disagreeing about what the numbers mean". `statusReport`
 * never called it: it laid out calls, answered, the question types and the in/out split
 * itself, further down. So the two copies it was warning about were the card and the
 * dialog, and the warning described a hazard the file had already walked into.
 *
 * The line is the card's, and only the card's -- it is one row in a narrow sidebar and has
 * to spend its width on the model name. The dialog is the same facts at a width that can
 * carry them, so it earns the split and the breakdown. What they share is not a formatter
 * but the fields they read and the units they format them in, which is why `formatBytes`
 * is the thing that is actually factored out and why the agreement between the two is a
 * test rather than a doc comment.
 */
export function formatUsage(b: BackendStatus): string {
  return `${b.calls} calls · ${b.answered} answered · ${formatBytes(b.inBytes + b.outBytes)}`
}

/**
 * Bytes, short.
 *
 * One letter for the unit, because this string is measured in sidebar columns and `KB`
 * spends a character to say nothing the `K` does not. The dialog shows the in/out split,
 * so the compact form never has to carry that detail itself.
 */
function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}K`
  return `${(n / 1024 / 1024).toFixed(1)}M`
}

/** " (3 choice, 1 noul)", or nothing when nothing has been answered. */
function describeTypes(byType: Record<string, number>): string {
  const parts = Object.entries(byType)
    .sort((a, b) => b[1] - a[1])
    .map(([type, n]) => `${n} ${type}`)
  return parts.length > 0 ? ` (${parts.join(", ")})` : ""
}

/**
 * The facts every renderer needs, decided once.
 *
 * There are four renderers in this file and they used to answer these questions four
 * separate ways, which is the only reason the issue that found them called it "one health
 * report, four renderers". The disagreements were not hypothetical. The footer counted
 * `b.local` when deciding what a model is, and had a test calling a remote backend
 * reported as resident "a lie"; the card counted *every* backend, so one local warm plus
 * one remote cold rendered `1/2 warm` there while the footer said `laya warm`; the dialog
 * applied no filter at all; and the card recomputed the idle sweep's rule from raw
 * per-backend numbers while the report already carried the signal.
 *
 * So the rule is stated once, here, and the renderers are formatting.
 *
 * `local` is the whole of "is a model". A `systemone-http` backend is somebody else's
 * server: it holds no VRAM, it is not wound down by the idle sweep, and counting it as a
 * model makes the card's headline and the footer's line describe different machines. A
 * remote backend is still worth showing — knowing one is configured and how it is doing
 * is real information — so it is listed, and it is listed as remote, and it is never
 * counted as a model.
 */
export interface DaemonView {
  /** Null when nothing is answering. Every other field is then its empty value. */
  health: HealthReport | null
  /** A healthy daemon was seen earlier in this session, so this is the idle window. */
  woundDown: boolean
  /** Backends that hold GPU memory. The only ones a model is. */
  models: BackendStatus[]
  /** Backends that are somebody else's server. Shown, never counted. */
  remote: BackendStatus[]
  /** How many models are warm. The `warm/n` the card headlines. */
  warm: number
  /** How many models are failed. */
  failed: number
  /** Ms until the GPU comes back, or null when nothing is holding it. */
  idleLeftMs: number | null
}

/**
 * Milliseconds until the daemon releases the GPU, or null if nothing is holding it.
 *
 * This mirrors the idle sweep in `supervisor.ts:168-188` rather than restating it, and the
 * four conditions it checks are all of them load-bearing. A backend is wound down only if
 * it is local, warm, idle for at least the window, and not in flight.
 *
 * The card used to compute the same number with a different rule: the quietest *local*
 * backend, whatever state it was in. A cold local backend has been idle since it started,
 * so it always has the largest `idleMs` and never the smallest — but a daemon with one
 * cold and one warm backend took the minimum over both, and if the cold one happened to
 * have been touched more recently the countdown read zero and the card said "winding down"
 * for a daemon that was holding a model quite happily. The `state` check is the fix, and
 * `inflight` matters for the same reason: a backend being called right now is not about to
 * be released, and counting it as nearly released is a lie told in the one place the user
 * goes to check.
 */
export function idleLeftMs(health: HealthReport, models: BackendStatus[]): number | null {
  const holding = models.filter((b) => b.state === "warm" && b.inflight === 0)
  if (holding.length === 0) return null
  const quietest = Math.min(...holding.map((b) => b.idleMs))
  return Math.max(0, health.idleShutdownSecs * 1000 - quietest)
}

/** Derive every renderer's facts from one report. */
export function daemonView(health: HealthReport | null, woundDown = false): DaemonView {
  const backends = health?.backends ?? []
  const models = backends.filter((b) => b.local)
  return {
    health,
    woundDown,
    models,
    remote: backends.filter((b) => !b.local),
    warm: models.filter((b) => b.state === "warm").length,
    failed: models.filter((b) => b.state === "failed").length,
    idleLeftMs: health ? idleLeftMs(health, models) : null,
  }
}

/**
 * The detail view.
 *
 * Usage is here because the question it answers is the one you cannot answer from the
 * footer: is the model actually being used, and is it keeping up. Counters are per
 * daemon-lifetime, so they reset when it restarts -- which is itself the signal, since a
 * daemon that has restarted recently is one that went idle.
 *
 * No tokens, deliberately. See BackendStatus.
 */
export function statusReport(health: HealthReport | null, base: string | null, woundDown = false): string {
  const view = daemonView(health, woundDown)
  if (!view.health) {
    if (view.woundDown) {
      return [
        `daemon  ${base ?? ""}  not answering`.trim(),
        "",
        "It was up earlier in this session, so it wound itself down on the idle window",
        "and released the GPU. That is the intended behaviour, not a failure.",
        "The next tool call restarts it; so does `onesystem start`.",
      ].join("\n")
    }
    return `no daemon is answering${base ? ` at ${base}` : ""} — run \`onesystem start\``
  }

  const lines = [`daemon  ${base}   up ${Math.round(view.health.uptimeMs / 1000)}s`]
  // One row per model, in the same order and the same vocabulary as the card's, because a
  // detail view that renames or reorders what the card just showed is the disagreement
  // this file used to have baked in.
  for (const b of view.models) lines.push(...backendRows(b))
  // Remotes last and labelled. They are not models, so they do not sit in the model list
  // implying they are one -- but a configured remote that has quietly failed is exactly
  // the thing a user opens this to find, so it is not omitted either.
  for (const b of view.remote) lines.push(...backendRows(b, "remote"))
  if (view.models.length === 0) lines.push("  no local model — nothing here holds the GPU")
  // The window is a supervisor rule over local backends only, so when a remote is on the
  // list, saying so stops the number above from reading as a promise about it.
  lines.push(
    `idle window ${view.health.idleShutdownSecs}s` +
      (view.remote.length > 0 ? "   applies to local models only" : ""),
  )
  return lines.join("\n")
}

/** One backend, as the dialog lays it out: state and calls, then volume underneath. */
function backendRows(b: BackendStatus, kind?: "remote"): string[] {
  const ms = b.lastMs === null ? "no calls yet" : `last ${b.lastMs}ms  mean ${b.meanMs}ms`
  return [
    `  ${b.name}${kind === "remote" ? "  (remote)" : ""}  ${b.state}  ${b.calls} calls` +
      `${b.errors ? `, ${b.errors} failed` : ""}  ${ms}${b.inflight ? `  ${b.inflight} in flight` : ""}`,
    // Volume, in the two units that are actually measured. Bytes, not tokens: neither
    // model reports tokens, so a token number would be an estimate next to a real one.
    `    ${b.answered} answered${describeTypes(b.byType)}  ${formatBytes(b.inBytes)} in / ${formatBytes(b.outBytes)} out`,
  ]
}

/**
 * One line, for one daemon.
 *
 * Kept as a pure function of the report so it can be asserted without a terminal — the
 * formatting is the part that rots, because a state is added to the backend and nobody
 * remembers there is a switch here.
 */
export function statusLine(health: HealthReport | null, woundDown = false): Line {
  const view = daemonView(health, woundDown)
  if (!view.health) {
    // Two different states that both render as "nothing is there", and only one of them
    // is a problem. A daemon that stopped after its quiet window has done exactly what it
    // was configured to do -- it released the GPU and went away, which is the point of the
    // idle window. Showing that in the error colour, next to a port that is not answering,
    // reads as breakage and is not.
    if (view.woundDown) return { text: "onesystem: idle (GPU released)", tone: "info" }
    return { text: "onesystem: not running", tone: "error" }
  }

  if (view.health.backends.length === 0) return { text: "onesystem: up, no backends", tone: "warning" }
  if (view.models.length === 0) return { text: "onesystem: up, no local model", tone: "info" }

  // `${b.name} ${b.state}`, and nothing more. This used to be a `describe` helper whose
  // two ternary arms were character-for-character identical -- `b.state === "warm" ?
  // `${b.name} warm` : `${b.name} ${b.state}`` -- and it was called out here as a no-op in
  // the issue that found it. It survived because it was a local function *shadowing* the
  // `describe()` method on `HealthReport`, so the name looked taken and the arm that
  // should have said something different never got written.
  const parts = view.models.slice(0, 2).map((b) => `${b.name} ${b.state}`)

  // One backend is the normal case and reads better alone; several get a count.
  const text =
    view.models.length === 1
      ? `onesystem: ${parts[0]}`
      : `onesystem: ${parts.join(", ")}${view.models.length > 2 ? ` +${view.models.length - 2}` : ""}`

  // Warm is the good state and worth noticing; cold is the cheap, correct default and
  // should not be coloured like a problem, or every idle session looks broken. Both come
  // off the view, so the tone cannot disagree with the card's count.
  return { text, tone: view.failed > 0 ? "error" : view.warm > 0 ? "success" : "info" }
}

/**
 * The slice of opencode's theme the card reads.
 *
 * Narrow on purpose, and generic in the colour rather than naming one. Naming `RGBA`
 * directly is not an option: it lives at an internal path that bun resolves and tsc does
 * not, so importing it breaks the typecheck. The colour is whatever the caller has,
 * inferred at the call site and irrelevant to the content.
 */
export interface CardTheme<C> {
  text: {
    base: C
    muted: C
    feedback: { success: { base: C }; error: { base: C } }
  }
}

/** How much attention a card row asks for. Not the footer's `Tone`: see `cardRows`. */
export type RowTone = "base" | "muted" | "success" | "error"

export interface CardRow {
  text: string
  tone: RowTone
}

/**
 * The card's content: what it says, in order, and how loudly.
 *
 * This is the testable half, and the split is not cosmetic. `jsx()` needs a live Solid
 * renderer — calling it outside a TUI throws "No renderer found" — so a function that
 * built nodes could not be called from a test at all, and the sidebar would go on having
 * no test surface while the three formatters had one. Returning rows puts the decisions
 * (which backends, what count, which words) in a pure function and leaves `renderCard` a
 * translation into nodes with nothing left to decide.
 *
 * `RowTone` is not the footer's `Tone` and the difference is real rather than tidiness: a
 * one-line status has to say "this is fine" or "this is broken", while a card has a
 * headline, a hierarchy, and de-emphasised detail. What the two must share is the *facts*,
 * and those all come off the `DaemonView`.
 */
export function cardRows(view: DaemonView): CardRow[] {
  if (!view.health) {
    // Same distinction as the footer. A daemon that released the GPU on its idle timer is
    // not an error, and colouring it like one trains the reader to ignore this card
    // exactly when it matters.
    if (view.woundDown) {
      // No duration claimed: this plugin only learns the daemon is gone on its next poll,
      // so anything it printed would be a guess. What it does know is that the next tool
      // call brings it back, which is the part that is actionable.
      return [{ text: "onesystem  idle, GPU released  ·  next tool call restarts it", tone: "muted" }]
    }
    return [{ text: "onesystem  not running", tone: "error" }]
  }

  // The headline counts models and only models. It used to count every backend, so one
  // local warm beside one remote cold rendered `1/2 warm` in the card while the footer
  // said `laya warm` — two renderers describing two different machines from one report.
  const rows: CardRow[] = [
    { text: `onesystem  ${view.warm}/${view.models.length} warm`, tone: "base" },
  ]
  for (const b of view.models) rows.push(...oneRow(b, false))
  // Remotes are listed last and marked, so the `n` above stays honest about the GPU while
  // a remote's state stays one glance away.
  for (const b of view.remote) rows.push(...oneRow(b, true))
  if (view.models.length === 0) {
    rows.push({ text: "  no local model — the GPU is free", tone: "muted" })
  }
  if (view.idleLeftMs !== null) {
    rows.push({
      text: view.idleLeftMs === 0 ? "  winding down" : `  idle in ${Math.round(view.idleLeftMs / 1000)}s`,
      tone: "muted",
    })
  }
  return rows
}

/** One backend: state, then usage indented underneath it. */
function oneRow(b: BackendStatus, remote: boolean): CardRow[] {
  return [
    {
      text: `  ${b.name} ${b.state}${remote ? " (remote)" : ""}`,
      tone: b.state === "failed" ? "error" : b.state === "warm" ? "success" : "muted",
    },
    // Usage on its own line, indented under the model. It was sharing a line with the
    // state, which pushed the card past the sidebar's width and clipped the end of the
    // number that mattered most.
    { text: `    ${formatUsage(b)}`, tone: "muted" },
  ]
}

/**
 * The sidebar card.
 *
 * What belongs here and what does not: the things that change on their own and that you
 * would otherwise have to open a terminal to check. So the per-model state, and how long
 * until the daemon gives the GPU back — which is the one number whose answer changes
 * without the user doing anything, and the reason the idle window exists.
 *
 * Not model accuracy, not VRAM, not a benchmark. A status card that starts making claims
 * about quality is a dashboard nobody trusts.
 *
 * All of the deciding is in `cardRows`, one layer up. This only maps tone onto colour and
 * stacks the results in a column.
 */
export function renderCard<C>(view: DaemonView, theme: CardTheme<C>): unknown {
  // A lookup rather than a nested ternary, so that adding a `RowTone` is a compile error
  // here instead of a card that silently renders every new row in the fallback colour.
  const color: Record<RowTone, C> = {
    base: theme.text.base,
    muted: theme.text.muted,
    success: theme.text.feedback.success.base,
    error: theme.text.feedback.error.base,
  }
  const rows = cardRows(view).map((row) => jsx("text", { fg: color[row.tone], children: row.text }))
  // A single row is returned bare, as it always was: wrapping one line in a box is a
  // column of one, and the idle/not-running states have no siblings to align with.
  if (rows.length === 1) return rows[0]
  return jsx("box", { flexDirection: "column", children: rows })
}

export default Plugin.define({
  id: "onesystem",

  setup(ctx) {
    // Two signals from one poll. The footer wants one line; the sidebar card wants the
    // per-backend detail. A second poll interval would be a second chance for them to
    // disagree about what the daemon is doing.
    const [line, setLine] = createSignal<Line>({ text: "onesystem: …", tone: "info" })
    const [report, setReport] = createSignal<HealthReport | null>(null)
    /**
     * Whether a healthy daemon has been seen in this session.
     *
     * This is the only thing that distinguishes "never started" from "wound itself down",
     * and it is exactly the distinction the user needs: the second is the idle window
     * working. A TUI that has just started cannot know, so it says "not running", which is
     * the truth from where it is standing.
     */
    const [sawHealthy, setSawHealthy] = createSignal(false)

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
      if (health) setSawHealthy(true)
      setReport(health)
      setLine(statusLine(health, sawHealthy()))
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
        // `report()`, not another `probeHealth(base)`. This used to probe again, which
        // made the dialog a second sample of the daemon taken seconds after the card's —
        // so the two could show different states for the same instant, and the idle window
        // could tick over between them. One poll, one snapshot, every renderer.
        await ctx.ui.dialog.alert({
          title: "onesystem",
          message: statusReport(report(), base, sawHealthy()),
        })
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

    // The card's rendering lives at module level, in `renderCard`, next to the view it
    // reads. It was in here for the file's whole life, which is the reason the sidebar had
    // no test surface while the three exported formatters did.
    const card = ctx.ui.slot({
      append: "sidebar.content",
      render: () => renderCard(daemonView(report(), sawHealthy()), ctx.theme),
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
