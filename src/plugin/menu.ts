/**
 * What the /onesystem menu offers, as data. Kept out of tui.ts so the option list,
 * labels, and value validation are testable without a terminal or a Solid renderer.
 */

import type { Config } from "../config.ts"
import { MODELS } from "../models.ts"
import { backendStates } from "../config-edit.ts"
import { SETTING_BOUNDS, type NumericSetting } from "../config-edit.ts"

export interface PluginSettings {
  /** How often the footer re-reads /health, in ms. */
  pollMs: number
  /** Whether the sidebar card renders alongside the footer. */
  showCard: boolean
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
  | `model:${string}`
  | `install:${string}`
  | `setting:${NumericSetting}`
  | "setting:pollMs"
  | "setting:showCard"

export interface MenuOption {
  title: string
  value: MenuValue
  description: string
  category?: string
}

/**
 * One flat list with categories rather than nested dialogs: the whole thing is one
 * screen, and the categories are what make it readable.
 */
export function topMenu(config: Config | null, settings: PluginSettings): MenuOption[] {
  const opts: MenuOption[] = [
    { title: "Show status", value: "status", description: "daemon, models and device" },
    { title: "Restart daemon", value: "restart", description: "reloads models; drops warm ones" },
  ]

  // Without a config there is nothing to toggle, and the install path writes it first.
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

  for (const { name } of MODELS) {
    opts.push({
      title: `Install ${name}`,
      value: `install:${name}`,
      description: "downloads its own torch; several GB",
      category: "Install",
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
