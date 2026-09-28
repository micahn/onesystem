/**
 * The `onesystem status --json` payload.
 *
 * This is a wire format with a reader and a writer on opposite sides of a process
 * boundary. `cli.ts` builds it, `plugin/discover.ts` parses it, and the plugin is what
 * registers the session's tools against the address in it. A field that stops being emitted
 * is not a compile error anywhere: the plugin reads `undefined`, `resolveBase` returns null,
 * and the session ends up with no tools and no message — which is the exact symptom that
 * `DaemonStatus` was introduced to prevent, arriving by the same route.
 *
 * `DaemonStatus` also moved modules during the `config.ts` split (it is a report type, so
 * it belongs in `health.ts`, and its presence in `config.ts` was the edge that closed a
 * three-module type cycle). A type moving is safe; a *payload* moving is not, and nothing
 * about the move would have been caught by a typecheck. So the key set is pinned here.
 *
 * The plugin-side half of the same risk is handled structurally rather than here:
 * `DaemonAnswer` is a `Pick<DaemonStatus, ...>`, so a renamed or dropped field is a
 * compile error. This test covers the half a type cannot: fields that are still declared
 * but no longer written.
 */

import { describe, expect, test } from "bun:test"
import { validate } from "../src/config.ts"
import { registrations } from "../src/naming.ts"
import { healthReport } from "../src/health.ts"
import { daemonUrl } from "../src/paths.ts"
import type { DaemonStatus } from "../src/health.ts"

/**
 * Build a status exactly the way `cmdStatus` does.
 *
 * Assembled here rather than by running the CLI so that the assertion is about the shape
 * and not about how to get a daemon running. The keys are written out longhand below, which
 * is the whole mechanism: a field the builder stops producing shows up as a missing key.
 */
function buildStatus(): DaemonStatus {
  const config = validate(
    { backends: { laya: { transport: "stdio-mcp", command: ["/bin/true"], tools: ["predict"] } } },
    "test",
  )
  const base = daemonUrl(config.host, config.port)
  return {
    config: "/home/u/.config/onesystem/onesystem.json",
    configCandidates: ["/home/u/.config/onesystem/onesystem.json", "/src/onesystem.config.json"],
    configDir: "/home/u/.config/onesystem",
    url: base,
    running: true,
    daemon: healthReport({ idleShutdownSecs: config.idleShutdownSecs, backends: [] }),
    lock: {
      path: "/home/u/.local/state/onesystem/daemon.lock",
      pid: 123,
      state: "held" as const,
      alive: true,
      port: 7331,
    },
    registrations: registrations(config.backends),
    idleShutdownSecs: config.idleShutdownSecs,
  }
}

describe("the status payload", () => {
  test("it carries exactly these keys", () => {
    expect(Object.keys(buildStatus()).sort()).toEqual([
      "config",
      "configCandidates",
      "configDir",
      "daemon",
      "idleShutdownSecs",
      "lock",
      "registrations",
      "running",
      "url",
    ])
  })

  test("routing is omitted when the config declares none", () => {
    // Omitted rather than `null` or `{}`, and the plugin distinguishes "no routing" from
    // "routing explicitly off" by that absence. A field that starts being emitted as null
    // would be read as a declared-but-empty routing config.
    expect("routing" in buildStatus()).toBe(false)
  })

  test("a registration entry carries the four fields the plugin reads", () => {
    // `toolPrefix` is the one that drifted historically: produced here, discarded by the
    // plugin. It is still part of the payload and still has to be written.
    const [reg] = buildStatus().registrations
    expect(Object.keys(reg!).sort()).toEqual(["backend", "serverName", "toolPrefix", "transport"])
  })

  test("the health report inside it is the same shape the daemon serves", () => {
    // Nested, so it is nested drift too: a renamed field inside `daemon` breaks the TUI's
    // card and the plugin's own health probe, and neither reads the type.
    expect(Object.keys(buildStatus().daemon!).sort()).toEqual([
      "anyLocalWarm",
      "backends",
      "idleShutdownSecs",
      "pid",
      "status",
      "uptimeMs",
    ])
  })

  test("it serialises to JSON with the same top-level keys, because that is what is read", () => {
    // The type says nothing about `JSON.stringify` dropping `undefined`. A field whose value
    // is undefined at runtime disappears from the payload, which is a quieter failure than a
    // missing key in the object literal and is exactly how a key set goes stale.
    const wire = JSON.parse(JSON.stringify(buildStatus())) as Record<string, unknown>
    expect(Object.keys(wire).sort()).toEqual(Object.keys(buildStatus()).sort())
  })
})
