/**
 * The /onesystem menu as data, and the validation of what a prompt accepts.
 *
 * These are the parts that decide what a user can do from inside OpenCode, so they are
 * tested without a terminal or a Solid renderer. The dialog wiring in tui.ts only routes.
 */

import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadConfig, validate } from "../../src/config.ts"
import { SETTING_BOUNDS, setBackendEnabled, setSetting } from "../../src/config-edit.ts"
import {
  DEFAULT_SETTINGS,
  POLL_MS_BOUNDS,
  normalizeSettings,
  parseNumeric,
  parsePollMs,
  topMenu,
  type MenuValue,
} from "../../src/plugin/menu.ts"
import { MODELS } from "../../src/models.ts"

const config = (backends: Record<string, unknown>, extra = {}) => validate({ backends, ...extra }, "test")

const values = (opts: { value: MenuValue }[]) => opts.map((o) => o.value)
const categories = (opts: { category?: string }[]) => [...new Set(opts.map((o) => o.category ?? ""))]

describe("the menu", () => {
  const full = config({
    laya: { transport: "stdio-mcp", command: ["/bin/true"], tools: ["predict"] },
    julia: { transport: "stdio-mcp", command: ["/bin/true"], tools: ["predict"], enabled: false },
  })

  test("it offers status, restart, both models, and both settings", () => {
    const v = values(topMenu(full, DEFAULT_SETTINGS))
    expect(v).toContain("status")
    expect(v).toContain("restart")
    expect(v).toContain("model:laya")
    expect(v).toContain("model:julia")
    expect(v).toContain("setting:port")
    expect(v).toContain("setting:idleShutdownSecs")
    expect(v).toContain("setting:pollMs")
    expect(v).toContain("setting:showCard")
  })

  test("a toggle says which way it will go", () => {
    const opts = topMenu(full, DEFAULT_SETTINGS)
    const laya = opts.find((o) => o.value === "model:laya")!
    const julia = opts.find((o) => o.value === "model:julia")!
    // laya is enabled, so the action offered is to disable it. Getting this backwards is
    // the worst kind of menu bug: the label promises one thing and the click does another.
    expect(laya.title).toBe("Disable laya")
    expect(julia.title).toBe("Enable julia")
  })

  test("every installable model is offered", () => {
    const v = values(topMenu(full, DEFAULT_SETTINGS))
    for (const m of MODELS) expect(v).toContain(`install:${m.name}`)
  })

  test("settings show their current values, not labels", () => {
    const c = config(
      { laya: { transport: "stdio-mcp", command: ["/bin/true"], tools: ["predict"] } },
      { port: 7999, idleShutdownSecs: 120 },
    )
    const opts = topMenu(c, { pollMs: 10_000, showCard: false })
    expect(opts.find((o) => o.value === "setting:port")!.title).toBe("Daemon port: 7999")
    expect(opts.find((o) => o.value === "setting:idleShutdownSecs")!.title).toBe("Idle window: 120s")
    expect(opts.find((o) => o.value === "setting:pollMs")!.title).toBe("Poll interval: 10s")
    expect(opts.find((o) => o.value === "setting:showCard")!.title).toBe("Sidebar card: off")
  })

  test("one flat list, grouped by category", () => {
    // Nested dialogs would make a routine toggle three keystrokes deep.
    const opts = topMenu(full, DEFAULT_SETTINGS)
    expect(categories(opts)).toEqual(["", "Models", "Install", "Settings"])
  })

  test("with no config there is nothing to toggle, and the menu still works", () => {
    // The install path writes the first config, so a first run must not be a dead menu.
    const v = values(topMenu(null, DEFAULT_SETTINGS))
    expect(v).toEqual(
      expect.arrayContaining(["status", "restart", "install:laya", "setting:pollMs"]),
    )
    expect(v.some((x) => x.startsWith("model:"))).toBe(false)
    expect(v.some((x) => x.startsWith("setting:port"))).toBe(false)
  })

  test("every value is one the dialog routes", () => {
    // A value with no handler is a dead row, and dead rows are the whole complaint.
    const known = new Set<MenuValue>([
      "status",
      "restart",
      "setting:pollMs",
      "setting:showCard",
      ...MODELS.map((m) => `install:${m.name}` as const),
      ...Object.keys(SETTING_BOUNDS).map((k) => `setting:${k}` as MenuValue),
      ...["laya", "julia"].map((n) => `model:${n}` as MenuValue),
    ])
    for (const v of values(topMenu(full, DEFAULT_SETTINGS))) {
      expect(`${v}: ${known.has(v)}`).toBe(`${v}: true`)
    }
  })
})

