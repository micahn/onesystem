/**
 * For one config, registrations, routing, and tool planning must agree on server
 * names and which backend keeps unqualified tools.
 */

import { describe, expect, test } from "bun:test"
import { planTools, type Catalog } from "../src/plugin/tools.ts"
import { validate, type Config } from "../src/config.ts"
import { registrations } from "../src/naming.ts"
import { resolve } from "../src/routing.ts"
import { planNames } from "../src/naming.ts"
import { STUB_TOOLS } from "./fixtures/stub-daemon.ts"

const config = (backends: Record<string, unknown>, routing?: unknown): Config =>
  validate(
    { idleShutdownSecs: 600, idleSweepSecs: 5, requestTimeoutSecs: 120, backends, routing },
    "test",
  )

const laya = { transport: "stdio-mcp", command: ["/bin/true"], toolPrefix: "laya_", tools: ["predict"] }
const julia = { transport: "stdio-mcp", command: ["/bin/true"], tools: ["predict"] }

/** A catalog shaped like the daemon's, so planTools sees the same backends as status. */
const catalog = (names: string[]): Catalog => ({
  backends: names.map((n) => (n === "julia" ? { backend: "julia", ...STUB_TOOLS.julia } : { backend: "laya", ...STUB_TOOLS.laya })),
})

/** The three configurations this actually has to get right. */
const scenarios: { what: string; config: Config; catalog: Catalog }[] = [
  { what: "one backend", config: config({ laya }), catalog: catalog(["laya"]) },
  {
    what: "two backends, no routing",
    config: config({ laya, julia }),
    catalog: catalog(["laya", "julia"]),
  },
  {
    what: "two backends, routing with a declared default",
    config: config({ laya, julia }, { enabled: true, default: "laya" }),
    catalog: catalog(["laya", "julia"]),
  },
  {
    what: "two backends, routing naming an unknown backend",
    config: config({ laya, julia }, { enabled: true, default: "nope" }),
    catalog: catalog(["laya", "julia"]),
  },
  {
    what: "an explicit serverName",
    config: config({ laya: { ...laya, serverName: "decisions" }, julia }),
    catalog: catalog(["laya", "julia"]),
  },
]

for (const { what, config: cfg } of scenarios) {
  describe(what, () => {
    test("registrations and the naming plan agree on every server name", () => {
      // `registrations` is what `onesystem status` prints, and the naming plan is what the
      // plugin hands the tool planner. They are computed from the same config by different
      // routes, so this is where a change to one that is not made to the other shows up.
      const registered = registrations(cfg.backends)
      const planned = planNames(registered.map((r) => ({ backend: r.backend, serverName: r.serverName })))
      expect(planned.map((p) => p.serverName)).toEqual(registered.map((r) => r.serverName))
    })

    test("the routing decision names servers that were actually registered", () => {
      // The bug this file exists for. `resolve` used to hardcode `onesystem` for the
      // preferred backend and rebuild the others from a template, so with routing on it
      // reported a name the daemon had never registered -- and, for a config with an
      // explicit `serverName`, discarded the name the user chose.
      const registered = registrations(cfg.backends)
      const route = resolve(cfg.routing, registered)
      if (!route) {
        // Routing off: there is no decision to check, and that is the correct answer.
        expect(cfg.routing).toBeFalsy()
        return
      }
      const byName = new Map(registered.map((r) => [r.backend, r.serverName]))
      expect(route.preferredServerName).toBe(byName.get(route.preferred)!)
      for (const other of route.others) {
        expect(other.serverName).toBe(byName.get(other.backend)!)
      }
      // And no name appears that is not a registered one, in either direction. The set
      // comparison is the stronger form of the two above: it would also catch a name that
      // happens to be right for the preferred backend and wrong for an "other".
      const reported = [route.preferredServerName, ...route.others.map((o) => o.serverName)].sort()
      expect(reported).toEqual(registered.map((r) => r.serverName).sort())
    })

    test("the tool names are exactly the ones the naming plan implies", () => {
      // The other axis, and the assertion is deliberately structural rather than a guess
      // made by inspecting the names.
      //
      // The obvious shortcut is to decide "is this name bare?" by looking for an
      // underscore, and it is wrong: laya really does publish `predict_batch` and
      // `route_batch`, so a bare `predict_batch` contains an underscore and reads as
      // qualified. Guessing at the output is how a test ends up asserting the shape of the
      // bug rather than the absence of it.
      //
      // So the expected list is built from the plan and the catalog's own tool names --
      // fixture data, not something `planTools` computed -- and compared exactly.
      const registered = registrations(cfg.backends)
      const route = resolve(cfg.routing, registered)
      const candidates = registered.map((r) => ({ backend: r.backend, serverName: r.serverName }))
      const cat = catalog(registered.map((r) => r.backend))

      const answerable = candidates.filter((c) => cat.backends.some((b) => b.backend === c.backend))
      const bare = new Set(planNames(answerable, route?.preferred).filter((n) => n.bare).map((n) => n.backend))

      const expected: string[] = []
      for (const entry of cat.backends) {
        const prefix = entry.toolPrefix ?? ""
        for (const t of entry.tools?.tools ?? []) {
          const stripped = t.name!.startsWith(prefix) ? t.name!.slice(prefix.length) : t.name!
          expected.push(bare.has(entry.backend) ? stripped : `${entry.backend}_${stripped}`)
        }
      }

      const { tools } = planTools(cat, candidates, route?.preferred)
      expect(tools.map((t) => t.name)).toEqual(expected)
    })
  })
}

