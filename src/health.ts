/**
 * The health contract: what `GET /health` means, and how to read it.
 *
 * `/health` is the most-read interface in the project and it used to be declared
 * nowhere. The body was assembled inline in the HTTP front from a `snapshot()` whose
 * return type was inferred, and eight callers parsed the result by hand: the CLI twice,
 * the plugin, `daemon.probe`, two test files, an e2e shell script using `grep -oP`, and
 * the README. A field rename would have compiled cleanly and broken all eight.
 *
 * So the shape lives here, once, and the same module both serves it and reads it. A
 * reader imports the type; a writer cannot drift from it.
 *
 * This is also the one place that knows the probe's discipline: one short timeout,
 * aborted rather than left hanging, and never throws. `daemon.probe` and the plugin's
 * `healthy()` were byte-identical copies of that, returning `Record | null` and
 * `boolean` respectively, and the duplication was invisible because neither was exported
 * from a module the other could import.
 */

import type { BackendStatus } from "./backend/types.ts"
import type { Holder as LockHolder } from "./lock.ts"
import type { BackendRegistration } from "./naming.ts"
import type { RoutingConfig } from "./routing.ts"

/**
 * Everything `onesystem status` reports, which is the whole of what the opencode plugin
 * knows about the daemon.
 *
 * This type used to live in `config.ts`, with a comment arguing that it belonged "next to
 * the rules that produce it". The rules that produce it are in `cli.ts`, and the comment's
 * own reasoning pointed the other way: what forced it into `config.ts` was that
 * `config.ts` was the one module already importing the types of the other three, so this
 * is the type that closed a three-module cycle:
 *
 *     config.ts -> health.ts -> backend/types.ts -> config.ts
 *
 * It is a *report* type — a machine interface, consumed by a plugin and printed by a CLI —
 * so it belongs beside the other report, which is this file. Its inputs are `HealthReport`
 * (here), `LockHolder` (`lock.ts`), `BackendRegistration` (`naming.ts`) and `RoutingConfig`
 * (`routing.ts`), and none of those imports this file, so nothing closes.
 *
 * It is also how the plugin stops guessing the address. `url` is the one true answer,
 * computed from the config the daemon actually loaded, and it is the answer the plugin uses.
 *
 * ## The payload is a contract
 *
 * `onesystem status --json` is read by `plugin/discover.ts`, which is a different program
 * from the one writing it. So the shape below is a wire format: adding a field is safe,
 * renaming or dropping one is a breaking change, and a field that stops being emitted is a
 * plugin that has quietly lost information. `test/status-payload.test.ts` pins the key set,
 * which is the only thing standing between a refactor of this file and a live session whose
 * tools are registered against a port nothing is listening on.
 */
export interface DaemonStatus {
  /** The config file in use. */
  config: string
  /** Every path that would be tried, in order. */
  configCandidates: string[]
  configDir: string
  /** Base URL the daemon answers on. */
  url: string
  running: boolean
  /** The health report, or null when nothing is listening. */
  daemon: HealthReport | null
  /** Who holds the lock, if anyone. */
  lock: LockHolder | null
  /** What opencode should register, and under which names. */
  registrations: BackendRegistration[]
  idleShutdownSecs: number
  /** Present only when the config declares one; omitted otherwise. */
  routing?: RoutingConfig
}

export interface HealthReport {
  status: "ok"
  /** Process id of the daemon. What `onesystem stop` signals. */
  pid: number
  uptimeMs: number
  idleShutdownSecs: number
  /** Backends whose quiesce would release a local process. */
  anyLocalWarm: boolean
  backends: BackendStatus[]
}

export interface HealthInput {
  idleShutdownSecs: number
  backends: BackendStatus[]
}

/** Assemble the report. Pure, so the shape is testable without a listener. */
export function healthReport(input: HealthInput, now: () => number = Date.now): HealthReport {
  return {
    status: "ok",
    pid: process.pid,
    uptimeMs: Math.round(process.uptime() * 1000),
    idleShutdownSecs: input.idleShutdownSecs,
    anyLocalWarm: input.backends.some((b) => b.local && b.state === "warm"),
    backends: input.backends,
  }
}

/** How long a probe waits before concluding nothing is listening. */
export const PROBE_TIMEOUT_MS = 1500

/**
 * Read a daemon's health, or `null` if nothing is answering.
 *
 * Never throws and never starts anything. A `null` means "not running or not reachable",
 * which is the distinction every caller actually wants; the difference between a refused
 * connection and a 500 is a debugging detail, not a branch in `cmdStart` or the plugin.
 */
export async function probeHealth(
  baseUrl: string,
  timeoutMs: number = PROBE_TIMEOUT_MS,
): Promise<HealthReport | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  timer.unref?.()
  try {
    const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/health`, { signal: controller.signal })
    if (!res.ok) return null
    return (await res.json()) as HealthReport
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/** Is a daemon answering on this base URL? Loads nothing, so it is safe to call often. */
export async function healthy(baseUrl: string, timeoutMs: number = PROBE_TIMEOUT_MS): Promise<boolean> {
  return (await probeHealth(baseUrl, timeoutMs)) !== null
}