describe("plugin settings from storage", () => {
  test("defaults are used when nothing is stored", () => {
    expect(normalizeSettings(undefined)).toEqual(DEFAULT_SETTINGS)
    expect(normalizeSettings({})).toEqual(DEFAULT_SETTINGS)
  })

  test("a stored value survives, and nonsense falls back", () => {
    // The store is on disk and shared across TUI instances, so it can hold a value written
    // by an older version or edited by hand. A bad one must not become the poll interval.
    expect(normalizeSettings({ pollMs: 30_000, showCard: false })).toEqual({ pollMs: 30_000, showCard: false })
    for (const bad of [0, -1, 100, 999_999, NaN, "x", null]) {
      expect(normalizeSettings({ pollMs: bad as number }).pollMs).toBe(DEFAULT_SETTINGS.pollMs)
    }
    // Only an explicit false turns the card off.
    expect(normalizeSettings({ showCard: 0 as unknown as boolean }).showCard).toBe(true)
  })
})

describe("value validation", () => {
  test("a number in range is accepted", () => {
    expect(parseNumeric("port", " 7331 ")).toBe(7331)
    expect(parseNumeric("idleShutdownSecs", "60")).toBe(60)
    expect(parsePollMs("1000")).toBe(1000)
  })

  test("out of range, fractional, and empty are refused with the range", () => {
    for (const raw of ["0", "70000", "1.5", "", "  ", "abc", "7331x"]) {
      expect(() => parseNumeric("port", raw)).toThrow(/must be a whole number from 1 to 65535/)
    }
    // The idle window has its own bounds, and 0 is excluded on purpose: it would pin the
    // GPU on forever, which is not a thing a menu should offer.
    expect(() => parseNumeric("idleShutdownSecs", "0")).toThrow(/from 10 to/)
    expect(() => parsePollMs("10")).toThrow(new RegExp(`from ${POLL_MS_BOUNDS.min} to`))
  })
})

describe("what the menu writes", () => {
  const seed = async (backends: Record<string, unknown>, extra: Record<string, unknown> = {}) => {
    const dir = await mkdtemp(join(tmpdir(), "onesystem-menu-"))
    const path = join(dir, "onesystem.jsonc")
    await writeFile(
      path,
      `{\n  // hand written\n  "port": 7331,\n  "backends": ${JSON.stringify(backends, null, 2)}\n}\n`,
    )
    process.env.ONESYSTEM_CONFIG_DIR = dir
    return { dir, path }
  }

  test("toggling one model leaves the others alone", async () => {
    const { dir, path } = await seed({
      laya: { transport: "stdio-mcp", command: ["/bin/true"], tools: ["predict"], enabled: true },
      julia: { transport: "stdio-mcp", command: ["/bin/true"], tools: ["predict"], enabled: true },
    })
    try {
      const { config: before } = await loadConfig()
      const { changed } = await setBackendEnabled(path, before, "julia", false)
      expect(changed).toBe(true)
      const { config: after } = await loadConfig()
      expect(after.backends.julia!.enabled).toBe(false)
      // The other model must not move. `switchToBackend` disables everything, which is
      // why this needs its own path.
      expect(after.backends.laya!.enabled).toBe(true)
      expect((await readFile(path, "utf8"))).toContain("// hand written")
    } finally {
      delete process.env.ONESYSTEM_CONFIG_DIR
    }
  })

  test("toggling to the value it already has writes nothing", async () => {
    const { path } = await seed({
      laya: { transport: "stdio-mcp", command: ["/bin/true"], tools: ["predict"], enabled: true },
    })
    try {
      const { config: before } = await loadConfig()
      const { changed } = await setBackendEnabled(path, before, "laya", true)
      expect(changed).toBe(false)
    } finally {
      delete process.env.ONESYSTEM_CONFIG_DIR
    }
  })

  test("an unknown model is refused by name, listing what exists", async () => {
    const { path } = await seed({
      laya: { transport: "stdio-mcp", command: ["/bin/true"], tools: ["predict"] },
    })
    try {
      const { config: before } = await loadConfig()
      await expect(setBackendEnabled(path, before, "nope", true)).rejects.toThrow(
        /no backend named "nope".*laya/,
      )
    } finally {
      delete process.env.ONESYSTEM_CONFIG_DIR
    }
  })

  test("a setting is written as a number, not a string", async () => {
    const { path } = await seed({ laya: { transport: "stdio-mcp", command: ["/bin/true"], tools: ["predict"] } })
    try {
      await setSetting(path, "port", 7999)
      const { config: after } = await loadConfig()
      // A quoted "7999" would still parse, so check the bytes as well as the value.
      expect(after.port).toBe(7999)
      expect(await readFile(path, "utf8")).toContain('"port": 7999')
    } finally {
      delete process.env.ONESYSTEM_CONFIG_DIR
    }
  })

  test("a setting set to its current value writes nothing", async () => {
    const { path } = await seed({ laya: { transport: "stdio-mcp", command: ["/bin/true"], tools: ["predict"] } })
    try {
      const before = await readFile(path, "utf8")
      const { changed } = await setSetting(path, "port", 7331)
      expect(changed).toBe(false)
      expect(await readFile(path, "utf8")).toBe(before)
    } finally {
      delete process.env.ONESYSTEM_CONFIG_DIR
    }
  })
})
