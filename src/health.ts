/**
 * Shared health and status payloads. Probes have a short timeout, never throw,
 * and never start the daemon or a model.
 */

import type { BackendStatus } from "./backend/types.ts"
import type { Holder as LockHolder } from "./lock.ts"
import type { BackendRegistration } from "./naming.ts"
import type { RoutingConfig } from "./routing.ts"

/**
 * JSON output of `onesystem status`, read by `plugin/discover.ts`.
 * The plugin uses `url` and registrations from this payload instead of guessing.
 * Renaming or removing fields breaks that contract; test/status-payload.test.ts
 * checks the emitted keys, including fields that TypeScript cannot check over JSON.
 */
export interface DaemonStatus {
  /** The config file in use. */
  config: string
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
 * Read health without starting anything. Return null on an unreachable or failed
 * response; never throw.
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
