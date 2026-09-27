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
