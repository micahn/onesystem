/**
 * What the /onesystem menu offers, as data. Kept out of tui.ts so the option list,
 * labels, and value validation are testable without a terminal or a Solid renderer.
 */

import type { ConfigProbe } from "../config.ts"
import { MODELS } from "../models.ts"
import { backendStates } from "../config-edit.ts"
import { SETTING_BOUNDS, type NumericSetting } from "../config-edit.ts"

export interface PluginSettings {
  /** How often the footer re-reads /health, in ms. */
  pollMs: number
  /** Whether the sidebar card renders alongside the footer. */
  showCard: boolean
}

/** What is on disk, as `listRuntimes` reports it. */
export interface RuntimeInfo {
  name: string
  installed: boolean
}

export const DEFAULT_SETTINGS: PluginSettings = { pollMs: 4_000, showCard: true }

/** Clamp stored settings, which may come from an older version or a hand edit. */
export function normalizeSettings(raw: unknown): PluginSettings {
  const s = (raw ?? {}) as Partial<PluginSettings>
  const poll = Math.round(Number(s.pollMs))
  return {
    pollMs: Number.isFinite(poll) && poll >= 500 && poll <= 300_000 ? poll : DEFAULT_SETTINGS.pollMs,
    showCard: s.showCard !== false,
  }
}

export type MenuValue =
  | "status"
  | "restart"
  | "config:repair"
  | `model:${string}`
  | `install:${string}`
  | `uninstall:${string}`
  | `setting:${NumericSetting}`
  | "setting:pollMs"
  | "setting:showCard"

export interface MenuOption {
  title: string
  value: MenuValue
  description: string
  category?: string
}

/** The layer shape, declared here so it is testable without an OpenCode renderer. */
export interface CommandLayer {
  mode: "global"
  commands: {
    id: string
    title: string
    description: string
    group: string
    palette: true
    slash: { name: string; aliases: string[] }
    run: () => void
  }[]
}

/**
 * The keymap layer that makes `/onesystem` exist.
 *
 * `mode: "global"` is load-bearing. A layer defaults to the `base` input mode, and prompt
 * slash completion only offers commands reachable in the mode you are typing in, so a
 * default-mode layer is invisible in the prompt -- the command works in the palette and
 * nowhere else, which reads as "the plugin is not installed".
 */
export function commandLayer(open: () => void): () => CommandLayer {
  return () => ({
    mode: "global",
    commands: [
      {
        id: "onesystem.menu",
        title: "onesystem",
        description: "model status, install, enable and settings",
        group: "onesystem",
        palette: true,
        slash: { name: "onesystem", aliases: ["onesys"] },
        run: open,
      },
    ],
  })
}

/**
 * One flat list with categories rather than nested dialogs: the whole thing is one
 * screen, and the categories are what make it readable.
 *
 * Takes a probe, not a config, because a config that will not load has to be something
 * the menu talks about. Reading it the other way round made a broken file indistinguishable
 * from no file: the model rows quietly disappeared and the menu read as though nothing
 * was installed.
 */
export function topMenu(
  probe: ConfigProbe,
  settings: PluginSettings,
  runtimes: RuntimeInfo[] = [],
): MenuOption[] {
  const config = probe.config
  const opts: MenuOption[] = []

  if (probe.problems.length > 0) {
    const fixable = probe.problems.filter((p) => p.fix).length
    opts.push({
      title: `Config problem${probe.problems.length > 1 ? "s" : ""}: ${probe.problems.length}`,
      value: "config:repair",
      description: fixable
        ? `${fixable} of them fixable; open to repair`
        : "open to read; needs a hand",
    })
  }

  opts.push(
    { title: "Show status", value: "status", description: "daemon, models and device" },
    { title: "Restart daemon", value: "restart", description: "reloads models; drops warm ones" },
  )

  // Nothing to toggle until there is a config that loads, and the install path writes one.
  if (config) {
    for (const { name, enabled } of backendStates(config)) {
      opts.push({
        title: `${enabled ? "Disable" : "Enable"} ${name}`,
        value: `model:${name}`,
        description: enabled ? "stops offering its tools after a restart" : "offers its tools after a restart",
        category: "Models",
      })
    }
  }

  // Split by what is on disk. Offering to install something already installed reads as
  // though the menu has no idea, and the model list is the one thing here that is several
  // gigabytes either way.
  const onDisk = new Set(runtimes.filter((r) => r.installed).map((r) => r.name))
  for (const { name } of MODELS) {
    if (onDisk.has(name)) continue
    opts.push({
      title: `Install ${name}`,
      value: `install:${name}`,
      description: "downloads its own torch; several GB",
      category: "Install",
    })
  }

  // Every installed runtime, not only the ones this build knows about: a model dropped
  // from the table is still taking up disk and should still be removable.
  for (const name of onDisk) {
    opts.push({
      title: `Uninstall ${name}`,
      value: `uninstall:${name}`,
      description: "removes the runtime; its config block stays",
      category: "Uninstall",
    })
  }

  if (config) {
    opts.push(
      {
        title: `Daemon port: ${config.port}`,
        value: "setting:port",
        description: "restarts the daemon on the new port",
        category: "Settings",
      },
      {
        title: `Idle window: ${config.idleShutdownSecs}s`,
        value: "setting:idleShutdownSecs",
        description: "how long before an unused model releases the GPU",
        category: "Settings",
      },
    )
  }

  opts.push(
    {
      title: `Poll interval: ${Math.round(settings.pollMs / 1000)}s`,
      value: "setting:pollMs",
      description: "how often the footer re-reads status",
      category: "Settings",
    },
    {
      title: `Sidebar card: ${settings.showCard ? "on" : "off"}`,
      value: "setting:showCard",
      description: "the model list in the sidebar",
      category: "Settings",
    },
  )

  return opts
}

/** Parse a settings value typed into a prompt, with the reason it was refused. */
export function parseNumeric(key: NumericSetting, raw: string): number {
  return parseBounded(key, raw, SETTING_BOUNDS[key])
}

function parseBounded(label: string, raw: string, { min, max }: { min: number; max: number }): number {
  const text = raw.trim()
  const n = Number(text)
  if (text === "" || !Number.isInteger(n) || n < min || n > max) {
    throw new Error(`${label} must be a whole number from ${min} to ${max}, not "${text}"`)
  }
  return n
}

/** Poll interval bounds, separate from the config's because it is a plugin setting. */
export const POLL_MS_BOUNDS = { min: 500, max: 300_000 }

/** Parse a poll interval typed into a prompt, with the reason it was refused. */
export function parsePollMs(raw: string): number {
  const n = parseBounded("poll interval", raw, POLL_MS_BOUNDS)
  return n
}
