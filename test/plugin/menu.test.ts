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
import { loadConfig, validate, type Config, type ConfigProblem } from "../../src/config.ts"
import { SETTING_BOUNDS, setBackendEnabled, setSetting } from "../../src/config-edit.ts"
import {
  DEFAULT_SETTINGS,
  POLL_MS_BOUNDS,
  normalizeSettings,
  parseNumeric,
  parsePollMs,
  commandLayer,
  topMenu,
  type MenuValue,
} from "../../src/plugin/menu.ts"
import { MODELS } from "../../src/models.ts"

const config = (backends: Record<string, unknown>, extra = {}) => validate({ backends, ...extra }, "test")

/** What probeConfig returns for a config that loads, and for one that does not. */
const probe = (cfg?: Config, problems: ConfigProblem[] = []) => ({
  path: "/home/u/.config/onesystem/onesystem.jsonc",
  address: { host: "127.0.0.1", port: cfg?.port ?? 7331 },
  problems,
  config: cfg,
})

const values = (opts: { value: MenuValue }[]) => opts.map((o) => o.value)
const categories = (opts: { category?: string }[]) => [...new Set(opts.map((o) => o.category ?? ""))]

describe("the menu", () => {
  const full = config({
    laya: { transport: "stdio-mcp", command: ["/bin/true"], tools: ["predict"] },
    julia: { transport: "stdio-mcp", command: ["/bin/true"], tools: ["predict"], enabled: false },
  })

  test("it offers status, restart, both models, and both settings", () => {
    const v = values(topMenu(probe(full), DEFAULT_SETTINGS))
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
    const opts = topMenu(probe(full), DEFAULT_SETTINGS)
    const laya = opts.find((o) => o.value === "model:laya")!
    const julia = opts.find((o) => o.value === "model:julia")!
    // laya is enabled, so the action offered is to disable it. Getting this backwards is
    // the worst kind of menu bug: the label promises one thing and the click does another.
    expect(laya.title).toBe("Disable laya")
    expect(julia.title).toBe("Enable julia")
  })

  test("every installable model is offered", () => {
    const v = values(topMenu(probe(full), DEFAULT_SETTINGS))
    for (const m of MODELS) expect(v).toContain(`install:${m.name}`)
  })

  test("settings show their current values, not labels", () => {
    const c = config(
      { laya: { transport: "stdio-mcp", command: ["/bin/true"], tools: ["predict"] } },
      { port: 7999, idleShutdownSecs: 120 },
    )
    const opts = topMenu(probe(c), { pollMs: 10_000, showCard: false })
    expect(opts.find((o) => o.value === "setting:port")!.title).toBe("Daemon port: 7999")
    expect(opts.find((o) => o.value === "setting:idleShutdownSecs")!.title).toBe("Idle window: 120s")
    expect(opts.find((o) => o.value === "setting:pollMs")!.title).toBe("Poll interval: 10s")
    expect(opts.find((o) => o.value === "setting:showCard")!.title).toBe("Sidebar card: off")
  })

  test("one flat list, grouped by category", () => {
    // Nested dialogs would make a routine toggle three keystrokes deep.
    const opts = topMenu(probe(full), DEFAULT_SETTINGS)
    expect(categories(opts)).toEqual(["", "Models", "Install", "Settings"])
  })

  test("with no config there is nothing to toggle, and the menu still works", () => {
    // The install path writes the first config, so a first run must not be a dead menu.
    const v = values(topMenu(probe(), DEFAULT_SETTINGS))
    expect(v).toEqual(
      expect.arrayContaining(["status", "restart", "install:laya", "setting:pollMs"]),
    )
    expect(v.some((x) => x.startsWith("model:"))).toBe(false)
    expect(v.some((x) => x.startsWith("setting:port"))).toBe(false)
  })

  test("a config that will not load is the first row, not a silent omission", () => {
    // The bug: a broken config was read as no config, so the model rows vanished and the
    // menu read as though nothing was installed. The failure has to name itself.
    const broken = probe(undefined, [
      { message: "backends.laya.startupTimeoutSecs (180) exceeds requestTimeoutSecs (120)", fix: { key: "requestTimeoutSecs", value: 180 } },
    ])
    const opts = topMenu(broken, DEFAULT_SETTINGS)
    expect(opts[0]!.value).toBe("config:repair")
    expect(opts[0]!.title).toBe("Config problem: 1")
    expect(opts[0]!.description).toContain("fixable")
    // And it is the only thing ahead of the ordinary rows, so it cannot be missed.
    expect(opts[1]!.value).toBe("status")
  })

  test("a problem with no fix says so rather than promising a repair", () => {
    const broken = probe(undefined, [{ message: "invalid JSON at offset 17" }])
    const row = topMenu(broken, DEFAULT_SETTINGS)[0]!
    expect(row.value).toBe("config:repair")
    expect(row.description).toBe("open to read; needs a hand")
  })

  test("several problems are counted, and the count is right", () => {
    const broken = probe(undefined, [
      { message: "a", fix: { key: "requestTimeoutSecs", value: 180 } },
      { message: "b" },
    ])
    const row = topMenu(broken, DEFAULT_SETTINGS)[0]!
    expect(row.title).toBe("Config problems: 2")
    expect(row.description).toContain("1 of them fixable")
  })

  test("a broken config still leaves the rest of the menu usable", () => {
    // Not a dead end: install, status and restart do not need a config that loads.
    const broken = probe(undefined, [{ message: "broken" }])
    const v = values(topMenu(broken, DEFAULT_SETTINGS))
    expect(v).toEqual(expect.arrayContaining(["config:repair", "status", "restart", "install:laya"]))
    // Toggling a model still needs a config, so those stay hidden.
    expect(v.some((x) => x.startsWith("model:"))).toBe(false)
  })

  test("a valid config shows no problem row at all", () => {
    expect(values(topMenu(probe(full), DEFAULT_SETTINGS))).not.toContain("config:repair")
  })

  test("every value is one the dialog routes", () => {
    // A value with no handler is a dead row, and dead rows are the whole complaint.
    const known = new Set<MenuValue>([
      "status",
      "restart",
      "config:repair",
      "setting:pollMs",
      "setting:showCard",
      ...MODELS.map((m) => `install:${m.name}` as const),
      ...Object.keys(SETTING_BOUNDS).map((k) => `setting:${k}` as MenuValue),
      ...["laya", "julia"].map((n) => `model:${n}` as MenuValue),
    ])
    for (const v of values(topMenu(probe(full), DEFAULT_SETTINGS))) {
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

describe("the /onesystem command", () => {
  test("it is global, or prompt completion never offers it", () => {
    // A keymap layer defaults to the `base` input mode. Prompt slash completion only
    // offers commands reachable in the mode being typed in, so a default-mode layer is
    // invisible in the prompt while working in the palette -- which reads as a plugin
    // that is not installed. Both reference plugins on this machine set `global`.
    const layer = commandLayer(() => {})()
    expect(layer.mode).toBe("global")
  })

  test("it is reachable as a slash command and in the palette", () => {
    const [command] = commandLayer(() => {})().commands
    expect(command!.slash.name).toBe("onesystem")
    expect(command!.slash.aliases).toContain("onesys")
    expect(command!.palette).toBe(true)
    // Stable, so a user can bind it in their keymap config.
    expect(command!.id).toBe("onesystem.menu")
  })

  test("running it opens the menu", () => {
    let opened = 0
    commandLayer(() => opened++)().commands[0]!.run()
    expect(opened).toBe(1)
  })

  test("it is registered from a slot that always renders, not the footer", async () => {
    // `ctx.keymap.layer` throws outside a render, so it needs a claimed slot -- but a
    // footer slot only renders once there is a footer, and the command has to exist
    // before anyone can type it. `app` renders unconditionally.
    const src = await readFile(join(import.meta.dir, "..", "..", "src", "plugin", "tui.ts"), "utf8")
    const appSlot = src.indexOf('append: "app"')
    expect(appSlot).toBeGreaterThan(-1)
    // Matched with the paren so the explanatory comment, which names the same call, is
    // not mistaken for it.
    const call = "ctx.keymap.layer("
    expect(src.indexOf(call)).toBeGreaterThan(appSlot)
    // And created exactly once, in that slot: a second layer would shadow this one.
    expect(src.split(call).length - 1).toBe(1)
    // Not from setup() either, which throws "Keymap.Provider is missing".
    expect(src.indexOf(call)).toBeGreaterThan(src.indexOf("const menu = async"))
  })

  test("the command is declared once, in menu.ts, and tui.ts adds no second one", async () => {
    const tui = await readFile(join(import.meta.dir, "..", "..", "src", "plugin", "tui.ts"), "utf8")
    // A duplicate `/onesystem` would shadow the first one, or show twice in completion.
    expect(tui).not.toContain('slash: { name: "onesystem"')
    expect(tui).not.toContain("onesystem.menu")
  })
})

describe("the repair handler", () => {
  const tui = () => readFile(join(import.meta.dir, "..", "..", "src", "plugin", "tui.ts"), "utf8")

  test("config:repair is routed, and the row is not dead", async () => {
    // The original complaint about this menu was rows that did nothing. Every value the
    // menu can produce has to be handled, and this one is the newest.
    const src = await tui()
    expect(src).toContain('choice === "config:repair"')
    expect(src).toContain("await repair(probe)")
  })

  test("it uses the same repair doctor --fix applies", async () => {
    // Two implementations of "fix the config" would drift, and the menu is the one a user
    // is looking at when they discover the problem.
    const src = await tui()
    expect(src).toContain("repairConfig(probe.path, probe.problems)")
  })

  test("it writes only after a confirmation, and re-checks afterwards", async () => {
    const src = await tui()
    expect(src.indexOf("ctx.ui.dialog.confirm")).toBeLessThan(src.indexOf("await repairConfig("))
    // Reporting success without re-reading would claim a repair that did not happen.
    expect(src).toContain("const after = await probeConfig()")
  })

  test("the menu probes the config rather than loading it", async () => {
    // loadConfig throws, which is exactly what this is fixing.
    const src = await tui()
    expect(src).toContain("await probeConfig()")
    expect(src).not.toContain("loadConfig().then")
  })
})
