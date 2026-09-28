/**
 * OpenCode TUI status and install menu. The footer, card, dialog, and countdown
 * share one health snapshot through daemonView. Only local backends count as models.
 * Installs require a menu choice because they download several GB.
 * Direct jsx() calls keep this file usable without a JSX compiler transform.
 */

import { Plugin } from "@opencode/plugin/tui"
import { createSignal } from "solid-js"
import { jsx } from "@opentui/solid/jsx-runtime"
import { probeHealth, type HealthReport } from "../health.ts"
import type { BackendStatus } from "../backend/types.ts"
import { MODELS } from "../models.ts"
import { loadConfig } from "../config.ts"
import { switchToBackend } from "../config-edit.ts"
import { describeError } from "../async.ts"
import { defaultCli, pluginLog, resolveBase, run } from "./discover.ts"

/** How often to re-read /health. */
const POLL_MS = 4_000

type Tone = "info" | "success" | "warning" | "error"
type Line = { text: string; tone: Tone }

/**
 * Compact card usage. The dialog shows the same counts with an input/output breakdown.
 */
export function formatUsage(b: BackendStatus): string {
  return `${b.calls} calls · ${b.answered} answered · ${formatBytes(b.inBytes + b.outBytes)}`
}

/**
 * Compact byte counts. K and M use powers of 1024.
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
 * Shared display state. Count local backends as models; list remote services
 * separately because onesystem does not own their processes or idle shutdown.
 */
export interface DaemonView {
  /** Null when nothing is answering. Every other field is then its empty value. */
  health: HealthReport | null
  /** A healthy daemon was seen earlier in this session, so this is the idle window. */
  woundDown: boolean
  /** Local backends, including those that are still cold. */
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
 * Idle countdown for warm local models with no calls in flight. Use the least-idle
 * eligible model; return null if none qualify. Cold models must not affect the count.
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
 * Detailed status and usage. Counters reset when the daemon restarts.
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
  // Match the card's model order.
  for (const b of view.models) lines.push(...backendRows(b))
  // Show remote services separately, including failures.
  for (const b of view.remote) lines.push(...backendRows(b, "remote"))
  if (view.models.length === 0) lines.push("  no local model — nothing here holds the GPU")
  // The idle window applies only to local backends.
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
    // Models report answers and bytes, not token counts.
    `    ${b.answered} answered${describeTypes(b.byType)}  ${formatBytes(b.inBytes)} in / ${formatBytes(b.outBytes)} out`,
  ]
}

/**
 * Format one status line without a terminal dependency.
 */
export function statusLine(health: HealthReport | null, woundDown = false): Line {
  const view = daemonView(health, woundDown)
  if (!view.health) {
    // Show expected idle shutdown as informational.
    if (view.woundDown) return { text: "onesystem: idle (GPU released)", tone: "info" }
    return { text: "onesystem: not running", tone: "error" }
  }

  if (view.health.backends.length === 0) return { text: "onesystem: up, no backends", tone: "warning" }
  if (view.models.length === 0) return { text: "onesystem: up, no local model", tone: "info" }

  const parts = view.models.slice(0, 2).map((b) => `${b.name} ${b.state}`)

  // One backend is the normal case and reads better alone; several get a count.
  const text =
    view.models.length === 1
      ? `onesystem: ${parts[0]}`
      : `onesystem: ${parts.join(", ")}${view.models.length > 2 ? ` +${view.models.length - 2}` : ""}`

  // Cold is normal; only failed models use the error color.
  return { text, tone: view.failed > 0 ? "error" : view.warm > 0 ? "success" : "info" }
}

/**
 * Theme fields used by the card. Infer the color type to avoid an internal RGBA
 * import that Bun resolves but TypeScript cannot.
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
 * Build card rows without JSX, which requires a live Solid renderer.
 * RowTone controls emphasis; all model facts come from DaemonView.
 */
export function cardRows(view: DaemonView): CardRow[] {
  if (!view.health) {
    if (view.woundDown) {
      // Polling cannot tell us the exact shutdown time.
      return [{ text: "onesystem  idle, GPU released  ·  next tool call restarts it", tone: "muted" }]
    }
    return [{ text: "onesystem  not running", tone: "error" }]
  }

  // Count only local models in the headline.
  const rows: CardRow[] = [
    { text: `onesystem  ${view.warm}/${view.models.length} warm`, tone: "base" },
  ]
  for (const b of view.models) rows.push(...oneRow(b, false))
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
    // A separate usage row fits the narrow sidebar.
    { text: `    ${formatUsage(b)}`, tone: "muted" },
  ]
}

/**
 * Render cardRows as a column with theme colors.
 */
export function renderCard<C>(view: DaemonView, theme: CardTheme<C>): unknown {
  // Require a color for every RowTone.
  const color: Record<RowTone, C> = {
    base: theme.text.base,
    muted: theme.text.muted,
    success: theme.text.feedback.success.base,
    error: theme.text.feedback.error.base,
  }
  const rows = cardRows(view).map((row) => jsx("text", { fg: color[row.tone], children: row.text }))
  if (rows.length === 1) return rows[0]
  return jsx("box", { flexDirection: "column", children: rows })
}

export default Plugin.define({
  id: "onesystem",

  setup(ctx) {
    // One poll supplies every view.
    const [line, setLine] = createSignal<Line>({ text: "onesystem: …", tone: "info" })
    const [report, setReport] = createSignal<HealthReport | null>(null)
    /**
     * A prior healthy response lets the UI infer idle shutdown instead of "not running".
     */
    const [sawHealthy, setSawHealthy] = createSignal(false)

    const cli = defaultCli()
    let base: string | null = null
    let busy = false

    const refresh = async () => {
      if (!base) {
        // Cache the address to avoid spawning the CLI on each poll.
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

    // Guard overlapping polls here. A second busy check in refresh would skip every read.
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
     * /onesystem menu: status and model installation.
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
        // Use the same snapshot as the card.
        await ctx.ui.dialog.alert({
          title: "onesystem",
          message: statusReport(report(), base, sawHealthy()),
        })
        return
      }
      if (!choice?.startsWith("install:")) return

      const name = choice.slice("install:".length)
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

      // Use the same config switch as the CLI.
      try {
        const { config, path } = await loadConfig()
        const switched = await switchToBackend(path, config, name)
        ctx.ui.toast.show({
          title: `${name} installed and switched to`,
          message: switched.changed
            ? `now enabled: ${switched.on.join(", ")}. Restart the daemon (or just make a tool call) to pick it up.`
            : `${name} was already the only enabled backend.`,
          variant: "success",
        })
      } catch (err) {
        // The runtime remains usable if the config switch fails.
        ctx.ui.toast.show({
          title: `${name} installed, but not switched to`,
          message: `${describeError(err)}\n\nIt is on disk and usable — \`onesystem use ${name}\` will switch to it.`,
          variant: "warning",
        })
      }
    }

    // keymap.layer needs a component owner; register once inside the slot render.
    let registered = false

    const card = ctx.ui.slot({
      append: "sidebar.content",
      render: () => renderCard(daemonView(report(), sawHealthy()), ctx.theme),
    })

    const dispose = ctx.ui.slot({
      append: "prompt.footer.status",
      render: () => {
        // Read the signal before keymap registration to keep it in the tracking scope.
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
        // Direct jsx() calls need getters to track reactive prop updates.
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