describe("what the rule actually decides", () => {
  test("one backend is bare, and gets the bare server name", () => {
    expect(planNames([{ backend: "laya" }])).toEqual([{ backend: "laya", serverName: "onesystem", bare: true }])
  })

  test("several backends with nothing declared are all qualified", () => {
    // Not an oversight and not a bug to tidy: a declared default is a claim somebody made,
    // and with no claim there is nothing to justify one backend being the unqualified one.
    // Changing it would rename every tool in every live session on a two-backend setup.
    expect(planNames([{ backend: "laya" }, { backend: "julia" }])).toEqual([
      { backend: "laya", serverName: "onesystem-laya", bare: false },
      { backend: "julia", serverName: "onesystem-julia", bare: false },
    ])
  })

  test("a declared default is the only bare one", () => {
    const planned = planNames([{ backend: "laya" }, { backend: "julia" }], "julia")
    expect(planned.filter((p) => p.bare)).toEqual([{ backend: "julia", serverName: "onesystem-julia", bare: true }])
  })

  test("an explicit serverName is never overridden, at any backend count", () => {
    // The field `routing.resolve` used to overwrite. One backend, so the derived name would
    // have been `onesystem`; several, so it would have been `onesystem-laya`.
    expect(planNames([{ backend: "laya", serverName: "decisions" }])[0]!.serverName).toBe("decisions")
    expect(
      planNames([{ backend: "laya", serverName: "decisions" }, { backend: "julia" }])[0]!.serverName,
    ).toBe("decisions")
  })

  test("a backend the plan does not mention is not bare", () => {
    // The fallback path: `planTools` is callable without registrations, and an unmentioned
    // backend must not be handed the unqualified name by accident.
    const cat: Catalog = { backends: [{ backend: "laya", ...STUB_TOOLS.laya }, { backend: "julia", ...STUB_TOOLS.julia }] }
    expect(planTools(cat).tools.map((t) => t.name)).toEqual(["laya_predict", "laya_status", "julia_predict"])
  })

  test("a configured backend that is down does not strip the working one of its bare name", () => {
    // Two configured, one unreachable. The one that can still answer keeps `predict`,
    // because "which backend is unqualified" is a question about the backends that can
    // answer -- not about the ones the config happens to mention.
    const cfg = config({ laya, julia, broken: { transport: "stdio-mcp", command: ["/bin/true"], tools: ["x"] } })
    const registered = registrations(cfg.backends)
    const cat: Catalog = {
      backends: [{ backend: "laya", ...STUB_TOOLS.laya }, { backend: "broken", error: "connect refused" }],
    }
    const { tools } = planTools(cat, registered.map((r) => ({ backend: r.backend })))
    expect(tools.map((t) => t.name)).toEqual(["predict", "status"])
  })
})
