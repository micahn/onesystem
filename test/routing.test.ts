import { describe, expect, test } from "bun:test"
import { isEnabled, resolve } from "../src/routing.ts"

const both = [
  { backend: "laya", serverName: "onesystem-laya" },
  { backend: "julia", serverName: "onesystem-julia" },
]

describe("routing is off unless asked for", () => {
  test("off with no config at all", () => {
    expect(isEnabled(undefined, 2)).toBe(false)
    expect(resolve(undefined, both)).toBeNull()
  })

  test("off when explicitly disabled", () => {
    // The default. A default model is a claim about which model is better, and nobody
    // should inherit that claim from a config file.
    expect(isEnabled({ enabled: false, default: "julia" }, 2)).toBe(false)
    expect(resolve({ enabled: false, default: "julia" }, both)).toBeNull()
  })

  test("a truthy-looking value is still not enabled", () => {
    // Config is hand-edited JSONC. "true" as a string is a typo, not consent.
    expect(isEnabled({ enabled: "true" as never }, 2)).toBe(false)
  })
})

describe("routing is a no-op with one backend", () => {
  test("declaring a default with one backend does nothing", () => {
    const one = [{ backend: "laya", serverName: "onesystem" }]
    expect(isEnabled({ enabled: true, default: "laya" }, 1)).toBe(false)
    expect(resolve({ enabled: true, default: "laya" }, one)).toBeNull()
  })

  test("and with zero", () => {
    expect(resolve({ enabled: true, default: "laya" }, [])).toBeNull()
  })
})

describe("when it is on", () => {
  test("the default gets the bare name, so an unqualified call reaches it", () => {
    const r = resolve({ enabled: true, default: "julia" }, both)!
    expect(r.preferred).toBe("julia")
    // The name is the one the daemon registered, read back out of the registrations rather
    // than recomputed. This used to be asserted as the literal `"onesystem"`, which is the
    // bug: `registrations` had named this backend `onesystem-julia`, so the routing
    // decision was reporting a server that did not exist, and the test recorded that as
    // the expected answer. A routing decision that names a server nobody registered is
    // exactly the "a tool is missing and nothing says why" case `registrations` exists to
    // prevent.
    expect(r.preferredServerName).toBe("onesystem-julia")
    expect(r.others).toEqual([{ backend: "laya", serverName: "onesystem-laya" }])
  })

  test("every name it reports came from the registrations, verbatim", () => {
    // The property, stated once. `resolve` used to build `others` with a hardcoded
    // template, so a config with `serverName: "decisions"` was reported correctly by
    // `onesystem status` and silently rewritten here.
    const renamed = [
      { backend: "laya", serverName: "decisions" },
      { backend: "julia", serverName: "onesystem-julia" },
    ]
    const r = resolve({ enabled: true, default: "laya" }, renamed)!
    expect(r.preferredServerName).toBe("decisions")
    expect(r.others).toEqual([{ backend: "julia", serverName: "onesystem-julia" }])
  })

  test("a default naming a backend that is not enabled falls back rather than failing", () => {
    // A typo in the config should not stop the daemon coming up.
    const r = resolve({ enabled: true, default: "nope" }, both)!
    expect(r.preferred).toBe("laya")
  })

  test("the task map is surfaced, one line per task", () => {
    const r = resolve(
      { enabled: true, default: "julia", tasks: { engineering: "laya", triage: "julia" } },
      both,
    )!
    expect(r.guidance).toEqual(["  engineering: laya", "  triage: julia"])
  })

  test("no task map is fine", () => {
    expect(resolve({ enabled: true, default: "julia" }, both)!.guidance).toEqual([])
  })

  test("others keep a stable order", () => {
    const three = [...both, { backend: "rev", serverName: "onesystem-rev" }]
    const r = resolve({ enabled: true, default: "julia" }, three)!
    expect(r.others.map((o) => o.backend)).toEqual(["laya", "rev"])
  })
})
